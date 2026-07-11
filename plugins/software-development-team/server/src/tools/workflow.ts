import { z } from 'zod';
import type { StateMachine } from '../state/machine.js';
import { positiveInt } from './schemas.js';

// Worker-slot capacity of this host, reported to coordinators via team_status.
// Both hosts' coordinator instructions size their worker pool from this value
// (maxParallel = hostCapacity - 1, one slot reserved for the coordinator).
export function hostCapacity(env: NodeJS.ProcessEnv = process.env): number | undefined {
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
});

// Raw shapes are exported for MCP registration: server.tool() takes a
// ZodRawShape (plain object of validators), not a ZodObject. index.ts spreads
// these same shapes into its registrations and the handlers below parse
// z.object(shape), so both validation layers derive from one definition.
export const teamStartShape = {
  task: z.string().optional().describe('Human-readable task description shown in the dashboard'),
  steps: z.array(PlanStepSchema).min(1),
};

const TeamStartSchema = z.object(teamStartShape);

export const teamStatusShape = {
  runId: z.string().min(1),
};

const TeamStatusSchema = z.object(teamStatusShape);

const WorktreeSchema = z.object({
  targetBranch: z.string().min(1),
  targetCommit: z.string().min(1),
  path: z.string().min(1),
  branch: z.string().min(1),
});

export const teamAdvanceShape = {
  runId: z.string().min(1),
  stepId: positiveInt,
  action: z.enum(['set_worktree', 'start_coding', 'approve', 'request_revision', 'resolve_escalation', 'mark_reviewed']),
  agent: z.string().min(1).optional(),
  summary: z.string().min(1).optional(),
  worktree: WorktreeSchema.optional(),
};

// The set_worktree cross-field requirement can only live on the handler-side
// ZodObject (a raw shape has nowhere to hang superRefine), so the MCP layer
// accepts set_worktree without a worktree and the handler rejects it.
const TeamAdvanceSchema = z.object(teamAdvanceShape).superRefine((value, ctx) => {
  if (value.action === 'set_worktree' && !value.worktree) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['worktree'], message: 'worktree is required for set_worktree' });
  }
});

export function handleTeamStart(sm: StateMachine, args: unknown) {
  const parsed = TeamStartSchema.parse(args);
  const run = sm.createRun(parsed.steps, parsed.task);
  return { runId: run.id, task: run.task, status: run.status, stepCount: run.steps.length };
}

export function handleTeamStatus(sm: StateMachine, args: unknown) {
  const parsed = TeamStatusSchema.parse(args);
  const run = sm.getRun(parsed.runId);
  if (!run) throw new Error(`Run ${parsed.runId} not found`);
  const capacity = hostCapacity();
  return {
    runId: run.id,
    status: run.status,
    ...(capacity === undefined ? {} : { hostCapacity: capacity }),
    steps: run.steps.map((s) => ({
      id: s.step.id,
      description: s.step.description,
      status: s.status,
      retryCount: s.retryCount,
      assignedAgent: s.assignedAgent,
      result: s.result,
      claimedFiles: s.claimedFiles,
      consecutiveSameError: s.consecutiveSameError,
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

export function handleTeamAdvance(sm: StateMachine, args: unknown) {
  const parsed = TeamAdvanceSchema.parse(args);
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
