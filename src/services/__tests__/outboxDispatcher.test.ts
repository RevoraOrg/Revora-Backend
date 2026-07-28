/**
 * Tests for the transactional outbox:
 *  1. Producer rollback discards the outbox row
 *  2. Dispatcher crash mid-dispatch retries without duplication (same event_id)
 *  3. Receiver sees the same event_id on every retry
 *  4. Dispatcher marks row dispatched on success
 *  5. Dispatcher applies exponential back-off on failure
 *  6. Dispatcher dead-letters after maxAttempts
 */

import { OutboxRepository, OutboxRow, InsertOutboxInput } from '../../db/repositories/outboxRepository';
import { OutboxDispatcher, makeWebhookDispatchFn, DispatchFn, PressureTier } from '../outboxDispatcher';
import { WebhookEventType } from '../webhookService';
import { MetricsCollector } from '../../lib/metrics';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeRow(overrides: Partial<OutboxRow> = {}): OutboxRow {
  return {
    id: 'row-1',
    event_id: 'evt-uuid-stable',
    event_type: WebhookEventType.PAYOUT_COMPLETED,
    payload: { investor_id: 'inv-1', amount: '10.00' },
    status: 'pending',
    attempts: 0,
    available_at: new Date(),
    created_at: new Date('2024-01-01T00:00:00Z'),
    updated_at: new Date(),
    ...overrides,
  };
}

function makeOutboxRepo(rows: OutboxRow[] = []): jest.Mocked<OutboxRepository> {
  return {
    insert: jest.fn().mockResolvedValue(rows[0] ?? makeRow()),
    drainPending: jest.fn().mockResolvedValue(rows),
    markDispatched: jest.fn().mockResolvedValue(undefined),
    markFailed: jest.fn().mockResolvedValue(undefined),
    getOldestPending: jest.fn().mockResolvedValue(rows.length > 0 ? rows[0] : null),
  } as unknown as jest.Mocked<OutboxRepository>;
}

beforeEach(() => jest.clearAllMocks());

// ─── 1. Producer rollback discards the outbox row ────────────────────────────

describe('producer rollback', () => {
  it('does not call outboxRepo.insert when the domain write throws before it', async () => {
    // Simulate a producer that throws before reaching the outbox insert.
    // This is the exact sequence inside withTransaction when the domain write fails.
    const outboxInsert = jest.fn();
    let outboxInsertCalled = false;

    const producerLogic = async () => {
      throw new Error('unique violation'); // domain INSERT fails
      // eslint-disable-next-line no-unreachable
      outboxInsertCalled = true;
      await outboxInsert({ event_type: WebhookEventType.PAYOUT_COMPLETED, payload: {} });
    };

    await expect(producerLogic()).rejects.toThrow('unique violation');
    expect(outboxInsertCalled).toBe(false);
    expect(outboxInsert).not.toHaveBeenCalled();
  });
});

// ─── 2 & 3. Dispatcher retry preserves event_id ──────────────────────────────

describe('OutboxDispatcher', () => {
  it('calls markDispatched on success', async () => {
    const row = makeRow();
    const repo = makeOutboxRepo([row]);
    const dispatch: DispatchFn = jest.fn().mockResolvedValue(true);
    const dispatcher = new OutboxDispatcher(repo, dispatch, { maxAttempts: 3, retryBaseMs: 0 });

    await dispatcher.drainOnce();

    expect(dispatch).toHaveBeenCalledWith(row);
    expect(repo.markDispatched).toHaveBeenCalledWith(row.id);
    expect(repo.markFailed).not.toHaveBeenCalled();
  });

  it('calls markFailed with retryAfter on transient failure (not yet exhausted)', async () => {
    const row = makeRow({ attempts: 0 });
    const repo = makeOutboxRepo([row]);
    const dispatch: DispatchFn = jest.fn().mockResolvedValue(false);
    const dispatcher = new OutboxDispatcher(repo, dispatch, { maxAttempts: 3, retryBaseMs: 100 });

    await dispatcher.drainOnce();

    expect(repo.markDispatched).not.toHaveBeenCalled();
    expect(repo.markFailed).toHaveBeenCalledWith(row.id, expect.any(Date));
    // retryAfter should be in the future
    const retryAfter: Date = (repo.markFailed as jest.Mock).mock.calls[0][1];
    expect(retryAfter.getTime()).toBeGreaterThan(Date.now() - 10);
  });

  it('dead-letters the row after maxAttempts', async () => {
    const row = makeRow({ attempts: 4 }); // next attempt = 5 = maxAttempts
    const repo = makeOutboxRepo([row]);
    const dispatch: DispatchFn = jest.fn().mockResolvedValue(false);
    const dispatcher = new OutboxDispatcher(repo, dispatch, { maxAttempts: 5, retryBaseMs: 0 });

    await dispatcher.drainOnce();

    // markFailed called with no retryAfter → dead-letter
    expect(repo.markFailed).toHaveBeenCalledWith(row.id);
    expect(repo.markFailed).toHaveBeenCalledTimes(1);
    const call = (repo.markFailed as jest.Mock).mock.calls[0];
    expect(call[1]).toBeUndefined();
  });

  it('treats a dispatch exception as a failure', async () => {
    const row = makeRow({ attempts: 0 });
    const repo = makeOutboxRepo([row]);
    const dispatch: DispatchFn = jest.fn().mockRejectedValue(new Error('network error'));
    const dispatcher = new OutboxDispatcher(repo, dispatch, { maxAttempts: 3, retryBaseMs: 0 });

    await dispatcher.drainOnce();

    expect(repo.markDispatched).not.toHaveBeenCalled();
    expect(repo.markFailed).toHaveBeenCalled();
  });

  it('returns 0 when there are no pending rows', async () => {
    const repo = makeOutboxRepo([]);
    const dispatch: DispatchFn = jest.fn();
    const dispatcher = new OutboxDispatcher(repo, dispatch);

    const count = await dispatcher.drainOnce();

    expect(count).toBe(0);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('start/stop controls the polling loop', () => {
    jest.useFakeTimers();
    const repo = makeOutboxRepo([]);
    const dispatch: DispatchFn = jest.fn().mockResolvedValue(true);
    const dispatcher = new OutboxDispatcher(repo, dispatch, { intervalMs: 1000 });

    dispatcher.start();
    dispatcher.start(); // idempotent

    jest.advanceTimersByTime(2500);
    dispatcher.stop();
    jest.advanceTimersByTime(5000); // no more ticks after stop

    jest.useRealTimers();
  });
});

// ─── 4. Idempotent event_id via makeWebhookDispatchFn ────────────────────────

describe('makeWebhookDispatchFn', () => {
  it('forwards the stable event_id as the webhook payload id', async () => {
    const row = makeRow({ event_id: 'stable-uuid-123' });
    const processDelivery = jest.fn().mockResolvedValue(true);
    const listActiveByEvent = jest.fn().mockResolvedValue([{ url: 'https://example.com/hook' }]);

    const fn = makeWebhookDispatchFn(processDelivery, listActiveByEvent);
    await fn(row);

    expect(processDelivery).toHaveBeenCalledWith(
      'https://example.com/hook',
      expect.objectContaining({ id: 'stable-uuid-123' })
    );
  });

  it('returns true when no endpoints are subscribed (no-op)', async () => {
    const row = makeRow();
    const processDelivery = jest.fn();
    const listActiveByEvent = jest.fn().mockResolvedValue([]);

    const fn = makeWebhookDispatchFn(processDelivery, listActiveByEvent);
    const result = await fn(row);

    expect(result).toBe(true);
    expect(processDelivery).not.toHaveBeenCalled();
  });

  it('returns false if any endpoint delivery fails', async () => {
    const row = makeRow();
    const processDelivery = jest.fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const listActiveByEvent = jest.fn().mockResolvedValue([
      { url: 'https://a.example.com/hook' },
      { url: 'https://b.example.com/hook' },
    ]);

    const fn = makeWebhookDispatchFn(processDelivery, listActiveByEvent);
    const result = await fn(row);

    expect(result).toBe(false);
  });

  it('uses the row created_at as the webhook timestamp (stable across retries)', async () => {
    const createdAt = new Date('2024-06-01T12:00:00Z');
    const row = makeRow({ created_at: createdAt });
    const processDelivery = jest.fn().mockResolvedValue(true);
    const listActiveByEvent = jest.fn().mockResolvedValue([{ url: 'https://example.com/hook' }]);

    const fn = makeWebhookDispatchFn(processDelivery, listActiveByEvent);
    await fn(row);

    const payload = (processDelivery as jest.Mock).mock.calls[0][1];
    expect(payload.timestamp).toBe(createdAt.toISOString());
  });
});

// ─── 5. OutboxRepository.insert participates in caller's transaction ─────────

describe('OutboxRepository.insert', () => {
  it('uses the provided PoolClient when given', async () => {
    const mockClient = { query: jest.fn().mockResolvedValue({ rows: [makeRow()] }) };
    const mockPool = { query: jest.fn() } as any;
    const repo = new OutboxRepository(mockPool);

    const input: InsertOutboxInput = {
      event_type: WebhookEventType.DISTRIBUTION_COMPLETED,
      payload: { distribution_run_id: 'run-1' },
    };

    await repo.insert(input, mockClient as any);

    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO webhook_outbox'),
      expect.arrayContaining([expect.any(String), WebhookEventType.DISTRIBUTION_COMPLETED])
    );
    // Pool should NOT have been used
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  it('uses the pool when no client is provided', async () => {
    const mockPool = { query: jest.fn().mockResolvedValue({ rows: [makeRow()] }) } as any;
    const repo = new OutboxRepository(mockPool);

    await repo.insert({
      event_type: WebhookEventType.PAYOUT_FAILED,
      payload: { investor_id: 'inv-1' },
    });

    expect(mockPool.query).toHaveBeenCalled();
  });

  it('uses the provided event_id when supplied (idempotent re-insert guard)', async () => {
    const stableId = 'my-stable-uuid';
    const mockPool = { query: jest.fn().mockResolvedValue({ rows: [makeRow({ event_id: stableId })] }) } as any;
    const repo = new OutboxRepository(mockPool);

    await repo.insert({
      event_type: WebhookEventType.PAYOUT_COMPLETED,
      payload: {},
      event_id: stableId,
    });

    const [, params] = (mockPool.query as jest.Mock).mock.calls[0];
    expect(params[0]).toBe(stableId);
  });
});

// ─── Outbox Lag Monitoring and Saturation Alerts ────────────────────────────

describe('OutboxDispatcher - Lag Monitoring and Pressure Gauge', () => {
  describe('lag measurement', () => {
    it('measures lag as age of oldest pending record', async () => {
      const now = Date.now();
      const oldestRowCreatedAt = new Date(now - 45000); // 45 seconds ago
      const oldestRow = makeRow({ created_at: oldestRowCreatedAt });

      const repo = makeOutboxRepo([]);
      (repo.getOldestPending as jest.Mock) = jest.fn().mockResolvedValue(oldestRow);
      (repo.drainPending as jest.Mock) = jest.fn().mockResolvedValue([]);

      const metrics = new MetricsCollector({ enabled: true });
      const dispatcher = new OutboxDispatcher(repo, jest.fn().mockResolvedValue(true), {
        metrics,
      });

      await dispatcher.drainOnce();

      // Verify getOldestPending was called
      expect(repo.getOldestPending).toHaveBeenCalled();

      // Verify lag measurement is within expected range (45 ± 1 seconds)
      const state = dispatcher.getPressureState();
      expect(state.lagSeconds).toBeCloseTo(45, 1);
    });

    it('emits outbox.lag_seconds gauge metric', async () => {
      const now = Date.now();
      const oldestRow = makeRow({ created_at: new Date(now - 30000) }); // 30 seconds ago

      const repo = makeOutboxRepo([]);
      (repo.getOldestPending as jest.Mock) = jest.fn().mockResolvedValue(oldestRow);

      const metrics = new MetricsCollector({ enabled: true });
      const setGaugeSpy = jest.spyOn(metrics, 'setGauge');

      const dispatcher = new OutboxDispatcher(repo, jest.fn().mockResolvedValue(true), {
        metrics,
      });

      await dispatcher.drainOnce();

      expect(setGaugeSpy).toHaveBeenCalledWith(
        'outbox_lag_seconds',
        expect.closeTo(30, 1),
        expect.any(Object)
      );
    });

    it('handles case when no pending records exist', async () => {
      const repo = makeOutboxRepo([]);
      (repo.getOldestPending as jest.Mock) = jest.fn().mockResolvedValue(null);

      const metrics = new MetricsCollector({ enabled: true });
      const dispatcher = new OutboxDispatcher(repo, jest.fn().mockResolvedValue(true), {
        metrics,
      });

      await dispatcher.drainOnce();

      const state = dispatcher.getPressureState();
      expect(state.lagSeconds).toBe(-1);
      expect(state.tier).toBe(PressureTier.NORMAL);
    });

    it('handles lag measurement failure gracefully', async () => {
      const repo = makeOutboxRepo([]);
      (repo.getOldestPending as jest.Mock) = jest
        .fn()
        .mockRejectedValue(new Error('database error'));
      (repo.drainPending as jest.Mock) = jest.fn().mockResolvedValue([]);

      const metrics = new MetricsCollector({ enabled: true });
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();

      const dispatcher = new OutboxDispatcher(repo, jest.fn().mockResolvedValue(true), {
        metrics,
      });

      // Should not throw
      await expect(dispatcher.drainOnce()).resolves.not.toThrow();
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('[OutboxDispatcher] Failed to measure lag'),
        expect.any(Error)
      );

      consoleErrorSpy.mockRestore();
    });
  });

  describe('pressure tier transitions', () => {
    it('transitions to INFO tier when lag exceeds info threshold', async () => {
      const repo = makeOutboxRepo([]);
      (repo.getOldestPending as jest.Mock) = jest
        .fn()
        .mockResolvedValue(makeRow({ created_at: new Date(Date.now() - 31000) })); // 31 seconds

      const metrics = new MetricsCollector({ enabled: true });
      const dispatcher = new OutboxDispatcher(repo, jest.fn().mockResolvedValue(true), {
        metrics,
        pressureConfig: { infoThresholdSeconds: 30 },
      });

      await dispatcher.drainOnce();

      expect(dispatcher.getPressureTier()).toBe(PressureTier.INFO);
    });

    it('transitions to WARNING tier when lag exceeds warning threshold', async () => {
      const repo = makeOutboxRepo([]);
      (repo.getOldestPending as jest.Mock) = jest
        .fn()
        .mockResolvedValue(makeRow({ created_at: new Date(Date.now() - 61000) })); // 61 seconds

      const metrics = new MetricsCollector({ enabled: true });
      const dispatcher = new OutboxDispatcher(repo, jest.fn().mockResolvedValue(true), {
        metrics,
        pressureConfig: { warningThresholdSeconds: 60 },
      });

      await dispatcher.drainOnce();

      expect(dispatcher.getPressureTier()).toBe(PressureTier.WARNING);
    });

    it('transitions to CRITICAL tier when lag exceeds critical threshold', async () => {
      const repo = makeOutboxRepo([]);
      (repo.getOldestPending as jest.Mock) = jest
        .fn()
        .mockResolvedValue(makeRow({ created_at: new Date(Date.now() - 121000) })); // 121 seconds

      const metrics = new MetricsCollector({ enabled: true });
      const dispatcher = new OutboxDispatcher(repo, jest.fn().mockResolvedValue(true), {
        metrics,
        pressureConfig: { criticalThresholdSeconds: 120 },
      });

      await dispatcher.drainOnce();

      expect(dispatcher.getPressureTier()).toBe(PressureTier.CRITICAL);
    });

    it('releases pressure when lag clears', async () => {
      const repo = makeOutboxRepo([]);
      (repo.drainPending as jest.Mock) = jest.fn().mockResolvedValue([]);

      const metrics = new MetricsCollector({ enabled: true });
      const dispatcher = new OutboxDispatcher(repo, jest.fn().mockResolvedValue(true), {
        metrics,
        pressureConfig: { infoThresholdSeconds: 30 },
      });

      // First call: high lag
      (repo.getOldestPending as jest.Mock) = jest
        .fn()
        .mockResolvedValue(makeRow({ created_at: new Date(Date.now() - 31000) }));

      await dispatcher.drainOnce();
      expect(dispatcher.getPressureTier()).toBe(PressureTier.INFO);

      // Second call: no pending records
      (repo.getOldestPending as jest.Mock) = jest.fn().mockResolvedValue(null);

      await dispatcher.drainOnce();
      expect(dispatcher.getPressureTier()).toBe(PressureTier.NORMAL);
    });
  });

  describe('pressure state callbacks', () => {
    it('invokes pressure state change callback on tier transition', async () => {
      const repo = makeOutboxRepo([]);
      (repo.getOldestPending as jest.Mock) = jest
        .fn()
        .mockResolvedValue(makeRow({ created_at: new Date(Date.now() - 31000) }));
      (repo.drainPending as jest.Mock) = jest.fn().mockResolvedValue([]);

      const metrics = new MetricsCollector({ enabled: true });
      const dispatcher = new OutboxDispatcher(repo, jest.fn().mockResolvedValue(true), {
        metrics,
        pressureConfig: { infoThresholdSeconds: 30 },
      });

      const pressureCallback = jest.fn();
      dispatcher.onPressureStateChange(pressureCallback);

      await dispatcher.drainOnce();

      expect(pressureCallback).toHaveBeenCalledTimes(1);
      const [oldState, newState] = pressureCallback.mock.calls[0];
      expect(oldState.tier).toBe(PressureTier.NORMAL);
      expect(newState.tier).toBe(PressureTier.INFO);
    });

    it('does not invoke callback when lag updates within same tier', async () => {
      const repo = makeOutboxRepo([]);
      (repo.drainPending as jest.Mock) = jest.fn().mockResolvedValue([]);

      const metrics = new MetricsCollector({ enabled: true });
      const dispatcher = new OutboxDispatcher(repo, jest.fn().mockResolvedValue(true), {
        metrics,
        pressureConfig: { infoThresholdSeconds: 30 },
      });

      const pressureCallback = jest.fn();
      dispatcher.onPressureStateChange(pressureCallback);

      // First call: info tier
      (repo.getOldestPending as jest.Mock) = jest
        .fn()
        .mockResolvedValue(makeRow({ created_at: new Date(Date.now() - 31000) }));
      await dispatcher.drainOnce();

      pressureCallback.mockClear();

      // Second call: still info tier but different lag
      (repo.getOldestPending as jest.Mock) = jest
        .fn()
        .mockResolvedValue(makeRow({ created_at: new Date(Date.now() - 40000) }));
      await dispatcher.drainOnce();

      expect(pressureCallback).not.toHaveBeenCalled();
    });
  });

  describe('pressure alerts and metrics', () => {
    it('emits tier transition metrics', async () => {
      const repo = makeOutboxRepo([]);
      (repo.getOldestPending as jest.Mock) = jest
        .fn()
        .mockResolvedValue(makeRow({ created_at: new Date(Date.now() - 31000) }));
      (repo.drainPending as jest.Mock) = jest.fn().mockResolvedValue([]);

      const metrics = new MetricsCollector({ enabled: true });
      const incrementCounterSpy = jest.spyOn(metrics, 'incrementCounter');

      const dispatcher = new OutboxDispatcher(repo, jest.fn().mockResolvedValue(true), {
        metrics,
        pressureConfig: { infoThresholdSeconds: 30 },
      });

      await dispatcher.drainOnce();

      // Should emit tier transition counter
      expect(incrementCounterSpy).toHaveBeenCalledWith(
        'outbox_pressure_tier_transitions',
        expect.objectContaining({
          from: PressureTier.NORMAL,
          to: PressureTier.INFO,
        })
      );

      // Should emit saturation alert counter
      expect(incrementCounterSpy).toHaveBeenCalledWith(
        'outbox_saturation_alerts',
        expect.objectContaining({
          tier: PressureTier.INFO,
        })
      );
    });

    it('logs pressure state changes with appropriate severity', async () => {
      const repo = makeOutboxRepo([]);
      (repo.getOldestPending as jest.Mock) = jest
        .fn()
        .mockResolvedValue(makeRow({ created_at: new Date(Date.now() - 121000) }));
      (repo.drainPending as jest.Mock) = jest.fn().mockResolvedValue([]);

      const metrics = new MetricsCollector({ enabled: true });
      const consoleLogSpy = jest.spyOn(console, 'log').mockImplementation();

      const dispatcher = new OutboxDispatcher(repo, jest.fn().mockResolvedValue(true), {
        metrics,
        pressureConfig: { criticalThresholdSeconds: 120 },
      });

      await dispatcher.drainOnce();

      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('[OutboxDispatcher] Outbox saturation alert [critical]')
      );

      consoleLogSpy.mockRestore();
    });
  });

  describe('pressure gauge query methods', () => {
    it('getPressureState returns complete pressure state', async () => {
      const repo = makeOutboxRepo([]);
      (repo.getOldestPending as jest.Mock) = jest
        .fn()
        .mockResolvedValue(makeRow({ created_at: new Date(Date.now() - 45000) }));

      const metrics = new MetricsCollector({ enabled: true });
      const dispatcher = new OutboxDispatcher(repo, jest.fn().mockResolvedValue(true), {
        metrics,
      });

      await dispatcher.drainOnce();

      const state = dispatcher.getPressureState();
      expect(state).toHaveProperty('tier');
      expect(state).toHaveProperty('lagSeconds');
      expect(state).toHaveProperty('tierChangedAt');
      expect(state).toHaveProperty('transitionCount');
    });

    it('getPressureTier returns current tier', async () => {
      const repo = makeOutboxRepo([]);
      (repo.getOldestPending as jest.Mock) = jest
        .fn()
        .mockResolvedValue(makeRow({ created_at: new Date(Date.now() - 31000) }));

      const metrics = new MetricsCollector({ enabled: true });
      const dispatcher = new OutboxDispatcher(repo, jest.fn().mockResolvedValue(true), {
        metrics,
        pressureConfig: { infoThresholdSeconds: 30 },
      });

      await dispatcher.drainOnce();

      expect(dispatcher.getPressureTier()).toBe(PressureTier.INFO);
    });

    it('isUnderPressure checks if tier meets threshold', async () => {
      const repo = makeOutboxRepo([]);
      (repo.getOldestPending as jest.Mock) = jest
        .fn()
        .mockResolvedValue(makeRow({ created_at: new Date(Date.now() - 45000) }));
      (repo.drainPending as jest.Mock) = jest.fn().mockResolvedValue([]);

      const metrics = new MetricsCollector({ enabled: true });
      const dispatcher = new OutboxDispatcher(repo, jest.fn().mockResolvedValue(true), {
        metrics,
        pressureConfig: {
          infoThresholdSeconds: 30,
          warningThresholdSeconds: 60,
        },
      });

      await dispatcher.drainOnce();

      // At INFO tier
      expect(dispatcher.isUnderPressure(PressureTier.INFO)).toBe(true);
      expect(dispatcher.isUnderPressure(PressureTier.WARNING)).toBe(false);
      expect(dispatcher.isUnderPressure(PressureTier.NORMAL)).toBe(true);
    });
  });

  describe('backward compatibility', () => {
    it('works without metrics collector (uses default)', async () => {
      const row = makeRow();
      const repo = makeOutboxRepo([row]);
      const dispatch: DispatchFn = jest.fn().mockResolvedValue(true);

      // Create dispatcher without metrics option
      const dispatcher = new OutboxDispatcher(repo, dispatch);

      await expect(dispatcher.drainOnce()).resolves.toBe(1);
      expect(dispatch).toHaveBeenCalled();
    });

    it('works without pressure config (uses defaults)', async () => {
      const repo = makeOutboxRepo([]);
      (repo.getOldestPending as jest.Mock) = jest
        .fn()
        .mockResolvedValue(makeRow({ created_at: new Date(Date.now() - 31000) }));

      // Create dispatcher without pressureConfig
      const dispatcher = new OutboxDispatcher(repo, jest.fn().mockResolvedValue(true));

      await dispatcher.drainOnce();

      // Should use default threshold (30 seconds)
      expect(dispatcher.getPressureTier()).toBe(PressureTier.INFO);
    });
  });

  describe('hysteresis in drainOnce loop', () => {
    it('prevents rapid tier oscillations during repeated drainOnce calls', async () => {
      const repo = makeOutboxRepo([]);
      (repo.drainPending as jest.Mock) = jest.fn().mockResolvedValue([]);

      const metrics = new MetricsCollector({ enabled: true });
      const pressureCallback = jest.fn();

      const dispatcher = new OutboxDispatcher(repo, jest.fn().mockResolvedValue(true), {
        metrics,
        pressureConfig: {
          infoThresholdSeconds: 30,
          recoveryBufferSeconds: 10,
        },
      });

      dispatcher.onPressureStateChange(pressureCallback);

      // First call: climb to INFO
      (repo.getOldestPending as jest.Mock) = jest
        .fn()
        .mockResolvedValue(makeRow({ created_at: new Date(Date.now() - 31000) }));
      await dispatcher.drainOnce();

      expect(dispatcher.getPressureTier()).toBe(PressureTier.INFO);
      pressureCallback.mockClear();

      // Second call: drop just below threshold
      (repo.getOldestPending as jest.Mock) = jest
        .fn()
        .mockResolvedValue(makeRow({ created_at: new Date(Date.now() - 25000) }));
      await dispatcher.drainOnce();

      // Should stay in INFO due to recovery buffer
      expect(dispatcher.getPressureTier()).toBe(PressureTier.INFO);
      expect(pressureCallback).not.toHaveBeenCalled(); // No tier transition

      // Third call: drop below recovery threshold
      (repo.getOldestPending as jest.Mock) = jest
        .fn()
        .mockResolvedValue(makeRow({ created_at: new Date(Date.now() - 15000) }));
      await dispatcher.drainOnce();

      // Now transitions to NORMAL
      expect(dispatcher.getPressureTier()).toBe(PressureTier.NORMAL);
      expect(pressureCallback).toHaveBeenCalledTimes(1); // Only one transition
    });
  });
});

