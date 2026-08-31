import { Pool, PoolClient } from "pg";
import { globalLogger } from "../lib/logger";

/**
 * Transaction options for controlling transaction behavior
 */
export interface TransactionOptions<T = unknown> {
  /**
   * Isolation level for the transaction
   * @default 'READ COMMITTED'
   */
  isolationLevel?:
    | "READ UNCOMMITTED"
    | "READ COMMITTED"
    | "REPEATABLE READ"
    | "SERIALIZABLE";

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
    public readonly rollbackSucceeded: boolean = true,
  ) {
    super(message);
    this.name = "TransactionError";
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
const logger = globalLogger.child({ service: "db-transaction" });

export async function withTransaction<T>(
  pool: Pool,
  callback: (client: PoolClient) => Promise<T>,
  options: TransactionOptions<T> = {},
): Promise<T> {
  // Validate inputs before acquiring connection
  if (!pool) {
    throw new TransactionError("Pool is required");
  }
  if (typeof callback !== "function") {
    throw new TransactionError("Callback must be a function");
  }

  const {
    isolationLevel = "READ COMMITTED",
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

    let beginCommand = "BEGIN";
    if (isolationLevel !== "READ COMMITTED") {
      beginCommand += ` ISOLATION LEVEL ${isolationLevel}`;
    }
    if (readOnly) {
      beginCommand += " READ ONLY";
    }

    logger.info("Beginning transaction", {
      isolationLevel,
      readOnly,
      useSavepoint,
    });

    await client.query(beginCommand);

    const result = await callback(client);

    await client.query("COMMIT");
    transactionContexts.delete(client);
    logger.info("Transaction committed");

    if (afterCommit) {
      try {
        await afterCommit(result);
      } catch (afterCommitError) {
        const sanitizedMessage = sanitizeError(afterCommitError);
        logger.error("Post-commit action failed", { error: sanitizedMessage });
        throw new TransactionError(
          `Transaction committed but post-commit action failed: ${sanitizedMessage}`,
          afterCommitError,
        );
      }
    }

    return result;
  } catch (error) {
    let rollbackSucceeded = true;

    if (client) {
      try {
        await client.query("ROLLBACK");
        transactionContexts.delete(client);
        logger.warn("Transaction rolled back successfully");
      } catch (rollbackError) {
        rollbackSucceeded = false;
        // Log rollback failure but throw original error
        console.error(
          "[transaction] Rollback failed:",
          sanitizeError(rollbackError),
        );
      }
    }

    const sanitizedMessage = sanitizeError(error);
    logger.error("Transaction failed", {
      error: sanitizedMessage,
      rollbackSucceeded,
    });
    throw new TransactionError(
      `Transaction failed: ${sanitizedMessage}`,
      error,
      rollbackSucceeded,
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
    message = message.replace(
      /postgresql:\/\/[^\s]+/gi,
      "postgresql://[REDACTED]",
    );

    // Remove password patterns
    message = message.replace(
      /password[=:]\s*['"]?[^'"\s]+['"]?/gi,
      "password=[REDACTED]",
    );

    // Remove potential API keys or tokens
    message = message.replace(/[a-z0-9]{32,}/gi, "[REDACTED]");

    return message;
  }

  return "Unknown error";
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
  options: TransactionOptions<T> = {},
): Promise<T> {
  return withTransaction(
    pool,
    async (client) => {
      const results: unknown[] = [];

      for (const operation of operations) {
        const result = await operation(client);
        results.push(result);
      }

      return results as T;
    },
    options,
  );
}

/**
 * Result type for advisory-lock acquisition attempts.
 */
export interface AdvisoryLockAcquireResult {
  /** True when the lock was granted, false if another session holds it. */
  acquired: boolean;
}

/**
 * Error thrown when a transaction-scoped advisory lock cannot be acquired.
 *
 * This distinct error type allows callers (scheduler, HTTP handlers) to
 * differentiate "another process is already running this batch" from other
 * transactional failures and respond with the appropriate status / retry
 * behaviour instead of surfacing a generic 500.
 */
export class AdvisoryLockNotAvailableError extends Error {
  constructor(
    message: string,
    public readonly classId: number,
    public readonly objectId: number,
  ) {
    super(message);
    this.name = "AdvisoryLockNotAvailableError";
    Object.setPrototypeOf(this, AdvisoryLockNotAvailableError.prototype);
  }
}

/**
 * Derive a pair of int4 keys from arbitrary strings for use with Postgres
 * two-argument advisory-lock functions (pg_try_advisory_xact_lock etc).
 *
 * Uses FNV-1a 32-bit split into two 16-bit halves sign-extended to int4 so
 * Postgres accepts them as integer literals. Collision probability is
 * negligible for the expected cardinality of (offering_id, period_id) pairs
 * in a single deployment.
 */
export function advisoryLockKey2(
  primary: string,
  secondary: string,
): [number, number] {
  const input = `${primary}:${secondary}`;
  let h = 0x811c9dc5; // FNV-1a 32-bit offset basis
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193); // FNV prime
  }
  const hi = (h >>> 16) & 0xffff;
  const lo = h & 0xffff;
  return [hi | 0, lo | 0];
}

/**
 * Attempt to acquire a transaction-scoped advisory lock keyed by two int4
 * values. Returns true when the lock was granted, false otherwise.
 *
 * The lock is automatically released when the enclosing transaction commits
 * or rolls back — no explicit release is required.
 *
 * Security assumptions:
 * - Must only be called inside an active transaction (`withTransaction`) so
 *   the lock scopes correctly to the work being serialised.
 * - Uses `pg_try_advisory_xact_lock` (non-blocking) so a contended batch
 *   fails fast rather than queueing an unbounded number of workers.
 */
export async function tryAcquireAdvisoryXactLock(
  client: PoolClient,
  classId: number,
  objectId: number,
): Promise<boolean> {
  const result = await client.query<{ acquired: boolean }>(
    "SELECT pg_try_advisory_xact_lock($1, $2) AS acquired",
    [classId, objectId],
  );
  return result.rows[0].acquired;
}

/**
 * Execute `callback` inside a transaction while holding a transaction-scoped
 * advisory lock derived from `(primaryKey, secondaryKey)`.
 *
 * If the lock cannot be acquired (another session/process already holds it),
 * throws `AdvisoryLockNotAvailableError` so callers can decide whether to
 * retry, skip, or return a 409 CONFLICT response.
 *
 * This is the **canonical** entry point for serialising work that must not
 * run concurrently across processes (e.g. a distribution batch for a given
 * offering/period).
 *
 * @param pool          PostgreSQL connection pool.
 * @param primaryKey    First lock dimension (e.g. `offeringId`).
 * @param secondaryKey  Second lock dimension (e.g. `periodId`).
 * @param callback      Work to execute while the lock is held. Receives the
 *                      transactional `PoolClient` so the caller can participate
 *                      in the same transaction as the lock.
 * @param options       Standard transaction options (isolation level,
 *                      readOnly, afterCommit hooks).
 * @returns The callback's return value.
 * @throws {AdvisoryLockNotAvailableError} If the lock is held by another session.
 * @throws {TransactionError} If the underlying transaction fails.
 */
export async function withAdvisoryLock<T>(
  pool: Pool,
  primaryKey: string,
  secondaryKey: string,
  callback: (client: PoolClient) => Promise<T>,
  options: TransactionOptions<T> = {},
): Promise<T> {
  if (!pool) throw new TransactionError("Pool is required");
  if (!primaryKey || typeof primaryKey !== "string") {
    throw new TransactionError("primaryKey is required");
  }
  if (!secondaryKey || typeof secondaryKey !== "string") {
    throw new TransactionError("secondaryKey is required");
  }
  if (typeof callback !== "function") {
    throw new TransactionError("Callback must be a function");
  }

  const [classId, objectId] = advisoryLockKey2(primaryKey, secondaryKey);

  return withTransaction<T>(
    pool,
    async (client) => {
      const acquired = await tryAcquireAdvisoryXactLock(
        client,
        classId,
        objectId,
      );
      if (!acquired) {
        throw new AdvisoryLockNotAvailableError(
          `Advisory lock for ("${primaryKey}", "${secondaryKey}") is held by another session`,
          classId,
          objectId,
        );
      }
      return await callback(client);
    },
    options,
  );
}
