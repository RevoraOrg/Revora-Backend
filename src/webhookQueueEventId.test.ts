import { WebhookQueue } from './index';
import {
  WebhookEndpointRepository,
  WebhookDelivery,
  WebhookEndpoint,
} from './db/repositories/webhookEndpointRepository';
import { WebhookService } from './services/webhookService';
import { pool } from './db/client';
import { globalMetrics } from './lib/metrics';
import type { Pool } from 'pg';

jest.mock('./db/client', () => ({
  pool: { query: jest.fn() },
  query: jest.fn(),
  dbHealth: jest.fn(),
  closePool: jest.fn(),
}));

const mockFetch = jest.fn() as jest.MockedFunction<typeof fetch>;
global.fetch = mockFetch;

function makeEndpoint(overrides: Partial<WebhookEndpoint> = {}): WebhookEndpoint {
  return {
    id: 'endpoint-1',
    url: 'https://example.com/webhook',
    secret: 'secret-1',
    owner_id: 'owner-1',
    events: ['*'],
    active: true,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

function makeDelivery(overrides: Partial<WebhookDelivery> = {}): WebhookDelivery {
  return {
    id: 'delivery-1',
    endpoint_id: 'endpoint-1',
    payload: {},
    attempts: 0,
    status: 'pending',
    next_retry_at: null,
    last_error: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

describe('WebhookQueue idempotency-key propagation (transactional outbox)', () => {
  let repo: WebhookEndpointRepository;
  let service: WebhookService;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    globalMetrics.reset();

    repo = new WebhookEndpointRepository(pool as unknown as Pool);
    service = new WebhookService(repo);
    WebhookQueue.init(repo, service);
    (WebhookQueue as unknown as { inFlight: number }).inFlight = 0;

    mockFetch.mockReset();
    jest.spyOn(repo, 'findByUrl').mockResolvedValue(makeEndpoint());
    jest.spyOn(repo, 'createDelivery').mockImplementation(async (d) =>
      makeDelivery({
        endpoint_id: d.endpoint_id!,
        payload: d.payload,
        attempts: d.attempts || 0,
        status: d.status || 'pending',
      }),
    );
    jest.spyOn(repo, 'updateDelivery').mockImplementation(async (id, updates) =>
      makeDelivery({ id, ...updates }),
    );
    jest.spyOn(repo, 'findDeliveryById').mockResolvedValue(makeDelivery());
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('forward the outbox event_id as the delivery payload id (exactly-once key)', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200 } as Response);

    const outboxEventId = 'e63e2607-4f83-4dc2-b3d3-c29f4b0b6e2e';
    const result = await WebhookQueue.processDelivery('https://example.com/webhook', {
      id: outboxEventId,
      event: 'distribution.completed',
      payload: { run_id: 'r1' },
      timestamp: '2026-08-30T00:00:00.000Z',
    });

    expect(result).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const call = mockFetch.mock.calls[0];
    const body = JSON.parse(call[1]!.body as string);
    // The receiver's webhookEventOrdering dedup reads event.id — it must be the
    // stable outbox event_id, not a fresh delivery row id.
    expect(body.id).toBe(outboxEventId);
  });

  test('a retried dispatch of the same outbox row reuses the same event_id', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 500 } as Response)
      .mockResolvedValueOnce({ ok: true, status: 200 } as Response);

    const outboxEventId = '72af1c9d-5f5f-4f5e-9c9b-5f5f4f5e9c9b';
    const payload = {
      id: outboxEventId,
      event: 'payout.failed',
      payload: { payout_id: 'p1' },
      timestamp: '2026-08-30T00:00:00.000Z',
    };

    // Seeding webhook_deliveries is mocked: each processDelivery call without a
    // delivery id starts from the same pending state, mimicking the dispatcher
    // retrying the same outbox row on the next poll.
    const first = await WebhookQueue.processDelivery('https://example.com/webhook', payload);
    expect(first).toBe(false);

    const second = await WebhookQueue.processDelivery('https://example.com/webhook', payload);
    expect(second).toBe(true);

    const ids = mockFetch.mock.calls.map((call) => JSON.parse(call[1]!.body as string).id);
    expect(ids[0]).toBe(outboxEventId);
    expect(ids[1]).toBe(outboxEventId);
  });

  test('falls back to the delivery id for legacy payloads without an id', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200 } as Response);

    await WebhookQueue.processDelivery('https://example.com/webhook', { test: true });

    const call = mockFetch.mock.calls[0];
    const body = JSON.parse(call[1]!.body as string);
    expect(body.id).toBe('delivery-1');
  });
});