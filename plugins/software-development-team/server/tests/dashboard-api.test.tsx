import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  allRuns, currentRun, messages, memoryEntries, loadingRunId, currentFilter,
  connectionStatus, dataFreshness, controlOperations, getControlOperation,
} from '../src/dashboard/client/state/store';
import type { RunState, Message, MemoryEntry } from '../src/dashboard/client/state/store';

// Mock fetch globally before importing the module under test
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const { fetchRuns, fetchMessages, fetchMemory, sendGuidance, selectRun, executeControl } =
  await import('../src/dashboard/client/state/api');

function makeRun(id: string, status = 'in_progress' as const): RunState {
  return {
    id, status, steps: [],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:01:00Z',
  };
}

function controlledRun(id: string, revision = 0): RunState {
  return {
    ...makeRun(id),
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

function makeMsg(id: string, runId: string): Message {
  return {
    id, runId, from: 'coder', to: 'all', type: 'info',
    body: 'hello', timestamp: '2026-01-01T00:00:00Z',
  };
}

function okJson(data: unknown) {
  return Promise.resolve({
    ok: true,
    json: () => Promise.resolve(data),
  });
}

function errorResponse(status = 500) {
  return Promise.resolve({ ok: false, status, json: () => Promise.resolve({}) });
}

beforeEach(() => {
  mockFetch.mockReset();
  allRuns.value = [];
  currentRun.value = null;
  messages.value = [];
  memoryEntries.value = [];
  loadingRunId.value = null;
  currentFilter.value = 'all';
  connectionStatus.value = 'online';
  dataFreshness.value = 'fresh';
  controlOperations.value = {};
});

describe('execution control API', () => {
  const commandId = '11111111-1111-4111-8111-111111111111';

  function successResponse(run: RunState, action = 'pause_run' as const) {
    run.lifecycle!.revision = 1;
    run.lifecycle!.controlPhase = 'paused';
    const receipt = {
      commandId, fingerprint: 'fingerprint', action, target: { kind: 'run' as const },
      expectedRevision: 0, revision: 1, recordedAt: '2026-01-01T00:02:00Z',
      outcome: { controlPhase: 'paused' as const, runStatus: run.status },
    };
    return { success: true, replayed: false, receipt, run };
  }

  it('sends commandId, expected revision, target, reason, and confirmation exactly once', async () => {
    const run = controlledRun('r1');
    allRuns.value = [run];
    currentRun.value = run;
    mockFetch.mockReturnValue(okJson(successResponse(controlledRun('r1'))));

    const result = await executeControl('r1', {
      action: 'cancel_run', target: { kind: 'run' }, commandId,
      reason: 'No longer needed', confirmation: 'cancel run r1',
    });

    expect(result.ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toEqual({
      action: 'cancel_run', target: { kind: 'run' }, commandId, expectedRevision: 0,
      reason: 'No longer needed', confirmation: 'cancel run r1',
    });
    expect(getControlOperation('r1', { kind: 'run' }).status).toBe('success');
  });

  it('suppresses a double submit while the target request is pending', async () => {
    const run = controlledRun('r1');
    allRuns.value = [run];
    currentRun.value = run;
    let resolveFetch!: (value: unknown) => void;
    mockFetch.mockReturnValue(new Promise(resolve => { resolveFetch = resolve; }));

    const first = executeControl('r1', { action: 'pause_run', target: { kind: 'run' }, commandId });
    const second = await executeControl('r1', { action: 'pause_run', target: { kind: 'run' } });
    expect(second).toMatchObject({ ok: false, error: { code: 'request_in_progress' } });
    expect(mockFetch).toHaveBeenCalledTimes(1);

    resolveFetch({ ok: true, json: () => Promise.resolve(successResponse(controlledRun('r1'))) });
    await first;
  });

  it('does not replay a conflicting mutation and refreshes before requiring reconfirmation', async () => {
    const run = controlledRun('r1');
    const refreshed = controlledRun('r1', 1);
    allRuns.value = [run];
    currentRun.value = run;
    mockFetch
      .mockResolvedValueOnce({
        ok: false, status: 409,
        json: () => Promise.resolve({ error: { code: 'revision_conflict', message: 'stale revision' } }),
      })
      .mockReturnValueOnce(okJson([refreshed]));

    const result = await executeControl('r1', { action: 'pause_run', target: { kind: 'run' }, commandId });
    expect(result).toMatchObject({ ok: false, requiresReconfirmation: true, error: { code: 'revision_conflict' } });
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch.mock.calls[0][1]?.method).toBe('POST');
    expect(mockFetch.mock.calls[1]).toEqual(['/api/runs']);
    expect(getControlOperation('r1', { kind: 'run' })).toMatchObject({
      status: 'conflict', requiresReconfirmation: true, recoveredRevision: 1,
    });
  });

  it.each([400, 403, 404])('preserves structured %s errors without retrying', async status => {
    const run = controlledRun('r1');
    allRuns.value = [run];
    currentRun.value = run;
    mockFetch.mockResolvedValue({
      ok: false, status,
      json: () => Promise.resolve({ error: { code: `code_${status}`, message: `message ${status}` } }),
    });
    const result = await executeControl('r1', { action: 'pause_run', target: { kind: 'run' }, commandId });
    expect(result).toMatchObject({ ok: false, error: { status, code: `code_${status}` } });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('does not replace the selected run when a control response resolves after a run switch', async () => {
    const firstRun = controlledRun('r1');
    const secondRun = controlledRun('r2');
    allRuns.value = [firstRun, secondRun];
    currentRun.value = firstRun;
    let resolveFetch!: (value: unknown) => void;
    mockFetch.mockReturnValue(new Promise(resolve => { resolveFetch = resolve; }));
    const pending = executeControl('r1', { action: 'pause_run', target: { kind: 'run' }, commandId });
    currentRun.value = secondRun;
    dataFreshness.value = 'loading';
    resolveFetch({ ok: true, json: () => Promise.resolve(successResponse(controlledRun('r1'))) });
    await pending;
    expect(currentRun.value?.id).toBe('r2');
    expect(dataFreshness.value).toBe('loading');
  });
});

describe('API client', () => {
  describe('fetchRuns', () => {
    it('calls GET /api/runs and returns parsed JSON', async () => {
      const runs = [makeRun('r1')];
      mockFetch.mockReturnValue(okJson(runs));
      const result = await fetchRuns();
      expect(mockFetch).toHaveBeenCalledWith('/api/runs');
      expect(result).toEqual(runs);
    });

    it('throws on non-ok response', async () => {
      mockFetch.mockReturnValue(errorResponse(500));
      await expect(fetchRuns()).rejects.toThrow('Server error: 500');
    });
  });

  describe('fetchMessages', () => {
    it('calls GET /api/runs/:runId/messages with encoded runId', async () => {
      mockFetch.mockReturnValue(okJson([]));
      await fetchMessages('run/with spaces');
      expect(mockFetch).toHaveBeenCalledWith('/api/runs/run%2Fwith%20spaces/messages');
    });

    it('returns empty array and warns on non-ok response', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      mockFetch.mockReturnValue(errorResponse(404));
      const result = await fetchMessages('r1');
      expect(result).toEqual([]);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('404'));
      warnSpy.mockRestore();
    });
  });

  describe('fetchMemory', () => {
    it('calls GET /api/memory and returns parsed JSON', async () => {
      const entries: MemoryEntry[] = [{ key: 'k', namespace: 'decisions', value: 'v', updatedAt: '' }];
      mockFetch.mockReturnValue(okJson(entries));
      const result = await fetchMemory();
      expect(result).toEqual(entries);
    });

    it('returns empty array and warns on non-ok response', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      mockFetch.mockReturnValue(errorResponse(500));
      const result = await fetchMemory();
      expect(result).toEqual([]);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('500'));
      warnSpy.mockRestore();
    });
  });

  describe('sendGuidance', () => {
    it('POSTs with correct Content-Type and body, returns true on ok', async () => {
      mockFetch.mockReturnValue(okJson({ success: true }));
      const result = await sendGuidance('r1', 'Please focus on tests');
      expect(mockFetch).toHaveBeenCalledWith('/api/guidance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runId: 'r1', body: 'Please focus on tests' }),
      });
      expect(result).toBe(true);
    });

    it('returns false and warns on non-ok response', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      mockFetch.mockReturnValue(errorResponse(404));
      const result = await sendGuidance('gone-run', 'hello?');
      expect(result).toBe(false);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('404'));
      warnSpy.mockRestore();
    });

    it('returns false and warns on network error', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      mockFetch.mockReturnValue(Promise.reject(new Error('network down')));
      const result = await sendGuidance('r1', 'anyone there?');
      expect(result).toBe(false);
      expect(warnSpy).toHaveBeenCalledWith('Failed to send guidance:', expect.any(Error));
      warnSpy.mockRestore();
    });
  });

  describe('selectRun', () => {
    it('sets currentRun signal immediately', async () => {
      const run = makeRun('r1');
      mockFetch.mockReturnValue(okJson([]));
      const promise = selectRun(run);
      expect(currentRun.value).toBe(run);
      await promise;
    });

    it('clears messages and sets loadingRunId', async () => {
      messages.value = [makeMsg('m1', 'old')];
      const run = makeRun('r1');
      mockFetch.mockReturnValue(okJson([]));
      const promise = selectRun(run);
      expect(messages.value).toEqual([]);
      expect(loadingRunId.value).toBe('r1');
      await promise;
    });

    it('resets currentFilter to all', async () => {
      currentFilter.value = 'review';
      mockFetch.mockReturnValue(okJson([]));
      await selectRun(makeRun('r1'));
      expect(currentFilter.value).toBe('all');
    });

    it('populates messages from fetchMessages response', async () => {
      const msgs = [makeMsg('m1', 'r1'), makeMsg('m2', 'r1')];
      mockFetch
        .mockReturnValueOnce(okJson(msgs))   // fetchMessages
        .mockReturnValueOnce(okJson([]));     // fetchMemory
      await selectRun(makeRun('r1'));
      expect(messages.value).toEqual(msgs);
    });

    it('clears loadingRunId after fetch completes', async () => {
      mockFetch.mockReturnValue(okJson([]));
      await selectRun(makeRun('r1'));
      expect(loadingRunId.value).toBeNull();
    });

    it('race condition: ignores stale fetchMessages if another selectRun was called', async () => {
      // First selectRun starts but takes a while
      let resolveFirst: (v: any) => void;
      const slowFetch = new Promise(r => { resolveFirst = r; });
      mockFetch
        .mockReturnValueOnce(slowFetch)                // first selectRun's fetchMessages
        .mockReturnValueOnce(okJson([makeMsg('m2', 'r2')]))  // second selectRun's fetchMessages
        .mockReturnValueOnce(okJson([]));               // second selectRun's fetchMemory

      const promise1 = selectRun(makeRun('r1'));

      // Second selectRun overtakes the first
      const promise2 = selectRun(makeRun('r2'));
      await promise2;

      // Now resolve the slow first fetch
      resolveFirst!({ ok: true, json: () => Promise.resolve([makeMsg('m1', 'r1')]) });
      await promise1;

      // Messages should be from r2, not r1 (stale result ignored)
      expect(messages.value).toEqual([makeMsg('m2', 'r2')]);
    });

    it('handles fetchMemory failure gracefully', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      mockFetch
        .mockReturnValueOnce(okJson([]))                              // fetchMessages
        .mockReturnValueOnce(Promise.reject(new Error('network')));   // fetchMemory
      await selectRun(makeRun('r1'));
      expect(consoleSpy).toHaveBeenCalledWith('Failed to fetch memory:', expect.any(Error));
      consoleSpy.mockRestore();
    });
  });
});
