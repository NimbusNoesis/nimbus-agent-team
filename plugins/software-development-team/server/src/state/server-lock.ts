import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

function readPids(lockFile: string): number[] {
  try {
    const raw = readFileSync(lockFile, 'utf-8').trim();
    const decoded: unknown = raw.startsWith('[') ? JSON.parse(raw) : [Number(raw)];
    return Array.isArray(decoded)
      ? decoded.filter((pid): pid is number => Number.isInteger(pid) && pid > 0)
      : [];
  } catch {
    return [];
  }
}

export function claimServerLock(
  teamDir: string,
  pid: number,
  isAlive: (pid: number) => boolean,
): number[] {
  const lockFile = join(teamDir, 'server.lock');
  const liveOwners = readPids(lockFile).filter((owner) => owner !== pid && isAlive(owner));
  const owners = [...liveOwners, pid];
  mkdirSync(teamDir, { recursive: true });
  writeFileSync(lockFile, JSON.stringify(owners));
  return liveOwners;
}

export function releaseServerLock(
  teamDir: string,
  pid: number,
  isAlive: (pid: number) => boolean,
): void {
  const lockFile = join(teamDir, 'server.lock');
  const remaining = readPids(lockFile).filter((owner) => owner !== pid && isAlive(owner));
  if (remaining.length === 0) {
    rmSync(lockFile, { force: true });
  } else {
    writeFileSync(lockFile, JSON.stringify(remaining));
  }
}
