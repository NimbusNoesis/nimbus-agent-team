import { describe, it, expect, vi } from 'vitest';
import { PersistQueue } from '../src/state/persist-queue.js';
import { logger } from '../src/logger.js';

describe('PersistQueue', () => {
  it('runs tasks serially in enqueue order', async () => {
    const queue = new PersistQueue();
    const order: number[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });

    queue.enqueue(async () => { await firstGate; order.push(1); }, { kind: 'test' });
    queue.enqueue(async () => { order.push(2); }, { kind: 'test' });

    releaseFirst();
    await queue.drain();
    expect(order).toEqual([1, 2]);
  });

  it('drain awaits tasks enqueued after draining began (shutdown race)', async () => {
    const queue = new PersistQueue();
    const completed: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });

    // A save is in flight when shutdown starts draining...
    queue.enqueue(async () => { await firstGate; completed.push('in-flight save'); }, { kind: 'test' });
    const drained = queue.drain();

    // ...and another save arrives AFTER the drain snapshot was taken.
    queue.enqueue(async () => { completed.push('late save'); }, { kind: 'test' });

    releaseFirst();
    await drained;
    expect(completed).toEqual(['in-flight save', 'late save']);
  });

  it('logs a failed task and keeps the queue running', async () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    try {
      const queue = new PersistQueue();
      const completed: string[] = [];

      queue.enqueue(async () => { throw new Error('disk full'); }, { kind: 'run_state', runId: 'r1' });
      queue.enqueue(async () => { completed.push('next save'); }, { kind: 'test' });

      await queue.drain();
      expect(completed).toEqual(['next save']);
      expect(errorSpy).toHaveBeenCalledWith(
        'Server',
        'Persistence write failed',
        expect.objectContaining({ kind: 'run_state', runId: 'r1', error: expect.stringContaining('disk full') }),
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('drain resolves immediately on an idle queue', async () => {
    const queue = new PersistQueue();
    await expect(queue.drain()).resolves.toBeUndefined();
  });
});
