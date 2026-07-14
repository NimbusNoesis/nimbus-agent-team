import { Database } from '../src/db/database.js';
import { StateMachine } from '../src/state/machine.js';
import { MessageBus } from '../src/bus/message-bus.js';
import { MemoryStore } from '../src/memory/store.js';
import { ToolRegistry } from '../src/tools/registry.js';
import type { RunState, Message, MemoryEntry, WorktreeContext } from '../src/types.js';

export const makeWorktree = (runId: string, stepId: number): WorktreeContext => ({
  targetBranch: 'main',
  targetCommit: 'abc123',
  path: `.worktrees/${runId}/step-${stepId}`,
  branch: `team-${runId}-step-${stepId}`,
});

export const startStepWithWorktree = (
  sm: StateMachine,
  runId: string,
  stepId: number,
  agent: string,
): void => {
  const step = sm.getRun(runId)?.steps.find((candidate) => candidate.step.id === stepId);
  if (step?.status === 'pending' && !step.worktree) {
    sm.setWorktree(runId, stepId, makeWorktree(runId, stepId));
  }
  sm.startStep(runId, stepId, agent);
};

export const makeRun = (id: string, overrides: Partial<RunState> = {}): RunState => ({
  id,
  status: 'in_progress',
  steps: [],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:01:00Z',
  ...overrides,
});

export const makeMessage = (overrides: Partial<Message> = {}): Message => ({
  id: 'msg-1',
  runId: 'run-1',
  from: 'coder',
  to: 'all',
  type: 'info',
  body: 'hello',
  timestamp: '2026-01-01T00:00:00Z',
  ...overrides,
});

export const makeMemoryEntry = (overrides: Partial<MemoryEntry> = {}): MemoryEntry => ({
  key: 'test-key',
  namespace: 'decisions',
  value: 'test value',
  updatedAt: '2026-01-01T00:00:00Z',
  ...overrides,
});

export async function createTestStack() {
  const db = await Database.create();
  const sm = new StateMachine(db);
  const bus = new MessageBus(db);
  const memory = new MemoryStore(db);
  const registry = new ToolRegistry(sm, bus, memory);
  return { db, sm, bus, memory, registry };
}
