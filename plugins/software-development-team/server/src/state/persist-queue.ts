import { logger } from '../logger.js';

/**
 * Serialized persistence queue — one chain for run states AND message appends,
 * so shutdown can await everything in flight (previously message appends were
 * fire-and-forget and could be lost on SIGTERM).
 *
 * All writers must go through enqueue(); a direct save can race a queued save
 * for the same run (both write the same state.json.tmp then rename).
 */
export class PersistQueue {
  private tail: Promise<void> = Promise.resolve();

  enqueue(task: () => Promise<void>, context: Record<string, unknown>): Promise<void> {
    this.tail = this.tail
      .then(task)
      .catch((err) => {
        logger.error('Server', 'Persistence write failed', { ...context, error: String(err) });
      });
    return this.tail;
  }

  /**
   * Await until the queue is fully drained — including tasks enqueued AFTER
   * draining began. A single snapshot of the tail would miss late enqueues, so
   * loop until the tail is unchanged after settling.
   */
  async drain(): Promise<void> {
    let settled: Promise<void>;
    do {
      settled = this.tail;
      await settled;
    } while (settled !== this.tail);
  }
}
