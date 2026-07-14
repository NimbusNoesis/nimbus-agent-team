import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { Message, MessageType } from '../types.js';
import { logger } from '../logger.js';
import { Database } from '../db/database.js';

interface PostMessageInput {
  runId: string;
  from: string;
  to: string;
  type: MessageType;
  body: string;
}

interface GetMessagesFilter {
  runId: string;
  to: string;
  type?: MessageType;
  since?: string;
}

export const MAX_MESSAGES_PER_RUN = 10_000;

export class MessageBus extends EventEmitter {
  private db: Database;
  private lastTimestamp = new Map<string, string>();

  constructor(db: Database) {
    super();
    this.db = db;
  }

  private nextTimestamp(runId: string): string {
    // Seed from persisted messages on first use after a restart, so new
    // timestamps stay strictly greater than any restored message's timestamp.
    if (!this.lastTimestamp.has(runId)) {
      const persistedMax = this.db.getMaxMessageTimestamp(runId);
      if (persistedMax) this.lastTimestamp.set(runId, persistedMax);
    }
    const last = this.lastTimestamp.get(runId) ?? '';
    let ts = new Date().toISOString();
    if (ts <= last) {
      // Ensure strictly increasing timestamps for deterministic filtering
      const next = new Date(new Date(last).getTime() + 1).toISOString();
      ts = next;
    }
    this.lastTimestamp.set(runId, ts);
    return ts;
  }

  post(input: PostMessageInput): Message {
    const message: Message = {
      id: randomUUID(),
      runId: input.runId,
      from: input.from,
      to: input.to,
      type: input.type,
      body: input.body,
      timestamp: this.nextTimestamp(input.runId),
    };
    this.db.insertMessage(message);
    // Enforce per-run message cap; evict oldest messages for this run if exceeded
    this.db.enforceMessageCap(input.runId, MAX_MESSAGES_PER_RUN);
    logger.debug('MessageBus', `${input.from} → ${input.to} [${input.type}]`, {
      runId: input.runId,
      messageId: message.id,
    });
    this.emit('message', { ...message });
    return message;
  }

  getMessages(filter: GetMessagesFilter): Message[] {
    const all = this.db.getMessagesByRun(filter.runId);
    const sinceEpoch = filter.since === undefined ? undefined : Date.parse(filter.since);
    return all.filter((msg) => {
      if (msg.to !== filter.to && msg.to !== 'all') return false;
      if (filter.type && msg.type !== filter.type) return false;
      if (sinceEpoch !== undefined && Date.parse(msg.timestamp) <= sinceEpoch) return false;
      return true;
    });
  }

  getAllMessages(runId: string): Message[] {
    return this.db.getMessagesByRun(runId);
  }
}
