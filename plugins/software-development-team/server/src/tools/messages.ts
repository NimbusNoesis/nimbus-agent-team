import { z } from 'zod';
import type { MessageBus } from '../bus/message-bus.js';
import type { StateMachine } from '../state/machine.js';

const MessageTypeSchema = z.enum(['info', 'review', 'escalation', 'guidance', 'result']);

const TeamSendMessageSchema = z.object({
  runId: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
  type: MessageTypeSchema,
  body: z.string().min(1),
});

const TeamGetMessagesSchema = z.object({
  runId: z.string().min(1),
  to: z.string().min(1),
  type: MessageTypeSchema.optional(),
  since: z.string().datetime().optional(),
});

export function handleTeamSendMessage(bus: MessageBus, sm: StateMachine, args: unknown) {
  const parsed = TeamSendMessageSchema.parse(args);
  // Reject unknown run IDs: messages posted under a fabricated runId are
  // orphaned — no dashboard run view will ever show them. Planning-phase work
  // that happens before team_start must use team_memory_write instead.
  if (!sm.getRun(parsed.runId)) {
    throw new Error(
      `Run ${parsed.runId} not found. team_send_message requires an existing run — ` +
      `before team_start, persist planning notes with team_memory_write instead.`
    );
  }
  const message = bus.post(parsed);
  return { messageId: message.id };
}

export function handleTeamGetMessages(bus: MessageBus, args: unknown) {
  const parsed = TeamGetMessagesSchema.parse(args);
  const messages = bus.getMessages(parsed);
  return { messages };
}
