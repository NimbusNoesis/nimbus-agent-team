import { z } from 'zod';
import type { StateMachine } from '../state/machine.js';

const positiveInt = z.number().int().positive();

const PlanStepSchema = z.object({
  id: positiveInt,
  description: z.string().min(1),
  files: z.array(z.string()),
  acceptanceCriteria: z.array(z.string()),
  dependsOn: z.array(positiveInt),
});

const TeamStartSchema = z.object({
  task: z.string().optional(),
  steps: z.array(PlanStepSchema).min(1),
});

const TeamStatusSchema = z.object({
  runId: z.string().min(1),
});

const TeamAdvanceSchema = z.object({
  runId: z.string().min(1),
  stepId: positiveInt,
  action: z.enum(['start_coding', 'approve', 'request_revision', 'resolve_escalation', 'mark_reviewed']),
  agent: z.string().min(1).optional(),
  summary: z.string().min(1).optional(),
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
  return {
    runId: run.id,
    status: run.status,
    steps: run.steps.map((s) => ({
      id: s.step.id,
      description: s.step.description,
      status: s.status,
      retryCount: s.retryCount,
      assignedAgent: s.assignedAgent,
      result: s.result,
      claimedFiles: s.claimedFiles,
      consecutiveSameError: s.consecutiveSameError,
      fileConflicts: sm.getFileConflicts(parsed.runId, s.step.id),
      startedAt: s.startedAt,
      completedAt: s.completedAt,
      blockingReasons: s.status === 'pending'
        ? sm.getBlockingReasons(parsed.runId, s.step.id)
        : [],
      dependsOn: s.step.dependsOn,
    })),
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
}

export function handleTeamAdvance(sm: StateMachine, args: unknown) {
  const parsed = TeamAdvanceSchema.parse(args);
  switch (parsed.action) {
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
