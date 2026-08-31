import { PoolClient } from 'pg';
import {
  enqueueWebhookOutboxEvents,
  TransactionError,
  WebhookOutboxEvent,
} from './transaction';
import { WebhookEventType } from '../services/webhookService';
import { OutboxRepository, OutboxRow, InsertOutboxInput } from './repositories/outboxRepository';

function makeRow(overrides: Partial<OutboxRow> = {}): OutboxRow {
  return {
    id: 'row-1',
    event_id: 'event-1',
    event_type: WebhookEventType.PAYOUT_COMPLETED,
    payload: {},
    status: 'pending',
    attempts: 0,
    available_at: new Date(),
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

function makeOutboxRepo(rows: OutboxRow[] = []): jest.Mocked<OutboxRepository> {
  const repo = {
    insert: jest.fn(),
    drainPending: jest.fn(),
    markDispatched: jest.fn(),
    markFailed: jest.fn(),
    getOldestPending: jest.fn(),
  } as unknown as jest.Mocked<OutboxRepository>;
  let call = 0;
  (repo.insert as jest.Mock).mockImplementation(
    async (input: InsertOutboxInput) =>
      rows[call++] ?? makeRow({ event_id: input.event_id ?? `event-${call}`, event_type: input.event_type }),
  );
  return repo;
}

function makeClient(): jest.Mocked<PoolClient> {
  return { query: jest.fn() } as unknown as jest.Mocked<PoolClient>;
}

describe('enqueueWebhookOutboxEvents', () => {
  it('inserts every event through the transactional client and returns the event_ids in order', async () => {
    const client = makeClient();
    const repo = makeOutboxRepo([
      makeRow({ id: 'row-a', event_id: 'id-a' }),
      makeRow({ id: 'row-b', event_id: 'id-b' }),
    ]);
    const events: WebhookOutboxEvent[] = [
      { event: WebhookEventType.DISTRIBUTION_COMPLETED, data: { run_id: 'r1' } },
      { event: WebhookEventType.PAYOUT_FAILED, data: { payout_id: 'p1' }, eventId: 'id-b' },
    ];

    const ids = await enqueueWebhookOutboxEvents(client, repo, events);

    expect(ids).toEqual(['id-a', 'id-b']);
    expect(repo.insert).toHaveBeenCalledTimes(2);
    expect(repo.insert).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        event_type: WebhookEventType.DISTRIBUTION_COMPLETED,
        payload: { run_id: 'r1' },
      }),
      client,
    );
    expect(repo.insert).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        event_type: WebhookEventType.PAYOUT_FAILED,
        payload: { payout_id: 'p1' },
        event_id: 'id-b',
      }),
      client,
    );
  });

  it('returns an empty array when no events are supplied', async () => {
    const repo = makeOutboxRepo();
    const ids = await enqueueWebhookOutboxEvents(makeClient(), repo, []);
    expect(ids).toEqual([]);
    expect(repo.insert).not.toHaveBeenCalled();
  });

  it('throws TransactionError when the transactional client is missing', async () => {
    await expect(
      enqueueWebhookOutboxEvents(null as unknown as PoolClient, makeOutboxRepo(), [
        { event: WebhookEventType.PAYOUT_COMPLETED, data: {} },
      ]),
    ).rejects.toThrow(TransactionError);
  });

  it('throws TransactionError when outboxRepo is missing', async () => {
    await expect(
      enqueueWebhookOutboxEvents(makeClient(), null as unknown as OutboxRepository, [
        { event: WebhookEventType.PAYOUT_COMPLETED, data: {} },
      ]),
    ).rejects.toThrow(TransactionError);
  });

  it('throws TransactionError when events is not an array', async () => {
    await expect(
      enqueueWebhookOutboxEvents(makeClient(), makeOutboxRepo(), {} as unknown as WebhookOutboxEvent[]),
    ).rejects.toThrow(TransactionError);
  });

  it('throws TransactionError when an event entry is missing its event type', async () => {
    await expect(
      enqueueWebhookOutboxEvents(makeClient(), makeOutboxRepo(), [
        { event: undefined as unknown as WebhookEventType, data: {} },
      ]),
    ).rejects.toThrow('Each outbox event must include a valid event type');
  });

  it('propagates an outbox insert failure so the producer transaction rolls back', async () => {
    const client = makeClient();
    const repo = makeOutboxRepo();
    (repo.insert as jest.Mock).mockRejectedValueOnce(new Error('insert failed'));
    await expect(
      enqueueWebhookOutboxEvents(client, repo, [
        { event: WebhookEventType.PAYOUT_COMPLETED, data: {} },
      ]),
    ).rejects.toThrow('insert failed');
  });
});