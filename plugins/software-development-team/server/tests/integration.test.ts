import { randomUUID } from 'node:crypto';
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import WebSocket from 'ws';
import { StateMachine } from '../src/state/machine.js';
import { MessageBus } from '../src/bus/message-bus.js';
import { MessageLogSync } from '../src/bus/message-sync.js';
import { MemoryStore } from '../src/memory/store.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { Database } from '../src/db/database.js';
import { makeWorktree } from './helpers.js';
import { Persistence } from '../src/state/persistence.js';
import { PersistQueue, PersistenceUnavailableError } from '../src/state/persist-queue.js';
import { startDashboard } from '../src/dashboard/server.js';
import { logger } from '../src/logger.js';
import type { Message } from '../src/types.js';

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

  const persistWorktrees = async (runId: string, ...stepIds: number[]): Promise<void> => {
    for (const stepId of stepIds) {
      await registry.handle('team_advance', {
        runId,
        stepId,
        action: 'set_worktree',
        worktree: makeWorktree(runId, stepId),
      });
    }
  };

  it('completes a two-step run with one revision', async () => {
    const { runId } = await registry.handle('team_start', {
      steps: [
        { id: 1, description: 'Create model', files: ['model.ts'], acceptanceCriteria: ['Tests pass'], dependsOn: [] },
        { id: 2, description: 'Create API', files: ['api.ts'], acceptanceCriteria: ['Endpoints work'], dependsOn: [1] },
      ],
    });
    await persistWorktrees(runId, 1, 2);

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

    await persistWorktrees(runId, 1);

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

  it('cancels an active run cooperatively and retries an escalated step through team_control', async () => {
    const { runId } = await registry.handle('team_start', {
      steps: [{ id: 1, description: 'Active', files: ['active.ts'], acceptanceCriteria: [], dependsOn: [] }],
    });
    await persistWorktrees(runId, 1);
    await registry.handle('team_advance', { runId, stepId: 1, action: 'start_coding', agent: 'coder' });
    const requested = await registry.handle('team_control', {
      runId, action: 'cancel_run', target: { kind: 'run' }, commandId: 'cancel-run', expectedRevision: 0,
      confirmation: true, reason: 'Operator stopped the run',
    });
    expect(requested).toMatchObject({ phase: 'cancelling', revision: 1 });
    expect(requested).not.toHaveProperty('stepStatus');
    await expect(registry.handle('team_submit_result', {
      runId, stepId: 1, result: { status: 'done', summary: 'late output' },
    })).rejects.toThrow("status 'cancelling'");
    const acknowledged = await registry.handle('team_control', {
      runId, action: 'acknowledge_cancel', target: { kind: 'run' }, commandId: 'cancel-run-ack', expectedRevision: 1,
    });
    expect(acknowledged).toMatchObject({ phase: 'cancelled', status: 'cancelled', revision: 2 });
    const cancelledStatus = await registry.handle('team_status', { runId });
    expect(cancelledStatus.steps[0]).toMatchObject({ status: 'cancelled', claimedFiles: [] });

    const { runId: retryRunId } = await registry.handle('team_start', {
      steps: [{ id: 1, description: 'Retryable', files: ['retry.ts'], acceptanceCriteria: [], dependsOn: [] }],
    });
    await persistWorktrees(retryRunId, 1);
    await registry.handle('team_advance', { runId: retryRunId, stepId: 1, action: 'start_coding', agent: 'coder' });
    await registry.handle('team_submit_result', {
      runId: retryRunId, stepId: 1, result: { status: 'blocked', summary: 'needs operator retry' },
    });
    const retried = await registry.handle('team_control', {
      runId: retryRunId, action: 'retry_step', target: { kind: 'step', stepId: 1 },
      commandId: 'retry-step', expectedRevision: 0, reason: 'Issue resolved',
    });
    expect(retried).toMatchObject({ stepStatus: 'coding', revision: 1 });
    const retryStatus = await registry.handle('team_status', { runId: retryRunId });
    expect(retryStatus.steps[0]).toMatchObject({ manualAttempt: 1, retryCount: 0, status: 'coding' });
  });

  it('prevents approving a step with needs_revision result', async () => {
    const { runId } = await registry.handle('team_start', {
      steps: [{ id: 1, description: 'S1', files: [], acceptanceCriteria: [], dependsOn: [] }],
    });
    await persistWorktrees(runId, 1);

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
    await persistWorktrees(runId, 1, 2);

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
    await persistWorktrees(runId, 1, 2, 3);

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
    await persistWorktrees(runId, 1, 2, 3);

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
    await persistWorktrees(runId, 1, 2);

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
    await persistWorktrees(runId, 1, 2);
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

describe('Integration: cross-instance message sync', () => {
  it('syncs a sibling on-disk append to a live WS client without echoing it back to the jsonl', async () => {
    const teamDir = await mkdtemp(join(tmpdir(), 'team-sync-e2e-'));
    let ws: WebSocket | undefined;
    const sync = { current: undefined as MessageLogSync | undefined };
    try {
      // Compose the production chain exactly as index.ts wires it: one
      // Persistence + PersistQueue, appendMessage bound ONLY to 'message',
      // dashboard listening to both 'message' and 'external_message', and a
      // MessageLogSync ingesting via bus.ingestExternal.
      const db = await Database.create();
      const sm = new StateMachine(db);
      const bus = new MessageBus(db);
      const memory = new MemoryStore(db);
      const persistence = new Persistence(teamDir);
      const persistQueue = new PersistQueue();
      bus.on('message', (msg) => {
        persistQueue.enqueue(() => persistence.appendMessage(msg.runId, msg), {
          kind: 'message',
          runId: msg.runId,
        });
      });
      sync.current = new MessageLogSync({
        runsDir: join(teamDir, 'runs'),
        isKnownRun: (runId) => Boolean(sm.getRun(runId)),
        ingest: (message) => bus.ingestExternal(message),
      });

      const run = sm.createRun([{
        id: 1, description: 'Sync step', files: [], acceptanceCriteria: [], dependsOn: [],
      }], 'Cross-instance sync');
      const logFile = join(teamDir, 'runs', run.id, 'messages.jsonl');

      // One local message creates the on-disk log; the first sync pass then
      // primes the per-run offset at the current file size (history is
      // already in the local DB — startup restore's job, not the sync's).
      bus.post({ runId: run.id, from: 'coordinator', to: 'all', type: 'info', body: 'local message' });
      await persistQueue.drain();
      await sync.current.syncNow();

      const port = await startDashboard(sm, bus, memory, persistQueue);
      ws = await new Promise<WebSocket>((resolve, reject) => {
        const socket = new WebSocket(`ws://localhost:${port}`);
        socket.on('open', () => resolve(socket));
        socket.on('error', reject);
      });
      const frames: any[] = [];
      ws.on('message', (data) => frames.push(JSON.parse(data.toString())));

      // Simulate the incident's sibling server process: it appends its own
      // durably-owned line (own id/timestamp) directly to the shared jsonl.
      const siblingMessage: Message = {
        id: randomUUID(),
        runId: run.id,
        from: 'coder',
        to: 'coordinator',
        type: 'info',
        body: 'written by a sibling process',
        timestamp: new Date().toISOString(),
      };
      await appendFile(logFile, JSON.stringify(siblingMessage) + '\n');

      // Deterministic sync pass — never rely on fs.watch/poll timing.
      await sync.current.syncNow();

      // The live WS client received new_message with the ORIGINAL id and
      // timestamp (never restamped).
      await vi.waitFor(() => {
        expect(frames.some((frame) => frame.type === 'new_message')).toBe(true);
      });
      const newMessages = frames.filter((frame) => frame.type === 'new_message');
      expect(newMessages).toHaveLength(1);
      expect(newMessages[0].message).toEqual(siblingMessage);

      // Ingested exactly once into the local DB alongside the local message.
      expect(bus.getAllMessages(run.id).map((m) => m.body)).toEqual([
        'local message',
        'written by a sibling process',
      ]);

      // Anti-echo: ingestion emitted 'external_message', not 'message', so
      // the appendMessage listener never re-appended the sibling's line.
      await persistQueue.drain();
      const lines = (await readFile(logFile, 'utf-8')).split('\n').filter((line) => line.trim() !== '');
      expect(lines).toHaveLength(2);
      expect(lines.filter((line) => line.includes(siblingMessage.id))).toHaveLength(1);

      // And a further pass stays quiet: offset advanced, nothing re-ingested.
      await sync.current.syncNow();
      expect(bus.getAllMessages(run.id)).toHaveLength(2);
    } finally {
      sync.current?.stop();
      ws?.close();
      await rm(teamDir, { recursive: true, force: true });
    }
  });
});

describe('Integration: concurrent durability failure', () => {
  it('makes concurrent mutation responses fail globally and skips queued work after the first failure', async () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    try {
      const db = await Database.create();
      const sm = new StateMachine(db);
      const bus = new MessageBus(db);
      const memory = new MemoryStore(db);
      const persistence = new PersistQueue();
      const registry = new ToolRegistry(sm, bus, memory, persistence);
      let persistenceAttempts = 0;

      memory.on('entry_change', () => {
        persistence.enqueue(async () => {
          persistenceAttempts += 1;
          throw new Error('first write failed');
        }, { kind: 'memory_entry' });
      });

      const first = registry.handle('team_memory_write', {
        key: 'first', namespace: 'context', value: 'volatile one',
      });
      const second = registry.handle('team_memory_write', {
        key: 'second', namespace: 'context', value: 'volatile two',
      });

      const results = await Promise.allSettled([first, second]);
      expect(results).toHaveLength(2);
      for (const result of results) {
        expect(result.status).toBe('rejected');
        if (result.status === 'rejected') expect(result.reason).toBeInstanceOf(PersistenceUnavailableError);
      }
      expect(persistenceAttempts).toBe(1);
      expect(memory.getAll()).toHaveLength(1);
      expect(persistence.health).toMatchObject({ status: 'failed', operationKind: 'memory_entry' });
    } finally {
      errorSpy.mockRestore();
    }
  });
});
