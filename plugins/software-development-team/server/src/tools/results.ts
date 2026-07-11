import { z } from 'zod';
import type { StateMachine } from '../state/machine.js';
import { positiveInt } from './schemas.js';

// Raw shape exported for MCP registration — see src/tools/schemas.ts for why
// both validation layers derive from this single definition.
export const teamSubmitResultShape = {
  runId: z.string().min(1),
  stepId: positiveInt,
  result: z.object({
    status: z.enum(['done', 'done_with_concerns', 'needs_revision', 'blocked']),
    summary: z.string().min(1),
    details: z.string().optional(),
  }),
};

const TeamSubmitResultSchema = z.object(teamSubmitResultShape);

export function handleTeamSubmitResult(sm: StateMachine, args: unknown) {
  const parsed = TeamSubmitResultSchema.parse(args);
  sm.submitResult(parsed.runId, parsed.stepId, parsed.result);
  const updatedRun = sm.getRun(parsed.runId);
  const step = updatedRun?.steps.find(s => s.step.id === parsed.stepId);
  return { success: true, stepStatus: step?.status };
}
