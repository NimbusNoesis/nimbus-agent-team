import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import NodeWebSocket from 'ws';
import {
  allRuns, currentRun, messages, memoryEntries, loadingRunId,
  connectionStatus, dataFreshness, getControlAvailability,
} from '../src/dashboard/client/state/store';
import type { RunState, MemoryEntry } from '../src/dashboard/client/state/store';
import { Database } from '../src/db/database.js';
import { StateMachine } from '../src/state/machine.js';
import { MessageBus } from '../src/bus/message-bus.js';
import { MemoryStore } from '../src/memory/store.js';
import { startDashboard } from '../src/dashboard/server.js';

// Mock WebSocket and fetch for the websocket module
let wsInstances: MockWebSocket[] = [];

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  readyState: number = MockWebSocket.CONNECTING;
  closed = false;

  constructor(_url: string) {
    wsInstances.push(this);
  }

  close() {
    this.closed = true;
    this.readyState = MockWebSocket.CLOSED;
  }

  simulateMessage(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
}

vi.stubGlobal('WebSocket', MockWebSocket);
vi.stubGlobal('location', { protocol: 'http:', host: 'localhost:3000' });

// Import after mocks are set
const { connectWebSocket } = await import('../src/dashboard/client/state/websocket');

function makeRun(id: string, status: RunState['status'] = 'in_progress'): RunState {
  return {
    id, status, steps: [],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:01:00Z',
  };
}

function controlledRun(id: string, revision: number, status: RunState['status'] = 'in_progress'): RunState {
  return {
    ...makeRun(id, status),
    lifecycle: {
      version: 2,
      capabilities: {
        pause_run: true, resume_run: true, cancel_run: true, cancel_step: true,
        retry_step: true, acknowledge_pause: true, acknowledge_cancel: true,
      },
      controlPhase: 'none', revision, commandReceipts: [], history: [],
    },
  };
}

beforeEach(() => {
  // Release the module-level single-flight guard in websocket.ts: mark every
  // socket from the previous test as CLOSED so connectWebSocket() opens a
  // fresh one instead of no-opping on a lingering CONNECTING/OPEN mock.
  for (const ws of wsInstances) ws.readyState = MockWebSocket.CLOSED;
  wsInstances = [];
  allRuns.value = [];
  currentRun.value = null;
  messages.value = [];
  memoryEntries.value = [];
  loadingRunId.value = null;
  connectionStatus.value = 'connecting';
  dataFreshness.value = 'loading';
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('WebSocket message handling', () => {
  it('rejects a state update with an older lifecycle revision', () => {
    const newest = controlledRun('r1', 2, 'in_progress');
    newest.updatedAt = '2026-01-01T00:02:00Z';
    allRuns.value = [newest];
    currentRun.value = newest;
    connectWebSocket();

    const older = controlledRun('r1', 1, 'ready');
    older.updatedAt = '2026-01-01T00:03:00Z';
    wsInstances[0].simulateMessage({ type: 'state_update', run: older });

    expect(allRuns.value[0]).toBe(newest);
    expect(currentRun.value?.status).toBe('in_progress');
  });

  it('dedupes and deterministically orders equal-revision audit history', () => {
    const first = controlledRun('r1', 2);
    const entry2 = {
      commandId: 'c2', action: 'pause_run' as const, target: { kind: 'run' as const }, revision: 2,
      recordedAt: '2026-01-01T00:02:00Z', fromPhase: 'none' as const, toPhase: 'paused' as const,
    };
    first.lifecycle!.history = [entry2];
    allRuns.value = [first];
    currentRun.value = first;
    connectWebSocket();

    const equal = controlledRun('r1', 2);
    equal.lifecycle!.history = [entry2, {
      commandId: 'c1', action: 'resume_run', target: { kind: 'run' }, revision: 1,
      recordedAt: '2026-01-01T00:01:00Z', fromPhase: 'paused', toPhase: 'none',
    }];
    wsInstances[0].simulateMessage({ type: 'state_update', run: equal });
    wsInstances[0].simulateMessage({ type: 'state_update', run: equal });

    expect(currentRun.value?.lifecycle?.history.map(entry => entry.commandId)).toEqual(['c1', 'c2']);
  });

  it('handles state_update for new run', () => {
    connectWebSocket();
    const ws = wsInstances[0];
    const run = makeRun('r1');

    ws.simulateMessage({ type: 'state_update', run });

    expect(allRuns.value).toHaveLength(1);
    expect(allRuns.value[0].id).toBe('r1');
  });

  it('handles state_update for existing run', () => {
    allRuns.value = [makeRun('r1')];
    connectWebSocket();
    const ws = wsInstances[0];

    const updatedRun = makeRun('r1', 'complete');
    ws.simulateMessage({ type: 'state_update', run: updatedRun });

    expect(allRuns.value).toHaveLength(1);
    expect(allRuns.value[0].status).toBe('complete');
  });

  it('updates currentRun when matching state_update arrives', () => {
    const run = makeRun('r1');
    currentRun.value = run;
    allRuns.value = [run];
    connectWebSocket();
    const ws = wsInstances[0];

    const updatedRun = makeRun('r1', 'complete');
    ws.simulateMessage({ type: 'state_update', run: updatedRun });

    expect(currentRun.value!.status).toBe('complete');
  });

  it('does not update currentRun for different run', () => {
    currentRun.value = makeRun('r1');
    allRuns.value = [makeRun('r1')];
    connectWebSocket();
    const ws = wsInstances[0];

    ws.simulateMessage({ type: 'state_update', run: makeRun('r2') });

    expect(currentRun.value!.id).toBe('r1');
    expect(currentRun.value!.status).toBe('in_progress');
  });

  it('handles new_message', () => {
    currentRun.value = makeRun('r1');
    connectWebSocket();
    const ws = wsInstances[0];

    const msg = { id: 'm1', runId: 'r1', from: 'coder', to: 'all', type: 'info', body: 'hello', timestamp: '2026-01-01T00:00:00Z' };
    ws.simulateMessage({ type: 'new_message', message: msg });

    expect(messages.value).toHaveLength(1);
    expect(messages.value[0].body).toBe('hello');
  });

  it('buffers new_message while loading instead of dropping it', () => {
    // Live messages that arrive during a run-history fetch must not be lost;
    // selectRun dedupes the buffered messages against the fetched history by id.
    currentRun.value = makeRun('r1');
    loadingRunId.value = 'r1';
    connectWebSocket();
    const ws = wsInstances[0];

    ws.simulateMessage({ type: 'new_message', message: { id: 'm1', runId: 'r1', from: 'coder', to: 'all', type: 'info', body: 'hi', timestamp: '2026-01-01T00:00:00Z' } });

    expect(messages.value).toHaveLength(1);
    expect(messages.value[0].id).toBe('m1');
  });

  it('dedupes new_message by id', () => {
    currentRun.value = makeRun('r1');
    connectWebSocket();
    const ws = wsInstances[0];

    const msg = { id: 'm1', runId: 'r1', from: 'coder', to: 'all', type: 'info', body: 'hi', timestamp: '2026-01-01T00:00:00Z' };
    ws.simulateMessage({ type: 'new_message', message: msg });
    ws.simulateMessage({ type: 'new_message', message: msg });

    expect(messages.value).toHaveLength(1);
  });

  it('ignores new_message for different run', () => {
    currentRun.value = makeRun('r1');
    connectWebSocket();
    const ws = wsInstances[0];

    ws.simulateMessage({ type: 'new_message', message: { id: 'm1', runId: 'r2', from: 'coder', to: 'all', type: 'info', body: 'hi', timestamp: '2026-01-01T00:00:00Z' } });

    expect(messages.value).toHaveLength(0);
  });

  it('handles memory_entry_update for new entry', () => {
    connectWebSocket();
    const ws = wsInstances[0];

    const entry: MemoryEntry = { key: 'arch', namespace: 'decisions', value: 'use preact', updatedAt: '2026-01-01T00:00:00Z' };
    ws.simulateMessage({ type: 'memory_entry_update', entry });

    expect(memoryEntries.value).toHaveLength(1);
    expect(memoryEntries.value[0].value).toBe('use preact');
  });

  it('handles memory_entry_update for existing entry (upsert)', () => {
    memoryEntries.value = [{ key: 'arch', namespace: 'decisions', value: 'old', updatedAt: '2026-01-01T00:00:00Z' }];
    connectWebSocket();
    const ws = wsInstances[0];

    const entry: MemoryEntry = { key: 'arch', namespace: 'decisions', value: 'updated', updatedAt: '2026-01-01T00:01:00Z' };
    ws.simulateMessage({ type: 'memory_entry_update', entry });

    expect(memoryEntries.value).toHaveLength(1);
    expect(memoryEntries.value[0].value).toBe('updated');
  });

  it('handles memory_entry_delete by removing the matching entry', () => {
    memoryEntries.value = [
      { key: 'arch', namespace: 'decisions', value: 'use preact', updatedAt: '2026-01-01T00:00:00Z' },
      { key: 'arch', namespace: 'learnings', value: 'same key, other namespace', updatedAt: '2026-01-01T00:00:00Z' },
    ];
    connectWebSocket();
    const ws = wsInstances[0];

    ws.simulateMessage({
      type: 'memory_entry_delete',
      entry: { key: 'arch', namespace: 'decisions', value: 'use preact', updatedAt: '2026-01-01T00:00:00Z' },
    });

    // Only the namespace+key match is removed — no empty ghost card remains.
    expect(memoryEntries.value).toHaveLength(1);
    expect(memoryEntries.value[0].namespace).toBe('learnings');
  });

  it('memory_entry_delete for an unknown entry leaves the list unchanged', () => {
    memoryEntries.value = [
      { key: 'arch', namespace: 'decisions', value: 'use preact', updatedAt: '2026-01-01T00:00:00Z' },
    ];
    connectWebSocket();
    const ws = wsInstances[0];

    ws.simulateMessage({
      type: 'memory_entry_delete',
      entry: { key: 'no-such-key', namespace: 'decisions', value: '', updatedAt: '2026-01-01T00:00:00Z' },
    });

    expect(memoryEntries.value).toHaveLength(1);
    expect(memoryEntries.value[0].key).toBe('arch');
  });

  it('creates immutable arrays on update (signal reactivity)', () => {
    connectWebSocket();
    const ws = wsInstances[0];

    const before = allRuns.value;
    ws.simulateMessage({ type: 'state_update', run: makeRun('r1') });
    expect(allRuns.value).not.toBe(before);

    const msgBefore = messages.value;
    currentRun.value = makeRun('r1');
    ws.simulateMessage({ type: 'new_message', message: { id: 'm1', runId: 'r1', from: 'x', to: 'y', type: 'info', body: 'z', timestamp: '' } });
    expect(messages.value).not.toBe(msgBefore);
  });

  it('handles malformed JSON gracefully', () => {
    connectWebSocket();
    const ws = wsInstances[0];
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    ws.onmessage?.({ data: 'not json{{{' });

    expect(consoleSpy).toHaveBeenCalledWith('Failed to parse WebSocket message:', expect.any(Error));
    consoleSpy.mockRestore();
  });
});

describe('WebSocket error and reconnection', () => {
  it('onerror calls close on the WebSocket', () => {
    connectWebSocket();
    const ws = wsInstances[0];
    ws.onerror?.();
    expect(ws.closed).toBe(true);
  });

  it('onclose schedules reconnection via setTimeout', () => {
    vi.useFakeTimers();
    connectWebSocket();
    const ws = wsInstances[0];
    expect(wsInstances).toHaveLength(1);

    // Trigger close — should schedule a reconnect after 2000ms
    ws.onclose?.();
    vi.advanceTimersByTime(2000);

    // A new WebSocket instance should have been created
    expect(wsInstances).toHaveLength(2);
    vi.useRealTimers();
  });

  it('reconnection creates a new WebSocket instance', () => {
    vi.useFakeTimers();
    connectWebSocket();
    const ws1 = wsInstances[0];
    ws1.onclose?.();
    vi.advanceTimersByTime(2000);

    const ws2 = wsInstances[1];
    expect(ws2).toBeDefined();
    expect(ws2).not.toBe(ws1);
    vi.useRealTimers();
  });

  it('ignores delayed open from a superseded socket', () => {
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
    connectWebSocket();
    const superseded = wsInstances[0];
    superseded.readyState = MockWebSocket.CLOSED;
    connectWebSocket();

    connectionStatus.value = 'connecting';
    dataFreshness.value = 'stale';
    superseded.onopen?.();

    expect(mockFetch).not.toHaveBeenCalled();
    expect(connectionStatus.value).toBe('connecting');
    expect(dataFreshness.value).toBe('stale');
  });

  it('ignores delayed error and close from a superseded socket', () => {
    vi.useFakeTimers();
    connectWebSocket();
    const superseded = wsInstances[0];
    superseded.readyState = MockWebSocket.CLOSED;
    connectWebSocket();
    const active = wsInstances[1];
    active.readyState = MockWebSocket.OPEN;
    connectionStatus.value = 'online';
    dataFreshness.value = 'fresh';

    superseded.onerror?.();
    superseded.onclose?.();
    vi.advanceTimersByTime(2000);

    expect(superseded.closed).toBe(false);
    expect(wsInstances).toHaveLength(2);
    expect(connectionStatus.value).toBe('online');
    expect(dataFreshness.value).toBe('fresh');
    vi.useRealTimers();
  });
});

describe('WebSocket single-flight guard', () => {
  it('is a no-op while a socket is CONNECTING', () => {
    connectWebSocket();
    expect(wsInstances).toHaveLength(1);

    connectWebSocket();
    connectWebSocket();

    expect(wsInstances).toHaveLength(1);
  });

  it('is a no-op while a socket is OPEN', () => {
    connectWebSocket();
    wsInstances[0].readyState = MockWebSocket.OPEN;

    connectWebSocket();

    expect(wsInstances).toHaveLength(1);
  });

  it('allows reconnection after close, without stacking a second socket from the reconnect timer', () => {
    vi.useFakeTimers();
    connectWebSocket();
    const ws1 = wsInstances[0];

    // Socket dies: guard is released in onclose, so an app-init retry may connect again.
    ws1.readyState = MockWebSocket.CLOSED;
    ws1.onclose?.();
    connectWebSocket();
    expect(wsInstances).toHaveLength(2);

    // The reconnect ws1 scheduled must now be a no-op — otherwise two live
    // sockets would each perpetuate their own reconnect loop forever.
    vi.advanceTimersByTime(2000);
    expect(wsInstances).toHaveLength(2);
    vi.useRealTimers();
  });
});

describe('Dashboard server broadcasts memory_entry_delete', () => {
  it('sends memory_entry_delete with the deleted entry to connected clients', async () => {
    const db = await Database.create();
    const sm = new StateMachine(db);
    const bus = new MessageBus(db);
    const memoryStore = new MemoryStore(db);
    const port = await startDashboard(sm, bus, memoryStore);

    // Write before connecting so the entry_change broadcast isn't received.
    memoryStore.write({ key: 'doomed', namespace: 'reflections', value: 'to be removed', runId: 'r1' });
    const written = memoryStore.read('reflections', 'doomed')!;

    const ws = await new Promise<NodeWebSocket>((resolve, reject) => {
      const socket = new NodeWebSocket(`ws://localhost:${port}`);
      socket.on('open', () => resolve(socket));
      socket.on('error', reject);
    });
    try {
      const msgPromise = new Promise<any>((resolve) => {
        ws.once('message', (data) => resolve(JSON.parse(data.toString())));
      });
      memoryStore.delete('reflections', 'doomed');
      const event = await msgPromise;

      expect(event.type).toBe('memory_entry_delete');
      // Payload is the entry as it existed: original value and updatedAt,
      // not blanked or re-stamped.
      expect(event.entry).toEqual({
        key: 'doomed',
        namespace: 'reflections',
        value: 'to be removed',
        runId: 'r1',
        updatedAt: written.updatedAt,
      });
    } finally {
      ws.close();
    }
  });
});

describe('WebSocket onopen sync', () => {
  it('does not let a reconnect snapshot overwrite a newer WS revision', async () => {
    const initial = controlledRun('r1', 0);
    allRuns.value = [initial];
    currentRun.value = initial;
    let resolveRuns!: (value: unknown) => void;
    const mockFetch = vi.fn()
      .mockReturnValueOnce(new Promise(resolve => { resolveRuns = resolve; }))
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([]) });
    vi.stubGlobal('fetch', mockFetch);

    connectWebSocket();
    const ws = wsInstances[0];
    ws.onopen?.();
    const live = controlledRun('r1', 2, 'complete');
    live.updatedAt = '2026-01-01T00:03:00Z';
    ws.simulateMessage({ type: 'state_update', run: live });

    const staleSnapshot = controlledRun('r1', 1, 'ready');
    staleSnapshot.updatedAt = '2026-01-01T00:04:00Z';
    resolveRuns({ ok: true, json: () => Promise.resolve([staleSnapshot]) });
    await vi.waitFor(() => expect(dataFreshness.value).toBe('fresh'));

    expect(currentRun.value?.lifecycle?.revision).toBe(2);
    expect(currentRun.value?.status).toBe('complete');
  });

  it('reconstructs audit history from an equal-revision reconnect snapshot', async () => {
    const current = controlledRun('r1', 2);
    current.lifecycle!.history = [{
      commandId: 'c2', action: 'pause_run', target: { kind: 'run' }, revision: 2,
      recordedAt: '2026-01-01T00:02:00Z', fromPhase: 'none', toPhase: 'paused',
    }];
    allRuns.value = [current];
    currentRun.value = current;
    const snapshot = controlledRun('r1', 2);
    snapshot.lifecycle!.history = [{
      commandId: 'c1', action: 'resume_run', target: { kind: 'run' }, revision: 1,
      recordedAt: '2026-01-01T00:01:00Z', fromPhase: 'paused', toPhase: 'none',
    }, ...current.lifecycle!.history];
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([snapshot]) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([]) });
    vi.stubGlobal('fetch', mockFetch);

    connectWebSocket();
    wsInstances[0].onopen?.();
    await vi.waitFor(() => expect(dataFreshness.value).toBe('fresh'));
    expect(currentRun.value?.lifecycle?.history.map(entry => entry.commandId)).toEqual(['c1', 'c2']);
  });

  it('fetches runs and memory on open', async () => {
    const runs = [makeRun('r1')];
    const memory = [{ key: 'k', namespace: 'decisions', value: 'v', updatedAt: '' }];
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(runs) })    // fetchRuns
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(memory) }); // fetchMemory
    vi.stubGlobal('fetch', mockFetch);

    connectWebSocket();
    const ws = wsInstances[0];
    ws.onopen?.();

    // Allow promises to resolve
    await vi.waitFor(() => {
      expect(allRuns.value).toHaveLength(1);
    });
    expect(memoryEntries.value).toHaveLength(1);
  });

  it('updates currentRun if it exists in fetched runs', async () => {
    currentRun.value = makeRun('r1');
    const updatedRun = makeRun('r1', 'complete');
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([updatedRun]) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([]) });
    vi.stubGlobal('fetch', mockFetch);

    connectWebSocket();
    const ws = wsInstances[0];
    ws.onopen?.();

    await vi.waitFor(() => {
      expect(currentRun.value!.status).toBe('complete');
    });
  });

  it('logs error if initial sync fails', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const mockFetch = vi.fn().mockRejectedValue(new Error('network fail'));
    vi.stubGlobal('fetch', mockFetch);

    connectWebSocket();
    const ws = wsInstances[0];
    ws.onopen?.();

    await vi.waitFor(() => {
      expect(consoleSpy).toHaveBeenCalledWith('Failed to re-sync after WebSocket connect:', expect.any(Error));
    });
    consoleSpy.mockRestore();
  });

  it('does not let superseded async resync completion change active state', async () => {
    const selected = controlledRun('r1', 0);
    currentRun.value = selected;
    allRuns.value = [selected];
    let resolveRuns!: (value: unknown) => void;
    const mockFetch = vi.fn()
      .mockReturnValueOnce(new Promise(resolve => { resolveRuns = resolve; }));
    vi.stubGlobal('fetch', mockFetch);

    connectWebSocket();
    const superseded = wsInstances[0];
    superseded.onopen?.();
    superseded.readyState = MockWebSocket.CLOSED;
    connectWebSocket();
    connectionStatus.value = 'connecting';
    dataFreshness.value = 'stale';

    resolveRuns({ ok: true, json: () => Promise.resolve([controlledRun('r1', 1)]) });
    await Promise.resolve();
    await Promise.resolve();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(currentRun.value?.lifecycle?.revision).toBe(0);
    expect(connectionStatus.value).toBe('connecting');
    expect(dataFreshness.value).toBe('stale');
  });
});

describe('WebSocket run-scoped freshness', () => {
  it.each(['loading', 'stale'] as const)(
    'reconciles another run without changing selected-run %s freshness',
    freshness => {
      const selected = controlledRun('selected', 0);
      currentRun.value = selected;
      allRuns.value = [selected];
      connectionStatus.value = 'online';
      dataFreshness.value = freshness;
      if (freshness === 'loading') loadingRunId.value = selected.id;
      connectWebSocket();
      const other = controlledRun('other', 2, 'complete');

      wsInstances[0].simulateMessage({ type: 'state_update', run: other });

      expect(allRuns.value.find(run => run.id === other.id)?.status).toBe('complete');
      expect(currentRun.value?.id).toBe(selected.id);
      expect(dataFreshness.value).toBe(freshness);
      expect(getControlAvailability('pause_run', { kind: 'run' }, selected).available).toBe(false);
    },
  );

  it('marks an active selected-run sync fresh and enables valid controls', () => {
    const selected = controlledRun('selected', 0);
    currentRun.value = selected;
    allRuns.value = [selected];
    loadingRunId.value = null;
    dataFreshness.value = 'stale';
    connectWebSocket();
    connectionStatus.value = 'online';

    wsInstances[0].simulateMessage({ type: 'state_update', run: controlledRun('selected', 1) });

    expect(dataFreshness.value).toBe('fresh');
    expect(getControlAvailability('pause_run', { kind: 'run' }).available).toBe(true);
  });
});
