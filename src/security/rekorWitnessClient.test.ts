import { envSchema } from '../config/env';
import type { SafeFetchResponse } from '../lib/ssrfProtection';
import {
  RekorWitnessClient,
  RekorWitnessError,
  type WitnessReceipt,
} from './witnessClient';

const ROOT_HASH = 'a'.repeat(64);
const REKOR_URL = 'https://rekor.example.test';
const UUID = '24296fb24b8ad77ac4a0c328b6e4b7f5f2c9d0b2e6f5b1a8d3c4e5f60718293a';

function makeResponse(body: unknown, status = 201, etag?: string): SafeFetchResponse {
  const headers = new Headers();
  if (etag) headers.set('etag', etag);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 201 ? 'Created' : 'Error',
    headers,
    url: `${REKOR_URL}/api/v1/log/entries`,
    text: async () => JSON.stringify(body),
    json: async () => body,
  };
}

function successfulRekorBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    [UUID]: {
      integratedTime: 1_700_000_000,
      logIndex: 42,
      logID: 'rekor-log-id',
      ...overrides,
    },
  };
}

function createFetchMock(): jest.Mock {
  return jest.fn();
}

function createClient(
  fetch: ReturnType<typeof createFetchMock>,
  options: Partial<ConstructorParameters<typeof RekorWitnessClient>[0]> = {},
): RekorWitnessClient {
  return new RekorWitnessClient({
    url: REKOR_URL,
    fetch,
    timeoutMs: 1_000,
    baseBackoffMs: 0,
    maxRetries: 1,
    ...options,
  });
}

describe('RekorWitnessClient', () => {
  it('accepts an HTTPS WITNESS_REKOR_URL and rejects non-HTTPS values', () => {
    expect(envSchema.shape.WITNESS_REKOR_URL.safeParse(REKOR_URL).success).toBe(true);
    expect(envSchema.shape.WITNESS_REKOR_URL.safeParse('http://rekor.example.test').success).toBe(false);
  });

  it('maps a successful Rekor response into a WitnessReceipt', async () => {
    const fetch = createFetchMock();
    fetch.mockResolvedValue(makeResponse(successfulRekorBody(), 201, `"${UUID}"`));
    const client = createClient(fetch);

    const receipt: WitnessReceipt = await client.publish(ROOT_HASH);

    expect(receipt).toEqual({
      rootHash: ROOT_HASH,
      witnessType: 'rekor',
      publishedAt: new Date(1_700_000_000 * 1000),
      receiptData: {
        uuid: UUID,
        logIndex: 42,
        integratedTime: 1_700_000_000,
        logId: 'rekor-log-id',
      },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('submits a signed rekord entry containing the root hash over HTTPS', async () => {
    const fetch = createFetchMock();
    fetch.mockResolvedValue(makeResponse(successfulRekorBody(), 201, `"${UUID}"`));
    const client = createClient(fetch);

    await client.publish(ROOT_HASH);

    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe(`${REKOR_URL}/api/v1/log/entries`);
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('error');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.headers).toEqual(
      expect.objectContaining({ 'content-type': 'application/json', accept: 'application/json' }),
    );

    const body = JSON.parse(String(init.body));
    expect(body.apiVersion).toBe('0.0.1');
    expect(body.kind).toBe('rekord');
    expect(body.spec.data.content).toBe(Buffer.from(ROOT_HASH, 'utf8').toString('base64'));
    expect(body.spec.signature.format).toBe('x509');
    expect(body.spec.signature.content).toEqual(expect.any(String));
    expect(body.spec.signature.publicKey.content).toEqual(expect.any(String));
    expect(body.spec.signature.content).not.toBe('');
  });

  it('fails immediately on a 4xx response without retrying', async () => {
    const fetch = createFetchMock();
    fetch.mockResolvedValue(makeResponse({ message: 'bad request' }, 400));
    const client = createClient(fetch);

    await expect(client.publish(ROOT_HASH)).rejects.toThrow(/HTTP 400/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('retries a 5xx response and succeeds when the next attempt works', async () => {
    const fetch = createFetchMock();
    fetch
      .mockResolvedValueOnce(makeResponse({ message: 'upstream unavailable' }, 503))
      .mockResolvedValueOnce(makeResponse(successfulRekorBody(), 201, `"${UUID}"`));
    const client = createClient(fetch);

    const receipt = await client.publish(ROOT_HASH);

    expect(receipt.receiptData).toEqual(expect.objectContaining({ logIndex: 42 }));
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('throws a retryable error after exhausting 5xx retries', async () => {
    const fetch = createFetchMock();
    fetch.mockResolvedValue(makeResponse({ message: 'upstream unavailable' }, 500));
    const client = createClient(fetch, { maxRetries: 2 });

    await expect(client.publish(ROOT_HASH)).rejects.toThrow(/HTTP 500/);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('retries transient network failures', async () => {
    const fetch = createFetchMock();
    fetch
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(makeResponse(successfulRekorBody(), 201, `"${UUID}"`));
    const client = createClient(fetch);

    await expect(client.publish(ROOT_HASH)).resolves.toEqual(
      expect.objectContaining({ witnessType: 'rekor' }),
    );
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('aborts the request when the configured timeout elapses', async () => {
    const fetch = createFetchMock();
    fetch.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    }));
    const client = createClient(fetch, { timeoutMs: 5, maxRetries: 0 });

    await expect(client.publish(ROOT_HASH)).rejects.toThrow(/timed out/i);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed success responses instead of inventing a receipt', async () => {
    const fetch = createFetchMock();
    fetch.mockResolvedValue(makeResponse({}, 201));
    const client = createClient(fetch);

    await expect(client.publish(ROOT_HASH)).rejects.toThrow(/no log entries/i);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid root hashes before making a request', async () => {
    const fetch = createFetchMock();
    const client = createClient(fetch);

    await expect(client.publish('not-a-sha256-hash')).rejects.toThrow(/root hash/i);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('exposes retryability for the publisher retry logic', async () => {
    const fetch = createFetchMock();
    fetch.mockResolvedValue(makeResponse({}, 400));
    const client = createClient(fetch);

    let thrown: unknown;
    try {
      await client.publish(ROOT_HASH);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(RekorWitnessError);
    expect((thrown as RekorWitnessError).retryable).toBe(false);
  });
});
