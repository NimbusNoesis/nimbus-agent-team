import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  currentRun, messages, memoryEntries, loadingRunId, currentFilter,
} from '../src/dashboard/client/state/store';
import type { RunState, Message, MemoryEntry } from '../src/dashboard/client/state/store';

// Mock fetch globally before importing the module under test
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const { fetchRuns, fetchMessages, fetchMemory, sendGuidance, selectRun } =
  await import('../src/dashboard/client/state/api');

function makeRun(id: string, status = 'in_progress' as const): RunState {
  return {
    id, status, steps: [],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:01:00Z',
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
  currentRun.value = null;
  messages.value = [];
  memoryEntries.value = [];
  loadingRunId.value = null;
  currentFilter.value = 'all';
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

    it('returns empty array on non-ok response', async () => {
      mockFetch.mockReturnValue(errorResponse(404));
      const result = await fetchMessages('r1');
      expect(result).toEqual([]);
    });
  });

  describe('fetchMemory', () => {
    it('calls GET /api/memory and returns parsed JSON', async () => {
      const entries: MemoryEntry[] = [{ key: 'k', namespace: 'decisions', value: 'v', updatedAt: '' }];
      mockFetch.mockReturnValue(okJson(entries));
      const result = await fetchMemory();
      expect(result).toEqual(entries);
    });

    it('returns empty array on non-ok response', async () => {
      mockFetch.mockReturnValue(errorResponse(500));
      const result = await fetchMemory();
      expect(result).toEqual([]);
    });
  });

  describe('sendGuidance', () => {
    it('POSTs with correct Content-Type and body', async () => {
      mockFetch.mockReturnValue(okJson({ success: true }));
      await sendGuidance('r1', 'Please focus on tests');
      expect(mockFetch).toHaveBeenCalledWith('/api/guidance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runId: 'r1', body: 'Please focus on tests' }),
      });
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
