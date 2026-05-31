// src/lib/stellarRpcClient.test.ts
import { createStellarRpcClient } from './stellarRpcClient';
import { STELLAR_HORIZON_URLS } from '../config/env';
import nock from 'nock';

/**
 * Simple integration test that verifies the client falls back to the second endpoint
 * when the primary returns a timeout.
 */
describe('StellarRpcClient failover', () => {
  const primary = 'http://primary.test';
  const secondary = 'http://secondary.test';
  const ledgerResponse = { sequence: 12345 };

  beforeAll(() => {
    // Override env URLs for this test
    (STELLAR_HORIZON_URLS as unknown as string[]) = [primary, secondary];
  });

  afterAll(() => {
    nock.cleanAll();
  });

  it('uses secondary when primary times out', async () => {
    // Primary never responds (timeout)
    nock(primary).get('/').delayConnection(6000).reply(200, {});
    // Secondary returns a valid ledger
    nock(secondary).get('/').reply(200, ledgerResponse);

    const client = createStellarRpcClient({ timeout: 1000 });
    const result = await client.getLatestLedger();
    expect(result.sequence).toBe(ledgerResponse.sequence);
  });
});
