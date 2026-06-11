import { signal, computed } from '@preact/signals';

// TypeScript types (inline — these mirror server/src/types.ts but for the client)
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
  status: 'pending' | 'coding' | 'reviewing' | 'complete' | 'escalated';
  retryCount: number;
  assignedAgent: string | null;
  result: StepResult | null;
  claimedFiles: string[];
  lastErrorSignature?: string;
  consecutiveSameError: number;
  startedAt?: string;
  completedAt?: string;
}

export interface RunState {
  id: string;
  task?: string;
  status: 'planning' | 'ready' | 'in_progress' | 'escalated' | 'complete';
  steps: StepState[];
  createdAt: string;
  updatedAt: string;
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

// --- Core Signals ---
export const allRuns = signal<RunState[]>([]);
export const currentRun = signal<RunState | null>(null);
export const expandedStepId = signal<number | null>(null);
export const memoryEntries = signal<MemoryEntry[]>([]);
export const expandedMemoryKeys = signal<Set<string>>(new Set());
export const currentFilter = signal<string>('all');
export const loadingRunId = signal<string | null>(null);
export const messages = signal<Message[]>([]);

// --- Computed Signals ---
export const completedSteps = computed(() =>
  currentRun.value?.steps.filter(s => s.status === 'complete').length ?? 0
);
export const totalSteps = computed(() =>
  currentRun.value?.steps.length ?? 0
);
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
