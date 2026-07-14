import { describe, it, expect, vi } from 'vitest';
import {
  PersistQueue,
  PersistenceUnavailableError,
} from '../src/state/persist-queue.js';
import { logger } from '../src/logger.js';

const context = (kind: string, extra: Record<string, unknown> = {}) => ({ kind, ...extra });

describe('PersistQueue', () => {
  it('runs tasks serially in enqueue order', async () => {
    const queue = new PersistQueue();
    const order: number[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });

    const first = queue.enqueue(async () => {
      await firstGate;
      order.push(1);
    }, context('first'));
    const second = queue.enqueue(() => { order.push(2); }, context('second'));

    releaseFirst();
    await Promise.all([first, second]);
    await queue.barrier();

    expect(order).toEqual([1, 2]);
    expect(queue.health).toEqual({ status: 'healthy', restartRequired: false });
  });

  it('barrier waits for work enqueued before it is called', async () => {
    const queue = new PersistQueue();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let durable = false;

    queue.enqueue(async () => {
      await gate;
      durable = true;
    }, context('run_state'));

    const barrier = queue.barrier();
    await Promise.resolve();
    expect(durable).toBe(false);

    release();
    await barrier;
    expect(durable).toBe(true);
  });

  it('latches a non-sensitive first failure and safely handles an ignored enqueue', async () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);

    try {
      const queue = new PersistQueue();
      const secret = 'credential-and-prompt-must-not-leak';

      // Deliberately ignore the returned promise, as EventEmitter listeners do.
      queue.enqueue(
        async () => { throw new Error(`disk full: ${secret}`); },
        context('message', { runId: secret, payload: secret }),
      );

      await expect(queue.barrier()).rejects.toBeInstanceOf(PersistenceUnavailableError);
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(unhandled).toEqual([]);
      expect(queue.health).toEqual({
        status: 'failed',
        restartRequired: true,
        code: 'persistence_failed',
        failedAt: expect.any(String),
        operationKind: 'message',
      });
      expect(Number.isNaN(Date.parse(queue.health.status === 'failed' ? queue.health.failedAt : ''))).toBe(false);

      expect(errorSpy).toHaveBeenCalledTimes(1);
      const logged = JSON.stringify(errorSpy.mock.calls[0]);
      expect(logged).not.toContain(secret);
      expect(logged).not.toContain('disk full');
      expect(logged).toContain('persistence_failed');
      expect(logged).toContain('message');
    } finally {
      process.off('unhandledRejection', onUnhandled);
      errorSpy.mockRestore();
    }
  });

  it('preserves the first failure and rejects later work before side effects', async () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    try {
      const queue = new PersistQueue();
      let laterTaskRan = false;

      await expect(queue.enqueue(
        async () => { throw new Error('first private failure'); },
        context('run_state'),
      )).rejects.toBeInstanceOf(PersistenceUnavailableError);

      const firstHealth = queue.health;
      await expect(queue.enqueue(
        () => { laterTaskRan = true; },
        context('later_secret_kind'),
      )).rejects.toBeInstanceOf(PersistenceUnavailableError);

      expect(laterTaskRan).toBe(false);
      expect(queue.health).toEqual(firstHealth);
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(() => queue.assertHealthy()).toThrow(PersistenceUnavailableError);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('makes concurrent barriers inherit a global queued failure', async () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    try {
      const queue = new PersistQueue();
      let successfulWriteRan = false;

      queue.enqueue(() => { successfulWriteRan = true; }, context('successful_write'));
      queue.enqueue(async () => { throw new Error('shared failure'); }, context('failed_write'));

      const firstRequestBarrier = queue.barrier();
      const secondRequestBarrier = queue.barrier();

      await expect(firstRequestBarrier).rejects.toBeInstanceOf(PersistenceUnavailableError);
      await expect(secondRequestBarrier).rejects.toBeInstanceOf(PersistenceUnavailableError);
      expect(successfulWriteRan).toBe(true);
      expect(queue.health).toMatchObject({
        status: 'failed',
        operationKind: 'failed_write',
      });
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('drain awaits late enqueues and resolves when persistence stays healthy', async () => {
    const queue = new PersistQueue();
    const completed: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });

    queue.enqueue(async () => {
      await firstGate;
      completed.push('in-flight save');
    }, context('in_flight'));
    const drained = queue.drain();

    queue.enqueue(() => { completed.push('late save'); }, context('late'));

    releaseFirst();
    await drained;
    expect(completed).toEqual(['in-flight save', 'late save']);
  });

  it('drain surfaces a latched failure instead of swallowing it', async () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    try {
      const queue = new PersistQueue();
      queue.enqueue(async () => { throw new Error('write failed'); }, context('shutdown_run_state'));

      await expect(queue.drain()).rejects.toMatchObject({
        name: 'PersistenceUnavailableError',
        code: 'persistence_failed',
        restartRequired: true,
      });
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('drain and barrier resolve immediately on an idle healthy queue', async () => {
    const queue = new PersistQueue();
    await expect(queue.barrier()).resolves.toBeUndefined();
    await expect(queue.drain()).resolves.toBeUndefined();
    expect(() => queue.assertHealthy()).not.toThrow();
  });
});
