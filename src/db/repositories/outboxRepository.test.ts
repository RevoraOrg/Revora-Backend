import { Pool, PoolClient } from 'pg';
import {
  InsertOutboxInput,
  OutboxRepository,
  OutboxRow,
} from './outboxRepository';
import { WebhookEventType } from '../../services/webhookService';

function makePool(query: jest.Mock = jest.fn()): jest.Mocked<Pool> {
  return { query } as unknown as jest.Mocked<Pool>;
}

function makeRow(overrides: Partial<OutboxRow> = {}): OutboxRow {
  const timestamp = new Date('2026-09-27T00:00:00.000Z');
  return {
    id: 'row-1',
    event_id: 'event-1',
    event_type: WebhookEventType.PAYOUT_COMPLETED,
    payload: { payout_id: 'payout-1' },
    status: 'pending',
    attempts: 0,
    available_at: timestamp,
    created_at: timestamp,
    updated_at: timestamp,
    ...overrides,
  };
}

function asQueryRow(row: OutboxRow): Record<string, unknown> {
  return { ...row };
}

describe('OutboxRepository', () => {
  it('inserts an outbox row with explicit idempotency and availability values', async () => {
    const query = jest.fn().mockResolvedValue({
      rows: [asQueryRow(makeRow())],
    });
    const pool = makePool(query);
    const repository = new OutboxRepository(pool);
    const availableAt = new Date('2026-09-28T12:00:00.000Z');
    const input: InsertOutboxInput = {
      event_id: 'stable-event-1',
      event_type: WebhookEventType.PAYOUT_COMPLETED,
      payload: { payout_id: 'payout-1', amount: 25 },
      available_at: availableAt,
    };

    const result = await repository.insert(input);

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO webhook_outbox'),
      ['stable-event-1', WebhookEventType.PAYOUT_COMPLETED, JSON.stringify(input.payload), availableAt],
    );
    expect(result).toEqual(makeRow());
  });

  it('generates a UUID and uses a Date when optional insert values are omitted', async () => {
    const row = makeRow({ event_id: 'generated-event' });
    const query = jest.fn().mockResolvedValue({ rows: [asQueryRow(row)] });
    const repository = new OutboxRepository(makePool(query));

    await repository.insert({
      event_type: WebhookEventType.OFFERING_CREATED,
      payload: null,
    });

    const values = query.mock.calls[0][1] as unknown[];
    expect(values[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(values[1]).toBe(WebhookEventType.OFFERING_CREATED);
    expect(values[2]).toBe('null');
    expect(values[3]).toBeInstanceOf(Date);
  });

  it('uses a transactional client when one is supplied', async () => {
    const poolQuery = jest.fn();
    const clientQuery = jest.fn().mockResolvedValue({ rows: [asQueryRow(makeRow())] });
    const client = { query: clientQuery } as unknown as PoolClient;
    const repository = new OutboxRepository(makePool(poolQuery));

    await repository.insert(
      { event_type: WebhookEventType.REVENUE_REPORTED, payload: { report_id: 'report-1' } },
      client,
    );

    expect(clientQuery).toHaveBeenCalledTimes(1);
    expect(poolQuery).not.toHaveBeenCalled();
  });

  it('drains ready pending rows and maps persisted JSON and dates', async () => {
    const row = makeRow({ payload: { report_id: 'report-1' }, status: 'pending' });
    const persistedRow = {
      ...asQueryRow(row),
      payload: JSON.stringify(row.payload),
      available_at: row.available_at.toISOString(),
      created_at: row.created_at.toISOString(),
      updated_at: row.updated_at.toISOString(),
    };
    const query = jest.fn().mockResolvedValue({ rows: [persistedRow] });
    const repository = new OutboxRepository(makePool(query));

    const result = await repository.drainPending(10);

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("WHERE status = 'pending' AND available_at <= NOW()"),
      [10],
    );
    expect(query.mock.calls[0][0]).toContain('FOR UPDATE SKIP LOCKED');
    expect(result).toEqual([row]);
    expect(result[0].available_at).toBeInstanceOf(Date);
  });

  it('returns an empty list when no pending rows are ready', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });
    const repository = new OutboxRepository(makePool(query));

    await expect(repository.drainPending(0)).resolves.toEqual([]);
    expect(query).toHaveBeenCalledWith(expect.any(String), [0]);
  });

  it('marks a pending row as dispatched and increments attempts in the database', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });
    const repository = new OutboxRepository(makePool(query));

    await repository.markDispatched('row-1');

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("SET status = 'dispatched', attempts = attempts + 1"),
      ['row-1'],
    );
  });

  it('keeps a failed row pending when a retry time is supplied', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });
    const repository = new OutboxRepository(makePool(query));
    const retryAfter = new Date('2026-09-28T00:00:00.000Z');

    await repository.markFailed('row-1', retryAfter);

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('SET attempts = attempts + 1, available_at = $2'),
      ['row-1', retryAfter],
    );
    expect(query.mock.calls[0][0]).not.toContain("status = 'failed'");
  });

  it('moves a failed row to the terminal failed state without a retry time', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });
    const repository = new OutboxRepository(makePool(query));

    await repository.markFailed('row-1');

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("SET status = 'failed', attempts = attempts + 1"),
      ['row-1'],
    );
  });

  it('returns the oldest pending row or null when none exists', async () => {
    const row = makeRow({ created_at: new Date('2026-09-26T00:00:00.000Z') });
    const query = jest
      .fn()
      .mockResolvedValueOnce({ rows: [asQueryRow(row)] })
      .mockResolvedValueOnce({ rows: [] });
    const repository = new OutboxRepository(makePool(query));

    await expect(repository.getOldestPending()).resolves.toEqual(row);
    await expect(repository.getOldestPending()).resolves.toBeNull();
    expect(query.mock.calls[0][0]).toContain('ORDER BY created_at ASC');
    expect(query.mock.calls[0][0]).toContain('LIMIT 1');
  });

  it('propagates database failures without masking the original error', async () => {
    const failure = new Error('database unavailable');
    const query = jest.fn().mockRejectedValue(failure);
    const repository = new OutboxRepository(makePool(query));

    await expect(repository.drainPending()).rejects.toBe(failure);
    await expect(repository.markDispatched('row-1')).rejects.toBe(failure);
  });

  it('surfaces malformed persisted JSON as a deterministic mapping failure', async () => {
    const query = jest.fn().mockResolvedValue({
      rows: [asQueryRow(makeRow({ payload: 'not-json' }))],
    });
    const repository = new OutboxRepository(makePool(query));

    await expect(repository.drainPending()).rejects.toThrow(SyntaxError);
  });
});
