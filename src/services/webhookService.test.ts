import { createHmac } from 'crypto';
import {
  WebhookService,
  WebhookEventType,
  WebhookPayload,
  IWebhookEndpointRepository,
  WebhookEndpointRecord,
  signPayload,
} from './webhookService';

// ─── Helpers ────────────────────────────────────────────────────────────────

const mockFetch = jest.fn() as jest.MockedFunction<typeof fetch>;
global.fetch = mockFetch;

function makeEndpoint(overrides: Partial<WebhookEndpointRecord> = {}): WebhookEndpointRecord {
  return { id: 'ep-1', url: 'https://example.com/hook', secret: 'shhh', ...overrides };
}

function makePayload<T>(data: T, event: WebhookEventType = WebhookEventType.OFFERING_CREATED): WebhookPayload<T> {
  return { id: 'test-id', event, payload: data, timestamp: '2024-01-01T00:00:00.000Z' };
}

function makeRepo(endpoints: WebhookEndpointRecord[] = []): jest.Mocked<IWebhookEndpointRepository> {
  return { listActiveByEvent: jest.fn().mockResolvedValue(endpoints) };
}

function makeOkResponse(status = 200): Response {
  return { ok: true, status } as Response;
}

function makeErrorResponse(status: number): Response {
  return { ok: false, status } as Response;
}

function flushPromises(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ─── signPayload ─────────────────────────────────────────────────────────────

describe('signPayload', () => {
  it('returns sha256=<hex> using HMAC-SHA256', () => {
    const secret = 'mysecret';
    const body = '{"hello":"world"}';
    const expected = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
    expect(signPayload(secret, body)).toBe(expected);
  });

  it('produces different signatures for different secrets', () => {
    const body = 'same body';
    expect(signPayload('secret-a', body)).not.toBe(signPayload('secret-b', body));
  });

  it('produces different signatures for different bodies', () => {
    const secret = 'same-secret';
    expect(signPayload(secret, 'body-a')).not.toBe(signPayload(secret, 'body-b'));
  });
});

// ─── WebhookService.deliver ──────────────────────────────────────────────────

describe('WebhookService.deliver', () => {
  const endpoint = makeEndpoint();
  // Use initialDelayMs: 0 to skip actual wait in tests
  const svc = new WebhookService(makeRepo(), { initialDelayMs: 0, maxRetries: 3, timeoutMs: 5000 });

  it('returns success on 200 response', async () => {
    mockFetch.mockResolvedValueOnce(makeOkResponse(200));
    const payload = makePayload({ id: 'offer-1' });
    const result = await svc.deliver(endpoint, payload);

    expect(result.success).toBe(true);
    expect(result.statusCode).toBe(200);
    expect(result.attempts).toBe(1);
    expect(result.endpointId).toBe(endpoint.id);
    expect(result.url).toBe(endpoint.url);
  });

  it('sends correct headers including signature and event type', async () => {
    mockFetch.mockResolvedValueOnce(makeOkResponse());
    const payload = makePayload({ id: 'offer-1' }, WebhookEventType.REVENUE_REPORTED);
    const body = JSON.stringify(payload);

    await svc.deliver(endpoint, payload);

    expect(mockFetch).toHaveBeenCalledWith(
      endpoint.url,
      expect.objectContaining({
        method: 'POST',
        body,
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          'X-Revora-Signature': signPayload(endpoint.secret, body),
          'X-Revora-Event': WebhookEventType.REVENUE_REPORTED,
        }),
      })
    );
  });

  it('retries on 500 and succeeds on second attempt', async () => {
    mockFetch
      .mockResolvedValueOnce(makeErrorResponse(500))
      .mockResolvedValueOnce(makeOkResponse(200));
    const result = await svc.deliver(endpoint, makePayload({}));

    expect(result.success).toBe(true);
    expect(result.attempts).toBe(2);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('retries on 429 and succeeds on second attempt', async () => {
    mockFetch
      .mockResolvedValueOnce(makeErrorResponse(429))
      .mockResolvedValueOnce(makeOkResponse(200));
    const result = await svc.deliver(endpoint, makePayload({}));

    expect(result.success).toBe(true);
    expect(result.attempts).toBe(2);
  });

  it('does NOT retry on 400 (non-retryable 4xx)', async () => {
    mockFetch.mockResolvedValueOnce(makeErrorResponse(400));
    const result = await svc.deliver(endpoint, makePayload({}));

    expect(result.success).toBe(false);
    expect(result.attempts).toBe(1);
    expect(result.statusCode).toBe(400);
    expect(result.error).toMatch(/Non-retryable HTTP 400/);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry on 404 (non-retryable 4xx)', async () => {
    mockFetch.mockResolvedValueOnce(makeErrorResponse(404));
    const result = await svc.deliver(endpoint, makePayload({}));

    expect(result.success).toBe(false);
    expect(result.attempts).toBe(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('exhausts maxRetries on persistent 500 errors', async () => {
    mockFetch.mockResolvedValue(makeErrorResponse(500));
    const result = await svc.deliver(endpoint, makePayload({}));

    expect(result.success).toBe(false);
    expect(result.attempts).toBe(3);
    expect(result.statusCode).toBe(500);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('retries on network error and exhausts retries', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
    const result = await svc.deliver(endpoint, makePayload({}));

    expect(result.success).toBe(false);
    expect(result.attempts).toBe(3);
    expect(result.error).toBe('ECONNREFUSED');
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('respects maxRetries option', async () => {
    const svc1 = new WebhookService(makeRepo(), { maxRetries: 1, initialDelayMs: 0 });
    mockFetch.mockResolvedValue(makeErrorResponse(503));
    const result = await svc1.deliver(endpoint, makePayload({}));

    expect(result.attempts).toBe(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

// ─── WebhookService.emit ─────────────────────────────────────────────────────

describe('WebhookService.emit', () => {
  it('dispatches payload to each subscribed endpoint (fire-and-forget)', async () => {
    const ep1 = makeEndpoint({ id: 'ep-1', url: 'https://a.example.com/hook' });
    const ep2 = makeEndpoint({ id: 'ep-2', url: 'https://b.example.com/hook' });
    const repo = makeRepo([ep1, ep2]);
    const svc = new WebhookService(repo, { initialDelayMs: 0 });

    mockFetch.mockResolvedValue(makeOkResponse());

    await svc.emit(WebhookEventType.OFFERING_CREATED, { id: 'offer-1' });
    await flushPromises();

    expect(repo.listActiveByEvent).toHaveBeenCalledWith(WebhookEventType.OFFERING_CREATED);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch).toHaveBeenCalledWith(ep1.url, expect.anything());
    expect(mockFetch).toHaveBeenCalledWith(ep2.url, expect.anything());
  });

  it('sends same payload id to all endpoints', async () => {
    const ep1 = makeEndpoint({ id: 'ep-1', url: 'https://a.example.com/hook' });
    const ep2 = makeEndpoint({ id: 'ep-2', url: 'https://b.example.com/hook' });
    const repo = makeRepo([ep1, ep2]);
    const svc = new WebhookService(repo, { initialDelayMs: 0 });

    mockFetch.mockResolvedValue(makeOkResponse());

    await svc.emit(WebhookEventType.PAYOUT_COMPLETED, { amount: '100' });
    await flushPromises();

    const bodies = mockFetch.mock.calls.map((call) => JSON.parse(call[1]!.body as string));
    expect(bodies[0].id).toBe(bodies[1].id);
    expect(bodies[0].event).toBe(WebhookEventType.PAYOUT_COMPLETED);
  });

  it('does nothing when no endpoints are subscribed', async () => {
    const repo = makeRepo([]);
    const svc = new WebhookService(repo, { initialDelayMs: 0 });

    await svc.emit(WebhookEventType.OFFERING_CREATED, {});
    await flushPromises();

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('logs error and returns when repo throws', async () => {
    const repo: jest.Mocked<IWebhookEndpointRepository> = {
      listActiveByEvent: jest.fn().mockRejectedValue(new Error('DB down')),
    };
    const svc = new WebhookService(repo, { initialDelayMs: 0 });
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    await expect(svc.emit(WebhookEventType.REVENUE_REPORTED, {})).resolves.toBeUndefined();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('[WebhookService]'),
      WebhookEventType.REVENUE_REPORTED,
      expect.any(Error)
    );

    consoleSpy.mockRestore();
  });

  it('continues other deliveries if one endpoint fetch rejects', async () => {
    const ep1 = makeEndpoint({ id: 'ep-1', url: 'https://a.example.com/hook' });
    const ep2 = makeEndpoint({ id: 'ep-2', url: 'https://b.example.com/hook' });
    const repo = makeRepo([ep1, ep2]);
    const svc = new WebhookService(repo, { initialDelayMs: 0 });

    // ep1 fails, ep2 succeeds
    mockFetch
      .mockRejectedValueOnce(new Error('network fail'))
      .mockResolvedValueOnce(makeOkResponse());

    jest.spyOn(console, 'error').mockImplementation(() => {});

    await svc.emit(WebhookEventType.PAYOUT_FAILED, { reason: 'test' });
    await flushPromises();

    // Both endpoints were still attempted (maxRetries=3 on ep1, then ep2)
    expect(mockFetch).toHaveBeenCalledWith(ep1.url, expect.anything());
    expect(mockFetch).toHaveBeenCalledWith(ep2.url, expect.anything());

    jest.restoreAllMocks();
  });
});

// ─── WebhookEventType constants ──────────────────────────────────────────────

describe('WebhookEventType', () => {
  it('exposes all expected event type strings', () => {
    expect(WebhookEventType.OFFERING_CREATED).toBe('offering.created');
    expect(WebhookEventType.OFFERING_UPDATED).toBe('offering.updated');
    expect(WebhookEventType.REVENUE_REPORTED).toBe('revenue.reported');
    expect(WebhookEventType.DISTRIBUTION_STARTED).toBe('distribution.started');
    expect(WebhookEventType.DISTRIBUTION_COMPLETED).toBe('distribution.completed');
    expect(WebhookEventType.PAYOUT_COMPLETED).toBe('payout.completed');
    expect(WebhookEventType.PAYOUT_FAILED).toBe('payout.failed');
  });
});
