import {
  allRuns,
  applyRunSnapshot,
  applyRunSnapshots,
  connectionStatus,
  currentRun,
  dataFreshness,
  getControlAvailability,
  getControlOperation,
  lastSyncedAt,
  lifecycleRevision,
  messages,
  memoryEntries,
  loadingRunId,
  currentFilter,
  setControlOperation,
} from './store';
import type {
  ControlError,
  ExecutionControlAction,
  ExecutionControlTarget,
  LifecycleCommandReceipt,
  RunState,
  Message,
  MemoryEntry,
} from './store';

export interface ControlCommand {
  action: ExecutionControlAction;
  target: ExecutionControlTarget;
  reason?: string;
  confirmation?: string;
  /** Primarily useful for deterministic tests; normal callers should omit it. */
  commandId?: string;
  /** Defaults to the selected snapshot's revision. */
  expectedRevision?: number;
}

export interface ControlSuccessResponse {
  success: true;
  replayed: boolean;
  receipt: LifecycleCommandReceipt;
  run: RunState;
}

export type ControlResult =
  | { ok: true; response: ControlSuccessResponse }
  | { ok: false; error: ControlError; requiresReconfirmation?: boolean };

let selectionSequence = 0;

export async function fetchRuns(): Promise<RunState[]> {
  const r = await fetch('/api/runs');
  if (!r.ok) throw new Error(`Server error: ${r.status}`);
  return r.json();
}

export async function refreshRuns(expectedSelectedRunId = currentRun.value?.id): Promise<RunState[]> {
  const runs = await fetchRuns();
  applyRunSnapshots(runs);
  if (currentRun.value?.id === expectedSelectedRunId) {
    dataFreshness.value = 'fresh';
    lastSyncedAt.value = new Date().toISOString();
  }
  return allRuns.value;
}

export async function fetchMessages(runId: string): Promise<Message[]> {
  const r = await fetch(`/api/runs/${encodeURIComponent(runId)}/messages`);
  if (!r.ok) {
    console.warn(`Failed to fetch messages for run ${runId}: server responded ${r.status}`);
    return [];
  }
  return r.json();
}

export async function fetchMemory(): Promise<MemoryEntry[]> {
  const r = await fetch('/api/memory');
  if (!r.ok) {
    console.warn(`Failed to fetch memory: server responded ${r.status}`);
    return [];
  }
  return r.json();
}

/** Returns true when the guidance was accepted by the server, false otherwise. */
export async function sendGuidance(runId: string, body: string): Promise<boolean> {
  try {
    const r = await fetch('/api/guidance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runId, body }),
    });
    if (!r.ok) {
      console.warn(`Failed to send guidance: server responded ${r.status}`);
      return false;
    }
    return true;
  } catch (e) {
    console.warn('Failed to send guidance:', e);
    return false;
  }
}

function generateCommandId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  // Browser fallback with UUID-v4 shape. It is an idempotency key, not a secret.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, character => {
    const random = Math.floor(Math.random() * 16);
    const value = character === 'x' ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
}

async function responseError(response: Response): Promise<ControlError> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = undefined;
  }
  const error = typeof payload === 'object' && payload !== null
    && typeof (payload as { error?: unknown }).error === 'object'
    && (payload as { error: unknown }).error !== null
    ? (payload as { error: Record<string, unknown> }).error
    : undefined;
  return {
    status: response.status,
    code: typeof error?.code === 'string' ? error.code : `http_${response.status}`,
    message: typeof error?.message === 'string' ? error.message : `Server error: ${response.status}`,
  };
}

/**
 * Sends exactly one control mutation. It never retries POST requests. A 409
 * performs a separate authoritative GET and leaves the operation in conflict,
 * requiring the operator to reconsider and explicitly submit a new command.
 */
export async function executeControl(runId: string, command: ControlCommand): Promise<ControlResult> {
  const run = (currentRun.value?.id === runId ? currentRun.value : undefined)
    ?? allRuns.value.find(candidate => candidate.id === runId);
  if (!run) {
    return { ok: false, error: { status: 404, code: 'target_not_found', message: 'The selected run no longer exists.' } };
  }

  const existing = getControlOperation(runId, command.target);
  if (existing.status === 'pending' || existing.status === 'recovering') {
    return {
      ok: false,
      error: { status: 409, code: 'request_in_progress', message: 'A control request for this target is already in progress.' },
    };
  }

  const availability = getControlAvailability(command.action, command.target, run);
  if (!availability.available) {
    return {
      ok: false,
      error: { status: 409, code: 'action_unavailable', message: availability.reason ?? 'This action is unavailable.' },
    };
  }

  const commandId = command.commandId ?? generateCommandId();
  const expectedRevision = command.expectedRevision ?? lifecycleRevision(run);
  const selectedRunIdAtStart = currentRun.value?.id;
  const startedAt = new Date().toISOString();
  setControlOperation(runId, command.target, {
    status: 'pending',
    action: command.action,
    target: command.target,
    commandId,
    updatedAt: startedAt,
  });

  try {
    const response = await fetch(`/api/runs/${encodeURIComponent(runId)}/control`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: command.action,
        target: command.target,
        commandId,
        expectedRevision,
        ...(command.reason === undefined ? {} : { reason: command.reason }),
        ...(command.confirmation === undefined ? {} : { confirmation: command.confirmation }),
      }),
    });

    if (!response.ok) {
      const error = await responseError(response);
      if (response.status === 409) {
        setControlOperation(runId, command.target, {
          status: 'recovering', action: command.action, target: command.target, commandId, error,
          requiresReconfirmation: true, updatedAt: new Date().toISOString(),
        });
        try {
          await refreshRuns(selectedRunIdAtStart);
        } catch (refreshError) {
          console.warn('Failed to refresh run state after control conflict:', refreshError);
          if (currentRun.value?.id === selectedRunIdAtStart) dataFreshness.value = 'stale';
        }
        const recovered = allRuns.value.find(candidate => candidate.id === runId);
        setControlOperation(runId, command.target, {
          status: 'conflict', action: command.action, target: command.target, commandId, error,
          requiresReconfirmation: true,
          recoveredRevision: recovered ? lifecycleRevision(recovered) : undefined,
          updatedAt: new Date().toISOString(),
        });
        return { ok: false, error, requiresReconfirmation: true };
      }
      setControlOperation(runId, command.target, {
        status: 'error', action: command.action, target: command.target, commandId, error,
        updatedAt: new Date().toISOString(),
      });
      return { ok: false, error };
    }

    const payload = await response.json() as ControlSuccessResponse;
    applyRunSnapshot(payload.run);
    if (currentRun.value?.id === selectedRunIdAtStart) {
      dataFreshness.value = 'fresh';
      lastSyncedAt.value = new Date().toISOString();
    }
    setControlOperation(runId, command.target, {
      status: 'success', action: command.action, target: command.target, commandId,
      receipt: payload.receipt, updatedAt: new Date().toISOString(),
    });
    return { ok: true, response: payload };
  } catch (cause) {
    const error: ControlError = {
      status: 0,
      code: 'network_error',
      message: cause instanceof Error ? cause.message : 'The control request could not reach the server.',
    };
    connectionStatus.value = 'offline';
    dataFreshness.value = 'stale';
    setControlOperation(runId, command.target, {
      status: 'error', action: command.action, target: command.target, commandId, error,
      updatedAt: new Date().toISOString(),
    });
    return { ok: false, error };
  }
}

/** Alias that reads naturally in event handlers. */
export const sendControlCommand = executeControl;

function mergeMessages(history: Message[], live: Message[]): Message[] {
  const byId = new Map<string, Message>();
  for (const message of [...history, ...live]) byId.set(message.id, message);
  return [...byId.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id));
}

export async function selectRun(run: RunState): Promise<void> {
  const sequence = ++selectionSequence;
  const merged = applyRunSnapshot(run);
  currentRun.value = merged;
  loadingRunId.value = run.id;
  dataFreshness.value = 'loading';
  messages.value = [];
  currentFilter.value = 'all';

  try {
    const msgs = await fetchMessages(run.id);
    if (selectionSequence !== sequence || currentRun.value?.id !== run.id) return;
    messages.value = mergeMessages(msgs, messages.value);
  } finally {
    if (selectionSequence === sequence && loadingRunId.value === run.id) loadingRunId.value = null;
  }

  try {
    const entries = await fetchMemory();
    if (selectionSequence !== sequence || currentRun.value?.id !== run.id) return;
    memoryEntries.value = entries;
    dataFreshness.value = 'fresh';
    lastSyncedAt.value = new Date().toISOString();
  } catch (e) {
    if (selectionSequence === sequence && currentRun.value?.id === run.id) dataFreshness.value = 'stale';
    console.error('Failed to fetch memory:', e);
  }
}
