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
