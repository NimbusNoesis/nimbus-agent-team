import { mkdir, readFile, writeFile, appendFile, readdir, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { RunState, Message, MemoryEntry } from '../types.js';
import { MAX_MESSAGES_PER_RUN } from '../bus/message-bus.js';
import { logger } from '../logger.js';

const SAFE_KEY_RE = /^[a-zA-Z0-9_\-]+$/;

// Number of appends between opportunistic message-log compactions. Keeps the
// on-disk jsonl from growing without bound (the DB is capped separately).
const COMPACT_INTERVAL = 2_000;

function sanitizeKey(key: string): string {
  if (!SAFE_KEY_RE.test(key)) {
    throw new Error(`Invalid key "${key}": must contain only alphanumeric characters, dashes, or underscores`);
  }
  return key;
}

export class Persistence {
  private appendCounts = new Map<string, number>();

  constructor(private baseDir: string) {}

  private runDir(runId: string): string {
    return join(this.baseDir, 'runs', sanitizeKey(runId));
  }

  private memoryDir(): string {
    return join(this.baseDir, 'memory');
  }

  async saveRunState(run: RunState): Promise<void> {
    const dir = this.runDir(run.id);
    await mkdir(dir, { recursive: true });
    const stateFile = join(dir, 'state.json');
    const tmpFile = join(dir, 'state.json.tmp');
    await writeFile(tmpFile, JSON.stringify(run, null, 2));
    await rename(tmpFile, stateFile);
    logger.debug('Persistence', `Saved run state`, { runId: run.id, status: run.status });
  }

  async loadAllRunStates(): Promise<RunState[]> {
    const runsDir = join(this.baseDir, 'runs');
    let runDirs: string[];
    try {
      const entries = await readdir(runsDir, { withFileTypes: true });
      runDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch (err: any) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
    const states: RunState[] = [];
    for (const runId of runDirs) {
      try {
        const state = await this.loadRunState(runId);
        if (state) states.push(state);
      } catch (err) {
        logger.warn('Persistence', `Skipping malformed run state`, { runId, error: String(err) });
      }
    }
    return states;
  }

  async loadRunState(runId: string): Promise<RunState | null> {
    try {
      const data = await readFile(join(this.runDir(runId), 'state.json'), 'utf-8');
      return JSON.parse(data);
    } catch (err: any) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }

  async appendMessage(runId: string, message: Message): Promise<void> {
    const dir = this.runDir(runId);
    await mkdir(dir, { recursive: true });
    const file = join(dir, 'messages.jsonl');
    await appendFile(file, JSON.stringify(message) + '\n');

    // Opportunistically compact so the log stays bounded (mirrors the DB cap).
    const count = (this.appendCounts.get(runId) ?? 0) + 1;
    if (count >= COMPACT_INTERVAL) {
      this.appendCounts.set(runId, 0);
      await this.compactMessages(runId, file);
    } else {
      this.appendCounts.set(runId, count);
    }
  }

  private async compactMessages(runId: string, file: string): Promise<void> {
    try {
      const data = await readFile(file, 'utf-8');
      const lines = data.trim().split('\n').filter(Boolean);
      if (lines.length <= MAX_MESSAGES_PER_RUN) return;
      const kept = lines.slice(lines.length - MAX_MESSAGES_PER_RUN);
      const tmp = file + '.tmp';
      await writeFile(tmp, kept.join('\n') + '\n');
      await rename(tmp, file);
      logger.debug('Persistence', `Compacted message log`, { runId, kept: kept.length });
    } catch (err) {
      logger.warn('Persistence', `Failed to compact message log`, { runId, error: String(err) });
    }
  }

  async loadMessages(runId: string): Promise<Message[]> {
    try {
      const data = await readFile(join(this.runDir(runId), 'messages.jsonl'), 'utf-8');
      const all = data.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
      // Cap restored history to the per-run limit so the DB never re-exceeds it.
      return all.length > MAX_MESSAGES_PER_RUN ? all.slice(all.length - MAX_MESSAGES_PER_RUN) : all;
    } catch (err: any) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
  }

  async saveMemoryEntry(entry: MemoryEntry): Promise<void> {
    const safeKey = sanitizeKey(entry.key);
    const dir = join(this.memoryDir(), entry.namespace);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${safeKey}.json`), JSON.stringify(entry, null, 2));
    logger.debug('Persistence', `Saved memory entry`, { namespace: entry.namespace, key: entry.key });
  }

  async deleteMemoryEntry(namespace: string, key: string): Promise<void> {
    const safeKey = sanitizeKey(key);
    const filePath = join(this.memoryDir(), namespace, `${safeKey}.json`);
    try {
      await unlink(filePath);
      logger.debug('Persistence', `Deleted memory entry`, { namespace, key });
    } catch (err: any) {
      if (err.code !== 'ENOENT') throw err;
      // Already deleted — no-op
    }
  }

  async loadMemoryEntries(): Promise<MemoryEntry[]> {
    const entries: MemoryEntry[] = [];
    const memDir = this.memoryDir();
    let namespaces: string[];
    try {
      namespaces = await readdir(memDir);
    } catch (err: any) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
    for (const ns of namespaces) {
      const nsDir = join(memDir, ns);
      let files: string[];
      try {
        files = await readdir(nsDir);
      } catch (err: any) {
        if (err.code === 'ENOENT') continue;
        throw err;
      }
      for (const file of files) {
        if (file.endsWith('.json')) {
          try {
            const data = await readFile(join(nsDir, file), 'utf-8');
            entries.push(JSON.parse(data));
          } catch (err) {
            logger.warn('Persistence', `Skipping malformed memory file`, { file: join(nsDir, file), error: String(err) });
          }
        }
      }
    }
    return entries;
  }
}
