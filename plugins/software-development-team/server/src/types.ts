// Convention: fields that are always present but may lack a value use `| null` (e.g., assignedAgent).
// Fields that are conditionally present use `?:` optional syntax (e.g., runId on MemoryEntry).

// --- Step States ---

export type StepStatus = 'pending' | 'coding' | 'reviewing' | 'complete' | 'escalated' | 'cancelled';

export type RunStatus = 'ready' | 'in_progress' | 'escalated' | 'complete' | 'cancelled';

export interface PlanStep {
  id: number;
  description: string;
  files: string[];
  acceptanceCriteria: string[];
  dependsOn: number[];  // step IDs this depends on
}

export interface WorktreeContext {
  targetBranch: string;
  targetCommit: string;
  path: string;
  branch: string;
}

export interface StepState {
  step: PlanStep;
  status: StepStatus;
  retryCount: number;
  assignedAgent: string | null;
  result: StepResult | null;
  claimedFiles: string[];       // files actively being edited by this step
  lastErrorSignature?: string;  // for stuck detection — hash of last error
  consecutiveSameError: number; // count of identical consecutive errors
  startedAt?: string;           // ISO timestamp when step entered coding status
  completedAt?: string;         // ISO timestamp when step entered complete status
  resultHistory?: StepResult[]; // prior results displaced by later submissions (e.g., coder result overwritten by reviewer verdict)
  worktree?: WorktreeContext;   // set once before initial admission and reused across retries/resume
  manualAttempt?: number;       // zero-based count of explicit operator retries; normalized to 0 on restore
  cancelRequestedAt?: string;   // ISO timestamp while an active worker is draining after cancellation
  cancelledAt?: string;         // ISO timestamp when coordinator quiescence is acknowledged
}

export interface StepResult {
  status: 'done' | 'done_with_concerns' | 'needs_revision' | 'blocked';
  summary: string;
  details?: string;
}

// --- Run State ---

export const RUN_LIFECYCLE_VERSION = 2 as const;
export const MAX_COMMAND_RECEIPTS = 128;
export const MAX_LIFECYCLE_HISTORY = 256;

/**
 * RunStatus remains the aggregate plan outcome. This phase independently
 * describes whether the coordinator may admit or spawn execution work.
 */
export type RunControlPhase = 'running' | 'pausing' | 'paused' | 'cancelling';

export type ExecutionControlAction =
  | 'pause_run'
  | 'resume_run'
  | 'cancel_run'
  | 'cancel_step'
  | 'retry_step'
  | 'acknowledge_pause'
  | 'acknowledge_cancel';

export type ExecutionControlTarget =
  | { kind: 'run' }
  | { kind: 'step'; stepId: number };

export interface LifecycleCommandOutcome {
  controlPhase: RunControlPhase;
  runStatus: RunStatus;
  stepStatus?: StepStatus;
}

/**
 * The durable result of applying a command. A repeated commandId with the
 * same fingerprint reuses this receipt rather than advancing the revision.
 */
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

/** A compact, user-visible audit record for a successful lifecycle command. */
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

export interface RunLifecycleV2 {
  version: typeof RUN_LIFECYCLE_VERSION;
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
  task?: string;           // human-readable task description
  status: RunStatus;
  steps: StepState[];
  createdAt: string;
  updatedAt: string;
  /**
   * Optional only so pre-v2 persisted JSON remains representable. Every
   * restore boundary returns a RunState with a canonical v2 lifecycle.
   */
  lifecycle?: RunLifecycleV2;
}

export type RestoredRunState = RunState & { lifecycle: RunLifecycleV2 };

// --- Messages ---

export type MessageType = 'info' | 'review' | 'escalation' | 'guidance' | 'result';

export interface Message {
  id: string;
  runId: string;
  from: string;
  to: string;  // agent name or "all"
  type: MessageType;
  body: string;
  timestamp: string;
}

// --- Memory ---

export type MemoryNamespace = 'decisions' | 'context' | 'learnings' | 'reviews' | 'reflections';

export interface MemoryEntry {
  key: string;
  namespace: MemoryNamespace;
  value: string;
  runId?: string;
  updatedAt: string;
}

// --- Dashboard Events ---

// memory_entry_update: broadcast when MemoryStore emits entry_change (write/upsert of a single entry).
// memory_entry_delete: broadcast when MemoryStore emits entry_delete — carries the entry as it
// existed at deletion time so clients can remove it by namespace+key.
export type DashboardEvent =
  | { type: 'state_update'; run: RunState }
  | { type: 'new_message'; message: Message }
  | { type: 'memory_entry_update'; entry: MemoryEntry }
  | { type: 'memory_entry_delete'; entry: MemoryEntry };
