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

  /**
   * Ingest a message written by a sibling server process (observed in that
   * process's messages.jsonl). Volatile-DB-only: this never touches
   * Persistence or the PersistQueue mutation lane — the sibling already owns
   * the durable append.
   *
   * Returns true when the message was ingested, false when it was a
   * duplicate (already present by id). Duplicates cause no insert and no
   * event — the log watcher re-observes this process's own appends, and the
   * id dedupe makes that harmless.
   */
  ingestExternal(message: Message): boolean {
    if (this.db.hasMessage(message.id)) {
      logger.debug('MessageBus', 'external message deduped', {
        runId: message.runId,
        messageId: message.id,
        deduped: true,
      });
      return false;
    }

    // Preserve the ORIGINAL id and timestamp — never restamp. The sibling
    // process already stamped this message; restamping would diverge from the
    // durable log.
    this.db.insertMessage(message);

    // Bump the per-run watermark so a subsequent post() still produces a
    // STRICTLY greater timestamp. nextTimestamp() seeds from the DB only on
    // FIRST use per run, so an already-seeded run needs this explicit bump.
    // Comparison is ISO-8601 string lexicographic, exactly like post()'s
    // monotonicity check — valid because every producer emits Z-suffixed
    // toISOString values.
    if (!this.lastTimestamp.has(message.runId)) {
      const persistedMax = this.db.getMaxMessageTimestamp(message.runId);
      if (persistedMax) this.lastTimestamp.set(message.runId, persistedMax);
    }
    const current = this.lastTimestamp.get(message.runId) ?? '';
    if (message.timestamp > current) {
      this.lastTimestamp.set(message.runId, message.timestamp);
    }

    this.db.enforceMessageCap(message.runId, MAX_MESSAGES_PER_RUN);

    logger.debug('MessageBus', 'external message ingested', {
      runId: message.runId,
      messageId: message.id,
      deduped: false,
    });

    // Emit a DISTINCT event — NEVER 'message'. index.ts binds
    // Persistence.appendMessage to 'message'; re-emitting it would re-append
    // the line the sibling already wrote (echo loop).
    //
    // Deliberate accepted quirk: emitted AFTER cap enforcement, so at the cap
    // an ingested message older than this run's current oldest may be evicted
    // immediately yet still broadcast once to the live feed — a transient
    // feed-only inconsistency. team_get_messages reads the capped DB, so
    // nothing durable diverges.
    this.emit('external_message', { ...message });
    return true;
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
