import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import WebSocket from 'ws';
import { Database } from '../src/db/database.js';
import { StateMachine } from '../src/state/machine.js';
import { MessageBus } from '../src/bus/message-bus.js';
import { MemoryStore } from '../src/memory/store.js';
import { startDashboard } from '../src/dashboard/server.js';
import { makeWorktree } from './helpers.js';
import { PersistQueue, PersistenceUnavailableError } from '../src/state/persist-queue.js';
import { logger } from '../src/logger.js';
import { ToolRegistry } from '../src/tools/registry.js';

describe('Dashboard server', () => {
  let sm: StateMachine;
  let bus: MessageBus;
  let memoryStore: MemoryStore;
  let port: number;
  let baseUrl: string;

  beforeAll(async () => {
    const db = await Database.create();
    sm = new StateMachine(db);
    bus = new MessageBus(db);
    memoryStore = new MemoryStore(db);
    port = await startDashboard(sm, bus, memoryStore);
    baseUrl = `http://localhost:${port}`;
  });

  describe('Security headers', () => {
    it('sets Content-Security-Policy header', async () => {
      const res = await fetch(`${baseUrl}/api/runs`);
      expect(res.headers.get('content-security-policy')).toContain("default-src 'self'");
    });

    it('restricts connect-src to localhost WebSocket origins (no bare ws:/wss:)', async () => {
      const res = await fetch(`${baseUrl}/api/runs`);
      const csp = res.headers.get('content-security-policy') ?? '';
      const connectSrc = csp
        .split(';')
        .map((d) => d.trim())
        .find((d) => d.startsWith('connect-src'));
      expect(connectSrc).toBe(
        "connect-src 'self' ws://localhost:* ws://127.0.0.1:* wss://localhost:* wss://127.0.0.1:*",
      );
      // No token may be a bare scheme wildcard allowing arbitrary hosts
      const tokens = connectSrc!.split(/\s+/).slice(1);
      expect(tokens).not.toContain('ws:');
      expect(tokens).not.toContain('wss:');
    });

    it('sets X-Content-Type-Options to nosniff', async () => {
      const res = await fetch(`${baseUrl}/api/runs`);
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    });

    it('sets X-Frame-Options to DENY', async () => {
      const res = await fetch(`${baseUrl}/api/runs`);
      expect(res.headers.get('x-frame-options')).toBe('DENY');
    });
  });

  describe('GET /api/runs', () => {
    it('returns empty array when no runs exist', async () => {
      const res = await fetch(`${baseUrl}/api/runs`);
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data).toEqual([]);
    });

    it('returns runs after creating one', async () => {
      sm.createRun([{
        id: 1, description: 'S1', files: [], acceptanceCriteria: [], dependsOn: [],
      }], 'Test task');
      const res = await fetch(`${baseUrl}/api/runs`);
      const data = await res.json();
      expect(data.length).toBeGreaterThanOrEqual(1);
      expect(data[0].task).toBe('Test task');
    });
  });

  describe('GET /api/runs/:runId/messages', () => {
    it('returns empty array for unknown runId', async () => {
      const res = await fetch(`${baseUrl}/api/runs/nonexistent/messages`);
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data).toEqual([]);
    });

    it('returns messages after posting one', async () => {
      const run = sm.createRun([{
        id: 1, description: 'S1', files: [], acceptanceCriteria: [], dependsOn: [],
      }]);
      bus.post({ runId: run.id, from: 'coder', to: 'all', type: 'info', body: 'test message' });
      const res = await fetch(`${baseUrl}/api/runs/${run.id}/messages`);
      const data = await res.json();
      expect(data).toHaveLength(1);
      expect(data[0].body).toBe('test message');
    });
  });

  describe('GET /api/memory', () => {
    it('returns entries after writing memory', async () => {
      memoryStore.write({ key: 'api-test', namespace: 'decisions', value: 'Use REST' });
      const res = await fetch(`${baseUrl}/api/memory`);
      const data = await res.json();
      expect(data.some((e: any) => e.key === 'api-test')).toBe(true);
    });
  });

  describe('POST /api/guidance', () => {
    it('posts a guidance message and returns success', async () => {
      const run = sm.createRun([{
        id: 1, description: 'S1', files: [], acceptanceCriteria: [], dependsOn: [],
      }]);
      const res = await fetch(`${baseUrl}/api/guidance`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runId: run.id, body: 'Focus on testing' }),
      });
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data.success).toBe(true);
    });

    it('returns 400 when runId is missing', async () => {
      const res = await fetch(`${baseUrl}/api/guidance`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: 'no run id' }),
      });
      expect(res.status).toBe(400);
    });

    it('returns 400 when body is missing', async () => {
      const res = await fetch(`${baseUrl}/api/guidance`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runId: 'r1' }),
      });
      expect(res.status).toBe(400);
    });

    it('returns 404 for an unknown runId instead of orphaning the message', async () => {
      const res = await fetch(`${baseUrl}/api/guidance`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runId: 'no-such-run', body: 'hello?' }),
      });
      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/runs/:runId/control', () => {
    type ControlTarget = { kind: 'run' } | { kind: 'step'; stepId: number };

    function createControlRun() {
      return sm.createRun([{
        id: 1,
        description: 'Controlled step',
        files: ['controlled.ts'],
        acceptanceCriteria: [],
        dependsOn: [],
      }]);
    }

    function bodyFor(
      runId: string,
      action: string,
      target: ControlTarget,
      expectedRevision = 0,
      overrides: Record<string, unknown> = {},
    ) {
      const destructive = action === 'cancel_run' || action === 'cancel_step';
      return {
        action,
        target,
        commandId: randomUUID(),
        expectedRevision,
        ...(destructive ? {
          reason: 'Operator requested cancellation',
          confirmation: target.kind === 'run'
            ? `cancel run ${runId}`
            : `cancel step ${runId}/${target.stepId}`,
        } : {}),
        ...overrides,
      };
    }

    async function postControl(
      runId: string,
      body: unknown,
      headers: Record<string, string> = {},
    ) {
      return fetch(`${baseUrl}/api/runs/${runId}/control`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      });
    }

    function activateStep(runId: string): void {
      sm.setWorktree(runId, 1, makeWorktree(runId, 1));
      sm.startStep(runId, 1, 'coder');
    }

    function escalateStep(runId: string): void {
      activateStep(runId);
      for (let attempt = 0; attempt < 4; attempt += 1) {
        sm.submitResult(runId, 1, { status: 'done', summary: `coder ${attempt}` });
        sm.submitResult(runId, 1, { status: 'needs_revision', summary: `review ${attempt}` });
        sm.requestRevision(runId, 1);
      }
    }

    it('applies pause and resume, and reports an identical command replay without a second mutation', async () => {
      const run = createControlRun();
      const pauseBody = bodyFor(run.id, 'pause_run', { kind: 'run' });
      const first = await postControl(run.id, pauseBody);
      expect(first.status).toBe(200);
      expect(await first.json()).toMatchObject({
        success: true,
        replayed: false,
        receipt: { action: 'pause_run', revision: 1, outcome: { controlPhase: 'paused' } },
        run: { lifecycle: { revision: 1, controlPhase: 'paused' } },
      });

      const replay = await postControl(run.id, pauseBody);
      expect(replay.status).toBe(200);
      expect(await replay.json()).toMatchObject({ success: true, replayed: true, receipt: { revision: 1 } });
      expect(sm.getRun(run.id)?.lifecycle?.history).toHaveLength(1);

      const resume = await postControl(run.id, bodyFor(run.id, 'resume_run', { kind: 'run' }, 1));
      expect(resume.status).toBe(200);
      expect(await resume.json()).toMatchObject({ receipt: { outcome: { controlPhase: 'none' }, revision: 2 } });
    });

    it('supports coordinator pause acknowledgement for a draining active worker', async () => {
      const run = createControlRun();
      activateStep(run.id);

      const pause = await postControl(run.id, bodyFor(run.id, 'pause_run', { kind: 'run' }));
      expect(await pause.json()).toMatchObject({ receipt: { outcome: { controlPhase: 'pausing' } } });

      const acknowledgement = await postControl(
        run.id,
        bodyFor(run.id, 'acknowledge_pause', { kind: 'run' }, 1),
      );
      expect(acknowledgement.status).toBe(200);
      expect(await acknowledgement.json()).toMatchObject({ receipt: { outcome: { controlPhase: 'paused' } } });
    });

    it('cancels a pending step with exact confirmation and preserves the reason in audit history', async () => {
      const run = createControlRun();
      const response = await postControl(run.id, bodyFor(run.id, 'cancel_step', { kind: 'step', stepId: 1 }));
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        receipt: { action: 'cancel_step', outcome: { stepStatus: 'cancelled' } },
      });
      expect(sm.getRun(run.id)?.lifecycle?.history[0]).toMatchObject({
        action: 'cancel_step',
        summary: 'Operator requested cancellation',
      });
    });

    it('cancels and acknowledges active step and run targets', async () => {
      const stepRun = createControlRun();
      activateStep(stepRun.id);
      const cancelStep = await postControl(
        stepRun.id,
        bodyFor(stepRun.id, 'cancel_step', { kind: 'step', stepId: 1 }),
      );
      expect(await cancelStep.json()).toMatchObject({ receipt: { outcome: { stepStatus: 'cancelling' } } });
      const acknowledgeStep = await postControl(
        stepRun.id,
        bodyFor(stepRun.id, 'acknowledge_cancel', { kind: 'step', stepId: 1 }, 1),
      );
      expect(await acknowledgeStep.json()).toMatchObject({ receipt: { outcome: { stepStatus: 'cancelled' } } });

      const run = createControlRun();
      activateStep(run.id);
      const cancelRun = await postControl(run.id, bodyFor(run.id, 'cancel_run', { kind: 'run' }));
      expect(await cancelRun.json()).toMatchObject({ receipt: { outcome: { controlPhase: 'cancelling' } } });
      const acknowledgeRun = await postControl(
        run.id,
        bodyFor(run.id, 'acknowledge_cancel', { kind: 'run' }, 1),
      );
      expect(await acknowledgeRun.json()).toMatchObject({
        receipt: { outcome: { controlPhase: 'cancelled', runStatus: 'cancelled' } },
      });
    });

    it('retries an escalated step through the authoritative state machine', async () => {
      const run = createControlRun();
      escalateStep(run.id);
      expect(sm.getRun(run.id)?.steps[0].status).toBe('escalated');

      const response = await postControl(run.id, bodyFor(run.id, 'retry_step', { kind: 'step', stepId: 1 }));
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        receipt: { action: 'retry_step', outcome: { stepStatus: 'coding' } },
        run: { steps: [{ status: 'coding', manualAttempt: 1 }] },
      });
    });

    it('returns structured 404, revision, command, and phase conflicts without extra mutations', async () => {
      const invalidRun = await postControl('not-a-uuid', bodyFor(randomUUID(), 'pause_run', { kind: 'run' }));
      expect(invalidRun.status).toBe(400);
      expect(await invalidRun.json()).toMatchObject({ error: { code: 'invalid_run_id' } });

      const unknown = randomUUID();
      const missingRun = await postControl(unknown, bodyFor(unknown, 'pause_run', { kind: 'run' }));
      expect(missingRun.status).toBe(404);
      expect(await missingRun.json()).toMatchObject({ error: { code: 'target_not_found' } });

      const run = createControlRun();
      const missingStep = await postControl(run.id, bodyFor(run.id, 'retry_step', { kind: 'step', stepId: 999 }));
      expect(missingStep.status).toBe(404);

      const invalidPhase = await postControl(run.id, bodyFor(run.id, 'resume_run', { kind: 'run' }));
      expect(invalidPhase.status).toBe(409);
      expect(await invalidPhase.json()).toMatchObject({ error: { code: 'invalid_phase' } });

      const pauseBody = bodyFor(run.id, 'pause_run', { kind: 'run' });
      expect((await postControl(run.id, pauseBody)).status).toBe(200);
      const stale = await postControl(run.id, bodyFor(run.id, 'resume_run', { kind: 'run' }, 0));
      expect(stale.status).toBe(409);
      expect(await stale.json()).toMatchObject({ error: { code: 'revision_conflict' } });

      const mismatchedReplay = await postControl(run.id, { ...pauseBody, reason: 'different payload' });
      expect(mismatchedReplay.status).toBe(409);
      expect(await mismatchedReplay.json()).toMatchObject({ error: { code: 'command_conflict' } });
      expect(sm.getRun(run.id)?.lifecycle).toMatchObject({ revision: 1, history: [{ action: 'pause_run' }] });
    });

    it('rejects malformed fields, targets, reasons, and confirmations before delegation', async () => {
      const run = createControlRun();
      const valid = bodyFor(run.id, 'pause_run', { kind: 'run' });
      const cases: Array<{ body: unknown; code: string }> = [
        { body: { ...valid, unexpected: true }, code: 'unknown_fields' },
        { body: { ...valid, action: 'explode_run' }, code: 'invalid_action' },
        { body: { ...valid, action: undefined }, code: 'invalid_action' },
        { body: { ...valid, commandId: 'not-a-uuid' }, code: 'invalid_command_id' },
        { body: { ...valid, commandId: undefined }, code: 'invalid_command_id' },
        { body: { ...valid, expectedRevision: -1 }, code: 'invalid_revision' },
        { body: { ...valid, expectedRevision: 1.5 }, code: 'invalid_revision' },
        { body: { ...valid, expectedRevision: undefined }, code: 'invalid_revision' },
        { body: { ...valid, target: { kind: 'run', extra: true } }, code: 'unknown_fields' },
        { body: { ...valid, target: { kind: 'step', stepId: 0 } }, code: 'invalid_step_id' },
        { body: { ...valid, target: { kind: 'step', stepId: 1 } }, code: 'target_mismatch' },
        { body: { ...valid, reason: '' }, code: 'invalid_reason' },
        { body: { ...valid, reason: 'x'.repeat(501) }, code: 'invalid_reason' },
        { body: { ...valid, confirmation: 'unused' }, code: 'unexpected_confirmation' },
        {
          body: bodyFor(run.id, 'cancel_run', { kind: 'run' }, 0, { reason: undefined }),
          code: 'reason_required',
        },
        {
          body: bodyFor(run.id, 'cancel_run', { kind: 'run' }, 0, { confirmation: 'cancel the wrong run' }),
          code: 'confirmation_mismatch',
        },
        {
          body: bodyFor(run.id, 'cancel_step', { kind: 'step', stepId: 1 }, 0, {
            confirmation: `cancel step ${run.id}/2`,
          }),
          code: 'confirmation_mismatch',
        },
      ];
      const execute = vi.spyOn(sm, 'executeControl');

      for (const testCase of cases) {
        const response = await postControl(run.id, testCase.body);
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ error: { code: testCase.code } });
      }
      expect(execute).not.toHaveBeenCalled();
      expect(sm.getRun(run.id)?.lifecycle?.revision).toBe(0);
      execute.mockRestore();
    });

    it('requires application/json and rejects malformed or oversized JSON side-effect-free', async () => {
      const run = createControlRun();
      const execute = vi.spyOn(sm, 'executeControl');

      const wrongType = await fetch(`${baseUrl}/api/runs/${run.id}/control`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: '{}',
      });
      expect(wrongType.status).toBe(400);
      expect(await wrongType.json()).toMatchObject({ error: { code: 'unsupported_content_type' } });

      const malformed = await postControl(run.id, '{"action":');
      expect(malformed.status).toBe(400);
      expect(await malformed.json()).toMatchObject({ error: { code: 'malformed_json' } });

      const oversized = await postControl(run.id, JSON.stringify({ padding: 'x'.repeat(17 * 1024) }));
      expect(oversized.status).toBe(400);
      expect(await oversized.json()).toMatchObject({ error: { code: 'body_too_large' } });

      expect(execute).not.toHaveBeenCalled();
      expect(sm.getRun(run.id)?.lifecycle?.revision).toBe(0);
      execute.mockRestore();
    });

    it('allows no-Origin local clients and exact same-origin browsers only', async () => {
      const noOriginRun = createControlRun();
      expect((await postControl(noOriginRun.id, bodyFor(noOriginRun.id, 'pause_run', { kind: 'run' }))).status).toBe(200);

      const browserRun = createControlRun();
      expect((await postControl(
        browserRun.id,
        bodyFor(browserRun.id, 'pause_run', { kind: 'run' }),
        { Origin: baseUrl },
      )).status).toBe(200);

      for (const origin of ['http://evil.example', 'http://localhost:1', 'null', 'not a url']) {
        const run = createControlRun();
        const execute = vi.spyOn(sm, 'executeControl');
        const response = await postControl(
          run.id,
          bodyFor(run.id, 'pause_run', { kind: 'run' }),
          { Origin: origin },
        );
        expect(response.status).toBe(403);
        expect(await response.json()).toMatchObject({ error: { code: 'invalid_origin' } });
        expect(execute).not.toHaveBeenCalled();
        execute.mockRestore();
      }

      const hostRun = createControlRun();
      const hostBody = JSON.stringify(bodyFor(hostRun.id, 'pause_run', { kind: 'run' }));
      const invalidHost = await new Promise<{ status: number; body: unknown }>((resolve, reject) => {
        const req = httpRequest({
          hostname: '127.0.0.1',
          port,
          path: `/api/runs/${hostRun.id}/control`,
          method: 'POST',
          headers: {
            Host: 'evil.example',
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(hostBody),
          },
        }, (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
          response.on('end', () => resolve({
            status: response.statusCode ?? 0,
            body: JSON.parse(Buffer.concat(chunks).toString()),
          }));
        });
        req.on('error', reject);
        req.end(hostBody);
      });
      expect(invalidHost.status).toBe(403);
      expect(invalidHost.body).toMatchObject({ error: { code: 'invalid_origin' } });
      expect(sm.getRun(hostRun.id)?.lifecycle?.revision).toBe(0);
    });
  });

  describe('WebSocket origin allowlist', () => {
    /** Opens a WS connection, resolving on 'open' and rejecting on 'error'. */
    function tryConnect(origin?: string): Promise<WebSocket> {
      return new Promise((resolve, reject) => {
        const ws = new WebSocket(
          `ws://localhost:${port}`,
          origin === undefined ? {} : { headers: { Origin: origin } },
        );
        ws.on('open', () => resolve(ws));
        ws.on('error', (err) => reject(err));
      });
    }

    async function expectAccepted(origin?: string): Promise<void> {
      const ws = await tryConnect(origin);
      ws.close();
    }

    async function expectRejected(origin: string): Promise<void> {
      await expect(tryConnect(origin)).rejects.toThrow();
    }

    it('accepts connections with no Origin header', async () => {
      await expectAccepted(undefined);
    });

    it('accepts http://localhost with the server port', async () => {
      await expectAccepted(`http://localhost:${port}`);
    });

    it('accepts localhost and 127.0.0.1 origins on any port, http and https', async () => {
      await expectAccepted('http://localhost:3000');
      await expectAccepted('https://localhost:8443');
      await expectAccepted('http://127.0.0.1:5173');
      await expectAccepted('https://127.0.0.1:9999');
      await expectAccepted('http://localhost');
      await expectAccepted('http://127.0.0.1');
    });

    it('rejects a cross-origin Origin header', async () => {
      await expectRejected('http://evil.example');
    });

    it('rejects hostnames that merely start with localhost', async () => {
      await expectRejected('http://localhost.evil.example');
      await expectRejected('http://localhost.evil.example:3000');
      await expectRejected('http://127.0.0.1.evil.example');
    });

    it('rejects non-http(s) and malformed Origin values', async () => {
      await expectRejected('ftp://localhost');
      await expectRejected('not a url');
    });

    it('still receives broadcasts on a connection with an allowed Origin', async () => {
      const ws = await tryConnect(`http://localhost:${port}`);
      try {
        const msgPromise = new Promise<any>((resolve) => {
          ws.once('message', (data) => resolve(JSON.parse(data.toString())));
        });
        sm.createRun([{
          id: 1, description: 'Origin WS test', files: [], acceptanceCriteria: [], dependsOn: [],
        }]);
        const event = await msgPromise;
        expect(event.type).toBe('state_update');
      } finally {
        ws.close();
      }
    });
  });

  describe('WebSocket broadcast', () => {
    function connectWs(): Promise<WebSocket> {
      return new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://localhost:${port}`);
        ws.on('open', () => resolve(ws));
        ws.on('error', reject);
      });
    }

    function waitForMessage(ws: WebSocket): Promise<any> {
      return new Promise((resolve) => {
        ws.once('message', (data) => resolve(JSON.parse(data.toString())));
      });
    }

    it('broadcasts state_update when state machine emits', async () => {
      const ws = await connectWs();
      try {
        const msgPromise = waitForMessage(ws);
        sm.createRun([{
          id: 1, description: 'WS test', files: [], acceptanceCriteria: [], dependsOn: [],
        }]);
        const event = await msgPromise;
        expect(event.type).toBe('state_update');
        expect(event.run).toBeDefined();
      } finally {
        ws.close();
      }
    });

    it('broadcasts new_message when message bus emits', async () => {
      // Create run before connecting WS to avoid needing to drain state_update
      const run = sm.createRun([{
        id: 1, description: 'S1', files: [], acceptanceCriteria: [], dependsOn: [],
      }]);
      const ws = await connectWs();
      try {
        const msgPromise = waitForMessage(ws);
        bus.post({ runId: run.id, from: 'test', to: 'all', type: 'info', body: 'ws broadcast test' });
        const event = await msgPromise;
        expect(event.type).toBe('new_message');
        expect(event.message.body).toBe('ws broadcast test');
      } finally {
        ws.close();
      }
    });

    it('broadcasts memory_entry_update when memory store emits', async () => {
      // createRun emits state_update, so create the run first
      sm.createRun([{
        id: 1, description: 'S1', files: [], acceptanceCriteria: [], dependsOn: [],
      }]);
      const ws = await connectWs();
      try {
        const msgPromise = waitForMessage(ws);
        memoryStore.write({ key: 'ws-test', namespace: 'decisions', value: 'broadcast' });
        const event = await msgPromise;
        expect(event.type).toBe('memory_entry_update');
        expect(event.entry.key).toBe('ws-test');
      } finally {
        ws.close();
      }
    });
  });
});

describe('Dashboard persistence health', () => {
  it('fails a volatile control response, blocks later control and guidance, and keeps reads available', async () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    try {
      const db = await Database.create();
      const sm = new StateMachine(db);
      const bus = new MessageBus(db);
      const memory = new MemoryStore(db);
      const persistence = new PersistQueue();
      const run = sm.createRun([{
        id: 1, description: 'Durability test', files: [], acceptanceCriteria: [], dependsOn: [],
      }]);
      let failNextWrite = true;
      sm.on('state_update', (updated) => {
        persistence.enqueue(async () => {
          if (failNextWrite) {
            failNextWrite = false;
            throw new Error('private persistence details');
          }
        }, { kind: 'run_state', runId: updated.id });
      });
      const port = await startDashboard(sm, bus, memory, persistence);
      const baseUrl = `http://localhost:${port}`;

      const first = await fetch(`${baseUrl}/api/runs/${run.id}/control`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'pause_run',
          target: { kind: 'run' },
          commandId: randomUUID(),
          expectedRevision: 0,
        }),
      });
      expect(first.status).toBe(503);
      expect(await first.json()).toMatchObject({
        error: { code: 'persistence_failed' },
      });
      expect(sm.getRun(run.id)?.lifecycle).toMatchObject({ revision: 1, controlPhase: 'paused' });

      const historyLength = sm.getRun(run.id)!.lifecycle!.history.length;
      const laterControl = await fetch(`${baseUrl}/api/runs/${run.id}/control`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'resume_run',
          target: { kind: 'run' },
          commandId: randomUUID(),
          expectedRevision: 1,
        }),
      });
      expect(laterControl.status).toBe(503);
      expect(sm.getRun(run.id)!.lifecycle!.history).toHaveLength(historyLength);

      const guidance = await fetch(`${baseUrl}/api/guidance`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runId: run.id, body: 'must not be inserted' }),
      });
      expect(guidance.status).toBe(503);
      expect(await guidance.json()).toMatchObject({ error: { code: 'persistence_failed' } });
      expect(bus.getAllMessages(run.id)).toEqual([]);

      const reads = await fetch(`${baseUrl}/api/runs`);
      expect(reads.status).toBe(200);
      expect(await reads.json()).toHaveLength(1);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('shares one mutation admission lane between dashboard and MCP requests', async () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    try {
      const db = await Database.create();
      const sm = new StateMachine(db);
      const bus = new MessageBus(db);
      const memory = new MemoryStore(db);
      const persistence = new PersistQueue();
      const registry = new ToolRegistry(sm, bus, memory, persistence);
      const run = sm.createRun([{
        id: 1, description: 'Cross-surface race', files: [], acceptanceCriteria: [], dependsOn: [],
      }]);
      let observeGuidance!: () => void;
      const guidanceObserved = new Promise<void>((resolve) => { observeGuidance = resolve; });
      let releaseFailure!: () => void;
      const failureGate = new Promise<void>((resolve) => { releaseFailure = resolve; });

      bus.on('message', (message) => {
        observeGuidance();
        persistence.enqueue(async () => {
          await failureGate;
          throw new Error('private cross-surface failure');
        }, { kind: 'message', runId: message.runId });
      });

      const port = await startDashboard(sm, bus, memory, persistence);
      const dashboardMutation = fetch(`http://localhost:${port}/api/guidance`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runId: run.id, body: 'volatile dashboard mutation' }),
      });
      await guidanceObserved;

      const mcpMutation = registry.handle('team_memory_write', {
        key: 'must-not-exist', namespace: 'decisions', value: 'blocked by shared lane',
      });
      const mcpOutcome = mcpMutation.then(
        () => undefined,
        (err: unknown) => err,
      );
      releaseFailure();

      const dashboardResponse = await dashboardMutation;
      expect(dashboardResponse.status).toBe(503);
      expect(await mcpOutcome).toBeInstanceOf(PersistenceUnavailableError);
      expect(bus.getAllMessages(run.id)).toHaveLength(1);
      expect(memory.getAll()).toEqual([]);
    } finally {
      errorSpy.mockRestore();
    }
  });
});
