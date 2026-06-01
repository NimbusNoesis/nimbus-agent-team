import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  allRuns, currentRun, messages, memoryEntries, loadingRunId,
} from '../src/dashboard/client/state/store';
import type { RunState, MemoryEntry } from '../src/dashboard/client/state/store';

// Mock WebSocket and fetch for the websocket module
let wsInstances: MockWebSocket[] = [];

class MockWebSocket {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  closed = false;

  constructor(_url: string) {
    wsInstances.push(this);
  }

  close() { this.closed = true; }

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

beforeEach(() => {
  wsInstances = [];
  allRuns.value = [];
  currentRun.value = null;
  messages.value = [];
  memoryEntries.value = [];
  loadingRunId.value = null;
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('WebSocket message handling', () => {
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
});

describe('WebSocket onopen sync', () => {
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
});
