/**
 * @file src/lib/gracefulShutdown.test.ts
 * @description Unit tests for createShutdownHandler.
 *
 * Covers:
 *  - Ordering: sampler → server.close → drain → closePool → exit
 *  - Timeout fallback: drain loop is interrupted when the timeout fires
 *  - Double-signal guard: a second call while shutdown is in progress is a no-op
 *  - Worker-only mode: server is undefined – pool is closed, exit is called
 *  - Drain completes before timeout: waits for server.close promise
 */

import { createShutdownHandler, ShutdownDeps } from './gracefulShutdown';
import type * as http from 'http';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal fake http.Server whose close() callback fires synchronously. */
function makeServer(closeError?: Error): http.Server {
  return {
    close(cb?: (err?: Error) => void) {
      cb?.(closeError);
    },
  } as unknown as http.Server;
}

/** Build default deps with all side-effects tracked via jest.fn(). */
function makeDeps(overrides: Partial<ShutdownDeps> = {}): {
  deps: Required<ShutdownDeps>;
  mocks: {
    samplerStop: jest.Mock;
    closePool: jest.Mock;
    exit: jest.Mock;
    log: jest.Mock;
    warn: jest.Mock;
  };
} {
  const samplerStop = jest.fn();
  const closePool = jest.fn().mockResolvedValue(undefined);
  const exit = jest.fn() as unknown as jest.Mock;
  const log = jest.fn();
  const warn = jest.fn();

  const deps: Required<ShutdownDeps> = {
    server: makeServer(),
    timeoutMs: 500,
    getInFlightRequests: jest.fn().mockReturnValue(0),
    sampler: { stop: samplerStop },
    closePool,
    exit: exit as unknown as (code: number) => never,
    log,
    warn,
    ...overrides,
  };

  return { deps, mocks: { samplerStop, closePool, exit, log, warn } };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createShutdownHandler', () => {
  beforeEach(() => {
    jest.useRealTimers();
  });

  describe('shutdown ordering', () => {
    it('calls sampler.stop, then closePool, then exit(0) when no in-flight requests', async () => {
      const { deps, mocks } = makeDeps();
      const callOrder: string[] = [];

      mocks.samplerStop.mockImplementation(() => callOrder.push('sampler.stop'));
      mocks.closePool.mockImplementation(async () => { callOrder.push('closePool'); });
      mocks.exit.mockImplementation(() => { callOrder.push('exit'); return undefined as never; });

      const shutdown = createShutdownHandler(deps);
      await shutdown('SIGTERM');

      expect(callOrder).toEqual(['sampler.stop', 'closePool', 'exit']);
    });

    it('passes exit code 0 to exit()', async () => {
      const { deps, mocks } = makeDeps();
      mocks.exit.mockReturnValue(undefined as never);

      const shutdown = createShutdownHandler(deps);
      await shutdown('SIGTERM');

      expect(mocks.exit).toHaveBeenCalledWith(0);
    });

    it('logs the signal name during shutdown', async () => {
      const { deps, mocks } = makeDeps();
      mocks.exit.mockReturnValue(undefined as never);

      const shutdown = createShutdownHandler(deps);
      await shutdown('SIGINT');

      expect(mocks.log).toHaveBeenCalledWith(
        expect.stringContaining('SIGINT'),
      );
    });
  });

  describe('handler injection – server receives the injected RefreshService mock', () => {
    it('calls server.close() before closing the pool', async () => {
      const callOrder: string[] = [];
      let closeCb: ((err?: Error) => void) | undefined;

      const fakeServer: http.Server = {
        close(cb?: (err?: Error) => void) {
          callOrder.push('server.close');
          closeCb = cb;
          cb?.(); // resolve immediately
        },
      } as unknown as http.Server;

      const { deps, mocks } = makeDeps({ server: fakeServer });
      mocks.closePool.mockImplementation(async () => { callOrder.push('closePool'); });
      mocks.exit.mockReturnValue(undefined as never);

      const shutdown = createShutdownHandler(deps);
      await shutdown('SIGTERM');

      expect(callOrder).toEqual(['server.close', 'closePool']);
      expect(closeCb).toBeDefined();
    });
  });

  describe('double-signal guard', () => {
    it('is a no-op when called a second time while shutdown is in progress', async () => {
      // Keep closePool pending so the first call does not complete before the
      // second call arrives.
      let resolvePending!: () => void;
      const pendingPool = new Promise<void>((resolve) => { resolvePending = resolve; });

      const { deps, mocks } = makeDeps({
        closePool: jest.fn().mockReturnValue(pendingPool),
      });
      mocks.exit.mockReturnValue(undefined as never);

      const shutdown = createShutdownHandler(deps);

      // Fire both; the second should be a synchronous no-op
      const first = shutdown('SIGTERM');
      const second = shutdown('SIGTERM');

      // second resolves immediately (no-op)
      await second;
      expect(mocks.samplerStop).toHaveBeenCalledTimes(1);

      // Let the first finish
      resolvePending();
      await first;
      expect(mocks.exit).toHaveBeenCalledTimes(1);
    });

    it('does not call exit() twice across two signals', async () => {
      const { deps, mocks } = makeDeps();
      mocks.exit.mockReturnValue(undefined as never);

      const shutdown = createShutdownHandler(deps);
      await shutdown('SIGTERM');
      await shutdown('SIGINT');

      expect(mocks.exit).toHaveBeenCalledTimes(1);
    });
  });

  describe('timeout fallback', () => {
    it('warns and proceeds to closePool when in-flight requests do not drain within timeoutMs', async () => {
      jest.useFakeTimers();

      // getInFlightRequests always returns 1 so the drain loop never exits naturally.
      const getInFlightRequests = jest.fn().mockReturnValue(1);
      const closePool = jest.fn().mockResolvedValue(undefined);
      const exit = jest.fn().mockReturnValue(undefined as never);
      const warn = jest.fn();

      const fakeServer: http.Server = {
        close(cb?: (err?: Error) => void) { cb?.(); },
      } as unknown as http.Server;

      const deps: ShutdownDeps = {
        server: fakeServer,
        timeoutMs: 200,
        getInFlightRequests,
        sampler: { stop: jest.fn() },
        closePool,
        exit: exit as unknown as (code: number) => never,
        log: jest.fn(),
        warn,
      };

      const shutdown = createShutdownHandler(deps);
      const shutdownPromise = shutdown('SIGTERM');

      // Advance timers past the 200 ms timeout; the 100 ms poll tick fires.
      jest.advanceTimersByTime(300);
      await Promise.resolve();
      jest.advanceTimersByTime(300);
      await Promise.resolve();
      jest.useRealTimers();
      await shutdownPromise;

      expect(warn).toHaveBeenCalledWith(expect.stringContaining('Drain timeout exceeded'));
      expect(closePool).toHaveBeenCalled();
      expect(exit).toHaveBeenCalledWith(0);
    });
  });

  describe('worker-only mode (server is undefined)', () => {
    it('skips server.close, closes pool, and exits when no server is provided', async () => {
      const closePool = jest.fn().mockResolvedValue(undefined);
      const exit = jest.fn().mockReturnValue(undefined as never);
      const samplerStop = jest.fn();

      const shutdown = createShutdownHandler({
        server: undefined,
        getInFlightRequests: () => 0,
        sampler: { stop: samplerStop },
        closePool,
        exit: exit as unknown as (code: number) => never,
        log: jest.fn(),
        warn: jest.fn(),
      });

      await shutdown('SIGTERM');

      expect(samplerStop).toHaveBeenCalled();
      expect(closePool).toHaveBeenCalled();
      expect(exit).toHaveBeenCalledWith(0);
    });
  });

  describe('server.close error handling', () => {
    it('proceeds to closePool even when server.close resolves with an error', async () => {
      const closePool = jest.fn().mockResolvedValue(undefined);
      const exit = jest.fn().mockReturnValue(undefined as never);
      const warn = jest.fn();

      const fakeServer: http.Server = {
        close(cb?: (err?: Error) => void) {
          cb?.(new Error('close failed'));
        },
      } as unknown as http.Server;

      const shutdown = createShutdownHandler({
        server: fakeServer,
        timeoutMs: 200,
        getInFlightRequests: () => 0,
        sampler: { stop: jest.fn() },
        closePool,
        exit: exit as unknown as (code: number) => never,
        log: jest.fn(),
        warn,
      });

      await shutdown('SIGTERM');

      // server.close errored — the handler warns and continues to closePool
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('Listener close timeout or error'),
      );
      expect(closePool).toHaveBeenCalled();
      expect(exit).toHaveBeenCalledWith(0);
    });
  });
});
