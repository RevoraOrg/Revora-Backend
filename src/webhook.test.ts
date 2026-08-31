import { WebhookQueue } from './index';
import { WebhookEndpointRepository } from './db/repositories/webhookEndpointRepository';
import { WebhookService } from './services/webhookService';
import { pool } from './db/client';
import { globalMetrics } from './lib/metrics';

jest.mock('./db/client', () => ({
  pool: { query: jest.fn() },
  query: jest.fn(),
  dbHealth: jest.fn(),
  closePool: jest.fn(),
}));

const mockFetch = jest.fn() as jest.MockedFunction<typeof fetch>;
global.fetch = mockFetch;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function makeEndpoint(overrides: Partial<ReturnType<WebhookEndpointRepository['findByUrl']> extends Promise<infer T> ? NonNullable<T> : never> = {}) {
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

function makeDelivery(overrides: Record<string, unknown> = {}) {
  return {
    id: 'delivery-1',
    endpoint_id: 'endpoint-1',
    payload: {},
    attempts: 0,
    status: 'pending' as const,
    next_retry_at: null,
    last_error: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('WebhookQueue Durable Delivery', () => {
  let repo: WebhookEndpointRepository;
  let service: WebhookService;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    globalMetrics.reset();

    repo = new WebhookEndpointRepository(pool as any);
    service = new WebhookService(repo);
    WebhookQueue.init(repo, service);

    // Reset in-flight counter between tests
    (WebhookQueue as any).inFlight = 0;

    mockFetch.mockReset();

    jest.spyOn(repo, 'findByUrl').mockResolvedValue(makeEndpoint());
    jest.spyOn(repo, 'createDelivery').mockImplementation(async (d) => makeDelivery({
      endpoint_id: d.endpoint_id!,
      payload: d.payload,
      attempts: d.attempts || 0,
      status: d.status || 'pending',
    }));
    jest.spyOn(repo, 'updateDelivery').mockImplementation(async (id, updates) =>
      makeDelivery({ id, ...updates }),
    );
    jest.spyOn(repo, 'findDeliveryById').mockResolvedValue(makeDelivery());
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // Existing happy-path tests
  // -------------------------------------------------------------------------

  test('delivers successfully on first attempt', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200 } as Response);

    const result = await WebhookQueue.processDelivery('https://example.com/webhook', { test: true });

    expect(result).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(repo.updateDelivery).toHaveBeenCalledWith('delivery-1', expect.objectContaining({
      status: 'completed',
      attempts: 1,
    }));
  });

  test('schedules retry on 500 error', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 } as Response);

    const result = await WebhookQueue.processDelivery('https://example.com/webhook', { test: true });

    expect(result).toBe(false);
    expect(repo.updateDelivery).toHaveBeenCalledWith('delivery-1', expect.objectContaining({
      attempts: 1,
      next_retry_at: expect.any(Date),
    }));
    // A retry setTimeout should have been scheduled
    expect(jest.getTimerCount()).toBeGreaterThan(0);
  });

  test('marks failed on non-retryable 400', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 400 } as Response);

    const result = await WebhookQueue.processDelivery('https://example.com/webhook', { test: true });

    expect(result).toBe(false);
    expect(repo.updateDelivery).toHaveBeenCalledWith('delivery-1', expect.objectContaining({
      status: 'failed',
    }));
  });

  test('dead-letters after max retries', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500 } as Response);

    let currentDelivery: any = makeDelivery();
    jest.spyOn(repo, 'findDeliveryById').mockImplementation(async () => currentDelivery);
    jest.spyOn(repo, 'updateDelivery').mockImplementation(async (_id, updates) => {
      currentDelivery = { ...currentDelivery, ...updates };
      return currentDelivery;
    });
    jest.spyOn(repo, 'countDeadLettersByEndpoint').mockResolvedValue(1);

    for (let i = 0; i <= 5; i++) {
      await WebhookQueue.processDelivery('https://example.com/webhook', {}, 'delivery-1');
    }

    expect(currentDelivery.status).toBe('dead_letter');
  });

  test('resumePending re-enqueues all pending deliveries', async () => {
    const pending = [
      makeDelivery({ id: 'del-1', payload: { p: 1 } }),
      makeDelivery({ id: 'del-2', payload: { p: 2 } }),
    ];
    jest.spyOn(repo, 'getPendingDeliveries').mockResolvedValue(pending as any);
    jest.spyOn(repo, 'findById').mockResolvedValue(makeEndpoint() as any);
    const processSpy = jest.spyOn(WebhookQueue, 'processDelivery').mockResolvedValue(true);

    await WebhookQueue.resumePending();

    expect(processSpy).toHaveBeenCalledTimes(2);
    expect(processSpy).toHaveBeenCalledWith('https://example.com/webhook', { p: 1 }, 'del-1');
    expect(processSpy).toHaveBeenCalledWith('https://example.com/webhook', { p: 2 }, 'del-2');
  });

  test('blocks unsafe URLs', async () => {
    const result = await WebhookQueue.processDelivery('http://localhost/webhook', {});
    expect(result).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test('getBackoffDelay returns expected values', () => {
    expect(WebhookQueue.getBackoffDelay(0)).toBe(1000);
    expect(WebhookQueue.getBackoffDelay(1)).toBe(2000);
    expect(WebhookQueue.getBackoffDelay(4)).toBe(16000);
    expect(WebhookQueue.getBackoffDelay(5)).toBe(-1);
  });

  // -------------------------------------------------------------------------
  // Back-pressure: at-capacity deferral
  // -------------------------------------------------------------------------

  describe('back-pressure / bounded queue depth', () => {
    beforeEach(() => {
      // Force queue to appear full
      (WebhookQueue as any).inFlight = (WebhookQueue as any).maxDepth;
    });

    test('defers delivery (not dropped) when queue is at capacity', async () => {
      const createSpy = jest.spyOn(repo, 'createDelivery').mockResolvedValue(
        makeDelivery({ id: 'deferred-1', status: 'deferred' }),
      );

      const result = await WebhookQueue.processDelivery('https://example.com/webhook', { x: 1 });

      expect(result).toBe(false);
      expect(createSpy).toHaveBeenCalledWith(expect.objectContaining({ status: 'deferred' }));
      // No HTTP attempt made
      expect(mockFetch).not.toHaveBeenCalled();
    });

    test('increments webhook_queue_shed_total metric on deferral', async () => {
      jest.spyOn(repo, 'createDelivery').mockResolvedValue(
        makeDelivery({ id: 'deferred-1', status: 'deferred' }),
      );
      const incrementSpy = jest.spyOn(globalMetrics, 'incrementCounter');

      await WebhookQueue.processDelivery('https://example.com/webhook', { x: 1 });

      expect(incrementSpy).toHaveBeenCalledWith(
        'webhook_queue_shed_total',
        expect.objectContaining({ endpoint: 'endpoint-1' }),
        1,
        expect.any(String),
      );
    });

    test('metric is idempotent — each deferral increments by exactly 1', async () => {
      jest.spyOn(repo, 'createDelivery').mockResolvedValue(
        makeDelivery({ status: 'deferred' }),
      );
      const incrementSpy = jest.spyOn(globalMetrics, 'incrementCounter');

      await WebhookQueue.processDelivery('https://example.com/webhook', { a: 1 });
      await WebhookQueue.processDelivery('https://example.com/webhook', { b: 2 });

      const shedCalls = incrementSpy.mock.calls.filter(
        ([name]) => name === 'webhook_queue_shed_total',
      );
      expect(shedCalls).toHaveLength(2);
      // Each call increments by 1
      shedCalls.forEach(([, , value]) => expect(value).toBe(1));
    });

    test('deferral with a known deliveryId reuses the row instead of duplicating it', async () => {
      jest.spyOn(repo, 'findDeliveryById').mockResolvedValue(
        makeDelivery({
          id: 'delivery-retry-1',
          status: 'pending',
          attempts: 2,
          next_retry_at: new Date(),
        }),
      );
      const createSpy = jest.spyOn(repo, 'createDelivery').mockResolvedValue(makeDelivery());
      const updateSpy = jest.spyOn(repo, 'updateDelivery').mockResolvedValue(
        makeDelivery({ id: 'delivery-retry-1', status: 'deferred', attempts: 2 }),
      );

      const result = await WebhookQueue.processDelivery(
        'https://example.com/webhook',
        { x: 1 },
        'delivery-retry-1',
      );

      expect(result).toBe(false);
      // The existing retry row is deferred in place — no duplicate row.
      expect(updateSpy).toHaveBeenCalledWith('delivery-retry-1', { status: 'deferred' });
      expect(createSpy).not.toHaveBeenCalled();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    test('re-shedding an already-deferred delivery does not double-count the metric', async () => {
      jest.spyOn(repo, 'findDeliveryById').mockResolvedValue(
        makeDelivery({ id: 'delivery-retry-1', status: 'deferred', attempts: 1 }),
      );
      const createSpy = jest.spyOn(repo, 'createDelivery').mockResolvedValue(makeDelivery());
      const updateSpy = jest.spyOn(repo, 'updateDelivery').mockResolvedValue(makeDelivery());
      const incrementSpy = jest.spyOn(globalMetrics, 'incrementCounter');

      const result = await WebhookQueue.processDelivery(
        'https://example.com/webhook',
        { x: 1 },
        'delivery-retry-1',
      );

      expect(result).toBe(false);
      // Idempotent: no row churn and no additional shed increment.
      expect(createSpy).not.toHaveBeenCalled();
      expect(updateSpy).not.toHaveBeenCalled();
      const shedCalls = incrementSpy.mock.calls.filter(
        ([name]) => name === 'webhook_queue_shed_total',
      );
      expect(shedCalls).toHaveLength(0);
    });

    test('emits the queue depth gauge alongside the shed counter', async () => {
      jest.spyOn(repo, 'createDelivery').mockResolvedValue(makeDelivery({ status: 'deferred' }));
      const gaugeSpy = jest.spyOn(globalMetrics, 'setGauge');

      await WebhookQueue.processDelivery('https://example.com/webhook', { x: 1 });

      expect(gaugeSpy).toHaveBeenCalledWith(
        'webhook_queue_depth',
        expect.any(Number),
        expect.any(Object),
        expect.any(String),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Capacity recovery: resumeDeferred
  // -------------------------------------------------------------------------

  describe('resumeDeferred', () => {
    test('re-enqueues deferred deliveries when capacity is available', async () => {
      (WebhookQueue as any).inFlight = 0;

      const deferred = [
        makeDelivery({ id: 'def-1', status: 'deferred', payload: { d: 1 } }),
        makeDelivery({ id: 'def-2', status: 'deferred', payload: { d: 2 } }),
      ];
      jest.spyOn(repo, 'getDeferredDeliveries').mockResolvedValue(deferred as any);
      jest.spyOn(repo, 'findById').mockResolvedValue(makeEndpoint() as any);
      const updateSpy = jest.spyOn(repo, 'updateDelivery').mockResolvedValue(makeDelivery());
      const processSpy = jest.spyOn(WebhookQueue, 'processDelivery').mockResolvedValue(true);

      await WebhookQueue.resumeDeferred();

      // Each deferred row promoted to 'pending' before re-enqueue
      expect(updateSpy).toHaveBeenCalledWith('def-1', { status: 'pending' });
      expect(updateSpy).toHaveBeenCalledWith('def-2', { status: 'pending' });
      expect(processSpy).toHaveBeenCalledTimes(2);
    });

    test('stops re-enqueuing when queue fills up again', async () => {
      const maxDepth = (WebhookQueue as any).maxDepth as number;
      // Fill the queue completely so resumeDeferred immediately stops
      (WebhookQueue as any).inFlight = maxDepth;

      const deferred = [
        makeDelivery({ id: 'def-1', status: 'deferred' }),
        makeDelivery({ id: 'def-2', status: 'deferred' }),
      ];
      jest.spyOn(repo, 'getDeferredDeliveries').mockResolvedValue(deferred as any);
      jest.spyOn(repo, 'findById').mockResolvedValue(makeEndpoint() as any);
      jest.spyOn(repo, 'updateDelivery').mockResolvedValue(makeDelivery());
      const processSpy = jest.spyOn(WebhookQueue, 'processDelivery').mockResolvedValue(true);

      await WebhookQueue.resumeDeferred();

      // Queue was full, nothing should be re-enqueued
      expect(processSpy).not.toHaveBeenCalled();
    });

    test('skips deferred rows whose endpoint no longer exists', async () => {
      (WebhookQueue as any).inFlight = 0;

      jest.spyOn(repo, 'getDeferredDeliveries').mockResolvedValue([
        makeDelivery({ id: 'def-orphan', status: 'deferred' }),
      ] as any);
      jest.spyOn(repo, 'findById').mockResolvedValue(null);
      const processSpy = jest.spyOn(WebhookQueue, 'processDelivery').mockResolvedValue(true);

      await WebhookQueue.resumeDeferred();

      expect(processSpy).not.toHaveBeenCalled();
    });

    test('does nothing when repo is not initialized', async () => {
      // Temporarily clear repo
      const savedRepo = (WebhookQueue as any).repo;
      (WebhookQueue as any).repo = undefined;

      await expect(WebhookQueue.resumeDeferred()).resolves.toBeUndefined();

      (WebhookQueue as any).repo = savedRepo;
    });
  });

  // -------------------------------------------------------------------------
  // resumePending honours the same bounded-depth contract as resumeDeferred
  // -------------------------------------------------------------------------

  describe('resumePending back-pressure', () => {
    test('does not re-enqueue anything when the queue is already at capacity', async () => {
      const maxDepth = (WebhookQueue as any).maxDepth as number;
      (WebhookQueue as any).inFlight = maxDepth;

      const pending = [
        makeDelivery({ id: 'pend-1', status: 'pending', payload: { p: 1 } }),
        makeDelivery({ id: 'pend-2', status: 'pending', payload: { p: 2 } }),
      ];
      jest.spyOn(repo, 'getPendingDeliveries').mockResolvedValue(pending as any);
      jest.spyOn(repo, 'findById').mockResolvedValue(makeEndpoint() as any);
      const processSpy = jest.spyOn(WebhookQueue, 'processDelivery').mockResolvedValue(true);

      await WebhookQueue.resumePending();

      expect(processSpy).not.toHaveBeenCalled();
    });

    test('re-enqueues pending deliveries only up to available capacity', async () => {
      const maxDepth = (WebhookQueue as any).maxDepth as number;
      // One slot free: exactly one pending delivery should be picked up.
      (WebhookQueue as any).inFlight = maxDepth - 1;

      const pending = [
        makeDelivery({ id: 'pend-1', status: 'pending', payload: { p: 1 } }),
        makeDelivery({ id: 'pend-2', status: 'pending', payload: { p: 2 } }),
      ];
      jest.spyOn(repo, 'getPendingDeliveries').mockResolvedValue(pending as any);
      jest.spyOn(repo, 'findById').mockResolvedValue(makeEndpoint() as any);
      // Simulate each re-enqueue occupying a queue slot so the guard can
      // observe capacity filling up.
      const processSpy = jest
        .spyOn(WebhookQueue, 'processDelivery')
        .mockImplementation(async (_url, _payload, deliveryId) => {
          if ((WebhookQueue as any).inFlight < maxDepth) {
            (WebhookQueue as any).inFlight += 1;
          }
          return deliveryId === 'pend-1';
        });

      await WebhookQueue.resumePending();

      expect(processSpy).toHaveBeenCalledTimes(1);
      expect(processSpy).toHaveBeenCalledWith('https://example.com/webhook', { p: 1 }, 'pend-1');
    });
  });

  // -------------------------------------------------------------------------
  // Normal delivery still works after capacity frees up
  // -------------------------------------------------------------------------

  test('processes normally when inFlight is below maxDepth', async () => {
    (WebhookQueue as any).inFlight = 0;
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200 } as Response);

    const result = await WebhookQueue.processDelivery('https://example.com/webhook', { ok: true });

    expect(result).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
