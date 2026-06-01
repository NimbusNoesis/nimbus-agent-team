import { describe, it, expect, beforeEach } from 'vitest';
import {
  allRuns, currentRun, expandedStepId, memoryEntries,
  expandedMemoryKeys, currentFilter, messages, loadingRunId,
  completedSteps, totalSteps, filteredMessages, messageCounts,
  toggleStep, toggleMemoryKey, setFilter,
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
