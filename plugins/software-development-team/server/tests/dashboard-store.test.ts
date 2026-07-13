import { describe, it, expect, beforeEach } from 'vitest';
import {
  allRuns, currentRun, expandedStepId, memoryEntries,
  expandedMemoryKeys, currentFilter, messages, loadingRunId,
  completedSteps, totalSteps, filteredMessages, messageCounts,
  connectionStatus, dataFreshness, controlOperations,
  toggleStep, toggleMemoryKey, setFilter, getControlAvailability,
  setControlOperation, mergeRunSnapshot,
} from '../src/dashboard/client/state/store';
import type { RunState, Message } from '../src/dashboard/client/state/store';

function makeRun(overrides: Partial<RunState> = {}): RunState {
  return {
    id: 'run-1',
    status: 'in_progress',
    steps: [
      { step: { id: 1, description: 'Step 1', files: [], acceptanceCriteria: [], dependsOn: [] }, status: 'complete', retryCount: 0, assignedAgent: null, result: null, claimedFiles: [], consecutiveSameError: 0 },
      { step: { id: 2, description: 'Step 2', files: [], acceptanceCriteria: [], dependsOn: [1] }, status: 'coding', retryCount: 0, assignedAgent: 'coder', result: null, claimedFiles: [], consecutiveSameError: 0 },
      { step: { id: 3, description: 'Step 3', files: [], acceptanceCriteria: [], dependsOn: [2] }, status: 'pending', retryCount: 0, assignedAgent: null, result: null, claimedFiles: [], consecutiveSameError: 0 },
    ],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:01:00Z',
    ...overrides,
  };
}

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: `msg-${Math.random()}`,
    runId: 'run-1',
    from: 'coder',
    to: 'coordinator',
    type: 'info',
    body: 'test message',
    timestamp: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

// Reset signals between tests
beforeEach(() => {
  allRuns.value = [];
  currentRun.value = null;
  expandedStepId.value = null;
  memoryEntries.value = [];
  expandedMemoryKeys.value = new Set();
  currentFilter.value = 'all';
  messages.value = [];
  loadingRunId.value = null;
  connectionStatus.value = 'connecting';
  dataFreshness.value = 'loading';
  controlOperations.value = {};
});

function withLifecycle(run: RunState, revision = 0): RunState {
  return {
    ...run,
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

describe('execution control state', () => {
  it('explains unsupported, offline, stale, and pending actions', () => {
    const run = makeRun();
    expect(getControlAvailability('pause_run', { kind: 'run' }, run).reason).toMatch(/does not support/);

    const controlled = withLifecycle(run);
    connectionStatus.value = 'offline';
    expect(getControlAvailability('pause_run', { kind: 'run' }, controlled).reason).toMatch(/offline/);
    connectionStatus.value = 'online';
    dataFreshness.value = 'stale';
    expect(getControlAvailability('pause_run', { kind: 'run' }, controlled).reason).toMatch(/stale/);
    dataFreshness.value = 'fresh';
    setControlOperation(controlled.id, { kind: 'run' }, { status: 'pending' });
    expect(getControlAvailability('pause_run', { kind: 'run' }, controlled).reason).toMatch(/in progress/);
  });

  it('rejects older revisions and dedupes equal-revision audit history', () => {
    const newer = withLifecycle(makeRun({ updatedAt: '2026-01-01T00:02:00Z' }), 2);
    newer.lifecycle!.history = [{
      commandId: 'c2', action: 'pause_run', target: { kind: 'run' }, revision: 2,
      recordedAt: '2026-01-01T00:02:00Z', fromPhase: 'none', toPhase: 'paused',
    }];
    const older = withLifecycle(makeRun({ status: 'ready', updatedAt: '2026-01-01T00:03:00Z' }), 1);
    expect(mergeRunSnapshot(newer, older)).toBe(newer);

    const equal = withLifecycle(makeRun({ updatedAt: '2026-01-01T00:03:00Z' }), 2);
    equal.lifecycle!.history = [newer.lifecycle!.history[0], {
      commandId: 'c1', action: 'resume_run', target: { kind: 'run' }, revision: 1,
      recordedAt: '2026-01-01T00:01:00Z', fromPhase: 'paused', toPhase: 'none',
    }];
    const merged = mergeRunSnapshot(newer, equal);
    expect(merged.lifecycle!.history.map(entry => entry.commandId)).toEqual(['c1', 'c2']);
  });

  it('requires an escalated step with a persisted worktree before retry', () => {
    const controlled = withLifecycle(makeRun());
    connectionStatus.value = 'online';
    dataFreshness.value = 'fresh';
    const target = { kind: 'step', stepId: 3 } as const;
    expect(getControlAvailability('retry_step', target, controlled).reason).toMatch(/escalated/);
    controlled.steps[2].status = 'escalated';
    expect(getControlAvailability('retry_step', target, controlled).reason).toMatch(/worktree/);
    controlled.steps[2].worktree = { targetBranch: 'main', targetCommit: 'abc', path: '/tmp/w', branch: 'w' };
    expect(getControlAvailability('retry_step', target, controlled).reason).toMatch(/dependency/);
    controlled.steps[1].status = 'complete';
    expect(getControlAvailability('retry_step', target, controlled)).toEqual({ available: true });
  });
});

describe('computed signals', () => {
  it('completedSteps counts complete steps', () => {
    expect(completedSteps.value).toBe(0);
    currentRun.value = makeRun();
    expect(completedSteps.value).toBe(1);
  });

  it('totalSteps counts all steps', () => {
    expect(totalSteps.value).toBe(0);
    currentRun.value = makeRun();
    expect(totalSteps.value).toBe(3);
  });

  it('filteredMessages returns all when filter is "all"', () => {
    messages.value = [makeMessage({ type: 'info' }), makeMessage({ type: 'review' })];
    currentFilter.value = 'all';
    expect(filteredMessages.value).toHaveLength(2);
  });

  it('filteredMessages filters by type', () => {
    messages.value = [
      makeMessage({ type: 'info' }),
      makeMessage({ type: 'review' }),
      makeMessage({ type: 'info' }),
    ];
    currentFilter.value = 'review';
    expect(filteredMessages.value).toHaveLength(1);
    expect(filteredMessages.value[0].type).toBe('review');
  });

  it('messageCounts tallies correctly', () => {
    messages.value = [
      makeMessage({ type: 'info' }),
      makeMessage({ type: 'info' }),
      makeMessage({ type: 'review' }),
      makeMessage({ type: 'escalation' }),
    ];
    const counts = messageCounts.value;
    expect(counts.all).toBe(4);
    expect(counts.info).toBe(2);
    expect(counts.review).toBe(1);
    expect(counts.escalation).toBe(1);
    expect(counts.guidance).toBe(0);
    expect(counts.result).toBe(0);
  });
});

describe('actions', () => {
  describe('toggleStep', () => {
    it('expands a step', () => {
      expect(expandedStepId.value).toBeNull();
      toggleStep(1);
      expect(expandedStepId.value).toBe(1);
    });

    it('collapses when toggling same step', () => {
      toggleStep(1);
      toggleStep(1);
      expect(expandedStepId.value).toBeNull();
    });

    it('switches to different step', () => {
      toggleStep(1);
      toggleStep(2);
      expect(expandedStepId.value).toBe(2);
    });
  });

  describe('toggleMemoryKey', () => {
    it('adds a key', () => {
      toggleMemoryKey('decisions:arch');
      expect(expandedMemoryKeys.value.has('decisions:arch')).toBe(true);
    });

    it('removes a key on second toggle', () => {
      toggleMemoryKey('decisions:arch');
      toggleMemoryKey('decisions:arch');
      expect(expandedMemoryKeys.value.has('decisions:arch')).toBe(false);
    });

    it('handles multiple keys independently', () => {
      toggleMemoryKey('decisions:a');
      toggleMemoryKey('context:b');
      expect(expandedMemoryKeys.value.size).toBe(2);
      toggleMemoryKey('decisions:a');
      expect(expandedMemoryKeys.value.size).toBe(1);
      expect(expandedMemoryKeys.value.has('context:b')).toBe(true);
    });

    it('creates new Set reference on each toggle (signal reactivity)', () => {
      const before = expandedMemoryKeys.value;
      toggleMemoryKey('x');
      expect(expandedMemoryKeys.value).not.toBe(before);
    });
  });

  describe('setFilter', () => {
    it('sets the filter', () => {
      setFilter('review');
      expect(currentFilter.value).toBe('review');
    });

    it('can reset to all', () => {
      setFilter('review');
      setFilter('all');
      expect(currentFilter.value).toBe('all');
    });
  });
});
