import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import WebSocket from 'ws';
import { Database } from '../src/db/database.js';
import { StateMachine } from '../src/state/machine.js';
import { MessageBus } from '../src/bus/message-bus.js';
import { MemoryStore } from '../src/memory/store.js';
import { startDashboard } from '../src/dashboard/server.js';

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
