// src/lib/stellarRpcClient.test.ts
import { createStellarRpcClient } from './stellarRpcClient';
import { env } from '../config/env';
import { globalMetrics } from './metrics';
// @ts-ignore
import nock from 'nock';

/**
 * Simple integration test that verifies the client falls back to the second endpoint
 * when the primary returns a timeout.
 */
describe('StellarRpcClient failover', () => {
  const primary = 'http://primary.test';
  const secondary = 'http://secondary.test';
  const ledgerResponse = { id: 'some-id', sequence: 12345, protocolVersion: '20' };

  beforeAll(() => {
    // We don't override env URL since we will pass serverUrls explicitly
  });

  afterAll(() => {
    nock.cleanAll();
  });

  it('uses secondary when primary times out', async () => {
    // Primary never responds (timeout)
    nock(primary).post('/').delayConnection(6000).reply(200, {});
    // Secondary returns a valid ledger
    nock(secondary).post('/').reply(200, { result: ledgerResponse });

    const client = createStellarRpcClient({ serverUrls: [primary, secondary], timeout: 1000 });
    const result = await client.getLatestLedger();
    expect(result.sequence).toBe(ledgerResponse.sequence);
  });
});

describe('StellarRpcClient chaos scenarios', () => {
  const primary = 'http://primary.test';
  const secondary = 'http://secondary.test';
  const validLedger = { id: 'valid-id', sequence: 12345, protocolVersion: '20' };
  
  beforeEach(() => {
    globalMetrics.reset();
  });

  afterEach(() => {
    nock.cleanAll();
  });

  it('rejects partial ledger and retries on secondary endpoint', async () => {
    const incrementSpy = jest.spyOn(globalMetrics, 'incrementCounter');
    
    // Primary returns a truncated payload (missing id and protocolVersion)
    nock(primary).post('/').reply(200, { result: { sequence: 12345 } });
    // Secondary returns a valid ledger
    nock(secondary).post('/').reply(200, { result: validLedger });

    const client = createStellarRpcClient({ serverUrls: [primary, secondary], timeout: 1000 });
    const result = await client.getLatestLedger();
    
    expect(result.sequence).toBe(validLedger.sequence);
    
    // Verify metric was emitted
    expect(incrementSpy).toHaveBeenCalledWith('ingest.partial.rejected');
    incrementSpy.mockRestore();
  });

  it('throws error when chained truncations exceed retry budget', async () => {
    const incrementSpy = jest.spyOn(globalMetrics, 'incrementCounter');

    // Both endpoints return truncated payload
    nock(primary).post('/').reply(200, { result: { sequence: 12345 } });
    nock(secondary).post('/').reply(200, { result: { id: 'some-id', sequence: 12345 } }); // missing protocolVersion

    const client = createStellarRpcClient({ serverUrls: [primary, secondary], timeout: 1000 });
    
    await expect(client.getLatestLedger()).rejects.toThrow('All Horizon endpoints are unavailable or circuit broken');
    
    // Verify metric was emitted twice
    expect(incrementSpy).toHaveBeenCalledTimes(2);
    expect(incrementSpy).toHaveBeenCalledWith('ingest.partial.rejected');
    incrementSpy.mockRestore();
  });
});

