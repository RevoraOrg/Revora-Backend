// src/lib/stellarRpcClient.getEventsFailure.test.ts
//
// Focused regression coverage for the `getEvents` failure-handling branch in
// `src/lib/stellarRpcClient.ts`.
//
// The client iterates its ordered endpoint list and only abandons the request
// once every endpoint has been skipped (circuit open) or has failed with a
// retryable error. Exhausting that loop surfaces the explicit aggregate failure:
//
//     throw new Error('All Horizon endpoints are unavailable or circuit broken');
//
// `getLatestLedger` already had coverage for that throw; `getEvents` did not.
// These tests pin the `getEvents` contract, the neighbouring happy path, and the
// circuit-breaker boundary that decides whether an endpoint is attempted at all.
import { createStellarRpcClient } from './stellarRpcClient';
import { globalMetrics } from './metrics';
// @ts-ignore
import nock from 'nock';

const AGGREGATE_FAILURE = 'All Horizon endpoints are unavailable or circuit broken';

describe('StellarRpcClient.getEvents failure handling', () => {
  const primary = 'http://primary.test';
  const secondary = 'http://secondary.test';

  const request = { startLedger: 1 } as any;

  beforeEach(() => {
    globalMetrics.reset();
    nock.disableNetConnect();
  });

  afterEach(() => {
    nock.cleanAll();
  });

  afterAll(() => {
    nock.enableNetConnect();
  });

  it('returns the RPC response verbatim on the happy path', async () => {
    const payload = { events: [{ id: 'evt-1' }], latestLedger: 4242 };
    nock(primary).post('/').reply(200, { result: payload });

    const client = createStellarRpcClient({ serverUrls: [primary], timeout: 1000 });

    await expect(client.getEvents(request)).resolves.toEqual(payload);
    expect(client.getBreakerStates()[primary]).toBe('closed');
  });

  it('falls back to the next endpoint when the primary fails with a retryable timeout', async () => {
    // Primary never answers within the configured timeout; secondary is healthy.
    nock(primary).post('/').delayConnection(6000).reply(200, {});
    const payload = { events: [{ id: 'evt-2' }], latestLedger: 5000 };
    nock(secondary).post('/').reply(200, { result: payload });

    const client = createStellarRpcClient({ serverUrls: [primary, secondary], timeout: 1000 });

    await expect(client.getEvents(request)).resolves.toEqual(payload);

    // The failed endpoint is penalised, the healthy one is not.
    expect(client.getBreakerStates()[primary]).toBe('closed');
    expect(client.getBreakerStates()[secondary]).toBe('closed');
  });

  it('throws the aggregate failure when every endpoint fails with a retryable error', async () => {
    nock(primary).post('/').delayConnection(6000).reply(200, {});
    nock(secondary).post('/').delayConnection(6000).reply(200, {});

    const client = createStellarRpcClient({
      serverUrls: [primary, secondary],
      timeout: 50,
    });

    await expect(client.getEvents(request)).rejects.toThrow(AGGREGATE_FAILURE);
  });

  it('opens the circuit breaker after the failure threshold is reached', async () => {
    nock(primary).post('/').delayConnection(6000).reply(200, {});

    const client = createStellarRpcClient({
      serverUrls: [primary],
      timeout: 50,
      failureThreshold: 1,
      cooldownMs: 60_000,
    });

    await expect(client.getEvents(request)).rejects.toThrow(AGGREGATE_FAILURE);
    expect(client.getBreakerStates()[primary]).toBe('open');
  });

  it('skips circuit-broken endpoints and fails fast without issuing a request', async () => {
    // Prime the breaker with a single retryable failure.
    nock(primary).post('/').delayConnection(6000).reply(200, {});

    const client = createStellarRpcClient({
      serverUrls: [primary],
      timeout: 50,
      failureThreshold: 1,
      cooldownMs: 60_000,
    });

    await expect(client.getLatestLedger()).rejects.toThrow(AGGREGATE_FAILURE);
    expect(client.getBreakerStates()[primary]).toBe('open');

    // A healthy-looking endpoint that must never be contacted while the breaker is open.
    const scope = nock(primary).post('/').reply(200, { result: { events: [], latestLedger: 1 } });

    await expect(client.getEvents(request)).rejects.toThrow(AGGREGATE_FAILURE);
    await expect(client.getLatestLedger()).rejects.toThrow(AGGREGATE_FAILURE);

    // No HTTP attempt was made for either skipped call.
    expect(scope.isDone()).toBe(false);
  });

  it('retries the healthy endpoint again once the cooldown has elapsed', async () => {
    nock(primary).post('/').delayConnection(6000).reply(200, {});
    const payload = { events: [{ id: 'evt-3' }], latestLedger: 6000 };
    nock(primary).post('/').reply(200, { result: payload });

    const client = createStellarRpcClient({
      serverUrls: [primary],
      timeout: 50,
      failureThreshold: 1,
      // Expire the breaker immediately so the next call takes the half-open probe.
      cooldownMs: 0,
    });

    await expect(client.getEvents(request)).rejects.toThrow(AGGREGATE_FAILURE);

    await expect(client.getEvents(request)).resolves.toEqual(payload);
    expect(client.getBreakerStates()[primary]).toBe('closed');
  });
});
