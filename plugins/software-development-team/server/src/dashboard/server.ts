// SECURITY NOTE: This dashboard server is intended for local development use only.
// It binds to a random ephemeral port (port 0) on localhost and has no authentication.
// Do NOT expose this server to a network. If network access is ever needed,
// authentication and authorization must be added before deployment.
// WebSocket upgrades enforce an Origin allowlist: browsers do not apply CORS to
// WebSocket connections, so without this check any web page could open
// ws://localhost:<port> and read the full event stream. Upgrade requests with a
// non-localhost (or malformed) Origin header are rejected; requests with no
// Origin header (non-browser clients) are allowed.
import express from 'express';
import type { ErrorRequestHandler, Request } from 'express';
import WebSocket, { WebSocketServer } from 'ws';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import type { StateMachine } from '../state/machine.js';
import type { MessageBus } from '../bus/message-bus.js';
import type { MemoryStore } from '../memory/store.js';
import type {
  DashboardEvent,
  ExecutionControlAction,
  ExecutionControlTarget,
  Message,
  RunState,
  MemoryEntry,
} from '../types.js';
import { logger } from '../logger.js';
import { PersistQueue, PersistenceUnavailableError } from '../state/persist-queue.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Hostnames allowed to originate browser WebSocket connections. Exact match only —
// substring/startsWith matching would let e.g. http://localhost.evil.example through.
// Node's WHATWG URL keeps IPv6 brackets in `hostname` ('[::1]'), but include the
// bare form too for safety across parsers.
const ALLOWED_WS_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const JSON_BODY_LIMIT_BYTES = 16 * 1024;
const MAX_CONTROL_REASON_LENGTH = 500;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONTROL_ACTIONS = new Set<ExecutionControlAction>([
  'pause_run',
  'resume_run',
  'cancel_run',
  'cancel_step',
  'retry_step',
  'acknowledge_pause',
  'acknowledge_cancel',
]);
const RUN_ONLY_ACTIONS = new Set<ExecutionControlAction>([
  'pause_run',
  'resume_run',
  'cancel_run',
  'acknowledge_pause',
]);
const STEP_ONLY_ACTIONS = new Set<ExecutionControlAction>(['cancel_step', 'retry_step']);

type ControlRequestBody = {
  action: ExecutionControlAction;
  target: ExecutionControlTarget;
  commandId: string;
  expectedRevision: number;
  reason?: string;
  confirmation?: string;
};

class ControlRequestError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 503,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rejectUnknownFields(object: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(object).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new ControlRequestError(400, 'unknown_fields', `${label} contains unknown fields: ${unknown.join(', ')}`);
  }
}

function parseControlBody(value: unknown, runId: string): ControlRequestBody {
  if (!isPlainObject(value)) {
    throw new ControlRequestError(400, 'invalid_body', 'Request body must be a JSON object');
  }
  rejectUnknownFields(
    value,
    ['action', 'target', 'commandId', 'expectedRevision', 'reason', 'confirmation'],
    'Request body',
  );

  if (typeof value.action !== 'string' || !CONTROL_ACTIONS.has(value.action as ExecutionControlAction)) {
    throw new ControlRequestError(400, 'invalid_action', 'action is not a supported execution control');
  }
  const action = value.action as ExecutionControlAction;
  if (typeof value.commandId !== 'string' || !UUID_PATTERN.test(value.commandId)) {
    throw new ControlRequestError(400, 'invalid_command_id', 'commandId must be a UUID');
  }
  if (!Number.isSafeInteger(value.expectedRevision) || (value.expectedRevision as number) < 0) {
    throw new ControlRequestError(400, 'invalid_revision', 'expectedRevision must be a non-negative safe integer');
  }
  if (!isPlainObject(value.target)) {
    throw new ControlRequestError(400, 'invalid_target', 'target must be a JSON object');
  }

  let target: ExecutionControlTarget;
  if (value.target.kind === 'run') {
    rejectUnknownFields(value.target, ['kind'], 'run target');
    target = { kind: 'run' };
  } else if (value.target.kind === 'step') {
    rejectUnknownFields(value.target, ['kind', 'stepId'], 'step target');
    if (!Number.isSafeInteger(value.target.stepId) || (value.target.stepId as number) <= 0) {
      throw new ControlRequestError(400, 'invalid_step_id', 'stepId must be a positive safe integer');
    }
    target = { kind: 'step', stepId: value.target.stepId as number };
  } else {
    throw new ControlRequestError(400, 'invalid_target', "target.kind must be 'run' or 'step'");
  }

  if (RUN_ONLY_ACTIONS.has(action) && target.kind !== 'run') {
    throw new ControlRequestError(400, 'target_mismatch', `${action} requires a run target`);
  }
  if (STEP_ONLY_ACTIONS.has(action) && target.kind !== 'step') {
    throw new ControlRequestError(400, 'target_mismatch', `${action} requires a step target`);
  }

  let reason: string | undefined;
  if (value.reason !== undefined) {
    if (typeof value.reason !== 'string' || value.reason.trim().length === 0) {
      throw new ControlRequestError(400, 'invalid_reason', 'reason must be a non-empty string when supplied');
    }
    reason = value.reason.trim();
    if (reason.length > MAX_CONTROL_REASON_LENGTH) {
      throw new ControlRequestError(
        400,
        'invalid_reason',
        `reason must be at most ${MAX_CONTROL_REASON_LENGTH} characters`,
      );
    }
  }

  const destructive = action === 'cancel_run' || action === 'cancel_step';
  if (destructive && reason === undefined) {
    throw new ControlRequestError(400, 'reason_required', 'Cancellation requires a reason');
  }
  if (!destructive && value.confirmation !== undefined) {
    throw new ControlRequestError(400, 'unexpected_confirmation', 'confirmation is only accepted for cancellation');
  }
  if (destructive) {
    const expected = target.kind === 'run'
      ? `cancel run ${runId}`
      : `cancel step ${runId}/${target.stepId}`;
    if (value.confirmation !== expected) {
      throw new ControlRequestError(400, 'confirmation_mismatch', 'Cancellation confirmation does not match the target');
    }
  }

  return {
    action,
    target,
    commandId: value.commandId,
    expectedRevision: value.expectedRevision as number,
    ...(reason === undefined ? {} : { reason }),
    ...(typeof value.confirmation === 'string' ? { confirmation: value.confirmation } : {}),
  };
}

/**
 * Browser mutations must be genuinely same-origin. Requests without Origin are
 * allowed for local CLI clients because the server is bound to loopback only.
 */
function enforceMutationOrigin(req: Request): void {
  const host = req.get('host');
  if (!host) throw new ControlRequestError(403, 'invalid_origin', 'A loopback Host header is required');

  let requestOrigin: URL;
  try {
    requestOrigin = new URL(`http://${host}`);
  } catch {
    throw new ControlRequestError(403, 'invalid_origin', 'Host header is malformed');
  }
  if (!ALLOWED_WS_HOSTNAMES.has(requestOrigin.hostname)) {
    throw new ControlRequestError(403, 'invalid_origin', 'Mutation requests must target a loopback host');
  }

  const origin = req.get('origin');
  if (origin === undefined) return;
  if (origin === '' || origin === 'null') {
    throw new ControlRequestError(403, 'invalid_origin', 'Browser mutation Origin is not allowed');
  }
  let parsedOrigin: URL;
  try {
    parsedOrigin = new URL(origin);
  } catch {
    throw new ControlRequestError(403, 'invalid_origin', 'Browser mutation Origin is malformed');
  }
  if (parsedOrigin.protocol !== 'http:' || parsedOrigin.origin !== requestOrigin.origin) {
    throw new ControlRequestError(403, 'invalid_origin', 'Browser mutation requests must be same-origin');
  }
}

function stateMachineError(err: unknown): ControlRequestError {
  if (err instanceof PersistenceUnavailableError) {
    return new ControlRequestError(503, err.code, err.message);
  }
  const message = err instanceof Error ? err.message : 'Execution control failed';
  if (/Run .+ not found|Step \d+ not found/.test(message)) {
    return new ControlRequestError(404, 'target_not_found', message);
  }
  if (/revision conflict/i.test(message)) {
    return new ControlRequestError(409, 'revision_conflict', message);
  }
  if (/already used with a different payload/i.test(message)) {
    return new ControlRequestError(409, 'command_conflict', message);
  }
  return new ControlRequestError(409, 'invalid_phase', message);
}

/**
 * Returns true when a WebSocket upgrade should be accepted based on its Origin
 * header. No Origin (non-browser clients: tests, wscat, curl) is allowed;
 * otherwise the origin must parse as a URL with an http/https protocol and a
 * hostname that is exactly localhost / 127.0.0.1 / ::1 (any port, or no port).
 * A malformed Origin is rejected.
 */
function isAllowedWsOrigin(origin: string | undefined): boolean {
  if (origin === undefined || origin === '') return true;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  return ALLOWED_WS_HOSTNAMES.has(url.hostname);
}

export async function startDashboard(
  sm: StateMachine,
  bus: MessageBus,
  memoryStore: MemoryStore,
  persistence: PersistQueue = new PersistQueue(),
): Promise<number> {
  const app = express();

  // Security headers
  app.use((_req, res, next) => {
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws://localhost:* ws://127.0.0.1:* wss://localhost:* wss://127.0.0.1:*; img-src 'self' data:");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    next();
  });

  // Keep every JSON mutation bounded. The error middleware below translates
  // parser failures to the dashboard's structured validation response.
  app.use(express.json({ limit: JSON_BODY_LIMIT_BYTES, strict: true }));

  // Resolve public directory — works in both dev (src/) and prod (dist/) layouts
  const candidates = [
    join(__dirname, 'public'),                              // dev: src/dashboard/public (unbundled)
    join(__dirname, 'dashboard', 'public'),                 // prod: dist/dashboard/public (tsup bundles to dist/index.js)
    join(__dirname, '..', '..', 'src', 'dashboard', 'public'), // fallback: relative to server/ root
  ];
  const publicDir = candidates.find((p) => existsSync(p)) ?? candidates[0];
  logger.info('Dashboard', `Serving static files from: ${publicDir}`);
  app.use(express.static(publicDir));

  app.get('/api/memory', (_req, res) => {
    res.json(memoryStore.getAll());
  });

  app.get('/api/runs', (_req, res) => {
    res.json(sm.getAllRuns());
  });

  app.get('/api/runs/:runId/messages', (req, res) => {
    res.json(bus.getAllMessages(req.params.runId));
  });

  app.post('/api/runs/:runId/control', async (req, res) => {
    try {
      enforceMutationOrigin(req);
      if (!req.is('application/json')) {
        throw new ControlRequestError(400, 'unsupported_content_type', 'Content-Type must be application/json');
      }

      const runId = req.params.runId;
      if (!UUID_PATTERN.test(runId)) {
        throw new ControlRequestError(400, 'invalid_run_id', 'runId must be a UUID');
      }
      const existing = sm.getRun(runId);
      if (!existing) {
        throw new ControlRequestError(404, 'target_not_found', `Run ${runId} not found`);
      }

      const body = parseControlBody(req.body as unknown, runId);
      if (body.target.kind === 'step') {
        const stepId = body.target.stepId;
        if (!existing.steps.some((step) => step.step.id === stepId)) {
          throw new ControlRequestError(404, 'target_not_found', `Step ${stepId} not found in run ${runId}`);
        }
      }
      const replayed = existing.lifecycle?.commandReceipts.some((receipt) => receipt.commandId === body.commandId) ?? false;

      let receipt;
      try {
        persistence.assertHealthy();
        receipt = sm.executeControl(runId, {
          action: body.action,
          target: body.target,
          commandId: body.commandId,
          expectedRevision: body.expectedRevision,
          ...(body.reason === undefined ? {} : { summary: body.reason }),
        });
        await persistence.barrier();
      } catch (err) {
        throw stateMachineError(err);
      }

      res.json({
        success: true,
        replayed,
        receipt,
        run: sm.getRun(runId),
      });
    } catch (err) {
      const responseError = err instanceof ControlRequestError ? err : stateMachineError(err);
      res.status(responseError.status).json({
        error: {
          code: responseError.code,
          message: responseError.message,
        },
      });
    }
  });

  app.post('/api/guidance', async (req, res) => {
    const { runId, body } = req.body;
    if (!runId || !body) {
      res.status(400).json({ error: 'runId and body required' });
      return;
    }
    if (!sm.getRun(runId)) {
      res.status(404).json({ error: `Run ${runId} not found` });
      return;
    }
    try {
      persistence.assertHealthy();
      bus.post({ runId, from: 'user', to: 'coordinator', type: 'guidance', body });
      await persistence.barrier();
      res.json({ success: true });
    } catch (err) {
      if (err instanceof PersistenceUnavailableError) {
        res.status(503).json({ error: { code: err.code, message: err.message } });
        return;
      }
      logger.error('Dashboard', 'Failed to post guidance message');
      res.status(500).json({ error: 'Failed to post message' });
    }
  });

  const jsonErrorHandler: ErrorRequestHandler = (err, _req, res, next) => {
    if (err instanceof Error && 'type' in err) {
      const type = String((err as Error & { type?: string }).type);
      const code = type === 'entity.too.large' ? 'body_too_large' : 'malformed_json';
      const message = type === 'entity.too.large'
        ? `JSON request body must not exceed ${JSON_BODY_LIMIT_BYTES} bytes`
        : 'Request body contains malformed JSON';
      res.status(400).json({ error: { code, message } });
      return;
    }
    next(err);
  };
  app.use(jsonErrorHandler);

  const httpServer = createServer(app);
  const wss = new WebSocketServer({
    server: httpServer,
    // Browsers do not apply CORS to WebSocket connections — reject upgrades
    // from non-localhost origins so arbitrary web pages cannot read the event
    // stream. Connections without an Origin header (non-browser clients) pass.
    verifyClient: ({ origin }: { origin?: string }) => {
      if (isAllowedWsOrigin(origin)) return true;
      logger.warn('Dashboard', 'Rejected WebSocket upgrade from disallowed origin', { origin: String(origin) });
      return false;
    },
  });

  function broadcast(event: DashboardEvent) {
    const data = JSON.stringify(event);
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    }
  }

  const onMessage = (message: Message) => {
    broadcast({ type: 'new_message', message });
  };

  const onStateUpdate = (run: RunState) => {
    broadcast({ type: 'state_update', run });
  };

  const onEntryChange = (entry: MemoryEntry) => {
    broadcast({ type: 'memory_entry_update', entry });
  };

  const onEntryDelete = (entry: MemoryEntry) => {
    broadcast({ type: 'memory_entry_delete', entry });
  };

  bus.on('message', onMessage);
  sm.on('state_update', onStateUpdate);
  memoryStore.on('entry_change', onEntryChange);
  memoryStore.on('entry_delete', onEntryDelete);

  httpServer.once('close', () => {
    bus.off('message', onMessage);
    sm.off('state_update', onStateUpdate);
    memoryStore.off('entry_change', onEntryChange);
    memoryStore.off('entry_delete', onEntryDelete);
  });

  return new Promise<number>((resolve, reject) => {
    httpServer.once('error', reject);
    // Loopback only — this server has no authentication, and /api/guidance
    // injects messages the coordinator treats as user input. Never bind wider.
    httpServer.listen(0, '127.0.0.1', () => {
      httpServer.off('error', reject);
      const addr = httpServer.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      logger.info('Dashboard', `Listening on http://localhost:${port}`);
      resolve(port);
    });
  });
}
