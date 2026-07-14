import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ToolRegistry } from '../src/tools/registry.js';
import { StateMachine } from '../src/state/machine.js';
import { MessageBus } from '../src/bus/message-bus.js';
import { MemoryStore } from '../src/memory/store.js';
import { Database } from '../src/db/database.js';
import { logger } from '../src/logger.js';
import { readFileSync } from 'node:fs';
import { makeWorktree } from './helpers.js';

describe('ToolRegistry', () => {
  let registry: ToolRegistry;
  let sm: StateMachine;

  beforeEach(async () => {
    const db = await Database.create();
    sm = new StateMachine(db);
    registry = new ToolRegistry(
      sm,
      new MessageBus(db),
      new MemoryStore(db),
    );
  });

  async function persistWorktree(runId: string, stepId = 1): Promise<void> {
    await registry.handle('team_advance', {
      runId,
      stepId,
      action: 'set_worktree',
      worktree: makeWorktree(runId, stepId),
    });
  }

  it('team_start creates a run and returns run ID', async () => {
    const result = await registry.handle('team_start', {
      steps: [
        { id: 1, description: 'Step 1', files: ['a.ts'], acceptanceCriteria: ['works'], dependsOn: [] },
      ],
    });
    expect(result.runId).toBeDefined();
    expect(result.status).toBe('ready');
    expect(result.stepCount).toBe(1);
    expect(sm.getRun(result.runId)!.steps[0].step.executionMode).toBe('code');
  });

  it('team_status returns current run state', async () => {
    const { runId } = await registry.handle('team_start', {
      steps: [{ id: 1, description: 'Step 1', files: [], acceptanceCriteria: [], dependsOn: [] }],
    });
    const status = await registry.handle('team_status', { runId });
    expect(status.status).toBe('ready');
    expect(status.steps).toHaveLength(1);
    expect(status.steps[0].executionMode).toBe('code');
  });

  it('team_start and team_status preserve an explicit read-only execution mode', async () => {
    const { runId } = await registry.handle('team_start', {
      steps: [{
        id: 1,
        description: 'Review',
        files: ['src/review.ts'],
        acceptanceCriteria: ['Report findings'],
        dependsOn: [],
        executionMode: 'read_only',
      }],
    });
    const status = await registry.handle('team_status', { runId });
    expect(sm.getRun(runId)!.steps[0].step.executionMode).toBe('read_only');
    expect(status.steps[0].executionMode).toBe('read_only');
  });

  it('team_status reports pending dependency and file conflict blockers', async () => {
    const { runId } = await registry.handle('team_start', {
      steps: [
        { id: 1, description: 'Active work', files: ['shared.ts'], acceptanceCriteria: [], dependsOn: [] },
        { id: 2, description: 'Blocked work', files: ['shared.ts'], acceptanceCriteria: [], dependsOn: [1] },
      ],
    });
    await persistWorktree(runId);
    await registry.handle('team_advance', {
      runId, stepId: 1, action: 'start_coding', agent: 'coder',
    });

    const status = await registry.handle('team_status', { runId });
    const active = status.steps.find((step: { id: number }) => step.id === 1);
    const pending = status.steps.find((step: { id: number }) => step.id === 2);

    expect(active.fileConflicts).toEqual([]);
    expect(active.blockingReasons).toEqual([]);
    expect(pending.fileConflicts).toEqual([
      'shared.ts (also claimed by step 1)',
    ]);
    expect(pending.blockingReasons).toEqual([
      'Waiting on step 1: Active work',
      'File conflict: shared.ts is claimed by step 1',
    ]);

    await registry.handle('team_submit_result', {
      runId, stepId: 1, result: { status: 'done', summary: 'ready for review' },
    });
    const reviewingStatus = await registry.handle('team_status', { runId });
    const blockedByReview = reviewingStatus.steps.find((step: { id: number }) => step.id === 2);
    expect(blockedByReview.fileConflicts).toEqual([
      'shared.ts (also claimed by step 1)',
    ]);
    expect(blockedByReview.blockingReasons).toContain(
      'File conflict: shared.ts is claimed by step 1',
    );
  });

  it('team_status reports disjoint pending work as runnable', async () => {
    const { runId } = await registry.handle('team_start', {
      steps: [
        { id: 1, description: 'Active work', files: ['active.ts'], acceptanceCriteria: [], dependsOn: [] },
        { id: 2, description: 'Runnable work', files: ['other.ts'], acceptanceCriteria: [], dependsOn: [] },
      ],
    });
    await persistWorktree(runId);
    await registry.handle('team_advance', {
      runId, stepId: 1, action: 'start_coding', agent: 'coder',
    });

    const status = await registry.handle('team_status', { runId });
    const pending = status.steps.find((step: { id: number }) => step.id === 2);

    expect(pending.fileConflicts).toEqual([]);
    expect(pending.blockingReasons).toEqual([]);
  });

  it('team_submit_result + team_advance complete a step', async () => {
    const { runId } = await registry.handle('team_start', {
      steps: [{ id: 1, description: 'S1', files: [], acceptanceCriteria: [], dependsOn: [] }],
    });
    await persistWorktree(runId);
    await registry.handle('team_advance', { runId, stepId: 1, action: 'start_coding', agent: 'coder' });
    await registry.handle('team_submit_result', {
      runId, stepId: 1, result: { status: 'done', summary: 'implemented' },
    });
    await registry.handle('team_advance', { runId, stepId: 1, action: 'approve' });
    const status = await registry.handle('team_status', { runId });
    expect(status.steps[0].status).toBe('complete');
  });

  it('team_send_message + team_get_messages round trips', async () => {
    const { runId } = await registry.handle('team_start', {
      steps: [{ id: 1, description: 'S1', files: [], acceptanceCriteria: [], dependsOn: [] }],
    });
    await registry.handle('team_send_message', {
      runId, from: 'coder', to: 'coordinator', type: 'info', body: 'hello',
    });
    const result = await registry.handle('team_get_messages', { runId, to: 'coordinator' });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].body).toBe('hello');
  });

  it('team_memory_write + team_memory_read round trips', async () => {
    await registry.handle('team_memory_write', {
      key: 'auth', namespace: 'decisions', value: 'Use JWT',
    });
    const result = await registry.handle('team_memory_read', { namespace: 'decisions', key: 'auth' });
    expect(result.entry.value).toBe('Use JWT');
  });

  it('team_dashboard_url returns a URL', async () => {
    const result = await registry.handle('team_dashboard_url', {});
    expect(result.url).toMatch(/^http/);
  });

  it('handle rejects unknown tool name', async () => {
    await expect(registry.handle('nonexistent_tool', {})).rejects.toThrow('Unknown tool');
  });

  it('registers team_control exactly once in the MCP entry point', () => {
    const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
    expect(source.match(/server\.registerTool\(\s*'team_control'/g)).toHaveLength(1);
    expect(source).toMatch(/inputSchema:\s*teamControlSchema/);
    expect(source).not.toMatch(/team_control'[\s\S]{0,300}teamControlShape/);
  });

  it('team_advance with resolve_escalation works on escalated step', async () => {
    const { runId } = await registry.handle('team_start', {
      steps: [{ id: 1, description: 'S1', files: [], acceptanceCriteria: [], dependsOn: [] }],
    });
    await persistWorktree(runId);
    await registry.handle('team_advance', { runId, stepId: 1, action: 'start_coding' });
    await registry.handle('team_submit_result', {
      runId, stepId: 1, result: { status: 'blocked', summary: 'stuck' },
    });
    const result = await registry.handle('team_advance', {
      runId, stepId: 1, action: 'resolve_escalation',
    });
    expect(result.stepStatus).toBe('coding');
  });

  it('team_status exposes lifecycle, worker truth, capabilities, and per-target availability', async () => {
    const { runId } = await registry.handle('team_start', {
      steps: [{ id: 1, description: 'S1', files: ['a.ts'], acceptanceCriteria: [], dependsOn: [] }],
    });
    let status = await registry.handle('team_status', { runId });
    expect(status).toMatchObject({
      lifecycleVersion: 2,
      revision: 0,
      phase: 'none',
      capabilities: { pause_run: true, retry_step: true },
      controlHistory: [],
      controlReceipts: [],
      workers: {
        truthSource: 'lifecycle_assignments', nativeProcessState: 'not_observed',
        activeCount: 0, active: [], admissionsFrozen: false,
      },
      actionAvailability: { pause_run: { available: true } },
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
    expect(status.steps[0]).toMatchObject({
      id: 1,
      description: 'S1',
      executionMode: 'code',
      status: 'pending',
      retryCount: 0,
      assignedAgent: null,
      result: null,
      claimedFiles: [],
      consecutiveSameError: 0,
      manualAttempt: 0,
      resultHistory: [],
      actionAvailability: {
        cancel_step: { available: true },
        retry_step: { available: false },
      },
      fileConflicts: [],
      blockingReasons: [],
      dependsOn: [],
    });
    expect(status.steps[0].actionAvailability.cancel_step.available).toBe(true);
    expect(status.steps[0].actionAvailability.retry_step).toMatchObject({
      available: false,
      reason: 'Step is not escalated',
    });

    await persistWorktree(runId);
    await registry.handle('team_advance', { runId, stepId: 1, action: 'start_coding', agent: 'coder-one' });
    status = await registry.handle('team_status', { runId });
    expect(status.workers).toMatchObject({ activeCount: 1, admissionsFrozen: false });
    expect(status.workers.active[0]).toMatchObject({ stepId: 1, agent: 'coder-one', status: 'coding' });
  });

  it('team_control pauses idempotently, freezes admissions, and resumes with monotonic status', async () => {
    const { runId } = await registry.handle('team_start', {
      steps: [
        { id: 1, description: 'Active', files: ['a.ts'], acceptanceCriteria: [], dependsOn: [] },
        { id: 2, description: 'Waiting', files: ['b.ts'], acceptanceCriteria: [], dependsOn: [] },
      ],
    });
    await persistWorktree(runId);
    await persistWorktree(runId, 2);
    await registry.handle('team_advance', { runId, stepId: 1, action: 'start_coding', agent: 'coder' });
    const execute = vi.spyOn(sm, 'executeControl');
    const pause = {
      runId, action: 'pause_run', target: { kind: 'run' }, commandId: 'pause-1', expectedRevision: 0,
    };
    const first = await registry.handle('team_control', pause);
    expect(execute).toHaveBeenCalledTimes(1);
    const replay = await registry.handle('team_control', pause);
    expect(first).toMatchObject({ success: true, replayed: false, revision: 1, phase: 'pausing' });
    expect(replay).toMatchObject({ success: true, replayed: true, revision: 1, phase: 'pausing' });
    expect(execute).toHaveBeenCalledTimes(2);
    await expect(registry.handle('team_advance', {
      runId, stepId: 2, action: 'start_coding', agent: 'other',
    })).rejects.toThrow("not admitting work while control phase is 'pausing'");

    await registry.handle('team_submit_result', {
      runId, stepId: 1, result: { status: 'done', summary: 'drained' },
    });
    await registry.handle('team_control', {
      runId, action: 'acknowledge_pause', target: { kind: 'run' }, commandId: 'pause-ack', expectedRevision: 1,
    });
    const resumed = await registry.handle('team_control', {
      runId, action: 'resume_run', target: { kind: 'run' }, commandId: 'resume-1', expectedRevision: 2,
    });
    expect(resumed).toMatchObject({ revision: 3, phase: 'none' });
    const status = await registry.handle('team_status', { runId });
    expect(status.controlHistory).toHaveLength(3);
    expect(status.controlReceipts).toHaveLength(3);
    expect(status.controlReceipts[0]).not.toHaveProperty('fingerprint');
  });

  it('team_control rejects stale and mismatched commands without changing revision', async () => {
    const { runId } = await registry.handle('team_start', {
      steps: [{ id: 1, description: 'S1', files: [], acceptanceCriteria: [], dependsOn: [] }],
    });
    await registry.handle('team_control', {
      runId, action: 'pause_run', target: { kind: 'run' }, commandId: 'pause-1', expectedRevision: 0,
    });
    await expect(registry.handle('team_control', {
      runId, action: 'pause_run', target: { kind: 'run' }, commandId: 'pause-1', expectedRevision: 0,
      reason: 'changed fingerprint',
    })).rejects.toThrow('different payload');
    await expect(registry.handle('team_control', {
      runId, action: 'resume_run', target: { kind: 'run' }, commandId: 'stale-resume', expectedRevision: 0,
    })).rejects.toThrow('revision conflict');
    const status = await registry.handle('team_status', { runId });
    expect(status.revision).toBe(1);
    expect(status.controlHistory).toHaveLength(1);
  });

  it('team_control requires explicit cancellation confirmation without side effects', async () => {
    const { runId } = await registry.handle('team_start', {
      steps: [{ id: 1, description: 'S1', files: [], acceptanceCriteria: [], dependsOn: [] }],
    });
    await expect(registry.handle('team_control', {
      runId, action: 'cancel_step', target: { kind: 'step', stepId: 1 }, commandId: 'cancel-1', expectedRevision: 0,
    })).rejects.toThrow();
    expect((await registry.handle('team_status', { runId })).revision).toBe(0);

    const cancelled = await registry.handle('team_control', {
      runId, action: 'cancel_step', target: { kind: 'step', stepId: 1 }, commandId: 'cancel-1', expectedRevision: 0,
      confirmation: true, reason: 'No longer needed',
    });
    expect(cancelled).toMatchObject({ stepStatus: 'cancelled', revision: 1 });
    expect(cancelled).not.toHaveProperty('fingerprint');
    const status = await registry.handle('team_status', { runId });
    expect(status.status).toBe('escalated');
    expect(status.steps[0].status).toBe('cancelled');
  });

  it('team_advance with mark_reviewed closes a read-only review step', async () => {
    const runId = sm.createRun([{
      id: 1,
      description: 'S1',
      files: [],
      acceptanceCriteria: [],
      dependsOn: [],
      executionMode: 'read_only',
    }]).id;
    await persistWorktree(runId);
    await registry.handle('team_advance', { runId, stepId: 1, action: 'start_coding', agent: 'reviewer' });
    const result = await registry.handle('team_advance', {
      runId, stepId: 1, action: 'mark_reviewed', summary: 'Findings delivered; no code changes.',
    });
    expect(result.stepStatus).toBe('complete');
    const status = await registry.handle('team_status', { runId });
    expect(status.steps[0].status).toBe('complete');
    expect(status.steps[0].result.summary).toBe('Findings delivered; no code changes.');
  });

  it('team_memory_delete removes an entry', async () => {
    await registry.handle('team_memory_write', {
      key: 'to-delete', namespace: 'decisions', value: 'temporary',
    });
    const deleteResult = await registry.handle('team_memory_delete', {
      namespace: 'decisions', key: 'to-delete',
    });
    expect(deleteResult.success).toBe(true);
    const readResult = await registry.handle('team_memory_read', {
      namespace: 'decisions', key: 'to-delete',
    });
    expect(readResult.entry).toBeNull();
  });

  it('team_memory_read with search returns matching entries', async () => {
    await registry.handle('team_memory_write', {
      key: 'auth-choice', namespace: 'decisions', value: 'Use JWT tokens',
    });
    await registry.handle('team_memory_write', {
      key: 'db-choice', namespace: 'decisions', value: 'Use PostgreSQL',
    });
    const result = await registry.handle('team_memory_read', { search: 'JWT' });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].key).toBe('auth-choice');
  });

  it('team_memory_read with namespace only returns entries for that namespace', async () => {
    await registry.handle('team_memory_write', {
      key: 'k1', namespace: 'decisions', value: 'v1',
    });
    await registry.handle('team_memory_write', {
      key: 'k2', namespace: 'context', value: 'v2',
    });
    const result = await registry.handle('team_memory_read', { namespace: 'decisions' });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].namespace).toBe('decisions');
  });

  it('team_status reports only an explicitly configured hostCapacity', async () => {
    const { runId } = await registry.handle('team_start', {
      steps: [{ id: 1, description: 'S1', files: [], acceptanceCriteria: [], dependsOn: [] }],
    });
    const previous = process.env.TEAM_HOST_CAPACITY;
    try {
      delete process.env.TEAM_HOST_CAPACITY;
      expect(await registry.handle('team_status', { runId })).not.toHaveProperty('hostCapacity');
      process.env.TEAM_HOST_CAPACITY = '4';
      expect((await registry.handle('team_status', { runId })).hostCapacity).toBe(4);
      process.env.TEAM_HOST_CAPACITY = 'not-a-quota';
      expect(await registry.handle('team_status', { runId })).not.toHaveProperty('hostCapacity');
    } finally {
      if (previous === undefined) delete process.env.TEAM_HOST_CAPACITY;
      else process.env.TEAM_HOST_CAPACITY = previous;
    }
  });

  it('persists and reports set-once worktree context before admission', async () => {
    const { runId } = await registry.handle('team_start', {
      steps: [{ id: 1, description: 'S1', files: [], acceptanceCriteria: [], dependsOn: [] }],
    });
    const worktree = makeWorktree(runId, 1);
    await registry.handle('team_advance', { runId, stepId: 1, action: 'set_worktree', worktree });
    expect((await registry.handle('team_status', { runId })).steps[0].worktree).toEqual(worktree);
    await expect(registry.handle('team_advance', {
      runId, stepId: 1, action: 'set_worktree', worktree,
    })).rejects.toThrow('already set');
  });

  it('team_send_message rejects an unknown runId instead of orphaning the message', async () => {
    await expect(registry.handle('team_send_message', {
      runId: 'no-such-run', from: 'planner', to: 'coordinator', type: 'info', body: 'pre-run note',
    })).rejects.toThrow('not found');
  });

  it('team_start rejects an invalid plan (dependency cycle)', async () => {
    await expect(registry.handle('team_start', {
      steps: [
        { id: 1, description: 'S1', files: [], acceptanceCriteria: [], dependsOn: [2] },
        { id: 2, description: 'S2', files: [], acceptanceCriteria: [], dependsOn: [1] },
      ],
    })).rejects.toThrow('dependency cycle');
  });

  it('failure logs never contain message bodies — only arg keys and identifying fields', async () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    try {
      await expect(registry.handle('team_send_message', {
        runId: 'no-such-run', from: 'coder', to: 'all', type: 'info', body: 'SECRET-MESSAGE-BODY',
      })).rejects.toThrow('not found');

      const call = errorSpy.mock.calls.find(([component]) => component === 'ToolRegistry');
      expect(call).toBeDefined();
      const data = call![2];
      expect(data).toMatchObject({
        tool: 'team_send_message',
        argKeys: ['runId', 'from', 'to', 'type', 'body'],
        runId: 'no-such-run',
        from: 'coder',
        to: 'all',
      });
      expect(JSON.stringify(data)).not.toContain('SECRET-MESSAGE-BODY');
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('failure logs never contain memory values — only arg keys and identifying fields', async () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    try {
      await expect(registry.handle('team_memory_write', {
        key: 'invalid key!', namespace: 'decisions', value: 'SECRET-MEMORY-VALUE',
      })).rejects.toThrow();

      const call = errorSpy.mock.calls.find(([component]) => component === 'ToolRegistry');
      expect(call).toBeDefined();
      const data = call![2];
      expect(data).toMatchObject({
        tool: 'team_memory_write',
        argKeys: ['key', 'namespace', 'value'],
        key: 'invalid key!',
        namespace: 'decisions',
      });
      expect(JSON.stringify(data)).not.toContain('SECRET-MEMORY-VALUE');
    } finally {
      errorSpy.mockRestore();
    }
  });
});
