import { mkdir, readFile, writeFile, appendFile, readdir, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import {
  EXECUTION_CONTROL_CAPABILITIES,
  MAX_COMMAND_RECEIPTS,
  MAX_LIFECYCLE_HISTORY,
  RUN_LIFECYCLE_VERSION,
  type RunState,
  type RestoredRunState,
  type RunControlPhase,
  type RunLifecycleV2,
  type Message,
  type MessageType,
  type MemoryEntry,
} from '../types.js';
import { MAX_MESSAGES_PER_RUN } from '../bus/message-bus.js';
import { logger } from '../logger.js';

const SAFE_KEY_RE = /^[a-zA-Z0-9_\-]+$/;

// Number of appends between opportunistic message-log compactions. Keeps the
// on-disk jsonl from growing without bound (the DB is capped separately).
const COMPACT_INTERVAL = 2_000;

const CONTROL_PHASES = new Set<RunControlPhase>([
  'none',
  'pausing',
  'paused',
  'cancelling',
  'cancelled',
]);

const MESSAGE_TYPES = new Set<MessageType>([
  'info',
  'review',
  'escalation',
  'guidance',
  'result',
]);

const MESSAGE_STRING_FIELDS = ['id', 'runId', 'from', 'to', 'body', 'timestamp'] as const;
const ISO_TIMESTAMP_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

type MessageRestoreFailure =
  | 'malformed_json'
  | 'non_object'
  | 'missing_required_field'
  | 'invalid_field_type'
  | 'empty_required_field'
  | 'invalid_message_type'
  | 'invalid_timestamp'
  | 'mismatched_run_id';

class UnsupportedLifecycleVersionError extends Error {
  constructor(version: number) {
    super(
      `Unsupported run lifecycle version ${version}; this server supports up to version ${RUN_LIFECYCLE_VERSION}. ` +
      'Upgrade the software-development-team server before restoring this run.',
    );
    this.name = 'UnsupportedLifecycleVersionError';
  }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Invalid persisted run state: ${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function nonNegativeInteger(value: unknown, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new Error(`Invalid persisted run state: ${label} must be a non-negative integer`);
  }
  return value as number;
}

function lifecycleVersion(run: Record<string, unknown>, lifecycle: Record<string, unknown> | undefined): number | undefined {
  const value = lifecycle?.version ?? run.lifecycleVersion;
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new Error('Invalid persisted run state: lifecycle version must be a positive integer');
  }
  return value as number;
}

function controlPhase(value: unknown): RunControlPhase {
  if (value === undefined) return 'none';
  if (typeof value !== 'string' || !CONTROL_PHASES.has(value as RunControlPhase)) {
    throw new Error(`Invalid persisted run state: unknown lifecycle control phase ${JSON.stringify(value)}`);
  }
  return value as RunControlPhase;
}

function lifecycleArray<T>(value: unknown, limit: number, label: string): T[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(`Invalid persisted run state: lifecycle ${label} must be an array`);
  }
  return value.slice(-limit) as T[];
}

function isValidIsoTimestamp(value: string): boolean {
  const match = ISO_TIMESTAMP_RE.exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) return false;

  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false;

  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= daysInMonth[month - 1];
}

function restoreMessage(value: unknown, expectedRunId: string): Message | MessageRestoreFailure {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'non_object';
  const record = value as Record<string, unknown>;

  for (const field of [...MESSAGE_STRING_FIELDS, 'type'] as const) {
    if (!Object.hasOwn(record, field)) return 'missing_required_field';
  }
  for (const field of MESSAGE_STRING_FIELDS) {
    if (typeof record[field] !== 'string') return 'invalid_field_type';
    if (record[field].length === 0) return 'empty_required_field';
  }
  if (typeof record.type !== 'string') return 'invalid_field_type';
  if (!MESSAGE_TYPES.has(record.type as MessageType)) return 'invalid_message_type';
  if (!isValidIsoTimestamp(record.timestamp as string)) return 'invalid_timestamp';
  if (record.runId !== expectedRunId) return 'mismatched_run_id';

  return {
    id: record.id as string,
    runId: record.runId as string,
    from: record.from as string,
    to: record.to as string,
    type: record.type as MessageType,
    body: record.body as string,
    timestamp: record.timestamp as string,
  };
}

/**
 * The single JSON restore-boundary migration. It is deliberately pure: it
 * neither persists the normalized value nor emits lifecycle/state events.
 */
export function normalizeRunState(value: unknown): RestoredRunState {
  const raw = requireRecord(value, 'root');
  if (!Array.isArray(raw.steps)) {
    throw new Error('Invalid persisted run state: steps must be an array');
  }

  const rawLifecycle = raw.lifecycle === undefined
    ? undefined
    : requireRecord(raw.lifecycle, 'lifecycle');
  const version = lifecycleVersion(raw, rawLifecycle);
  if (version !== undefined && version > RUN_LIFECYCLE_VERSION) {
    throw new UnsupportedLifecycleVersionError(version);
  }

  // Only an explicitly versioned v2 record may supply lifecycle control data.
  // Missing-version and v1 records predate this contract, so lifecycle-looking
  // fields in them are untrusted and must not freeze admissions, invent a
  // revision, or replay an operator command after restore.
  const lifecycle: RunLifecycleV2 = version === RUN_LIFECYCLE_VERSION ? {
    version: RUN_LIFECYCLE_VERSION,
    // Capabilities describe this binary's v2 contract, not persisted action
    // availability. Deriving them here gives legacy runs a safe canonical
    // support surface and prevents stale JSON from enabling unknown behavior.
    capabilities: { ...EXECUTION_CONTROL_CAPABILITIES },
    controlPhase: controlPhase(rawLifecycle?.controlPhase),
    revision: nonNegativeInteger(rawLifecycle?.revision, 0, 'lifecycle revision'),
    commandReceipts: lifecycleArray(
      rawLifecycle?.commandReceipts,
      MAX_COMMAND_RECEIPTS,
      'commandReceipts',
    ),
    history: lifecycleArray(rawLifecycle?.history, MAX_LIFECYCLE_HISTORY, 'history'),
    ...(typeof rawLifecycle?.pauseRequestedAt === 'string'
      ? { pauseRequestedAt: rawLifecycle.pauseRequestedAt }
      : {}),
    ...(typeof rawLifecycle?.pausedAt === 'string' ? { pausedAt: rawLifecycle.pausedAt } : {}),
    ...(typeof rawLifecycle?.cancelRequestedAt === 'string'
      ? { cancelRequestedAt: rawLifecycle.cancelRequestedAt }
      : {}),
  } : {
    version: RUN_LIFECYCLE_VERSION,
    capabilities: { ...EXECUTION_CONTROL_CAPABILITIES },
    controlPhase: 'none',
    revision: 0,
    commandReceipts: [],
    history: [],
  };

  const steps = raw.steps.map((step, index) => {
    const restored = requireRecord(step, `steps[${index}]`);
    const {
      manualAttempt: _manualAttempt,
      cancelRequestedAt: _cancelRequestedAt,
      cancelledAt: _cancelledAt,
      ...legacySafeStep
    } = restored;
    return {
      ...(version === RUN_LIFECYCLE_VERSION ? restored : legacySafeStep),
      manualAttempt: version === RUN_LIFECYCLE_VERSION
        ? nonNegativeInteger(restored.manualAttempt, 0, `steps[${index}].manualAttempt`)
        : 0,
    };
  });

  const { lifecycleVersion: _legacyVersion, ...withoutLegacyVersion } = raw;
  return {
    ...withoutLegacyVersion,
    steps,
    lifecycle,
  } as unknown as RestoredRunState;
}

function normalizeDiskExecutionModes(run: RestoredRunState): RestoredRunState {
  return {
    ...run,
    steps: run.steps.map((stepState, index) => {
      const planStep = requireRecord(stepState.step, `steps[${index}].step`);
      const executionMode = planStep.executionMode;
      if (executionMode !== undefined && executionMode !== 'code' && executionMode !== 'read_only') {
        throw new Error(
          `Invalid persisted run state: steps[${index}].step.executionMode must be code or read_only`,
        );
      }
      return {
        ...stepState,
        step: { ...planStep, executionMode: executionMode ?? 'code' },
      };
    }),
  } as RestoredRunState;
}

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

  async loadAllRunStates(): Promise<RestoredRunState[]> {
    const runsDir = join(this.baseDir, 'runs');
    let runDirs: string[];
    try {
      const entries = await readdir(runsDir, { withFileTypes: true });
      runDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch (err: any) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
    const states: RestoredRunState[] = [];
    for (const runId of runDirs) {
      try {
        const state = await this.loadRunState(runId);
        if (state) states.push(state);
      } catch (err) {
        if (err instanceof UnsupportedLifecycleVersionError) throw err;
        logger.warn('Persistence', `Skipping malformed run state`, { runId, error: String(err) });
      }
    }
    return states;
  }

  async loadRunState(runId: string): Promise<RestoredRunState | null> {
    try {
      const data = await readFile(join(this.runDir(runId), 'state.json'), 'utf-8');
      return normalizeDiskExecutionModes(normalizeRunState(JSON.parse(data)));
    } catch (err: any) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }

  async appendMessage(runId: string, message: Message): Promise<void> {
    const dir = this.runDir(runId);
    await mkdir(dir, { recursive: true });
    const file = join(dir, 'messages.jsonl');
    // First touch of this run in this process lifetime: appendCounts is
    // in-memory only, so the every-COMPACT_INTERVAL compaction restarts from
    // zero each boot. Compact once up front so a log that grew past the cap
    // in earlier sessions is bounded again. This reads the file only on the
    // first append per run per process, keeping the hot path cheap.
    const firstTouch = !this.appendCounts.has(runId);
    await appendFile(file, JSON.stringify(message) + '\n');

    // Opportunistically compact so the log stays bounded (mirrors the DB cap).
    const count = (this.appendCounts.get(runId) ?? 0) + 1;
    if (firstTouch || count >= COMPACT_INTERVAL) {
      this.appendCounts.set(runId, count % COMPACT_INTERVAL);
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
      const all: Message[] = [];
      const lines = data.split(/\r?\n/);
      for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        if (line.trim().length === 0) continue;

        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          logger.warn('Persistence', 'Skipping invalid persisted message', {
            runId,
            lineNumber: index + 1,
            reasonCode: 'malformed_json',
          });
          continue;
        }

        const restored = restoreMessage(parsed, runId);
        if (typeof restored === 'string') {
          logger.warn('Persistence', 'Skipping invalid persisted message', {
            runId,
            lineNumber: index + 1,
            reasonCode: restored,
          });
          continue;
        }
        all.push(restored);
      }
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
