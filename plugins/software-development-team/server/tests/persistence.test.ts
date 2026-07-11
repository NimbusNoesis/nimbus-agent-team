import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Persistence } from '../src/state/persistence.js';
import { MAX_MESSAGES_PER_RUN } from '../src/bus/message-bus.js';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
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
