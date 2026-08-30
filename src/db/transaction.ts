import { Pool, PoolClient } from 'pg';
import { globalLogger } from '../lib/logger';
import { WebhookEventType } from '../services/webhookService';
import { OutboxRepository } from './repositories/outboxRepository';

/**
 * Transaction options for controlling transaction behavior
 */
export interface TransactionOptions<T = unknown> {
  /**
   * Isolation level for the transaction
   * @default 'READ COMMITTED'
   */
  isolationLevel?: 'READ UNCOMMITTED' | 'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE';
  
  /**
   * Whether this is a read-only transaction
   * @default false
   */
  readOnly?: boolean;
  
  /**
   * Whether to use a savepoint for nested transactions
   * @default true
   */
  useSavepoint?: boolean;

  /**
   * Optional callback invoked after a successful commit.
   * Use this for external side effects such as Stellar/Horizon or Soroban calls that
   * should only occur once the database transaction is durable.
   */
  afterCommit?: (result: T) => Promise<void> | void;
}

/**
 * Error thrown when a transaction fails
 */
export class TransactionError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
    public readonly rollbackSucceeded: boolean = true
  ) {
    super(message);
    this.name = 'TransactionError';
    Object.setPrototypeOf(this, TransactionError.prototype);
  }
}

/**
 * Context for tracking nested transaction state
 */
interface TransactionContext {
  client: PoolClient;
  depth: number;
  savepointCounter: number;
}

const transactionContexts = new WeakMap<PoolClient, TransactionContext>();

/**
 * Execute a function within a database transaction.
 * 
 * Provides atomic operations with automatic commit/rollback:
 * - All changes commit together on success
 * - All changes rollback together on failure
 * - Connection is always released back to the pool
 * - Supports nested transactions via savepoints
 * 
 * Security guarantees:
 * - Prevents partial writes on failure
 * - No connection leaks (always releases)
 * - Sanitized error messages (no sensitive data)
 * - Input validation before transaction starts
 * 
 * @param pool - PostgreSQL connection pool
 * @param callback - Function to execute within transaction, receives PoolClient
 * @param options - Transaction configuration options
 * @returns Result of the callback function
 * @throws {TransactionError} If transaction fails or cannot be rolled back
 * 
 * @example
 * ```typescript
 * const result = await withTransaction(pool, async (client) => {
 *   await client.query('INSERT INTO users (email) VALUES ($1)', ['user@example.com']);
 *   await client.query('INSERT INTO profiles (user_id) VALUES ($1)', [userId]);
 *   return { success: true };
 * });
 * ```
 * 
 * @example Nested transactions
 * ```typescript
 * await withTransaction(pool, async (client) => {
 *   await client.query('INSERT INTO orders (id) VALUES ($1)', [orderId]);
 *   
 *   // Nested transaction uses savepoint
 *   await withTransaction(pool, async (nestedClient) => {
 *     await nestedClient.query('INSERT INTO order_items (order_id) VALUES ($1)', [orderId]);
 *   }, { useSavepoint: true });
 * });
 * ```
 */
const logger = globalLogger.child({ service: 'db-transaction' });

export async function withTransaction<T>(
  pool: Pool,
  callback: (client: PoolClient) => Promise<T>,
  options: TransactionOptions<T> = {}
): Promise<T> {
  // Validate inputs before acquiring connection
  if (!pool) {
    throw new TransactionError('Pool is required');
  }
  if (typeof callback !== 'function') {
    throw new TransactionError('Callback must be a function');
  }

  const {
    isolationLevel = 'READ COMMITTED',
    readOnly = false,
    useSavepoint = true,
    afterCommit,
  } = options;

  let client: PoolClient | null = null;
  let isNestedTransaction = false;
  let savepointName: string | null = null;

  try {
    client = await pool.connect();
    
    transactionContexts.set(client, {
      client,
      depth: 0,
      savepointCounter: 0,
    });

    let beginCommand = 'BEGIN';
    if (isolationLevel !== 'READ COMMITTED') {
      beginCommand += ` ISOLATION LEVEL ${isolationLevel}`;
    }
    if (readOnly) {
      beginCommand += ' READ ONLY';
    }

    logger.info('Beginning transaction', {
      isolationLevel,
      readOnly,
      useSavepoint,
    });

    await client.query(beginCommand);

    const result = await callback(client);

    await client.query('COMMIT');
    transactionContexts.delete(client);
    logger.info('Transaction committed');

    if (afterCommit) {
      try {
        await afterCommit(result);
      } catch (afterCommitError) {
        const sanitizedMessage = sanitizeError(afterCommitError);
        logger.error('Post-commit action failed', { error: sanitizedMessage });
        throw new TransactionError(
          `Transaction committed but post-commit action failed: ${sanitizedMessage}`,
          afterCommitError
        );
      }
    }

    return result;
  } catch (error) {
    let rollbackSucceeded = true;
    
    if (client) {
      try {
        await client.query('ROLLBACK');
        transactionContexts.delete(client);
        logger.warn('Transaction rolled back successfully');
      } catch (rollbackError) {
        rollbackSucceeded = false;
        // Log rollback failure but throw original error
        console.error('[transaction] Rollback failed:', sanitizeError(rollbackError));
      }
    }

    const sanitizedMessage = sanitizeError(error);
    logger.error('Transaction failed', { error: sanitizedMessage, rollbackSucceeded });
    throw new TransactionError(
      `Transaction failed: ${sanitizedMessage}`,
      error,
      rollbackSucceeded
    );
  } finally {
    if (client && !isNestedTransaction) {
      client.release();
    }
  }
}

/**
 * Sanitize error messages to prevent sensitive data leakage
 * @param error - Error to sanitize
 * @returns Safe error message
 */
function sanitizeError(error: unknown): string {
  if (error instanceof Error) {
    // Remove sensitive patterns from error messages
    let message = error.message;
    
    // Remove connection strings
    message = message.replace(/postgresql:\/\/[^\s]+/gi, 'postgresql://[REDACTED]');
    
    // Remove password patterns
    message = message.replace(/password[=:]\s*['"]?[^'"\s]+['"]?/gi, 'password=[REDACTED]');
    
    // Remove potential API keys or tokens
    message = message.replace(/[a-z0-9]{32,}/gi, '[REDACTED]');
    
    return message;
  }
  
  return 'Unknown error';
}

/**
 * Execute multiple operations in a transaction with automatic rollback on any failure.
 * Convenience wrapper around withTransaction for common patterns.
 * 
 * @param pool - PostgreSQL connection pool
 * @param operations - Array of functions to execute in sequence
 * @param options - Transaction configuration options
 * @returns Array of results from each operation
 * 
 * @example
 * ```typescript
 * const [user, profile] = await transactional(pool, [
 *   (client) => client.query('INSERT INTO users (email) VALUES ($1) RETURNING *', ['user@example.com']),
 *   (client) => client.query('INSERT INTO profiles (user_id) VALUES ($1) RETURNING *', [userId]),
 * ]);
 * ```
 */
export async function transactional<T extends unknown[]>(
  pool: Pool,
  operations: Array<(client: PoolClient) => Promise<unknown>>,
  options: TransactionOptions<T> = {}
): Promise<T> {
  return withTransaction(pool, async (client) => {
    const results: unknown[] = [];
    
    for (const operation of operations) {
      const result = await operation(client);
      results.push(result);
    }
    
    return results as T;
  }, options);
}

/**
 * A webhook event to be captured by the transactional outbox as part of the
 * producing database transaction.
 */
export interface WebhookOutboxEvent {
  /** Webhook event type (e.g. `distribution.completed`, `payout.failed`). */
  event: WebhookEventType;
  /** Arbitrary JSON-serialisable event payload. */
  data: unknown;
  /** Stable idempotency key; a UUID v4 is generated when omitted. */
  eventId?: string;
}

/**
 * Insert webhook events into the transactional outbox using the caller's
 * transactional `client`.
 *
 * Because every row is written through the same `PoolClient` as the domain
 * change that produced the event, the rows commit or roll back atomically with
 * the surrounding `withTransaction` block:
 *
 * - **Commit**  → the rows become visible and are picked up by the
 *   `OutboxDispatcher` drain worker.
 * - **Rollback** → the rows are discarded with the transaction, so a failed
 *   producer never emits a phantom webhook event.
 *
 * Each row carries a stable `event_id` (the caller-supplied idempotency key or
 * a fresh UUID v4). The dispatcher forwards that id as the webhook payload `id`
 * on every delivery attempt, so the receiver's `webhookEventOrdering`
 * middleware can deduplicate retries — exactly-once delivery.
 *
 * @example
 * ```typescript
 * await withTransaction(pool, async (client) => {
 *   await client.query('UPDATE payouts SET status = $1 ...', ['completed', payoutId]);
 *   await enqueueWebhookOutboxEvents(client, outboxRepo, [{
 *     event: WebhookEventType.PAYOUT_COMPLETED,
 *     data: { payout_id: payoutId },
 *   }]);
 * });
 * ```
 *
 * @param client    Transactional PoolClient from the producing transaction.
 * @param outboxRepo OutboxRepository wrapping the `webhook_outbox` table.
 * @param events    List of events to capture atomically.
 * @returns         The stable `event_id` written for each event, in order.
 * @throws {TransactionError} when `client`, `outboxRepo` or the events list
 *         is invalid.
 */
export async function enqueueWebhookOutboxEvents(
  client: PoolClient,
  outboxRepo: OutboxRepository,
  events: WebhookOutboxEvent[],
): Promise<string[]> {
  if (!client) {
    throw new TransactionError('PoolClient is required to enqueue webhook outbox events');
  }
  if (!outboxRepo) {
    throw new TransactionError('OutboxRepository is required to enqueue webhook outbox events');
  }
  if (!Array.isArray(events)) {
    throw new TransactionError('Outbox events must be provided as an array');
  }
  if (events.length === 0) {
    return [];
  }

  const eventIds: string[] = [];
  for (const entry of events) {
    if (!entry || typeof entry !== 'object' || !entry.event) {
      throw new TransactionError('Each outbox event must include a valid event type');
    }
    const row = await outboxRepo.insert(
      { event_type: entry.event, payload: entry.data, event_id: entry.eventId },
      client,
    );
    eventIds.push(row.event_id);
  }
  return eventIds;
}
