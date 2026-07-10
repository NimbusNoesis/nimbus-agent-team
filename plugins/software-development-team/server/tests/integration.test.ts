import { describe, it, expect, beforeEach } from 'vitest';
import { StateMachine } from '../src/state/machine.js';
import { MessageBus } from '../src/bus/message-bus.js';
import { MemoryStore } from '../src/memory/store.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { Database } from '../src/db/database.js';

describe('Integration: Full workflow', () => {
  let registry: ToolRegistry;

  beforeEach(async () => {
    const db = await Database.create();
    registry = new ToolRegistry(
      new StateMachine(db),
      new MessageBus(db),
      new MemoryStore(db),
    );
  });

  it('completes a two-step run with one revision', async () => {
    const { runId } = await registry.handle('team_start', {
      steps: [
        { id: 1, description: 'Create model', files: ['model.ts'], acceptanceCriteria: ['Tests pass'], dependsOn: [] },
        { id: 2, description: 'Create API', files: ['api.ts'], acceptanceCriteria: ['Endpoints work'], dependsOn: [1] },
      ],
    });

    // Step 1: code
    await registry.handle('team_advance', { runId, stepId: 1, action: 'start_coding', agent: 'coder' });
    let status = await registry.handle('team_status', { runId });
    expect(status.steps[0].status).toBe('coding');
    expect(status.status).toBe('in_progress');

    // Step 1: coder submits
    await registry.handle('team_submit_result', {
      runId, stepId: 1, result: { status: 'done', summary: 'Created model' },
    });
    status = await registry.handle('team_status', { runId });
    expect(status.steps[0].status).toBe('reviewing');

    // Step 1: reviewer submits needs_revision, then requests revision
    await registry.handle('team_submit_result', {
      runId, stepId: 1, result: { status: 'needs_revision', summary: 'Missing validation' },
    });
    await registry.handle('team_advance', { runId, stepId: 1, action: 'request_revision' });
    status = await registry.handle('team_status', { runId });
    expect(status.steps[0].status).toBe('coding');
    expect(status.steps[0].retryCount).toBe(1);

    // Step 1: coder resubmits
    await registry.handle('team_submit_result', {
      runId, stepId: 1, result: { status: 'done', summary: 'Fixed model' },
    });

    // Step 1: reviewer approves
    await registry.handle('team_advance', { runId, stepId: 1, action: 'approve' });
    status = await registry.handle('team_status', { runId });
    expect(status.steps[0].status).toBe('complete');

    // Step 2: code (dependency on step 1 now met)
    await registry.handle('team_advance', { runId, stepId: 2, action: 'start_coding', agent: 'coder' });
    await registry.handle('team_submit_result', {
      runId, stepId: 2, result: { status: 'done', summary: 'Created API' },
    });
    await registry.handle('team_advance', { runId, stepId: 2, action: 'approve' });

    // Run complete
    status = await registry.handle('team_status', { runId });
    expect(status.status).toBe('complete');
    expect(status.steps.every((s: any) => s.status === 'complete')).toBe(true);
  });

  it('escalates after retry budget exhausted and recovers', async () => {
    const { runId } = await registry.handle('team_start', {
      steps: [
        { id: 1, description: 'Tricky step', files: ['a.ts'], acceptanceCriteria: ['Works'], dependsOn: [] },
      ],
    });

    // First attempt: start from pending
    await registry.handle('team_advance', { runId, stepId: 1, action: 'start_coding', agent: 'coder' });

    // 3 retries succeed (retryCount 1, 2, 3 — all stay in coding)
    // After requestRevision step is 'coding', so no re-start_coding needed
    for (let i = 0; i < 3; i++) {
      await registry.handle('team_submit_result', {
        runId, stepId: 1, result: { status: 'done', summary: `Attempt ${i + 1}` },
      });
      // Reviewer submits needs_revision before requesting revision
      await registry.handle('team_submit_result', {
        runId, stepId: 1, result: { status: 'needs_revision', summary: 'Still needs work' },
      });
      await registry.handle('team_advance', { runId, stepId: 1, action: 'request_revision' });
      const status = await registry.handle('team_status', { runId });
      expect(status.steps[0].status).toBe('coding');
    }

    // 4th revision triggers escalation (retryCount = 4 > MAX_RETRIES=3)
    await registry.handle('team_submit_result', {
      runId, stepId: 1, result: { status: 'done', summary: 'Attempt 4' },
    });
    await registry.handle('team_submit_result', {
      runId, stepId: 1, result: { status: 'needs_revision', summary: 'Still needs work' },
    });
    await registry.handle('team_advance', { runId, stepId: 1, action: 'request_revision' });

    let status = await registry.handle('team_status', { runId });
    expect(status.steps[0].status).toBe('escalated');
    expect(status.status).toBe('escalated');

    // User resolves escalation
    await registry.handle('team_advance', { runId, stepId: 1, action: 'resolve_escalation' });
    status = await registry.handle('team_status', { runId });
    expect(status.steps[0].status).toBe('coding');
    expect(status.status).toBe('in_progress');
  });

  it('prevents approving a step with needs_revision result', async () => {
    const { runId } = await registry.handle('team_start', {
      steps: [{ id: 1, description: 'S1', files: [], acceptanceCriteria: [], dependsOn: [] }],
    });

    await registry.handle('team_advance', { runId, stepId: 1, action: 'start_coding', agent: 'coder' });
    await registry.handle('team_submit_result', {
      runId, stepId: 1, result: { status: 'done', summary: 'coded' },
    });
    // Reviewer submits needs_revision
    await registry.handle('team_submit_result', {
      runId, stepId: 1, result: { status: 'needs_revision', summary: 'missing validation' },
    });
    // Coordinator tries to approve — should fail
    await expect(
      registry.handle('team_advance', { runId, stepId: 1, action: 'approve' })
    ).rejects.toThrow('cannot be approved');
  });

  it('messages flow between agents', async () => {
    const { runId } = await registry.handle('team_start', {
      steps: [{ id: 1, description: 'S1', files: [], acceptanceCriteria: [], dependsOn: [] }],
    });

    await registry.handle('team_send_message', {
      runId, from: 'coordinator', to: 'all', type: 'info', body: 'Starting run',
    });

    await registry.handle('team_send_message', {
      runId, from: 'user', to: 'coordinator', type: 'guidance', body: 'Focus on tests',
    });

    const result = await registry.handle('team_get_messages', { runId, to: 'coordinator' });
    expect(result.messages).toHaveLength(2);
  });

  it('memory persists across tool calls', async () => {
    await registry.handle('team_memory_write', {
      key: 'auth', namespace: 'decisions', value: 'Use JWT',
    });
    await registry.handle('team_memory_write', {
      key: 'db', namespace: 'context', value: 'PostgreSQL with Prisma',
    });

    const decisions = await registry.handle('team_memory_read', { namespace: 'decisions' });
    expect(decisions.entries).toHaveLength(1);

    const search = await registry.handle('team_memory_read', { search: 'JWT' });
    expect(search.entries).toHaveLength(1);
  });

  it('pipeline parallelism: step N+1 blocked when N has dependency and is not complete', async () => {
    const { runId } = await registry.handle('team_start', {
      steps: [
        { id: 1, description: 'S1', files: [], acceptanceCriteria: [], dependsOn: [] },
        { id: 2, description: 'S2', files: [], acceptanceCriteria: [], dependsOn: [1] },
      ],
    });

    // Start and submit step 1 — now reviewing
    await registry.handle('team_advance', { runId, stepId: 1, action: 'start_coding', agent: 'coder' });
    await registry.handle('team_submit_result', {
      runId, stepId: 1, result: { status: 'done', summary: 'done' },
    });

    // Step 2 depends on step 1 — can't start while step 1 is reviewing
    await expect(
      registry.handle('team_advance', { runId, stepId: 2, action: 'start_coding', agent: 'coder' })
    ).rejects.toThrow('dependencies');

    // Complete step 1
    await registry.handle('team_advance', { runId, stepId: 1, action: 'approve' });

    // Now step 2 can start
    await registry.handle('team_advance', { runId, stepId: 2, action: 'start_coding', agent: 'coder' });
    const status = await registry.handle('team_status', { runId });
    expect(status.steps[1].status).toBe('coding');
  });

  it('admits multiple disjoint initial coding steps in parallel', async () => {
    const { runId } = await registry.handle('team_start', {
      steps: [
        { id: 1, description: 'Model', files: ['model.ts'], acceptanceCriteria: [], dependsOn: [] },
        { id: 2, description: 'API', files: ['api.ts'], acceptanceCriteria: [], dependsOn: [] },
        { id: 3, description: 'UI', files: ['ui.ts'], acceptanceCriteria: [], dependsOn: [] },
      ],
    });

    await Promise.all([
      registry.handle('team_advance', { runId, stepId: 1, action: 'start_coding', agent: 'coder-1' }),
      registry.handle('team_advance', { runId, stepId: 2, action: 'start_coding', agent: 'coder-2' }),
      registry.handle('team_advance', { runId, stepId: 3, action: 'start_coding', agent: 'coder-3' }),
    ]);

    const status = await registry.handle('team_status', { runId });
    expect(status.steps.map((step: any) => step.status)).toEqual(['coding', 'coding', 'coding']);
    expect(status.steps.map((step: any) => step.assignedAgent)).toEqual(['coder-1', 'coder-2', 'coder-3']);
  });

  it('rejects dependency and file-overlap starts without disturbing admitted work', async () => {
    const { runId } = await registry.handle('team_start', {
      steps: [
        { id: 1, description: 'Shared base', files: ['shared.ts'], acceptanceCriteria: [], dependsOn: [] },
        { id: 2, description: 'Dependent', files: ['dependent.ts'], acceptanceCriteria: [], dependsOn: [1] },
        { id: 3, description: 'Overlapping', files: ['shared.ts'], acceptanceCriteria: [], dependsOn: [] },
      ],
    });

    await registry.handle('team_advance', { runId, stepId: 1, action: 'start_coding', agent: 'coder-1' });
    await expect(registry.handle('team_advance', {
      runId, stepId: 2, action: 'start_coding', agent: 'coder-2',
    })).rejects.toThrow('dependencies');
    await expect(registry.handle('team_advance', {
      runId, stepId: 3, action: 'start_coding', agent: 'coder-3',
    })).rejects.toThrow('file conflicts');

    const status = await registry.handle('team_status', { runId });
    expect(status.steps[0].status).toBe('coding');
    expect(status.steps[0].assignedAgent).toBe('coder-1');
    expect(status.steps[1].status).toBe('pending');
    expect(status.steps[2].status).toBe('pending');
    expect(status.steps[2].blockingReasons.join(' ')).toContain('shared.ts');
  });

  it('exposes a blocker when a stale status snapshot loses a competing claim', async () => {
    const { runId } = await registry.handle('team_start', {
      steps: [
        { id: 1, description: 'First claimant', files: ['shared.ts'], acceptanceCriteria: [], dependsOn: [] },
        { id: 2, description: 'Second claimant', files: ['shared.ts'], acceptanceCriteria: [], dependsOn: [] },
      ],
    });

    const stale = await registry.handle('team_status', { runId });
    expect(stale.steps[1].blockingReasons).toEqual([]);
    await registry.handle('team_advance', { runId, stepId: 1, action: 'start_coding', agent: 'winner' });

    await expect(registry.handle('team_advance', {
      runId, stepId: 2, action: 'start_coding', agent: 'loser',
    })).rejects.toThrow('file conflicts');
    const refreshed = await registry.handle('team_status', { runId });
    expect(refreshed.steps[1].status).toBe('pending');
    expect(refreshed.steps[1].blockingReasons.join(' ')).toContain('step 1');
    expect(refreshed.steps[0].assignedAgent).toBe('winner');
  });

  it('preserves independent concurrent claims, results, and timestamps', async () => {
    const { runId } = await registry.handle('team_start', {
      steps: [
        { id: 1, description: 'One', files: ['one.ts'], acceptanceCriteria: [], dependsOn: [] },
        { id: 2, description: 'Two', files: ['two.ts'], acceptanceCriteria: [], dependsOn: [] },
      ],
    });
    await Promise.all([
      registry.handle('team_advance', { runId, stepId: 1, action: 'start_coding', agent: 'agent-one' }),
      registry.handle('team_advance', { runId, stepId: 2, action: 'start_coding', agent: 'agent-two' }),
    ]);
    await Promise.all([
      registry.handle('team_submit_result', { runId, stepId: 1, result: { status: 'done', summary: 'one complete' } }),
      registry.handle('team_submit_result', { runId, stepId: 2, result: { status: 'done', summary: 'two complete' } }),
    ]);

    const status = await registry.handle('team_status', { runId });
    for (const [index, summary] of ['one complete', 'two complete'].entries()) {
      expect(status.steps[index].status).toBe('reviewing');
      expect(status.steps[index].result.summary).toBe(summary);
      expect(status.steps[index].assignedAgent).toBe(`agent-${index === 0 ? 'one' : 'two'}`);
      expect(status.steps[index].claimedFiles).toHaveLength(1);
      expect(status.steps[index].startedAt).toBeTruthy();
    }
    expect(status.updatedAt).toBeTruthy();
  });
});
