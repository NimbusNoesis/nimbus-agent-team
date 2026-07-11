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
import WebSocket, { WebSocketServer } from 'ws';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import type { StateMachine } from '../state/machine.js';
import type { MessageBus } from '../bus/message-bus.js';
import type { MemoryStore } from '../memory/store.js';
import type { DashboardEvent, Message, RunState, MemoryEntry } from '../types.js';
import { logger } from '../logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Hostnames allowed to originate browser WebSocket connections. Exact match only —
// substring/startsWith matching would let e.g. http://localhost.evil.example through.
// Node's WHATWG URL keeps IPv6 brackets in `hostname` ('[::1]'), but include the
// bare form too for safety across parsers.
const ALLOWED_WS_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

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
): Promise<number> {
  const app = express();

  // Security headers
  app.use((_req, res, next) => {
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws://localhost:* ws://127.0.0.1:* wss://localhost:* wss://127.0.0.1:*; img-src 'self' data:");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    next();
  });

  app.use(express.json());

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

  app.post('/api/guidance', (req, res) => {
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
      bus.post({ runId, from: 'user', to: 'coordinator', type: 'guidance', body });
      res.json({ success: true });
    } catch (err) {
      logger.error('Dashboard', 'Failed to post guidance message', { error: String(err) });
      res.status(500).json({ error: 'Failed to post message' });
    }
  });

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
