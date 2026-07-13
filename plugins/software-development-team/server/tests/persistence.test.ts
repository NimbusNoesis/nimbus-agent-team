import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Persistence, normalizeRunState } from '../src/state/persistence.js';
import { MAX_MESSAGES_PER_RUN } from '../src/bus/message-bus.js';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunState, Message, MemoryEntry } from '../src/types.js';
import {
  EXECUTION_CONTROL_CAPABILITIES,
  MAX_COMMAND_RECEIPTS,
  MAX_LIFECYCLE_HISTORY,
  RUN_LIFECYCLE_VERSION,
} from '../src/types.js';

describe('Persistence', () => {
  let tmpDir: string;
  let persistence: Persistence;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'team-test-'));
    persistence = new Persistence(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true });
  });

  it('uses the approved bounded lifecycle retention budgets', () => {
    expect(MAX_COMMAND_RECEIPTS).toBe(256);
    expect(MAX_LIFECYCLE_HISTORY).toBe(128);
  });

  it.each(['none', 'pausing', 'paused', 'cancelling', 'cancelled'] as const)(
    'restores the canonical %s control phase for version 2',
    (controlPhase) => {
      const restored = normalizeRunState({
        id: `phase-${controlPhase}`, status: 'in_progress', steps: [],
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
        lifecycle: {
          version: 2, capabilities: EXECUTION_CONTROL_CAPABILITIES,
          controlPhase, revision: 0, commandReceipts: [], history: [],
        },
      });

      expect(restored.lifecycle.controlPhase).toBe(controlPhase);
    },
  );

  it('saves and loads run state', async () => {
    const run: RunState = {
      id: 'r1',
      status: 'ready',
      steps: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await persistence.saveRunState(run);
    const loaded = await persistence.loadRunState('r1');
    expect(loaded).toEqual({
      ...run,
      steps: [],
      lifecycle: {
        version: RUN_LIFECYCLE_VERSION,
        capabilities: EXECUTION_CONTROL_CAPABILITIES,
        controlPhase: 'none',
        revision: 0,
        commandReceipts: [],
        history: [],
      },
    });
  });

  it('normalizes missing-version JSON in memory without rewriting the file', async () => {
    const dir = join(tmpDir, 'runs', 'legacy-missing');
    await mkdir(dir, { recursive: true });
    const raw = JSON.stringify({
      id: 'legacy-missing', status: 'ready', steps: [],
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      lifecycle: {
        controlPhase: 'cancelling', revision: 12,
        commandReceipts: [{ commandId: 'unversioned-receipt' }],
        history: [{ commandId: 'unversioned-history' }],
        cancelRequestedAt: '2026-01-01T00:00:01.000Z',
      },
    }, null, 2);
    const file = join(dir, 'state.json');
    await writeFile(file, raw);

    const loaded = await persistence.loadRunState('legacy-missing');

    expect(loaded?.lifecycle).toEqual({
      version: 2, capabilities: EXECUTION_CONTROL_CAPABILITIES,
      controlPhase: 'none', revision: 0,
      commandReceipts: [], history: [],
    });
    expect(await readFile(file, 'utf-8')).toBe(raw);
  });

  it('normalizes version-1 lifecycle JSON without rewriting or emitting side effects', async () => {
    const dir = join(tmpDir, 'runs', 'legacy-v1');
    await mkdir(dir, { recursive: true });
    const legacy = {
      id: 'legacy-v1', status: 'in_progress',
      steps: [{
        step: { id: 1, description: 'legacy', files: [], acceptanceCriteria: [], dependsOn: [] },
        status: 'coding', retryCount: 0, assignedAgent: 'coder', result: null,
        claimedFiles: [], consecutiveSameError: 0, manualAttempt: 9,
        cancelRequestedAt: '2026-01-01T00:00:02.000Z',
        cancelledAt: '2026-01-01T00:00:03.000Z',
      }],
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      lifecycle: {
        version: 1,
        capabilities: { pause_run: false },
        controlPhase: 'pausing',
        revision: 4,
        commandReceipts: [{ commandId: 'untrusted-v1-receipt' }],
        history: [{ commandId: 'untrusted-v1-history' }],
        pauseRequestedAt: '2026-01-01T00:00:04.000Z',
        pausedAt: '2026-01-01T00:00:05.000Z',
        cancelRequestedAt: '2026-01-01T00:00:06.000Z',
      },
    };
    const raw = JSON.stringify(legacy, null, 2);
    const file = join(dir, 'state.json');
    await writeFile(file, raw);

    const loaded = await persistence.loadRunState('legacy-v1');

    expect(loaded?.lifecycle).toEqual({
      version: 2, capabilities: EXECUTION_CONTROL_CAPABILITIES,
      controlPhase: 'none', revision: 0,
      commandReceipts: [], history: [],
    });
    expect(loaded?.steps[0].manualAttempt).toBe(0);
    expect(loaded?.steps[0]).not.toHaveProperty('cancelRequestedAt');
    expect(loaded?.steps[0]).not.toHaveProperty('cancelledAt');
    expect(await readFile(file, 'utf-8')).toBe(raw);
  });

  it('round-trips all version-2 lifecycle fields', async () => {
    const run: RunState = {
      id: 'v2', status: 'cancelled', steps: [{
        step: {
          id: 1, description: 'draining cancellation', files: ['src/active.ts'],
          acceptanceCriteria: [], dependsOn: [],
        },
        status: 'cancelling', retryCount: 0, assignedAgent: 'coder', result: null,
        claimedFiles: ['src/active.ts'], consecutiveSameError: 0, manualAttempt: 2,
        cancelRequestedAt: '2026-01-01T00:00:04.000Z',
      }, {
        step: {
          id: 2, description: 'acknowledged cancellation', files: ['src/inactive.ts'],
          acceptanceCriteria: [], dependsOn: [],
        },
        status: 'cancelled', retryCount: 0, assignedAgent: null, result: null,
        claimedFiles: [], consecutiveSameError: 0, manualAttempt: 0,
        cancelRequestedAt: '2026-01-01T00:00:05.000Z',
        cancelledAt: '2026-01-01T00:00:06.000Z',
      }],
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:01.000Z',
      lifecycle: {
        version: 2,
        capabilities: { ...EXECUTION_CONTROL_CAPABILITIES },
        controlPhase: 'cancelled',
        revision: 7,
        pauseRequestedAt: '2026-01-01T00:00:02.000Z',
        pausedAt: '2026-01-01T00:00:03.000Z',
        cancelRequestedAt: '2026-01-01T00:00:04.000Z',
        commandReceipts: [{
          commandId: 'cmd-1', fingerprint: 'cancel:run', action: 'cancel_run',
          target: { kind: 'run' }, expectedRevision: 6, revision: 7,
          recordedAt: '2026-01-01T00:00:02.000Z',
          outcome: { controlPhase: 'cancelled', runStatus: 'cancelled' },
        }],
        history: [{
          commandId: 'cmd-1', action: 'cancel_run', target: { kind: 'run' },
          revision: 7, recordedAt: '2026-01-01T00:00:02.000Z',
          fromPhase: 'cancelling', toPhase: 'cancelled', summary: 'Cancellation acknowledged',
        }],
      },
    };

    await persistence.saveRunState(run);
    expect(await persistence.loadRunState(run.id)).toEqual(run);
  });

  it('bounds restored command receipts and lifecycle history to their newest entries', async () => {
    const receipts = Array.from({ length: MAX_COMMAND_RECEIPTS + 3 }, (_, revision) => ({
      commandId: `command-${revision}`, fingerprint: `fingerprint-${revision}`,
      action: 'pause_run' as const, target: { kind: 'run' as const },
      expectedRevision: revision, revision: revision + 1,
      recordedAt: '2026-01-01T00:00:00.000Z',
      outcome: { controlPhase: 'none' as const, runStatus: 'in_progress' as const },
    }));
    const history = Array.from({ length: MAX_LIFECYCLE_HISTORY + 5 }, (_, revision) => ({
      commandId: `command-${revision}`, action: 'pause_run' as const,
      target: { kind: 'run' as const }, revision: revision + 1,
      recordedAt: '2026-01-01T00:00:00.000Z',
      fromPhase: 'none' as const, toPhase: 'pausing' as const,
    }));
    const run: RunState = {
      id: 'bounded', status: 'in_progress', steps: [],
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      lifecycle: {
        version: 2, capabilities: { ...EXECUTION_CONTROL_CAPABILITIES },
        controlPhase: 'none', revision: 999, commandReceipts: receipts, history,
      },
    };
    await persistence.saveRunState(run);

    const loaded = await persistence.loadRunState(run.id);
    expect(loaded?.lifecycle.commandReceipts).toHaveLength(MAX_COMMAND_RECEIPTS);
    expect(loaded?.lifecycle.commandReceipts[0].commandId).toBe('command-3');
    expect(loaded?.lifecycle.history).toHaveLength(MAX_LIFECYCLE_HISTORY);
    expect(loaded?.lifecycle.history[0].commandId).toBe('command-5');
  });

  it('fails closed with an actionable error for unsupported future lifecycle versions', async () => {
    const dir = join(tmpDir, 'runs', 'future');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'state.json'), JSON.stringify({
      id: 'future', status: 'ready', steps: [], lifecycle: { version: 3 },
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    }));

    await expect(persistence.loadRunState('future')).rejects.toThrow(
      /Unsupported run lifecycle version 3.*Upgrade/s,
    );
    await expect(persistence.loadAllRunStates()).rejects.toThrow(
      /Unsupported run lifecycle version 3/,
    );
  });

  it('preserves durable worktree lifecycle context across restart', async () => {
    const run: RunState = {
      id: 'worktree-run', status: 'ready',
      steps: [{
        step: { id: 1, description: 'work', files: [], acceptanceCriteria: [], dependsOn: [] },
        status: 'pending', retryCount: 0, assignedAgent: null, result: null,
        claimedFiles: [], consecutiveSameError: 0,
        worktree: {
          targetBranch: 'main', targetCommit: 'abc123',
          path: '.worktrees/worktree-run/step-1', branch: 'team-worktree-run-step-1',
        },
      }],
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    await persistence.saveRunState(run);
    expect((await persistence.loadRunState(run.id))?.steps[0].worktree).toEqual(run.steps[0].worktree);
  });

  it('appends and loads messages', async () => {
    const msg: Message = {
      id: 'm1', runId: 'r1', from: 'coder', to: 'all',
      type: 'info', body: 'hello', timestamp: new Date().toISOString(),
    };
    await persistence.appendMessage('r1', msg);
    const loaded = await persistence.loadMessages('r1');
    expect(loaded).toHaveLength(1);
    expect(loaded[0].body).toBe('hello');
  });

  it('saves and loads memory entries', async () => {
    const entry: MemoryEntry = {
      key: 'k', namespace: 'decisions', value: 'v', updatedAt: new Date().toISOString(),
    };
    await persistence.saveMemoryEntry(entry);
    const loaded = await persistence.loadMemoryEntries();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].key).toBe('k');
  });

  // N1 — atomic write: no partial state.json left on success
  it('saveRunState writes atomically (no .tmp file left)', async () => {
    const run: RunState = {
      id: 'r-atomic',
      status: 'ready',
      steps: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await persistence.saveRunState(run);
    const { existsSync } = await import('node:fs');
    const runDir = join(tmpDir, 'runs', 'r-atomic');
    expect(existsSync(join(runDir, 'state.json'))).toBe(true);
    expect(existsSync(join(runDir, 'state.json.tmp'))).toBe(false);
  });

  // N2 — sanitizeKey throws on invalid keys
  it('saveMemoryEntry throws on invalid key', async () => {
    const entry: MemoryEntry = {
      key: 'bad key!', namespace: 'decisions', value: 'v', updatedAt: new Date().toISOString(),
    };
    await expect(persistence.saveMemoryEntry(entry)).rejects.toThrow(/Invalid key/);
  });

  it('saveRunState throws on invalid run id', async () => {
    const run: RunState = {
      id: 'bad/id',
      status: 'ready',
      steps: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await expect(persistence.saveRunState(run)).rejects.toThrow(/Invalid key/);
  });

  // N3 — malformed memory JSON logs a warning
  it('loadMemoryEntries warns on malformed JSON and skips file', async () => {
    const { logger } = await import('../src/logger.js');
    const warnSpy = vi.spyOn(logger, 'warn');

    const nsDir = join(tmpDir, 'memory', 'decisions');
    await mkdir(nsDir, { recursive: true });
    await writeFile(join(nsDir, 'bad-entry.json'), 'NOT JSON');

    const loaded = await persistence.loadMemoryEntries();
    expect(loaded).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledWith(
      'Persistence',
      expect.stringContaining('malformed'),
      expect.objectContaining({ file: expect.stringContaining('bad-entry.json') })
    );

    warnSpy.mockRestore();
  });

  // N4 — loadAllRunStates returns all saved run states
  it('loadAllRunStates restores all saved runs', async () => {
    const run1: RunState = {
      id: 'run-one',
      status: 'ready',
      steps: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const run2: RunState = {
      id: 'run-two',
      status: 'complete',
      steps: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await persistence.saveRunState(run1);
    await persistence.saveRunState(run2);

    const all = await persistence.loadAllRunStates();
    expect(all).toHaveLength(2);
    const ids = all.map((r) => r.id).sort();
    expect(ids).toEqual(['run-one', 'run-two']);
  });

  it('loadAllRunStates returns empty array when runs dir does not exist', async () => {
    const all = await persistence.loadAllRunStates();
    expect(all).toEqual([]);
  });

  describe('message log compaction across restarts', () => {
    const makeMsg = (i: number): Message => ({
      id: `m${i}`,
      runId: 'r-compact',
      from: 'coder',
      to: 'all',
      type: 'info',
      body: `msg ${i}`,
      timestamp: new Date(Date.UTC(2026, 0, 1) + i).toISOString(),
    });

    async function writeOversizedLog(runId: string, total: number): Promise<string> {
      const dir = join(tmpDir, 'runs', runId);
      await mkdir(dir, { recursive: true });
      const file = join(dir, 'messages.jsonl');
      const lines: string[] = [];
      for (let i = 0; i < total; i++) {
        lines.push(JSON.stringify(makeMsg(i)));
      }
      await writeFile(file, lines.join('\n') + '\n');
      return file;
    }

    async function readLog(file: string): Promise<Message[]> {
      const data = await readFile(file, 'utf-8');
      return data.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    }

    it('compacts an over-cap file on first append after restart (fresh append counter)', async () => {
      const overflow = 50;
      const file = await writeOversizedLog('r-compact', MAX_MESSAGES_PER_RUN + overflow);

      // Fresh instance simulates a server restart: appendCounts starts empty.
      const fresh = new Persistence(tmpDir);
      const newMsg: Message = {
        id: 'm-new', runId: 'r-compact', from: 'coder', to: 'all',
        type: 'info', body: 'after restart', timestamp: new Date().toISOString(),
      };
      await fresh.appendMessage('r-compact', newMsg);

      const messages = await readLog(file);
      expect(messages.length).toBeLessThanOrEqual(MAX_MESSAGES_PER_RUN);
      // Newest retained: the just-appended message is the last line.
      expect(messages[messages.length - 1].id).toBe('m-new');
      // Oldest dropped: the file held cap+overflow lines plus the new append,
      // so at least overflow+1 of the oldest entries are gone.
      expect(messages[0].id).toBe(`m${overflow + 1}`);
      expect(messages.some((m) => m.id === 'm0')).toBe(false);
    });

    it('leaves an under-cap file untruncated on first append', async () => {
      const file = await writeOversizedLog('r-compact', 5);

      const fresh = new Persistence(tmpDir);
      const newMsg: Message = {
        id: 'm-new', runId: 'r-compact', from: 'coder', to: 'all',
        type: 'info', body: 'small log', timestamp: new Date().toISOString(),
      };
      await fresh.appendMessage('r-compact', newMsg);

      const messages = await readLog(file);
      expect(messages).toHaveLength(6);
      expect(messages[0].id).toBe('m0');
      expect(messages[5].id).toBe('m-new');
    });

    it('reads the file only on first touch, not on every append', async () => {
      await writeOversizedLog('r-compact', 5);
      const fresh = new Persistence(tmpDir);
      const compactSpy = vi.spyOn(fresh as any, 'compactMessages');

      for (let i = 0; i < 3; i++) {
        await fresh.appendMessage('r-compact', {
          id: `live-${i}`, runId: 'r-compact', from: 'coder', to: 'all',
          type: 'info', body: `live ${i}`, timestamp: new Date().toISOString(),
        });
      }

      // Only the first append triggers the compaction check.
      expect(compactSpy).toHaveBeenCalledTimes(1);
      compactSpy.mockRestore();
    });
  });
});
