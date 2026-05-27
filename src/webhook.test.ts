import { WebhookQueue } from '../index';
import { WebhookEndpointRepository } from '../db/repositories/webhookEndpointRepository';
import { WebhookService } from '../services/webhookService';
import { pool } from '../db/client';

jest.mock('../db/client', () => ({
  pool: {
    query: jest.fn(),
  },
  query: jest.fn(),
  dbHealth: jest.fn(),
  closePool: jest.fn(),
}));

const mockFetch = jest.fn() as jest.MockedFunction<typeof fetch>;
global.fetch = mockFetch;

describe('WebhookQueue Durable Delivery', () => {
  let repo: WebhookEndpointRepository;
  let service: WebhookService;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    
    repo = new WebhookEndpointRepository(pool as any);
    service = new WebhookService(repo);
    WebhookQueue.init(repo, service);

    mockFetch.mockReset();

    // Mock repo methods
    jest.spyOn(repo, 'findByUrl').mockResolvedValue({
      id: 'endpoint-1',
      url: 'https://example.com/webhook',
      secret: 'secret-1',
      owner_id: 'owner-1',
      events: ['*'],
      active: true,
      created_at: new Date(),
      updated_at: new Date(),
    });

    jest.spyOn(repo, 'createDelivery').mockImplementation(async (d) => ({
      id: 'delivery-1',
      endpoint_id: d.endpoint_id!,
      payload: d.payload,
      attempts: d.attempts || 0,
      status: d.status || 'pending',
      next_retry_at: d.next_retry_at || null,
      last_error: d.last_error || null,
      created_at: new Date(),
      updated_at: new Date(),
    }));

    jest.spyOn(repo, 'updateDelivery').mockImplementation(async (id, updates) => ({
      id,
      endpoint_id: 'endpoint-1',
      payload: {},
      attempts: updates.attempts || 0,
      status: updates.status || 'pending',
      next_retry_at: updates.next_retry_at || null,
      last_error: updates.last_error || null,
      created_at: new Date(),
      updated_at: new Date(),
    }));

    jest.spyOn(repo, 'findDeliveryById').mockResolvedValue({
      id: 'delivery-1',
      endpoint_id: 'endpoint-1',
      payload: {},
      attempts: 0,
      status: 'pending',
      next_retry_at: null,
      last_error: null,
      created_at: new Date(),
      updated_at: new Date(),
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('should deliver successfully on first attempt', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
    } as Response);

    const result = await WebhookQueue.processDelivery('https://example.com/webhook', { test: true });

    expect(result).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(repo.createDelivery).toHaveBeenCalled();
    expect(repo.updateDelivery).toHaveBeenCalledWith('delivery-1', expect.objectContaining({
      status: 'completed',
      attempts: 1,
    }));
  });

  test('should retry on 500 error', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
    } as Response);

    const promise = WebhookQueue.processDelivery('https://example.com/webhook', { test: true });
    
    // Wait for the first attempt to finish and schedule the next one
    for (let i = 0; i < 10; i++) await Promise.resolve();

    expect(repo.updateDelivery).toHaveBeenCalledWith('delivery-1', expect.objectContaining({
      attempts: 1,
      next_retry_at: expect.any(Date),
    }));

    // Fast-forward timer for retry
    jest.runAllTimers();
    
    // Mock success on second attempt
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
    } as Response);

    // We need to resolve the second attempt
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  test('should dead-letter on 400 error (non-retryable)', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
    } as Response);

    const result = await WebhookQueue.processDelivery('https://example.com/webhook', { test: true });

    expect(result).toBe(false);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(repo.updateDelivery).toHaveBeenCalledWith('delivery-1', expect.objectContaining({
      status: 'failed',
      attempts: 1,
    }));
  });

  test('should dead-letter after max retries', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
    } as Response);

    // We'll manually trigger retries to avoid complex async timer logic in tests
    let currentDelivery: any = { id: 'delivery-1', attempts: 0 };
    jest.spyOn(repo, 'findDeliveryById').mockImplementation(async () => currentDelivery);
    jest.spyOn(repo, 'updateDelivery').mockImplementation(async (id, updates) => {
      currentDelivery = { ...currentDelivery, ...updates };
      return currentDelivery;
    });

    // 1st attempt
    await WebhookQueue.processDelivery('https://example.com/webhook', { test: true });
    expect(currentDelivery.attempts).toBe(1);

    // 2nd
    await WebhookQueue.processDelivery('https://example.com/webhook', { test: true }, 'delivery-1');
    expect(currentDelivery.attempts).toBe(2);

    // 3rd
    await WebhookQueue.processDelivery('https://example.com/webhook', { test: true }, 'delivery-1');
    expect(currentDelivery.attempts).toBe(3);

    // 4th
    await WebhookQueue.processDelivery('https://example.com/webhook', { test: true }, 'delivery-1');
    expect(currentDelivery.attempts).toBe(4);

    // 5th
    await WebhookQueue.processDelivery('https://example.com/webhook', { test: true }, 'delivery-1');
    expect(currentDelivery.attempts).toBe(5);

    // 6th (Max retries reached)
    await WebhookQueue.processDelivery('https://example.com/webhook', { test: true }, 'delivery-1');
    expect(currentDelivery.status).toBe('dead_letter');
    expect(currentDelivery.attempts).toBe(6);
  });

  test('resumePending should restart all pending deliveries', async () => {
    const pendingDeliveries = [
      { id: 'del-1', endpoint_id: 'endpoint-1', payload: { p: 1 }, attempts: 0, status: 'pending' },
      { id: 'del-2', endpoint_id: 'endpoint-1', payload: { p: 2 }, attempts: 1, status: 'pending' },
    ];

    jest.spyOn(repo, 'getPendingDeliveries').mockResolvedValue(pendingDeliveries as any);
    jest.spyOn(repo, 'findById').mockResolvedValue({
      id: 'endpoint-1',
      url: 'https://example.com/webhook',
      secret: 's',
    } as any);

    const processSpy = jest.spyOn(WebhookQueue, 'processDelivery').mockResolvedValue(true);

    await WebhookQueue.resumePending();

    expect(processSpy).toHaveBeenCalledTimes(2);
    expect(processSpy).toHaveBeenCalledWith('https://example.com/webhook', { p: 1 }, 'del-1');
    expect(processSpy).toHaveBeenCalledWith('https://example.com/webhook', { p: 2 }, 'del-2');
  });

  test('should block unsafe URLs', async () => {
    const result = await WebhookQueue.processDelivery('http://localhost/webhook', {});
    expect(result).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test('isSafeUrl should block SSRF attempts', () => {
    const isSafe = (WebhookQueue as any).isSafeUrl;
    expect(isSafe('http://127.0.0.1')).toBe(false);
    expect(isSafe('http://localhost')).toBe(false);
    expect(isSafe('http://192.168.1.50')).toBe(false);
    expect(isSafe('https://google.com')).toBe(true);
    expect(isSafe('not-a-valid-url')).toBe(false);
  });

  test('getBackoffDelay returns expected values', () => {
    expect(WebhookQueue.getBackoffDelay(0)).toBe(1000);
    expect(WebhookQueue.getBackoffDelay(1)).toBe(2000);
    expect(WebhookQueue.getBackoffDelay(4)).toBe(16000);
    expect(WebhookQueue.getBackoffDelay(5)).toBe(-1);
  });
});
