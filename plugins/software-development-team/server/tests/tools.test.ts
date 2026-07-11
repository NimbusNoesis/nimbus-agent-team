import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ToolRegistry } from '../src/tools/registry.js';
import { StateMachine } from '../src/state/machine.js';
import { MessageBus } from '../src/bus/message-bus.js';
import { MemoryStore } from '../src/memory/store.js';
import { Database } from '../src/db/database.js';
import { logger } from '../src/logger.js';

describe('ToolRegistry', () => {
  let registry: ToolRegistry;

  beforeEach(async () => {
    const db = await Database.create();
    registry = new ToolRegistry(
      new StateMachine(db),
      new MessageBus(db),
      new MemoryStore(db),
    );
  });

  it('team_start creates a run and returns run ID', async () => {
    const result = await registry.handle('team_start', {
      steps: [
        { id: 1, description: 'Step 1', files: ['a.ts'], acceptanceCriteria: ['works'], dependsOn: [] },
      ],
    });
    expect(result.runId).toBeDefined();
    expect(result.status).toBe('ready');
    expect(result.stepCount).toBe(1);
  });

  it('team_status returns current run state', async () => {
    const { runId } = await registry.handle('team_start', {
      steps: [{ id: 1, description: 'Step 1', files: [], acceptanceCriteria: [], dependsOn: [] }],
    });
    const status = await registry.handle('team_status', { runId });
    expect(status.status).toBe('ready');
    expect(status.steps).toHaveLength(1);
  });

  it('team_status reports pending dependency and file conflict blockers', async () => {
    const { runId } = await registry.handle('team_start', {
      steps: [
        { id: 1, description: 'Active work', files: ['shared.ts'], acceptanceCriteria: [], dependsOn: [] },
        { id: 2, description: 'Blocked work', files: ['shared.ts'], acceptanceCriteria: [], dependsOn: [1] },
      ],
    });
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

  it('team_advance with resolve_escalation works on escalated step', async () => {
    const { runId } = await registry.handle('team_start', {
      steps: [{ id: 1, description: 'S1', files: [], acceptanceCriteria: [], dependsOn: [] }],
    });
    await registry.handle('team_advance', { runId, stepId: 1, action: 'start_coding' });
    await registry.handle('team_submit_result', {
      runId, stepId: 1, result: { status: 'blocked', summary: 'stuck' },
    });
    const result = await registry.handle('team_advance', {
      runId, stepId: 1, action: 'resolve_escalation',
    });
    expect(result.stepStatus).toBe('coding');
  });

  it('team_advance with mark_reviewed closes a read-only review step', async () => {
    const { runId } = await registry.handle('team_start', {
      steps: [{ id: 1, description: 'S1', files: [], acceptanceCriteria: [], dependsOn: [] }],
    });
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
    const worktree = {
      targetBranch: 'main', targetCommit: 'abc123',
      path: '.worktrees/run/step-1', branch: 'team-run-step-1',
    };
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
