import { open, readdir, stat } from 'node:fs/promises';
import { watch, type FSWatcher } from 'node:fs';
import { basename, join } from 'node:path';
import type { Message } from '../types.js';
import { restoreMessage } from '../state/persistence.js';
import { logger } from '../logger.js';

/**
 * Bounded, payload-free descriptor for a filesystem error. Bus logs stay
 * metadata-only, so never log the raw message — it embeds absolute paths.
 */
function errorReasonCode(err: unknown): string {
  const code: unknown = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && /^[A-Z_]{1,32}$/.test(code)) return code;
  if (err instanceof Error && /^[A-Za-z]{1,32}$/.test(err.name)) return err.name;
  return 'unknown';
}

interface MessageLogSyncOptions {
  /** The .team/runs directory containing one subdirectory per run. */
  runsDir: string;
  /** Only runs for which this returns true are synced (see class docs). */
  isKnownRun: (runId: string) => boolean;
  /**
   * Ingests one validated message (production: MessageBus.ingestExternal).
   * Returns false for a duplicate id — dedupe is the ingest callback's job.
   */
  ingest: (message: Message) => boolean;
}

const NEWLINE = 0x0a;
const CARRIAGE_RETURN = 0x0d;

// Poll cadence for the unconditional reliability backstop (see start()).
const POLL_INTERVAL_MS = 1500;

/**
 * Tails sibling-process appends to each run's messages.jsonl under
 * .team/runs and feeds newly appended, validated messages to the injected
 * ingest callback so a dashboard-hosting process can see messages posted by
 * other server processes sharing the same .team directory.
 *
 * Detection is one recursive fs.watch over the runs directory tree PLUS a
 * ~1.5s polling interval as an unconditional reliability backstop: fs.watch
 * is unreliable across rename-based compaction (which replaces the inode),
 * and new run directories appear over time.
 *
 * Only runs known to the local process (isKnownRun) are ingested. A run
 * created by a sibling process AFTER this process booted is therefore never
 * ingested — a deliberate, accepted limitation of the design.
 *
 * Read semantics assume producers append WHOLE lines via appendFile, which
 * is atomic on local filesystems via O_APPEND. The partial-line deferral in
 * syncRun handles torn tails only (a line whose trailing newline has not
 * landed yet), not interleaved partial writes.
 */
export class MessageLogSync {
  private readonly runsDir: string;
  private readonly isKnownRun: (runId: string) => boolean;
  private readonly ingest: (message: Message) => boolean;

  // Per-run byte offset of the first not-yet-consumed byte in messages.jsonl.
  private readonly offsets = new Map<string, number>();

  private watcher: FSWatcher | null = null;
  private pollTimer: NodeJS.Timeout | null = null;

  // Overlapping-pass guard: every pass chains onto the previous one, so two
  // concurrent syncNow() calls (e.g. an in-flight pass while the poll fires)
  // serialize instead of double-reading the same file.
  private chain: Promise<void> = Promise.resolve();

  // Coalescing for watcher/poll triggers: while one triggered pass is queued
  // or running, further triggers are dropped (the poll backstop guarantees a
  // later pass anyway).
  private triggerQueued = false;

  constructor(options: MessageLogSyncOptions) {
    this.runsDir = options.runsDir;
    this.isKnownRun = options.isKnownRun;
    this.ingest = options.ingest;
  }

  start(): void {
    if (this.watcher !== null || this.pollTimer !== null) return;
    try {
      this.watcher = watch(this.runsDir, { recursive: true }, (_eventType, filename) => {
        // CHEAP filter: sibling processes constantly create/rename
        // state.json.tmp.<pid>.<seq> files in these directories — only
        // messages.jsonl basenames may trigger a pass.
        if (typeof filename !== 'string' || basename(filename) !== 'messages.jsonl') return;
        this.requestSync();
      });
      this.watcher.on('error', (err) => {
        // Metadata-only, like every other bus log: an fs error's raw text can
        // carry absolute paths. The error name/code is enough to diagnose.
        logger.warn('MessageLogSync', 'fs.watch failed; relying on poll backstop', {
          reasonCode: errorReasonCode(err),
        });
        this.watcher?.close();
        this.watcher = null;
      });
    } catch (err) {
      // The runs directory may not exist yet (no run persisted). The poll
      // backstop still detects appends; watching is a latency optimization.
      logger.debug('MessageLogSync', 'fs.watch unavailable; relying on poll backstop', {
        reasonCode: errorReasonCode(err),
      });
      this.watcher = null;
    }
    this.pollTimer = setInterval(() => this.requestSync(), POLL_INTERVAL_MS);
    // Prime per-run offsets immediately (first sight = current file size).
    this.requestSync();
  }

  /**
   * Disposes the fs.watch handle and clears the poll interval so neither
   * keeps the process alive.
   */
  stop(): void {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.watcher !== null) {
      this.watcher.close();
      this.watcher = null;
    }
  }

  /**
   * Performs one full scan-and-ingest pass over every known run's log.
   * Deterministic testing API: tests drive this directly and never depend on
   * fs.watch events or timer timing. Passes are serialized (see `chain`).
   */
  syncNow(): Promise<void> {
    const pass = this.chain.then(() => this.scanAll());
    this.chain = pass.then(
      () => undefined,
      () => undefined,
    );
    return pass;
  }

  private requestSync(): void {
    if (this.triggerQueued) return;
    this.triggerQueued = true;
    void this.syncNow().finally(() => {
      this.triggerQueued = false;
    });
  }

  private async scanAll(): Promise<void> {
    let entries;
    try {
      entries = await readdir(this.runsDir, { withFileTypes: true });
    } catch (err) {
      // ENOENT: no run persisted yet — nothing to sync.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn('MessageLogSync', 'Failed to list runs directory', { error: String(err) });
      }
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const runId = entry.name;
      // Only runs known to the local process are ingested. Unknown-run
      // directories (created by a sibling after this process booted) are
      // skipped — deliberate accepted limitation; do not "fix".
      if (!this.isKnownRun(runId)) continue;
      try {
        await this.syncRun(runId);
      } catch (err) {
        // Transient files vanish mid-event (sibling compaction renames);
        // swallow ENOENT from stat/open and retry naturally on a later pass.
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
        logger.warn('MessageLogSync', 'Failed to sync run message log', {
          runId,
          error: String(err),
        });
      }
    }
  }

  private async syncRun(runId: string): Promise<void> {
    const file = join(this.runsDir, runId, 'messages.jsonl');
    const size = (await stat(file)).size;

    const known = this.offsets.get(runId);
    if (known === undefined) {
      // First sight of this run's log: initialize the offset to the CURRENT
      // file size, skipping history — startup restore already loaded it into
      // the DB. Deliberately cheap for the many short-lived Codex worker
      // instances that also run this watcher.
      this.offsets.set(runId, size);
      return;
    }

    let offset = known;
    if (size < offset) {
      // The file shrank: sibling compaction replaced it (or it was
      // truncated). Reset to 0 and rescan the whole file, relying on id
      // dedupe in the ingest callback (returns false for duplicates) — which
      // also makes re-observing our own process's appends harmless.
      offset = 0;
    }
    if (size <= offset) {
      this.offsets.set(runId, offset);
      return;
    }

    const bytes = await this.readRange(file, offset, size - offset);

    // Consume only newline-terminated lines. A trailing line WITHOUT a
    // newline is left pending: the offset does not advance past it and it is
    // re-read on the next sync (torn-tail deferral — see class docs for the
    // whole-line O_APPEND atomicity assumption this relies on).
    let consumed = 0;
    for (;;) {
      const nl = bytes.indexOf(NEWLINE, consumed);
      if (nl === -1) break;
      const lineStart = consumed;
      let lineEnd = nl;
      if (lineEnd > lineStart && bytes[lineEnd - 1] === CARRIAGE_RETURN) lineEnd--;
      consumed = nl + 1;

      const text = bytes.subarray(lineStart, lineEnd).toString('utf-8');
      if (text.trim().length === 0) continue;

      // A complete-but-invalid line is skipped PERMANENTLY: the offset
      // advances past it and it is never re-attempted.
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        this.warnSkippedLine(runId, offset + lineStart, 'malformed_json');
        continue;
      }
      const restored = restoreMessage(parsed, runId);
      if (typeof restored === 'string') {
        this.warnSkippedLine(runId, offset + lineStart, restored);
        continue;
      }
      this.ingest(restored);
    }

    this.offsets.set(runId, offset + consumed);
  }

  private async readRange(file: string, position: number, length: number): Promise<Buffer> {
    const handle = await open(file, 'r');
    try {
      const buffer = Buffer.alloc(length);
      // The file may have been replaced or grown between stat and read; a
      // short read is fine — unconsumed bytes are picked up next pass, and a
      // shrink is detected by the size < offset check next pass.
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      return buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  }

  private warnSkippedLine(runId: string, byteOffset: number, reasonCode: string): void {
    // Metadata only — never the line content or message payload.
    logger.warn('MessageLogSync', 'Skipping invalid synced message line', {
      runId,
      byteOffset,
      reasonCode,
    });
  }
}
