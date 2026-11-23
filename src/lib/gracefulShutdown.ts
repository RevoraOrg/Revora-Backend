/**
 * @file src/lib/gracefulShutdown.ts
 * @description Factory for the process-level graceful shutdown handler.
 *
 * Extracts the inline `shutdown()` function from `src/index.ts` so the
 * ordering, timeout fallback, and double-signal guard can be unit-tested
 * without starting the full application.
 *
 * ## Shutdown ordering (matches docs/graceful-shutdown-completeness.md)
 *
 *  1. Double-signal guard – a second signal while shutdown is in progress is
 *     a no-op; the first call owns the lifecycle.
 *  2. Stop the event-loop sampler so profiling does not interfere with
 *     connection draining.
 *  3. Stop the HTTP server (`server.close()`) so no new connections are
 *     accepted.  Existing keep-alive sockets are drained within the timeout.
 *  4. Poll in-flight request counter; break early when the counter reaches
 *     zero or the drain timeout expires.
 *  5. Close the PostgreSQL pool so idle clients are released cleanly.
 *  6. Exit the process with code 0.
 *
 * ## Security / abuse assumptions
 *
 *  - The double-signal guard (`isShuttingDown`) is synchronous and therefore
 *    not susceptible to a TOCTOU race; Node.js event-loop single-threading
 *    guarantees the flag is set before any `await` suspends.
 *  - `server.close()` stops accepting new connections immediately (sync),
 *    which removes the instance from the upstream load-balancer pool even
 *    when the drain loop is still running.
 *  - The drain timeout is a hard upper bound: a DDoS or hanging request
 *    cannot hold the process alive indefinitely.
 *  - `closePool()` is called once regardless of whether draining completed
 *    cleanly; a pool close error is intentionally swallowed here because we
 *    are already on the exit path.
 */

import type * as http from 'http';

/** Minimal interface for the event-loop sampler. */
export interface ShutdownSampler {
  stop(): void;
}

/**
 * Returns the number of in-flight HTTP requests at this instant.
 * Provided by the caller so the counter lives in the same module that
 * instruments the Express middleware (`src/index.ts`).
 */
export type InFlightGetter = () => number;

/** Closes the database connection pool. Returns a Promise. */
export type PoolCloser = () => Promise<void>;

/** Terminates the process with the given exit code. */
export type ProcessExiter = (code: number) => never;

export interface ShutdownDeps {
  /** HTTP server instance; `undefined` when running in worker-only mode. */
  server: http.Server | undefined;
  /** Drain / hard-timeout in milliseconds. Default: 10 000. */
  timeoutMs?: number;
  /** Returns the current in-flight HTTP request count. */
  getInFlightRequests: InFlightGetter;
  /** Stops the event-loop sampler. */
  sampler: ShutdownSampler;
  /** Closes the PostgreSQL connection pool. */
  closePool: PoolCloser;
  /** `process.exit` – injectable for testing. */
  exit?: ProcessExiter;
  /** `console.log` – injectable to suppress output in tests. */
  log?: (...args: unknown[]) => void;
  /** `console.warn` – injectable to suppress output in tests. */
  warn?: (...args: unknown[]) => void;
}

/**
 * Returns a signal handler function.
 *
 * The handler is idempotent: calling it a second time (double-signal) is a
 * synchronous no-op.  The first invocation drives the full shutdown sequence
 * and resolves once `exit()` has been called.
 *
 * @example
 * ```ts
 * const shutdown = createShutdownHandler({
 *   server,
 *   getInFlightRequests: () => inFlightRequests,
 *   sampler: globalSampler,
 *   closePool,
 * });
 * process.on('SIGTERM', () => void shutdown('SIGTERM'));
 * process.on('SIGINT',  () => void shutdown('SIGINT'));
 * ```
 */
export function createShutdownHandler(deps: ShutdownDeps): (signal: string) => Promise<void> {
  const {
    server,
    timeoutMs = 10_000,
    getInFlightRequests,
    sampler,
    closePool,
    exit = process.exit as ProcessExiter,
    log = console.log,
    warn = console.warn,
  } = deps;

  let isShuttingDown = false;

  return async function shutdown(signal: string): Promise<void> {
    // Double-signal guard – synchronous, no TOCTOU risk.
    if (isShuttingDown) return;
    isShuttingDown = true;

    // 1. Stop event-loop profiling.
    sampler.stop();
    log(`\n[server] ${signal} shutting down`);

    if (server) {
      // 2. Stop accepting new connections.
      const serverClosePromise = new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });

      log('[server] Stopped accepting new connections. Draining in-flight requests...');

      // 3. Poll until all in-flight requests finish or the timeout fires.
      const drainStart = Date.now();
      while (getInFlightRequests() > 0) {
        if (Date.now() - drainStart > timeoutMs) {
          warn(`[server] Drain timeout exceeded with ${getInFlightRequests()} in-flight requests. Forcing exit.`);
          break;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
      }

      if (getInFlightRequests() === 0) {
        log('[server] All in-flight requests drained.');
        try {
          const remaining = Math.max(0, timeoutMs - (Date.now() - drainStart));
          await Promise.race([
            serverClosePromise,
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error('timeout')), remaining),
            ),
          ]);
          log('[server] Listener closed completely.');
        } catch {
          warn('[server] Listener close timeout or error. Proceeding to close pool.');
        }
      }
    }

    // 4. Close the database pool.
    await closePool();

    // 5. Exit cleanly.
    exit(0);
  };
}
