import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MessageBus, MAX_MESSAGES_PER_RUN } from '../src/bus/message-bus.js';
import { Database } from '../src/db/database.js';
import { logger } from '../src/logger.js';
import { makeMessage } from './helpers.js';

describe('MessageBus', () => {
  let db: Database;
  let bus: MessageBus;

  beforeEach(async () => {
    db = await Database.create();
    bus = new MessageBus(db);
  });

  it('posts and retrieves a message', () => {
    bus.post({ runId: 'r1', from: 'coder', to: 'coordinator', type: 'info', body: 'hello' });
    const msgs = bus.getMessages({ runId: 'r1', to: 'coordinator' });
    expect(msgs).toHaveLength(1);
    expect(msgs[0].body).toBe('hello');
    expect(msgs[0].id).toBeDefined();
    expect(msgs[0].timestamp).toBeDefined();
  });

  it('filters by recipient including "all" messages', () => {
    bus.post({ runId: 'r1', from: 'coordinator', to: 'all', type: 'info', body: 'broadcast' });
    bus.post({ runId: 'r1', from: 'coder', to: 'coordinator', type: 'info', body: 'direct' });
    const coderMsgs = bus.getMessages({ runId: 'r1', to: 'coder' });
    expect(coderMsgs).toHaveLength(1);
    expect(coderMsgs[0].body).toBe('broadcast');
  });

  it('filters by type', () => {
    bus.post({ runId: 'r1', from: 'user', to: 'all', type: 'guidance', body: 'focus on tests' });
    bus.post({ runId: 'r1', from: 'coder', to: 'coordinator', type: 'info', body: 'done' });
    const guidance = bus.getMessages({ runId: 'r1', to: 'coordinator', type: 'guidance' });
    expect(guidance).toHaveLength(1);
    expect(guidance[0].body).toBe('focus on tests');
  });

  it('filters by since timestamp', () => {
    const old = bus.post({ runId: 'r1', from: 'coder', to: 'all', type: 'info', body: 'old' });
    // Use the first message's timestamp as the cutoff — guarantees it's strictly less than
    // the second message's timestamp (nextTimestamp() ensures strictly increasing order).
    const cutoff = old.timestamp;
    bus.post({ runId: 'r1', from: 'coder', to: 'all', type: 'info', body: 'new' });
    const msgs = bus.getMessages({ runId: 'r1', to: 'coder', since: cutoff });
    expect(msgs).toHaveLength(1);
    expect(msgs[0].body).toBe('new');
  });

  it('compares equivalent Z and offset since instants by epoch with an exclusive cutoff', () => {
    const atCutoff = bus.post({ runId: 'r1', from: 'coder', to: 'all', type: 'info', body: 'cutoff' });
    const afterCutoff = bus.post({ runId: 'r1', from: 'coder', to: 'all', type: 'info', body: 'after' });
    const cutoffEpoch = Date.parse(atCutoff.timestamp);
    const plusTwo = new Date(cutoffEpoch + 2 * 60 * 60 * 1_000).toISOString().replace('Z', '+02:00');
    const minusFive = new Date(cutoffEpoch - 5 * 60 * 60 * 1_000).toISOString().replace('Z', '-05:00');

    const idsFor = (since: string) => bus
      .getMessages({ runId: 'r1', to: 'coder', since })
      .map((message) => message.id);

    expect(idsFor(atCutoff.timestamp)).toEqual([afterCutoff.id]);
    expect(idsFor(plusTwo)).toEqual([afterCutoff.id]);
    expect(idsFor(minusFive)).toEqual([afterCutoff.id]);
  });

  it('logs message metadata without persisting agent-controlled bodies', () => {
    const sentinel = 'SECRET_CREDENTIAL_CODE_PROMPT_MEMORY_MESSAGE_BODY';
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});

    const message = bus.post({
      runId: 'r1',
      from: 'coder',
      to: 'coordinator',
      type: 'result',
      body: sentinel,
    });

    expect(debugSpy).toHaveBeenCalledWith(
      'MessageBus',
      'coder → coordinator [result]',
      { runId: 'r1', messageId: message.id },
    );
    expect(JSON.stringify(debugSpy.mock.calls)).not.toContain(sentinel);
    debugSpy.mockRestore();
  });

  it('emits events on post', () => {
    const events: unknown[] = [];
    bus.on('message', (msg) => events.push(msg));
    bus.post({ runId: 'r1', from: 'coder', to: 'all', type: 'info', body: 'test' });
    expect(events).toHaveLength(1);
  });

  it('returns all messages for a run', () => {
    bus.post({ runId: 'r1', from: 'a', to: 'b', type: 'info', body: '1' });
    bus.post({ runId: 'r1', from: 'b', to: 'a', type: 'info', body: '2' });
    bus.post({ runId: 'r2', from: 'a', to: 'b', type: 'info', body: '3' });
    expect(bus.getAllMessages('r1')).toHaveLength(2);
  });

  describe('ingestExternal', () => {
    it('ingests a fresh message preserving its original id and timestamp', () => {
      const external = makeMessage({
        id: 'ext-1',
        runId: 'r1',
        timestamp: '2026-01-01T00:00:00.000Z',
        body: 'from sibling',
      });

      expect(bus.ingestExternal(external)).toBe(true);

      const stored = bus.getAllMessages('r1');
      expect(stored).toHaveLength(1);
      expect(stored[0]).toEqual(external);
      expect(stored[0].id).toBe('ext-1');
      expect(stored[0].timestamp).toBe('2026-01-01T00:00:00.000Z');
    });

    it("emits 'external_message' with a copy of the message and never 'message'", () => {
      const externalEvents: unknown[] = [];
      const messageEvents: unknown[] = [];
      bus.on('external_message', (msg) => externalEvents.push(msg));
      bus.on('message', (msg) => messageEvents.push(msg));

      const external = makeMessage({ id: 'ext-1', runId: 'r1' });
      bus.ingestExternal(external);

      expect(externalEvents).toHaveLength(1);
      expect(externalEvents[0]).toEqual(external);
      // A copy, not the caller's object — listeners must not share mutable state.
      expect(externalEvents[0]).not.toBe(external);
      // 'message' is bound to Persistence.appendMessage in index.ts; emitting it
      // here would re-append a line the sibling already wrote (echo loop).
      expect(messageEvents).toHaveLength(0);
    });

    it('returns false for a duplicate id with no insert and no event', () => {
      const original = makeMessage({ id: 'dup-1', runId: 'r1', body: 'original' });
      expect(bus.ingestExternal(original)).toBe(true);

      const externalEvents: unknown[] = [];
      const messageEvents: unknown[] = [];
      bus.on('external_message', (msg) => externalEvents.push(msg));
      bus.on('message', (msg) => messageEvents.push(msg));

      const duplicate = makeMessage({ id: 'dup-1', runId: 'r1', body: 'changed' });
      expect(bus.ingestExternal(duplicate)).toBe(false);

      const stored = bus.getAllMessages('r1');
      expect(stored).toHaveLength(1);
      expect(stored[0].body).toBe('original');
      expect(externalEvents).toHaveLength(0);
      expect(messageEvents).toHaveLength(0);
    });

    it('dedupes against messages this process posted itself (watcher re-observing own appends)', () => {
      const posted = bus.post({ runId: 'r1', from: 'coder', to: 'all', type: 'info', body: 'own' });

      const externalEvents: unknown[] = [];
      bus.on('external_message', (msg) => externalEvents.push(msg));

      expect(bus.ingestExternal({ ...posted })).toBe(false);
      expect(bus.getAllMessages('r1')).toHaveLength(1);
      expect(externalEvents).toHaveLength(0);
    });

    it('bumps the watermark of an already-seeded run so post() stays strictly monotonic', () => {
      // Seed the run's in-memory watermark: nextTimestamp() only consults the
      // DB on FIRST use per run, so without an explicit bump a future-stamped
      // external message would be invisible to it.
      bus.post({ runId: 'r1', from: 'coder', to: 'all', type: 'info', body: 'seed' });

      const future = new Date(Date.now() + 60 * 60 * 1_000).toISOString();
      bus.ingestExternal(makeMessage({ id: 'ext-future', runId: 'r1', timestamp: future }));

      const next = bus.post({ runId: 'r1', from: 'coder', to: 'all', type: 'info', body: 'after' });
      // Strictly greater under ISO-8601 lexicographic comparison (same rule
      // post() itself uses; all producers emit Z-suffixed toISOString values).
      expect(next.timestamp > future).toBe(true);
    });

    it('keeps post() strictly monotonic on a run whose watermark was never seeded', () => {
      const future = new Date(Date.now() + 60 * 60 * 1_000).toISOString();
      bus.ingestExternal(makeMessage({ id: 'ext-future', runId: 'r1', timestamp: future }));

      const next = bus.post({ runId: 'r1', from: 'coder', to: 'all', type: 'info', body: 'after' });
      expect(next.timestamp > future).toBe(true);
    });

    it('does not move the watermark backwards for a past-stamped external message', () => {
      const before = bus.post({ runId: 'r1', from: 'coder', to: 'all', type: 'info', body: 'now' });
      bus.ingestExternal(makeMessage({ id: 'ext-old', runId: 'r1', timestamp: '2020-01-01T00:00:00.000Z' }));

      const next = bus.post({ runId: 'r1', from: 'coder', to: 'all', type: 'info', body: 'later' });
      expect(next.timestamp > before.timestamp).toBe(true);
    });

    it("emits 'external_message' after cap enforcement (at-cap ingest stays capped, event fires once)", () => {
      // Fill the run to exactly the cap, all newer than the message we ingest.
      const base = Date.parse('2026-01-01T00:00:00.000Z');
      for (let i = 0; i < MAX_MESSAGES_PER_RUN; i++) {
        db.insertMessage(makeMessage({
          id: `m${i}`,
          runId: 'r1',
          timestamp: new Date(base + i).toISOString(),
        }));
      }

      const countsSeenByListener: number[] = [];
      const evictedSeenByListener: boolean[] = [];
      const externalEvents: unknown[] = [];
      bus.on('external_message', (msg) => {
        externalEvents.push(msg);
        // Event fires AFTER cap enforcement: the DB is already back at the cap
        // and the older-than-oldest ingested message is already evicted.
        countsSeenByListener.push(db.getMessagesByRun('r1').length);
        evictedSeenByListener.push(db.hasMessage('ext-old'));
      });

      const external = makeMessage({
        id: 'ext-old',
        runId: 'r1',
        timestamp: new Date(base - 1).toISOString(),
      });
      expect(bus.ingestExternal(external)).toBe(true);

      // Accepted quirk: the evicted-at-cap message is still broadcast once to
      // the live feed; the capped DB is what team_get_messages reads.
      expect(externalEvents).toHaveLength(1);
      expect(externalEvents[0]).toEqual(external);
      expect(countsSeenByListener).toEqual([MAX_MESSAGES_PER_RUN]);
      expect(evictedSeenByListener).toEqual([false]);
      expect(db.getMessagesByRun('r1')).toHaveLength(MAX_MESSAGES_PER_RUN);
    });

    it('logs ingest metadata without message bodies', () => {
      const sentinel = 'SECRET_EXTERNAL_MESSAGE_BODY_SENTINEL';
      const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});

      const external = makeMessage({ id: 'ext-log', runId: 'r1', body: sentinel });
      bus.ingestExternal(external);
      bus.ingestExternal(external); // duplicate path logs too

      expect(debugSpy).toHaveBeenCalledWith(
        'MessageBus',
        'external message ingested',
        { runId: 'r1', messageId: 'ext-log', deduped: false },
      );
      expect(debugSpy).toHaveBeenCalledWith(
        'MessageBus',
        'external message deduped',
        { runId: 'r1', messageId: 'ext-log', deduped: true },
      );
      expect(JSON.stringify(debugSpy.mock.calls)).not.toContain(sentinel);
      debugSpy.mockRestore();
    });
  });
});
