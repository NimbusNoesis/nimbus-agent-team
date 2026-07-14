import { z } from 'zod';
import type { StateMachine } from '../state/machine.js';
import type {
  ExecutionControlAction,
  ExecutionControlTarget,
  RunState,
  StepState,
} from '../types.js';
import { positiveInt } from './schemas.js';

// Worker-slot capacity of this host, reported to coordinators via team_status.
// Both hosts' coordinator instructions size their worker pool from this value
// (maxParallel = hostCapacity - 1, one slot reserved for the coordinator).
function hostCapacity(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const raw = env.TEAM_HOST_CAPACITY;
  if (!raw || !/^\d+$/.test(raw)) return undefined;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 1 ? parsed : undefined;
}

const PlanStepSchema = z.object({
  id: positiveInt,
  description: z.string().min(1),
  files: z.array(z.string()),
  acceptanceCriteria: z.array(z.string()),
  dependsOn: z.array(positiveInt),
  executionMode: z.enum(['code', 'read_only']).default('code'),
}).strict();

// Keep the raw shape available for direct schema-parity tests. Production
// registration must use the complete schema below so root strictness survives
// at the public MCP boundary.
export const teamStartShape = {
  task: z.string().optional().describe('Human-readable task description shown in the dashboard'),
  steps: z.array(PlanStepSchema).min(1),
};

// A raw shape cannot retain object-level strictness when spread into a new
// object, so production callers register this complete schema.
export const teamStartSchema = z.object(teamStartShape).strict();

export const teamStatusShape = {
  runId: z.string().min(1),
};

const TeamStatusSchema = z.object(teamStatusShape);

const ExecutionControlActionSchema = z.enum([
  'pause_run',
  'acknowledge_pause',
  'resume_run',
  'cancel_run',
  'cancel_step',
  'acknowledge_cancel',
  'retry_step',
]);

const ExecutionControlTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('run') }).strict(),
  z.object({ kind: z.literal('step'), stepId: positiveInt }).strict(),
]);

const teamControlShape = {
  runId: z.string().min(1),
  action: ExecutionControlActionSchema,
  target: ExecutionControlTargetSchema,
  commandId: z.string().trim().min(1).max(128),
  expectedRevision: z.number().int().nonnegative(),
  reason: z.string().trim().min(1).max(500).optional(),
  confirmation: z.literal(true).optional(),
};

const RUN_TARGET_ACTIONS = new Set<ExecutionControlAction>([
  'pause_run', 'acknowledge_pause', 'resume_run', 'cancel_run',
]);
const STEP_TARGET_ACTIONS = new Set<ExecutionControlAction>(['cancel_step', 'retry_step']);

export const teamControlSchema = z.object(teamControlShape).strict().superRefine((value, ctx) => {
  if (RUN_TARGET_ACTIONS.has(value.action) && value.target.kind !== 'run') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['target'], message: `${value.action} requires a run target` });
  }
  if (STEP_TARGET_ACTIONS.has(value.action) && value.target.kind !== 'step') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['target'], message: `${value.action} requires a step target` });
  }
  if ((value.action === 'cancel_run' || value.action === 'cancel_step') && value.confirmation !== true) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['confirmation'], message: 'confirmation=true is required for cancellation' });
  }
});

const WorktreeSchema = z.object({
  targetBranch: z.string().min(1),
  targetCommit: z.string().min(1),
  path: z.string().min(1),
  branch: z.string().min(1),
}).strict();

export const teamAdvanceShape = {
  runId: z.string().min(1),
  stepId: positiveInt,
  action: z.enum(['set_worktree', 'start_coding', 'approve', 'request_revision', 'resolve_escalation', 'mark_reviewed']),
  agent: z.string().min(1).optional(),
  summary: z.string().min(1).optional(),
  worktree: WorktreeSchema.optional(),
};

// The set_worktree cross-field requirement cannot live on the raw legacy
// shape. Keep it on the complete schema so registerTool() and the handler
// reject the same input before dispatch or mutation.
export const teamAdvanceSchema = z.object(teamAdvanceShape).strict().superRefine((value, ctx) => {
  if (value.action === 'set_worktree' && !value.worktree) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['worktree'], message: 'worktree is required for set_worktree' });
  }
});

export function handleTeamStart(sm: StateMachine, args: unknown) {
  const parsed = teamStartSchema.parse(args);
  const run = sm.createRun(parsed.steps, parsed.task);
  return { runId: run.id, task: run.task, status: run.status, stepCount: run.steps.length };
}

export function handleTeamStatus(sm: StateMachine, args: unknown): Record<string, unknown> {
  const parsed = TeamStatusSchema.parse(args);
  const run = sm.getRun(parsed.runId);
  if (!run) throw new Error(`Run ${parsed.runId} not found`);
  const capacity = hostCapacity();
  const lifecycle = run.lifecycle!;
  const activeWorkers = run.steps
    .filter((step) => step.status === 'coding' || step.status === 'reviewing' || step.status === 'cancelling')
    .map((step) => ({
      stepId: step.step.id,
      agent: step.assignedAgent,
      status: step.status,
      draining: lifecycle.controlPhase === 'pausing' || step.status === 'cancelling',
    }));
  return {
    runId: run.id,
    status: run.status,
    phase: lifecycle.controlPhase,
    lifecycleVersion: lifecycle.version,
    revision: lifecycle.revision,
    capabilities: lifecycle.capabilities,
    actionAvailability: runActionAvailability(run),
    controlHistory: lifecycle.history,
    // Deliberately omit receipt fingerprints: they contain operator-provided
    // reasons and exist for internal idempotency, not status presentation.
    controlReceipts: lifecycle.commandReceipts.map(({ fingerprint: _fingerprint, ...receipt }) => receipt),
    workers: {
      // The MCP server observes lifecycle assignments, not native processes.
      // Coordinators must use their native agent roster before acknowledging
      // draining; this marker prevents clients treating assignments as PIDs.
      truthSource: 'lifecycle_assignments',
      nativeProcessState: 'not_observed',
      activeCount: activeWorkers.length,
      active: activeWorkers,
      admissionsFrozen: lifecycle.controlPhase !== 'none',
    },
    ...(capacity === undefined ? {} : { hostCapacity: capacity }),
    steps: run.steps.map((s) => ({
      id: s.step.id,
      description: s.step.description,
      executionMode: s.step.executionMode,
      status: s.status,
      retryCount: s.retryCount,
      assignedAgent: s.assignedAgent,
      result: s.result,
      claimedFiles: s.claimedFiles,
      consecutiveSameError: s.consecutiveSameError,
      manualAttempt: s.manualAttempt ?? 0,
      resultHistory: s.resultHistory ?? [],
      cancelRequestedAt: s.cancelRequestedAt,
      cancelledAt: s.cancelledAt,
      actionAvailability: stepActionAvailability(sm, run, s),
      fileConflicts: sm.fileConflictsFor(run, s.step.id),
      startedAt: s.startedAt,
      completedAt: s.completedAt,
      blockingReasons: s.status === 'pending'
        ? sm.blockingReasonsFor(run, s.step.id)
        : [],
      dependsOn: s.step.dependsOn,
      worktree: s.worktree,
    })),
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
}

type Availability = { available: boolean; reason?: string };

function availability(available: boolean, reason?: string): Availability {
  return available ? { available: true } : { available: false, reason: reason ?? 'Unavailable' };
}

function supported(run: RunState, action: ExecutionControlAction): boolean {
  return run.lifecycle?.capabilities[action] === true;
}

function runActionAvailability(run: RunState): Record<string, Availability> {
  const lifecycle = run.lifecycle!;
  const phase = lifecycle.controlPhase;
  const terminal = run.status === 'complete' || run.status === 'cancelled' || phase === 'cancelled';
  const entry = (action: ExecutionControlAction, allowed: boolean, reason: string) =>
    supported(run, action)
      ? availability(allowed, reason)
      : availability(false, `${action} is not supported by this run`);
  return {
    pause_run: entry('pause_run', !terminal && phase === 'none', terminal ? 'Run is terminal' : `Run control phase is '${phase}'`),
    acknowledge_pause: entry('acknowledge_pause', phase === 'pausing', `Run control phase is '${phase}'`),
    resume_run: entry('resume_run', phase === 'paused', `Run control phase is '${phase}'`),
    cancel_run: entry('cancel_run', !terminal && phase !== 'cancelling', terminal ? 'Run is terminal' : 'Run cancellation is already in progress'),
    acknowledge_cancel: entry('acknowledge_cancel', phase === 'cancelling', `Run control phase is '${phase}'`),
  };
}

function stepActionAvailability(
  sm: StateMachine,
  run: RunState,
  step: StepState,
): Record<string, Availability> {
  const lifecycle = run.lifecycle!;
  const phase = lifecycle.controlPhase;
  const terminal = run.status === 'complete' || run.status === 'cancelled' || phase === 'cancelled';
  const cancelAllowed = !terminal
    && phase !== 'cancelling'
    && step.status !== 'complete'
    && step.status !== 'cancelled'
    && step.status !== 'cancelling';
  let retryReason = 'Step is not escalated';
  let retryAllowed = false;
  if (phase !== 'none') retryReason = `Run control phase is '${phase}'`;
  else if (terminal) retryReason = 'Run is terminal';
  else if (step.status === 'escalated' && !step.worktree) retryReason = 'Persisted worktree context is required';
  else if (step.status === 'escalated' && (step.manualAttempt ?? 0) >= 3) retryReason = 'Manual retry allowance is exhausted';
  else if (step.status === 'escalated') {
    const blockers = sm.blockingReasonsFor(run, step.step.id);
    retryAllowed = blockers.length === 0;
    retryReason = blockers[0] ?? '';
  }
  const withCapability = (action: ExecutionControlAction, value: Availability) =>
    supported(run, action) ? value : availability(false, `${action} is not supported by this run`);
  return {
    cancel_step: withCapability('cancel_step', availability(cancelAllowed,
      terminal ? 'Run is terminal' : step.status === 'complete' ? 'Step is complete and immutable'
        : step.status === 'cancelled' || step.status === 'cancelling' ? `Step is already ${step.status}`
          : `Run control phase is '${phase}'`)),
    acknowledge_cancel: withCapability('acknowledge_cancel', availability(
      phase !== 'cancelling' && step.status === 'cancelling',
      phase === 'cancelling' ? 'Acknowledge cancellation at run scope' : 'Step is not awaiting cancellation acknowledgement',
    )),
    retry_step: withCapability('retry_step', availability(retryAllowed, retryReason)),
  };
}

export function handleTeamControl(sm: StateMachine, args: unknown) {
  const parsed = teamControlSchema.parse(args);
  const before = sm.getRun(parsed.runId);
  if (!before) throw new Error(`Run ${parsed.runId} not found`);
  const receipt = sm.executeControl(parsed.runId, {
    action: parsed.action,
    target: parsed.target as ExecutionControlTarget,
    commandId: parsed.commandId,
    expectedRevision: parsed.expectedRevision,
    ...(parsed.reason ? { summary: parsed.reason } : {}),
  });
  return {
    success: true,
    replayed: receipt.revision <= before.lifecycle!.revision,
    commandId: receipt.commandId,
    action: receipt.action,
    target: receipt.target,
    revision: receipt.revision,
    recordedAt: receipt.recordedAt,
    status: receipt.outcome.runStatus,
    phase: receipt.outcome.controlPhase,
    ...(receipt.outcome.stepStatus ? { stepStatus: receipt.outcome.stepStatus } : {}),
  };
}

export function handleTeamAdvance(sm: StateMachine, args: unknown) {
  const parsed = teamAdvanceSchema.parse(args);
  switch (parsed.action) {
    case 'set_worktree':
      sm.setWorktree(parsed.runId, parsed.stepId, parsed.worktree!);
      break;
    case 'start_coding':
      sm.startStep(parsed.runId, parsed.stepId, parsed.agent ?? 'coder');
      break;
    case 'approve':
      sm.advanceStep(parsed.runId, parsed.stepId);
      break;
    case 'request_revision':
      sm.requestRevision(parsed.runId, parsed.stepId);
      break;
    case 'resolve_escalation':
      sm.resolveEscalation(parsed.runId, parsed.stepId);
      break;
    case 'mark_reviewed':
      sm.markReviewed(parsed.runId, parsed.stepId, parsed.summary);
      break;
  }
  const updatedRun = sm.getRun(parsed.runId);
  const step = updatedRun?.steps.find(s => s.step.id === parsed.stepId);
  return { success: true, stepStatus: step?.status, runStatus: updatedRun?.status };
}
