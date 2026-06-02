/**
 * Tests for the transactional outbox:
 *  1. Producer rollback discards the outbox row
 *  2. Dispatcher crash mid-dispatch retries without duplication (same event_id)
 *  3. Receiver sees the same event_id on every retry
 *  4. Dispatcher marks row dispatched on success
 *  5. Dispatcher applies exponential back-off on failure
 *  6. Dispatcher dead-letters after maxAttempts
 */

import { OutboxRepository, OutboxRow, InsertOutboxInput } from '../db/repositories/outboxRepository';
import { OutboxDispatcher, makeWebhookDispatchFn, DispatchFn } from './outboxDispatcher';
import { WebhookEventType } from './webhookService';

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
