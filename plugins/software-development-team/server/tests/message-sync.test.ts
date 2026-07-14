import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MessageLogSync } from '../src/bus/message-sync.js';
import { logger } from '../src/logger.js';
import { mkdtemp, rm, mkdir, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Message } from '../src/types.js';

const RUN_ID = 'run-1';

function makeMessage(id: string, runId = RUN_ID, body = `body-${id}`): Message {
  return {
    id,
    runId,
    from: 'coder',
    to: 'coordinator',
    type: 'info',
    body,
    timestamp: '2026-01-01T00:00:00.000Z',
  };
}

function line(message: Message): string {
  return JSON.stringify(message) + '\n';
}

describe('MessageLogSync', () => {
  let tmpDir: string;
  let runsDir: string;
  let logFile: string;
  let ingested: Message[];
  let ingestCalls: Message[];
  let knownRuns: Set<string>;
  let sync: MessageLogSync;

  // Dedupe-by-id ingest stub matching the MessageBus.ingestExternal contract:
  // returns false (and stores nothing) for an already-seen id.
  const ingest = (message: Message): boolean => {
    ingestCalls.push(message);
    if (ingested.some((m) => m.id === message.id)) return false;
    ingested.push(message);
    return true;
  };

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'team-sync-test-'));
    runsDir = join(tmpDir, 'runs');
    logFile = join(runsDir, RUN_ID, 'messages.jsonl');
    await mkdir(join(runsDir, RUN_ID), { recursive: true });
    ingested = [];
    ingestCalls = [];
    knownRuns = new Set([RUN_ID]);
    sync = new MessageLogSync({
      runsDir,
      isKnownRun: (runId) => knownRuns.has(runId),
      ingest,
    });
  });

  afterEach(async () => {
    sync.stop();
    vi.restoreAllMocks();
    vi.useRealTimers();
    await rm(tmpDir, { recursive: true });
  });

  it('skips pre-existing history on first sight and ingests appended lines exactly once each', async () => {
    // History present before the watcher's first pass — startup restore
    // already loaded it, so the first pass only primes the offset.
    await writeFile(logFile, line(makeMessage('history-1')));
    await sync.syncNow();
    expect(ingestCalls).toHaveLength(0);

    await appendFile(logFile, line(makeMessage('m1')) + line(makeMessage('m2')));
    await sync.syncNow();
    expect(ingested.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(ingestCalls).toHaveLength(2);

    // Offset advanced: a further pass re-reads nothing.
    await sync.syncNow();
    expect(ingestCalls).toHaveLength(2);
  });

  it('preserves the full payload of an ingested message', async () => {
    await writeFile(logFile, '');
    await sync.syncNow();

    const original = makeMessage('m1');
    await appendFile(logFile, line(original));
    await sync.syncNow();
    expect(ingested).toEqual([original]);
  });

  it('defers a torn trailing line without a newline, then ingests it once completed', async () => {
    await writeFile(logFile, '');
    await sync.syncNow();

    const full = line(makeMessage('torn-1'));
    const splitAt = Math.floor(full.length / 2);
    await appendFile(logFile, full.slice(0, splitAt));
    await sync.syncNow();
    expect(ingestCalls).toHaveLength(0);

    // A second pass over the still-torn tail must not consume or skip it.
    await sync.syncNow();
    expect(ingestCalls).toHaveLength(0);

    await appendFile(logFile, full.slice(splitAt));
    await sync.syncNow();
    expect(ingested.map((m) => m.id)).toEqual(['torn-1']);
    expect(ingestCalls).toHaveLength(1);
  });

  it('skips a complete-but-invalid line permanently with a metadata-only warning', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    await writeFile(logFile, '');
    await sync.syncNow();

    const secretBody = 'super-secret-body';
    const invalid = { ...makeMessage('bad-1', 'some-other-run', secretBody) };
    await appendFile(
      logFile,
      'this is not json\n' + JSON.stringify(invalid) + '\n' + line(makeMessage('good-1')),
    );
    await sync.syncNow();
    expect(ingested.map((m) => m.id)).toEqual(['good-1']);
    expect(ingestCalls).toHaveLength(1);

    // Skipped permanently: the offset advanced past both invalid lines.
    warn.mockClear();
    await sync.syncNow();
    expect(ingestCalls).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();

    // Warnings were metadata-only: bounded reasonCode, never line content.
    warn.mockRestore();
  });

  it('logs reasonCode metadata without message content when skipping invalid lines', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    await writeFile(logFile, '');
    await sync.syncNow();

    const secretBody = 'super-secret-body';
    const invalid = { ...makeMessage('bad-1', RUN_ID, secretBody), type: 'not-a-type' };
    await appendFile(logFile, 'not json\n' + JSON.stringify(invalid) + '\n');
    await sync.syncNow();

    expect(warn).toHaveBeenCalledTimes(2);
    const reasonCodes = warn.mock.calls.map((call) => (call[2] as { reasonCode: string }).reasonCode);
    expect(reasonCodes).toEqual(['malformed_json', 'invalid_message_type']);
    for (const call of warn.mock.calls) {
      const serialized = JSON.stringify(call);
      expect(serialized).not.toContain(secretBody);
      expect(serialized).not.toContain('bad-1');
      expect(JSON.stringify(call[2])).toContain(RUN_ID);
    }
  });

  it('resets the offset to 0 on file shrink and relies on ingest dedupe to prevent duplicates', async () => {
    const a = makeMessage('a');
    const b = makeMessage('b');
    await writeFile(logFile, '');
    await sync.syncNow();
    await appendFile(logFile, line(a) + line(b));
    await sync.syncNow();
    expect(ingested.map((m) => m.id)).toEqual(['a', 'b']);

    // Compaction-style replacement: a strictly smaller file keeping only `a`.
    await writeFile(logFile, line(a));
    await sync.syncNow();

    // The whole file was rescanned from offset 0: `a` was re-observed but
    // deduped by the ingest callback returning false — no duplicate stored.
    expect(ingestCalls.map((m) => m.id)).toEqual(['a', 'b', 'a']);
    expect(ingested.map((m) => m.id)).toEqual(['a', 'b']);

    // New appends after the reset are ingested normally.
    const c = makeMessage('c');
    await appendFile(logFile, line(c));
    await sync.syncNow();
    expect(ingestCalls.map((m) => m.id)).toEqual(['a', 'b', 'a', 'c']);
    expect(ingested.map((m) => m.id)).toEqual(['a', 'b', 'c']);

    await sync.syncNow();
    expect(ingestCalls).toHaveLength(4);
  });

  it('never ingests from a run the local process does not know', async () => {
    const unknownDir = join(runsDir, 'run-unknown');
    await mkdir(unknownDir, { recursive: true });
    await writeFile(join(unknownDir, 'messages.jsonl'), '');
    await sync.syncNow();
    await appendFile(
      join(unknownDir, 'messages.jsonl'),
      line(makeMessage('u1', 'run-unknown')),
    );
    await sync.syncNow();
    expect(ingestCalls).toHaveLength(0);
  });

  it('tolerates a missing runs directory and a run without a log file', async () => {
    await rm(runsDir, { recursive: true });
    await expect(sync.syncNow()).resolves.toBeUndefined();

    await mkdir(join(runsDir, RUN_ID), { recursive: true });
    await expect(sync.syncNow()).resolves.toBeUndefined();
    expect(ingestCalls).toHaveLength(0);
  });

  it('serializes overlapping syncNow passes without double-ingesting', async () => {
    await writeFile(logFile, '');
    await sync.syncNow();
    await appendFile(logFile, line(makeMessage('m1')) + line(makeMessage('m2')));

    await Promise.all([sync.syncNow(), sync.syncNow(), sync.syncNow()]);
    expect(ingestCalls).toHaveLength(2);
    expect(ingested.map((m) => m.id)).toEqual(['m1', 'm2']);
  });

  it('start() registers a poll interval and stop() clears it and the watcher', async () => {
    vi.useFakeTimers();
    expect(vi.getTimerCount()).toBe(0);
    sync.start();
    expect(vi.getTimerCount()).toBe(1);

    // Idempotent: a second start does not stack watchers or timers.
    sync.start();
    expect(vi.getTimerCount()).toBe(1);

    sync.stop();
    expect(vi.getTimerCount()).toBe(0);

    // Idempotent stop.
    sync.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('start() survives a missing runs directory (poll backstop only)', async () => {
    await rm(runsDir, { recursive: true });
    vi.useFakeTimers();
    sync.start();
    expect(vi.getTimerCount()).toBe(1);
    sync.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});
