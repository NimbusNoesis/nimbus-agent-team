import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claimServerLock, releaseServerLock } from '../src/state/server-lock.js';

describe('server lock ownership', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('preserves an older live owner when a newer server exits', async () => {
    dir = await mkdtemp(join(tmpdir(), 'team-lock-'));
    const live = new Set([101, 202, 303]);
    const isAlive = (pid: number) => live.has(pid);

    expect(claimServerLock(dir, 101, isAlive)).toEqual([]);
    expect(claimServerLock(dir, 202, isAlive)).toEqual([101]);
    live.delete(202);
    releaseServerLock(dir, 202, isAlive);
    expect(JSON.parse(await readFile(join(dir, 'server.lock'), 'utf-8'))).toEqual([101]);
    expect(claimServerLock(dir, 303, isAlive)).toEqual([101]);
  });

  it('reads the legacy single-PID lock format and prunes stale owners', async () => {
    dir = await mkdtemp(join(tmpdir(), 'team-lock-'));
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(dir, 'server.lock'), '101');
    expect(claimServerLock(dir, 202, (pid) => pid === 101)).toEqual([101]);
  });
});
