// Convention: fields that are always present but may lack a value use `| null` (e.g., assignedAgent).
// Fields that are conditionally present use `?:` optional syntax (e.g., runId on MemoryEntry).

// --- Step States ---

type StepStatus = 'pending' | 'coding' | 'reviewing' | 'complete' | 'escalated';

type RunStatus = 'ready' | 'in_progress' | 'escalated' | 'complete';

export interface PlanStep {
  id: number;
  description: string;
  files: string[];
  acceptanceCriteria: string[];
  dependsOn: number[];  // step IDs this depends on
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
}

export interface StepResult {
  status: 'done' | 'done_with_concerns' | 'needs_revision' | 'blocked';
  summary: string;
  details?: string;
}

// --- Run State ---

export interface RunState {
  id: string;
  task?: string;           // human-readable task description
  status: RunStatus;
  steps: StepState[];
  createdAt: string;
  updatedAt: string;
}

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

// memory_update: emitted on initial load or full refresh — carries all entries for a run.
// memory_entry_update: emitted by MemoryStore on individual entry changes (WebSocket broadcast).
export type DashboardEvent =
  | { type: 'state_update'; run: RunState }
  | { type: 'new_message'; message: Message }
  | { type: 'memory_update'; entries: MemoryEntry[] }
  | { type: 'memory_entry_update'; entry: MemoryEntry };
