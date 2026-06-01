import { z } from 'zod';
import type { MessageBus } from '../bus/message-bus.js';

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

export function handleTeamSendMessage(bus: MessageBus, args: unknown) {
  const parsed = TeamSendMessageSchema.parse(args);
  const message = bus.post(parsed);
  return { messageId: message.id };
}

export function handleTeamGetMessages(bus: MessageBus, args: unknown) {
  const parsed = TeamGetMessagesSchema.parse(args);
  const messages = bus.getMessages(parsed);
  return { messages };
}
