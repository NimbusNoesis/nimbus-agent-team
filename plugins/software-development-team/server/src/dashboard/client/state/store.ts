import { signal, computed } from '@preact/signals';

export type StepStatus =
  | 'pending'
  | 'coding'
  | 'reviewing'
  | 'complete'
  | 'escalated'
  | 'cancelling'
  | 'cancelled';
export type RunStatus = 'ready' | 'in_progress' | 'escalated' | 'complete' | 'cancelled';
export type RunControlPhase = 'none' | 'pausing' | 'paused' | 'cancelling' | 'cancelled';
export type ExecutionControlAction =
  | 'pause_run'
  | 'resume_run'
  | 'cancel_run'
  | 'cancel_step'
  | 'retry_step'
  | 'acknowledge_pause'
  | 'acknowledge_cancel';
export type ExecutionControlTarget = { kind: 'run' } | { kind: 'step'; stepId: number };
export type ExecutionControlCapabilities = Record<ExecutionControlAction, boolean>;

interface PlanStep {
  id: number;
  description: string;
  files: string[];
  acceptanceCriteria: string[];
  dependsOn: number[];
}

interface StepResult {
  status: 'done' | 'done_with_concerns' | 'needs_revision' | 'blocked';
  summary: string;
  details?: string;
}

export interface StepState {
  step: PlanStep;
  status: StepStatus;
  retryCount: number;
  assignedAgent: string | null;
  result: StepResult | null;
  claimedFiles: string[];
  lastErrorSignature?: string;
  consecutiveSameError: number;
  startedAt?: string;
  completedAt?: string;
  resultHistory?: StepResult[];
  worktree?: { targetBranch: string; targetCommit: string; path: string; branch: string };
  manualAttempt?: number;
  cancelRequestedAt?: string;
  cancelledAt?: string;
}

export interface LifecycleCommandOutcome {
  controlPhase: RunControlPhase;
  runStatus: RunStatus;
  stepStatus?: StepStatus;
}

export interface LifecycleCommandReceipt {
  commandId: string;
  fingerprint: string;
  action: ExecutionControlAction;
  target: ExecutionControlTarget;
  expectedRevision: number;
  revision: number;
  recordedAt: string;
  outcome: LifecycleCommandOutcome;
}

export interface LifecycleHistoryEntry {
  commandId: string;
  action: ExecutionControlAction;
  target: ExecutionControlTarget;
  revision: number;
  recordedAt: string;
  fromPhase: RunControlPhase;
  toPhase: RunControlPhase;
  summary?: string;
}

export interface RunLifecycle {
  version: number;
  capabilities: ExecutionControlCapabilities;
  controlPhase: RunControlPhase;
  revision: number;
  commandReceipts: LifecycleCommandReceipt[];
  history: LifecycleHistoryEntry[];
  pauseRequestedAt?: string;
  pausedAt?: string;
  cancelRequestedAt?: string;
}

export interface RunState {
  id: string;
  task?: string;
  status: RunStatus;
  steps: StepState[];
  createdAt: string;
  updatedAt: string;
  /** Optional for a safe, read-only fallback when connected to a pre-v2 server. */
  lifecycle?: RunLifecycle;
}

export interface Message {
  id: string;
  runId: string;
  from: string;
  to: string;
  type: 'info' | 'review' | 'escalation' | 'guidance' | 'result';
  body: string;
  timestamp: string;
}

export interface MemoryEntry {
  key: string;
  namespace: string;
  value: string;
  runId?: string;
  updatedAt: string;
}

export type ConnectionStatus = 'connecting' | 'online' | 'offline';
export type DataFreshness = 'loading' | 'fresh' | 'stale';
export type ControlOperationStatus = 'idle' | 'pending' | 'success' | 'error' | 'conflict' | 'recovering';

export interface ControlError {
  status: number;
  code: string;
  message: string;
}

export interface ControlOperationState {
  status: ControlOperationStatus;
  action?: ExecutionControlAction;
  target?: ExecutionControlTarget;
  commandId?: string;
  error?: ControlError;
  receipt?: LifecycleCommandReceipt;
  requiresReconfirmation?: boolean;
  recoveredRevision?: number;
  updatedAt?: string;
}

export interface ControlAvailability {
  available: boolean;
  reason?: string;
}

// --- Core Signals ---
export const allRuns = signal<RunState[]>([]);
export const currentRun = signal<RunState | null>(null);
export const expandedStepId = signal<number | null>(null);
export const memoryEntries = signal<MemoryEntry[]>([]);
export const expandedMemoryKeys = signal<Set<string>>(new Set());
export const currentFilter = signal<string>('all');
export const loadingRunId = signal<string | null>(null);
export const messages = signal<Message[]>([]);
export const connectionStatus = signal<ConnectionStatus>('connecting');
export const dataFreshness = signal<DataFreshness>('loading');
export const lastSyncedAt = signal<string | null>(null);
/** Control state is intentionally retained per run and target when switching tabs. */
export const controlOperations = signal<Record<string, ControlOperationState>>({});

// --- Computed Signals ---
export const completedSteps = computed(() =>
  currentRun.value?.steps.filter(s => s.status === 'complete').length ?? 0
);
export const totalSteps = computed(() => currentRun.value?.steps.length ?? 0);
export const filteredMessages = computed(() => {
  if (currentFilter.value === 'all') return messages.value;
  return messages.value.filter(m => m.type === currentFilter.value);
});
export const messageCounts = computed(() => {
  const counts: Record<string, number> = { all: 0, info: 0, review: 0, escalation: 0, guidance: 0, result: 0 };
  messages.value.forEach(m => {
    if (m.type && counts[m.type] !== undefined) counts[m.type]++;
    counts.all++;
  });
  return counts;
});
export const controlHistory = computed(() => currentRun.value?.lifecycle?.history ?? []);

export function lifecycleRevision(run: RunState | null | undefined): number {
  return run?.lifecycle?.version === 2 && Number.isSafeInteger(run.lifecycle.revision)
    ? run.lifecycle.revision
    : -1;
}

function historyIdentity(entry: LifecycleHistoryEntry): string {
  return `${entry.commandId}:${entry.revision}`;
}

function mergeHistory(
  previous: LifecycleHistoryEntry[] = [],
  incoming: LifecycleHistoryEntry[] = [],
): LifecycleHistoryEntry[] {
  const entries = new Map<string, LifecycleHistoryEntry>();
  for (const entry of [...previous, ...incoming]) entries.set(historyIdentity(entry), entry);
  return [...entries.values()].sort((a, b) =>
    a.revision - b.revision || a.recordedAt.localeCompare(b.recordedAt) || a.commandId.localeCompare(b.commandId)
  );
}

function mergeReceipts(
  previous: LifecycleCommandReceipt[] = [],
  incoming: LifecycleCommandReceipt[] = [],
): LifecycleCommandReceipt[] {
  const receipts = new Map(previous.map(receipt => [receipt.commandId, receipt]));
  for (const receipt of incoming) receipts.set(receipt.commandId, receipt);
  return [...receipts.values()].sort((a, b) => a.revision - b.revision || a.commandId.localeCompare(b.commandId));
}

/**
 * Reconciles HTTP and WebSocket snapshots. Older lifecycle revisions never win;
 * equal revisions use updatedAt for ordinary state while unioning the audit log.
 */
export function mergeRunSnapshot(previous: RunState | undefined, incoming: RunState): RunState {
  if (!previous) return incoming;
  const previousRevision = lifecycleRevision(previous);
  const incomingRevision = lifecycleRevision(incoming);
  if (incomingRevision < previousRevision) return previous;

  const incomingIsOlderAtSameRevision = incomingRevision === previousRevision
    && Date.parse(incoming.updatedAt) < Date.parse(previous.updatedAt);
  const base = incomingIsOlderAtSameRevision ? previous : incoming;
  if (!previous.lifecycle || !incoming.lifecycle || incomingRevision !== previousRevision) return base;

  return {
    ...base,
    lifecycle: {
      ...base.lifecycle!,
      history: mergeHistory(previous.lifecycle.history, incoming.lifecycle.history),
      commandReceipts: mergeReceipts(previous.lifecycle.commandReceipts, incoming.lifecycle.commandReceipts),
    },
  };
}

/** Upserts a snapshot and updates the selected run only when its id still matches. */
export function applyRunSnapshot(incoming: RunState): RunState {
  const index = allRuns.value.findIndex(run => run.id === incoming.id);
  const previous = index >= 0
    ? allRuns.value[index]
    : currentRun.value?.id === incoming.id ? currentRun.value : undefined;
  const merged = mergeRunSnapshot(previous, incoming);
  if (index < 0 || merged !== previous) {
    const next = [...allRuns.value];
    if (index >= 0) next[index] = merged;
    else next.push(merged);
    allRuns.value = next;
  }
  if (currentRun.value?.id === incoming.id) {
    currentRun.value = mergeRunSnapshot(currentRun.value, merged);
  }
  return merged;
}

/** Applies a collection without allowing a slow fetch to downgrade newer WS state. */
export function applyRunSnapshots(incoming: RunState[]): RunState[] {
  for (const run of incoming) applyRunSnapshot(run);
  return allRuns.value;
}

export function controlTargetKey(runId: string, target: ExecutionControlTarget): string {
  return target.kind === 'run' ? `${runId}:run` : `${runId}:step:${target.stepId}`;
}

export function getControlOperation(runId: string, target: ExecutionControlTarget): ControlOperationState {
  return controlOperations.value[controlTargetKey(runId, target)] ?? { status: 'idle' };
}

export function setControlOperation(
  runId: string,
  target: ExecutionControlTarget,
  operation: ControlOperationState,
): void {
  controlOperations.value = {
    ...controlOperations.value,
    [controlTargetKey(runId, target)]: operation,
  };
}

export function clearControlOperation(runId: string, target: ExecutionControlTarget): void {
  const next = { ...controlOperations.value };
  delete next[controlTargetKey(runId, target)];
  controlOperations.value = next;
}

/** Derives both capability support and current lifecycle/action preconditions. */
export function getControlAvailability(
  action: ExecutionControlAction,
  target: ExecutionControlTarget,
  run: RunState | null = currentRun.value,
): ControlAvailability {
  if (!run) return { available: false, reason: 'No run is selected.' };
  if (run.lifecycle?.version !== 2 || run.lifecycle.capabilities[action] !== true) {
    return { available: false, reason: 'This server does not support this action.' };
  }
  if (connectionStatus.value === 'connecting') return { available: false, reason: 'The dashboard is connecting.' };
  if (connectionStatus.value === 'offline') return { available: false, reason: 'The dashboard is offline.' };
  if (dataFreshness.value !== 'fresh' || loadingRunId.value === run.id) {
    return { available: false, reason: 'Run data is still loading or may be stale.' };
  }
  const operation = getControlOperation(run.id, target);
  if (operation.status === 'pending' || operation.status === 'recovering') {
    return { available: false, reason: 'Another control request for this target is in progress.' };
  }

  const phase = run.lifecycle.controlPhase;
  if (run.status === 'complete' || run.status === 'cancelled' || phase === 'cancelled') {
    return { available: false, reason: 'This run is terminal.' };
  }

  const runOnly = ['pause_run', 'resume_run', 'cancel_run', 'acknowledge_pause'] as ExecutionControlAction[];
  const stepOnly = ['cancel_step', 'retry_step'] as ExecutionControlAction[];
  if (target.kind === 'step' && runOnly.includes(action)) {
    return { available: false, reason: 'This action requires a run target.' };
  }
  if (target.kind === 'run' && stepOnly.includes(action)) {
    return { available: false, reason: 'This action requires a step target.' };
  }

  if (target.kind === 'run') {
    if (action === 'pause_run' && phase !== 'none') return { available: false, reason: `Cannot pause while the run is ${phase}.` };
    if (action === 'resume_run' && phase !== 'paused') return { available: false, reason: 'Only a paused run can be resumed.' };
    if (action === 'acknowledge_pause' && phase !== 'pausing') return { available: false, reason: 'The run is not draining for pause.' };
    if (action === 'acknowledge_cancel' && phase !== 'cancelling') return { available: false, reason: 'The run is not draining for cancellation.' };
    if (action === 'cancel_run' && phase === 'cancelling') return { available: false, reason: 'Cancellation is already in progress.' };
  }

  if (target.kind === 'step') {
    const step = run.steps.find(candidate => candidate.step.id === target.stepId);
    if (!step) return { available: false, reason: 'The selected step no longer exists.' };
    if (action === 'cancel_step') {
      if (phase === 'cancelling') return { available: false, reason: 'Cancel the run rather than an individual step.' };
      if (['complete', 'cancelled', 'cancelling'].includes(step.status)) {
        return { available: false, reason: 'This step is already terminal or cancelling.' };
      }
    }
    if (action === 'acknowledge_cancel') {
      if (phase === 'cancelling') return { available: false, reason: 'Acknowledge cancellation at run scope.' };
      if (step.status !== 'cancelling') return { available: false, reason: 'This step is not awaiting cancellation acknowledgement.' };
    }
    if (action === 'retry_step') {
      if (phase !== 'none') return { available: false, reason: `Step retry is unavailable while the run is ${phase}.` };
      if (step.status !== 'escalated') return { available: false, reason: 'Only an escalated step can be retried.' };
      if (!step.worktree) return { available: false, reason: 'This step has no persisted worktree to retry.' };
      if ((step.manualAttempt ?? 0) >= 3) return { available: false, reason: 'The manual retry allowance is exhausted.' };
      const incompleteDependency = step.step.dependsOn.some(id =>
        run.steps.find(candidate => candidate.step.id === id)?.status !== 'complete'
      );
      if (incompleteDependency) return { available: false, reason: 'A dependency is not complete.' };
      const claimed = new Set(step.step.files);
      const conflicts = run.steps.some(candidate =>
        candidate.step.id !== step.step.id
        && ['coding', 'reviewing', 'cancelling'].includes(candidate.status)
        && candidate.claimedFiles.some(file => claimed.has(file))
      );
      if (conflicts) return { available: false, reason: 'Another active step claims one or more of these files.' };
    }
  }
  return { available: true };
}

// --- Actions ---
export function toggleStep(id: number) {
  expandedStepId.value = expandedStepId.value === id ? null : id;
}

export function toggleMemoryKey(key: string) {
  const next = new Set(expandedMemoryKeys.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  expandedMemoryKeys.value = next;
}

export function setFilter(type: string) {
  currentFilter.value = type;
}
