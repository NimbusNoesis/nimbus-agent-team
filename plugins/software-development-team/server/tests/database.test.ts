import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Database } from '../src/db/database.js';
import { StateMachine } from '../src/state/machine.js';
import { makeRun, makeMessage, makeMemoryEntry } from './helpers.js';
import type { RunState, Message, MemoryEntry } from '../src/types.js';
import {
  EXECUTION_CONTROL_CAPABILITIES,
  MAX_COMMAND_RECEIPTS,
  MAX_LIFECYCLE_HISTORY,
  RUN_LIFECYCLE_VERSION,
  type RunControlPhase,
} from '../src/types.js';

function makeLifecycleRun(
  id: string,
  controlPhase: RunControlPhase,
  status: RunState['status'],
): RunState {
  return makeRun(id, {
    status,
    steps: [{
      step: {
        id: 1, description: 'durable work', files: ['src/durable.ts'],
        acceptanceCriteria: ['survives restart'], dependsOn: [],
      },
      status: controlPhase === 'cancelled'
        ? 'cancelled'
        : controlPhase === 'cancelling' ? 'cancelling' : 'reviewing',
      retryCount: 1,
      assignedAgent: controlPhase === 'cancelled' ? null : 'reviewer',
      result: { status: 'done_with_concerns', summary: 'implementation retained' },
      resultHistory: [{ status: 'done', summary: 'coder result retained' }],
      claimedFiles: controlPhase === 'cancelled' ? [] : ['src/durable.ts'],
      consecutiveSameError: 0,
      manualAttempt: 2,
      cancelRequestedAt: '2026-01-01T00:00:05.000Z',
      cancelledAt: '2026-01-01T00:00:06.000Z',
      worktree: {
        targetBranch: 'main', targetCommit: 'abc123',
        path: `.worktrees/${id}/step-1`, branch: `team-${id}-step-1`,
      },
    }],
    lifecycle: {
      version: RUN_LIFECYCLE_VERSION,
      capabilities: EXECUTION_CONTROL_CAPABILITIES,
      controlPhase,
      revision: 23,
      pauseRequestedAt: '2026-01-01T00:00:02.000Z',
      pausedAt: '2026-01-01T00:00:03.000Z',
      cancelRequestedAt: '2026-01-01T00:00:04.000Z',
      commandReceipts: [{
        commandId: 'command-23', fingerprint: `phase:${controlPhase}`,
        action: 'pause_run', target: { kind: 'run' }, expectedRevision: 22,
        revision: 23, recordedAt: '2026-01-01T00:00:07.000Z',
        outcome: { controlPhase, runStatus: status },
      }],
      history: [{
        commandId: 'command-23', action: 'pause_run', target: { kind: 'run' },
        revision: 23, recordedAt: '2026-01-01T00:00:07.000Z',
        fromPhase: 'none', toPhase: controlPhase, summary: 'durable audit entry',
      }],
    },
  });
}

async function restartDatabase(db: Database): Promise<Database> {
  const sqlDb = (db as unknown as { db: { export: () => Uint8Array } }).db;
  const initSqlJs = (await import('sql.js')).default;
  const SQL = await initSqlJs();
  return new Database(new SQL.Database(sqlDb.export()));
}

describe('Database', () => {
  let db: Database;

  beforeEach(async () => {
    db = await Database.create();
  });

  describe('Run CRUD', () => {
    it('insertRun + getRun round-trips a full RunState', () => {
      const run = makeRun('r1', {
        task: 'Build the thing',
        status: 'ready',
        lifecycle: {
          version: RUN_LIFECYCLE_VERSION,
          capabilities: EXECUTION_CONTROL_CAPABILITIES,
          controlPhase: 'none',
          revision: 0,
          commandReceipts: [],
          history: [],
        },
      });
      db.insertRun(run);
      const retrieved = db.getRun('r1');
      expect(retrieved).toEqual(run);
    });

    it('getRun returns undefined for non-existent id', () => {
      expect(db.getRun('nonexistent')).toBeUndefined();
    });

    it('getAllRuns returns runs ordered by created_at ASC', () => {
      const early = makeRun('r1', { createdAt: '2026-01-01T00:00:00Z' });
      const late = makeRun('r2', { createdAt: '2026-01-02T00:00:00Z' });
      db.insertRun(late);
      db.insertRun(early);
      const runs = db.getAllRuns();
      expect(runs).toHaveLength(2);
      expect(runs[0].id).toBe('r1');
      expect(runs[1].id).toBe('r2');
    });

    it('getAllRuns returns empty array when no runs exist', () => {
      expect(db.getAllRuns()).toEqual([]);
    });

    it('updateRun persists changes', () => {
      const run = makeRun('r1', { status: 'ready' });
      db.insertRun(run);
      run.status = 'complete';
      run.task = 'Updated task';
      db.updateRun(run);
      const retrieved = db.getRun('r1');
      expect(retrieved!.status).toBe('complete');
      expect(retrieved!.task).toBe('Updated task');
    });

    it('insertRun with duplicate id throws', () => {
      const run = makeRun('r1');
      db.insertRun(run);
      expect(() => db.insertRun(run)).toThrow();
    });

    it.each([undefined, 1] as const)(
      'normalizes legacy lifecycle version %s on read without a migration write or event',
      (version) => {
        const legacy = makeRun(`legacy-${version ?? 'missing'}`, {
          steps: [{
            step: {
              id: 1, description: 'legacy work', files: ['src/legacy.ts'],
              acceptanceCriteria: [], dependsOn: [],
            },
            status: 'coding', retryCount: 0, assignedAgent: 'coder', result: null,
            claimedFiles: ['src/legacy.ts'], consecutiveSameError: 0,
            manualAttempt: 8,
            cancelRequestedAt: '2026-01-01T00:00:02.000Z',
            cancelledAt: '2026-01-01T00:00:03.000Z',
          }],
          lifecycle: {
            version: (version ?? 2) as 2,
            capabilities: EXECUTION_CONTROL_CAPABILITIES,
            controlPhase: 'cancelling', revision: 14,
            commandReceipts: [{ commandId: 'legacy-receipt' }] as never,
            history: [{ commandId: 'legacy-history' }] as never,
            cancelRequestedAt: '2026-01-01T00:00:04.000Z',
          },
        });
        if (version === undefined) delete legacy.lifecycle;
        else (legacy.lifecycle as unknown as { version: number }).version = version;

        db.insertRun(legacy);
        const updateSpy = vi.spyOn(db, 'updateRun');
        const sm = new StateMachine(db);
        const stateEvent = vi.fn();
        sm.on('state_update', stateEvent);

        const restored = sm.getRun(legacy.id)!;
        expect(restored.lifecycle).toEqual({
          version: RUN_LIFECYCLE_VERSION,
          capabilities: EXECUTION_CONTROL_CAPABILITIES,
          controlPhase: 'none', revision: 0, commandReceipts: [], history: [],
        });
        expect(restored.steps[0].manualAttempt).toBe(0);
        expect(restored.steps[0]).not.toHaveProperty('cancelRequestedAt');
        expect(restored.steps[0]).not.toHaveProperty('cancelledAt');
        expect(updateSpy).not.toHaveBeenCalled();
        expect(stateEvent).not.toHaveBeenCalled();
      },
    );

    it.each([
      ['pausing', 'in_progress'],
      ['paused', 'in_progress'],
      ['cancelling', 'in_progress'],
      ['cancelled', 'cancelled'],
    ] as const)('round-trips durable lifecycle phase %s across an adapter restart', async (phase, status) => {
      const run = makeLifecycleRun(`phase-${phase}`, phase, status);
      db.insertRun(run);

      const restarted = await restartDatabase(db);
      const restored = restarted.getRun(run.id)!;
      expect(restored).toEqual(run);
      expect(restored.lifecycle).toMatchObject({
        version: RUN_LIFECYCLE_VERSION,
        capabilities: EXECUTION_CONTROL_CAPABILITIES,
        controlPhase: phase,
        revision: 23,
      });
      expect(restored.steps[0]).toMatchObject({
        manualAttempt: 2,
        cancelRequestedAt: '2026-01-01T00:00:05.000Z',
        cancelledAt: '2026-01-01T00:00:06.000Z',
        worktree: run.steps[0].worktree,
        result: run.steps[0].result,
        resultHistory: run.steps[0].resultHistory,
      });
    });

    it('bounds lifecycle receipts and history when reading persisted JSON', () => {
      const run = makeLifecycleRun('bounded', 'paused', 'in_progress');
      run.lifecycle!.commandReceipts = Array.from(
        { length: MAX_COMMAND_RECEIPTS + 3 },
        (_, index) => ({
          commandId: `receipt-${index}`, fingerprint: `fingerprint-${index}`,
          action: 'pause_run' as const, target: { kind: 'run' as const },
          expectedRevision: index, revision: index + 1,
          recordedAt: '2026-01-01T00:00:00.000Z',
          outcome: { controlPhase: 'paused' as const, runStatus: 'in_progress' as const },
        }),
      );
      run.lifecycle!.history = Array.from(
        { length: MAX_LIFECYCLE_HISTORY + 4 },
        (_, index) => ({
          commandId: `history-${index}`, action: 'pause_run' as const,
          target: { kind: 'run' as const }, revision: index + 1,
          recordedAt: '2026-01-01T00:00:00.000Z',
          fromPhase: 'none' as const, toPhase: 'pausing' as const,
        }),
      );
      db.insertRun(run);

      const restored = db.getRun(run.id)!;
      expect(restored.lifecycle!.commandReceipts).toHaveLength(MAX_COMMAND_RECEIPTS);
      expect(restored.lifecycle!.commandReceipts[0].commandId).toBe('receipt-3');
      expect(restored.lifecycle!.history).toHaveLength(MAX_LIFECYCLE_HISTORY);
      expect(restored.lifecycle!.history[0].commandId).toBe('history-4');
    });

    it('fails closed when persisted JSON declares a future lifecycle version', () => {
      const future = makeRun('future', { lifecycle: {
        version: RUN_LIFECYCLE_VERSION,
        capabilities: EXECUTION_CONTROL_CAPABILITIES,
        controlPhase: 'none', revision: 0, commandReceipts: [], history: [],
      } });
      (future.lifecycle as unknown as { version: number }).version = RUN_LIFECYCLE_VERSION + 1;
      db.insertRun(future);

      expect(() => db.getRun(future.id)).toThrow(
        /Unsupported run lifecycle version 3.*Upgrade/s,
      );
      expect(() => db.getAllRuns()).toThrow(/Unsupported run lifecycle version 3/);
    });

    it('keeps the existing runs SQL schema unchanged', () => {
      const sqlDb = (db as unknown as {
        db: { exec: (sql: string) => Array<{ values: unknown[][] }> };
      }).db;
      const [result] = sqlDb.exec('PRAGMA table_info(runs)');
      expect(result.values.map((row) => row[1])).toEqual([
        'id', 'task', 'status', 'data', 'created_at', 'updated_at',
      ]);
    });
  });

  describe('Message CRUD', () => {
    it('insertMessage + getMessages round-trips correctly', () => {
      const msg = makeMessage({ id: 'm1', runId: 'r1' });
      db.insertMessage(msg);
      const messages = db.getMessages('r1');
      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual(msg);
    });

    it('getMessages returns empty array for unknown runId', () => {
      expect(db.getMessages('nonexistent')).toEqual([]);
    });

    it('getMessages returns messages ordered by timestamp ASC', () => {
      db.insertMessage(makeMessage({ id: 'm2', runId: 'r1', timestamp: '2026-01-01T00:02:00Z' }));
      db.insertMessage(makeMessage({ id: 'm1', runId: 'r1', timestamp: '2026-01-01T00:01:00Z' }));
      const messages = db.getMessages('r1');
      expect(messages[0].id).toBe('m1');
      expect(messages[1].id).toBe('m2');
    });

    it('hasMessage returns true for an existing message id', () => {
      db.insertMessage(makeMessage({ id: 'm1', runId: 'r1' }));
      expect(db.hasMessage('m1')).toBe(true);
    });

    it('hasMessage returns false for an unknown message id', () => {
      db.insertMessage(makeMessage({ id: 'm1', runId: 'r1' }));
      expect(db.hasMessage('m2')).toBe(false);
    });

    it('hasMessage matches by id regardless of run', () => {
      db.insertMessage(makeMessage({ id: 'm1', runId: 'r1' }));
      // Dedupe is by message id (globally unique UUIDs), not (run, id).
      expect(db.hasMessage('m1')).toBe(true);
      expect(db.getMessages('r2')).toEqual([]);
    });

    it('getMessagesByRun maps column names correctly', () => {
      db.insertMessage(makeMessage({ id: 'm1', runId: 'r1', from: 'coder', to: 'reviewer' }));
      const messages = db.getMessagesByRun('r1');
      expect(messages[0].from).toBe('coder');
      expect(messages[0].to).toBe('reviewer');
      expect(messages[0].runId).toBe('r1');
    });
  });

  describe('enforceMessageCap', () => {
    it('does nothing when count <= maxMessages', () => {
      db.insertMessage(makeMessage({ id: 'm1', runId: 'r1' }));
      db.insertMessage(makeMessage({ id: 'm2', runId: 'r1' }));
      db.enforceMessageCap('r1', 5);
      expect(db.getMessages('r1')).toHaveLength(2);
    });

    it('deletes oldest messages when count exceeds maxMessages by 1', () => {
      for (let i = 0; i < 4; i++) {
        db.insertMessage(makeMessage({
          id: `m${i}`,
          runId: 'r1',
          timestamp: `2026-01-01T00:0${i}:00Z`,
        }));
      }
      db.enforceMessageCap('r1', 3);
      const messages = db.getMessages('r1');
      expect(messages).toHaveLength(3);
      expect(messages[0].id).toBe('m1');
    });

    it('deletes oldest N messages when count exceeds maxMessages by N', () => {
      for (let i = 0; i < 5; i++) {
        db.insertMessage(makeMessage({
          id: `m${i}`,
          runId: 'r1',
          timestamp: `2026-01-01T00:0${i}:00Z`,
        }));
      }
      db.enforceMessageCap('r1', 2);
      const messages = db.getMessages('r1');
      expect(messages).toHaveLength(2);
      expect(messages[0].id).toBe('m3');
      expect(messages[1].id).toBe('m4');
    });

    it('preserves newest messages after cap enforcement', () => {
      for (let i = 0; i < 5; i++) {
        db.insertMessage(makeMessage({
          id: `m${i}`,
          runId: 'r1',
          body: `message ${i}`,
          timestamp: `2026-01-01T00:0${i}:00Z`,
        }));
      }
      db.enforceMessageCap('r1', 3);
      const messages = db.getMessages('r1');
      expect(messages.map(m => m.body)).toEqual(['message 2', 'message 3', 'message 4']);
    });
  });

  describe('Memory CRUD', () => {
    it('writeMemoryEntry + readMemoryEntry round-trips with runId', () => {
      const entry = makeMemoryEntry({ runId: 'r1' });
      db.writeMemoryEntry(entry);
      const retrieved = db.readMemoryEntry('decisions', 'test-key');
      expect(retrieved).toEqual(entry);
    });

    it('writeMemoryEntry upserts on conflict (same namespace+key)', () => {
      db.writeMemoryEntry(makeMemoryEntry({ value: 'old' }));
      db.writeMemoryEntry(makeMemoryEntry({ value: 'new', updatedAt: '2026-01-02T00:00:00Z' }));
      const entry = db.readMemoryEntry('decisions', 'test-key');
      expect(entry!.value).toBe('new');
    });

    it('readMemoryEntry returns undefined for non-existent entry', () => {
      expect(db.readMemoryEntry('decisions', 'nonexistent')).toBeUndefined();
    });

    it('listByNamespace returns only matching entries, ordered by updated_at', () => {
      db.writeMemoryEntry(makeMemoryEntry({ key: 'k2', namespace: 'decisions', updatedAt: '2026-01-02T00:00:00Z' }));
      db.writeMemoryEntry(makeMemoryEntry({ key: 'k1', namespace: 'decisions', updatedAt: '2026-01-01T00:00:00Z' }));
      db.writeMemoryEntry(makeMemoryEntry({ key: 'other', namespace: 'context' }));
      const entries = db.listByNamespace('decisions');
      expect(entries).toHaveLength(2);
      expect(entries[0].key).toBe('k1');
      expect(entries[1].key).toBe('k2');
    });

    it('listByNamespace returns empty array for empty namespace', () => {
      expect(db.listByNamespace('reviews')).toEqual([]);
    });

    it('getAllMemory returns all entries ordered by namespace ASC, updated_at ASC', () => {
      db.writeMemoryEntry(makeMemoryEntry({ key: 'k1', namespace: 'decisions', updatedAt: '2026-01-01T00:00:00Z' }));
      db.writeMemoryEntry(makeMemoryEntry({ key: 'k2', namespace: 'context', updatedAt: '2026-01-01T00:00:00Z' }));
      db.writeMemoryEntry(makeMemoryEntry({ key: 'k3', namespace: 'reviews', updatedAt: '2026-01-01T00:00:00Z' }));
      const entries = db.getAllMemory();
      expect(entries).toHaveLength(3);
      expect(entries[0].namespace).toBe('context');
      expect(entries[1].namespace).toBe('decisions');
      expect(entries[2].namespace).toBe('reviews');
    });

    it('deleteMemoryEntry removes the entry', () => {
      db.writeMemoryEntry(makeMemoryEntry());
      db.deleteMemoryEntry('decisions', 'test-key');
      expect(db.readMemoryEntry('decisions', 'test-key')).toBeUndefined();
    });

    it('deleteMemoryEntry is a no-op for non-existent entry', () => {
      expect(() => db.deleteMemoryEntry('decisions', 'nonexistent')).not.toThrow();
    });
  });

  describe('searchMemory', () => {
    it('matches on key substring', () => {
      db.writeMemoryEntry(makeMemoryEntry({ key: 'auth-decision', value: 'unrelated' }));
      db.writeMemoryEntry(makeMemoryEntry({ key: 'other-thing', namespace: 'context', value: 'unrelated' }));
      const results = db.searchMemory('auth');
      expect(results).toHaveLength(1);
      expect(results[0].key).toBe('auth-decision');
    });

    it('matches on value substring', () => {
      db.writeMemoryEntry(makeMemoryEntry({ key: 'k1', value: 'Use JWT tokens' }));
      const results = db.searchMemory('JWT');
      expect(results).toHaveLength(1);
      expect(results[0].value).toBe('Use JWT tokens');
    });

    it('returns empty array when nothing matches', () => {
      db.writeMemoryEntry(makeMemoryEntry());
      expect(db.searchMemory('zzz_nomatch')).toEqual([]);
    });

    it('treats % and _ in the query as literals, not wildcards', () => {
      db.writeMemoryEntry(makeMemoryEntry({ key: 'literal', value: 'task is 100%_done now' }));
      // Would match '%100%_done%' via wildcards (% -> "Xy", _ -> "z") but is
      // not a literal occurrence of "100%_done".
      db.writeMemoryEntry(makeMemoryEntry({ key: 'wildcard-bait', namespace: 'context', value: 'task is 100Xyzdone now' }));
      const results = db.searchMemory('100%_done');
      expect(results).toHaveLength(1);
      expect(results[0].key).toBe('literal');
    });

    it('does not let _ match an arbitrary character', () => {
      db.writeMemoryEntry(makeMemoryEntry({ key: 'underscore', value: 'value 100_ literal' }));
      db.writeMemoryEntry(makeMemoryEntry({ key: 'no-underscore', namespace: 'context', value: 'value 100X literal' }));
      const results = db.searchMemory('100_');
      expect(results).toHaveLength(1);
      expect(results[0].key).toBe('underscore');
    });

    it('does not let % match an arbitrary substring', () => {
      db.writeMemoryEntry(makeMemoryEntry({ key: 'percent', value: 'coverage 95%25 report' }));
      db.writeMemoryEntry(makeMemoryEntry({ key: 'no-percent', namespace: 'context', value: 'coverage 95xx25 report' }));
      const results = db.searchMemory('95%25');
      expect(results).toHaveLength(1);
      expect(results[0].key).toBe('percent');
    });

    it('handles backslashes in the query literally without breaking', () => {
      db.writeMemoryEntry(makeMemoryEntry({ key: 'backslash', value: 'path\\to\\file on disk' }));
      db.writeMemoryEntry(makeMemoryEntry({ key: 'no-backslash', namespace: 'context', value: 'pathXtoXfile on disk' }));
      const results = db.searchMemory('path\\to');
      expect(results).toHaveLength(1);
      expect(results[0].key).toBe('backslash');
      // A trailing backslash must not produce a dangling escape.
      expect(() => db.searchMemory('ends-with\\')).not.toThrow();
    });
  });

  describe('close', () => {
    it('throws on subsequent operations after close', () => {
      db.close();
      expect(() => db.getRun('x')).toThrow();
    });
  });
});
