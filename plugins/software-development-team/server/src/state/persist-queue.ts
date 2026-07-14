import { logger } from '../logger.js';

export interface PersistenceOperationContext {
  kind: string;
  [key: string]: unknown;
}

interface HealthyPersistenceHealth {
  status: 'healthy';
  restartRequired: false;
}

export interface FailedPersistenceHealth {
  status: 'failed';
  restartRequired: true;
  code: 'persistence_failed';
  failedAt: string;
  operationKind: string;
}

export type PersistenceHealth = HealthyPersistenceHealth | FailedPersistenceHealth;

interface QueuedOperation {
  sequence: number;
  operationKind: string;
}

const SAFE_OPERATION_KINDS: ReadonlySet<string> = new Set([
  'run_state',
  'message',
  'memory_entry',
  'memory_delete',
  'shutdown_run_state',
]);

/**
 * Public failure raised after persistence becomes unavailable. Keep this error
 * deliberately free of the original exception and operation payload: it can
 * cross MCP and dashboard boundaries in later callers.
 */
export class PersistenceUnavailableError extends Error {
  readonly code = 'persistence_failed' as const;
  readonly restartRequired = true as const;

  constructor() {
    super('Persistence failed; restart the server before making more changes.');
    this.name = 'PersistenceUnavailableError';
  }
}

/**
 * Server-wide serialized persistence and durability coordinator.
 *
 * Every writer must use enqueue(). The internal tail is always rejection-safe
 * so EventEmitter listeners may intentionally ignore enqueue's return value.
 * Callers that need a durability guarantee use barrier() after their synchronous
 * mutation has emitted its persistence work.
 *
 * The first write failure permanently fails the queue for this process. The
 * triggering mutation may already exist in volatile memory; no rollback is
 * attempted. Later queued work is rejected before it can run, and restart is the
 * only recovery path.
 */
export class PersistQueue {
  /** A rejection-safe chain used only to serialize work. */
  private tail: Promise<void> = Promise.resolve();
  private nextSequence = 0;
  private failure: FailedPersistenceHealth | null = null;

  get health(): PersistenceHealth {
    return this.failure === null
      ? { status: 'healthy', restartRequired: false }
      : { ...this.failure };
  }

  assertHealthy(): void {
    if (this.failure !== null) {
      throw new PersistenceUnavailableError();
    }
  }

  enqueue(
    task: () => Promise<void> | void,
    context: PersistenceOperationContext,
  ): Promise<void> {
    const queuedOperation: QueuedOperation = {
      sequence: ++this.nextSequence,
      operationKind: this.safeOperationKind(context.kind),
    };

    const operation = this.tail.then(async () => {
      this.assertHealthy();

      try {
        await task();
      } catch {
        this.latchFailure(queuedOperation);
        throw new PersistenceUnavailableError();
      }
    });

    // Attach the rejection handler synchronously. `operation` remains
    // awaitable (and rejects safely), while the internal chain always settles
    // successfully so a rejected write cannot create an unhandled rejection or
    // break queue serialization.
    this.tail = operation.catch(() => undefined);

    return operation;
  }

  /**
   * Wait for every operation synchronously enqueued before this call, then
   * report the server-wide health latch. The health check is intentionally
   * global: a caller does not receive durable success after any known write
   * failure, even when its own write happened to succeed.
   */
  async barrier(): Promise<void> {
    const target = this.tail;
    await target;
    this.assertHealthy();
  }

  /**
   * Await until the queue is fully drained, including tasks enqueued after
   * draining began, then surface any latched persistence failure.
   */
  async drain(): Promise<void> {
    let settled: Promise<void>;
    do {
      settled = this.tail;
      await settled;
    } while (settled !== this.tail);

    this.assertHealthy();
  }

  private latchFailure(operation: QueuedOperation): void {
    if (this.failure !== null) return;

    this.failure = {
      status: 'failed',
      restartRequired: true,
      code: 'persistence_failed',
      failedAt: new Date().toISOString(),
      operationKind: operation.operationKind,
    };

    logger.error('Server', 'Persistence subsystem failed; restart required', {
      status: this.failure.status,
      restartRequired: this.failure.restartRequired,
      code: this.failure.code,
      failedAt: this.failure.failedAt,
      operationKind: this.failure.operationKind,
    });
  }

  private safeOperationKind(kind: string): string {
    const trimmed = kind.trim();
    return SAFE_OPERATION_KINDS.has(trimmed) ? trimmed : 'unknown';
  }
}
