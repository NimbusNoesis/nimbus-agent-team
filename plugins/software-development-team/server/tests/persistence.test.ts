import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Persistence } from '../src/state/persistence.js';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunState, Message, MemoryEntry } from '../src/types.js';

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
    expect(loaded).toEqual(run);
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
});
