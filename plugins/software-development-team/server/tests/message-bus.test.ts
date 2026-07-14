import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MessageBus } from '../src/bus/message-bus.js';
import { Database } from '../src/db/database.js';
import { logger } from '../src/logger.js';

describe('MessageBus', () => {
  let bus: MessageBus;

  beforeEach(async () => {
    const db = await Database.create();
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
});
