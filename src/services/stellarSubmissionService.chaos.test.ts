import * as StellarSdk from '@stellar/stellar-sdk';

jest.mock('../config/env', () => ({
  env: {
    STELLAR_HORIZON_URL: 'https://horizon-testnet.stellar.org',
    STELLAR_NETWORK: 'testnet',
    STELLAR_NETWORK_PASSPHRASE: undefined,
    STELLAR_SERVER_SECRET: StellarSdk.Keypair.random().secret(),
    STELLAR_MAX_FEE: '100',
  },
}));

import { StellarSubmissionService } from './stellarSubmissionService';

/**
 * Mimics the shape of a Horizon "tx_bad_seq" error. If classifyStellarRPCFailure
 * in stellarRpcFailure.ts detects BAD_SEQUENCE via a different field, adjust this
 * shape to match — check that function first if these tests don't trigger BAD_SEQUENCE.
 */
function makeBadSeqError() {
  const err: any = new Error('Bad Request');
  err.response = {
    status: 400,
    data: {
      status: 400,
      type: 'transaction_failed',
      extras: { result_codes: { transaction: 'tx_bad_seq' } },
    },
  };
  return err;
}

function makeAccountNotFoundError() {
  const err: any = new Error('Not Found');
  err.response = { status: 404, data: { status: 404, type: 'not_found' } };
  return err;
}

describe('StellarSubmissionService — bad_seq chaos', () => {
  let service: StellarSubmissionService;
  let getAccountMock: jest.Mock;
  let sendTransactionMock: jest.Mock;

  beforeEach(() => {
    service = new StellarSubmissionService();

    getAccountMock = jest.fn();
    sendTransactionMock = jest.fn();
    (service as any).server.getAccount = getAccountMock;
    (service as any).server.sendTransaction = sendTransactionMock;

    // Skip real backoff delays so tests run fast.
    jest.spyOn(service as any, 'delay').mockResolvedValue(undefined);
  });

  const publicKey = (service: StellarSubmissionService) => service.getPublicKey();

  it('recovers from an intermittent bad_seq by re-fetching the account and retrying', async () => {
    getAccountMock
      .mockResolvedValueOnce(new StellarSdk.Account(publicKey(service), '1')) // initial fetch
      .mockResolvedValueOnce(new StellarSdk.Account(publicKey(service), '2')); // rebuild re-fetch

    sendTransactionMock
      .mockRejectedValueOnce(makeBadSeqError())
      .mockResolvedValueOnce({ status: 'PENDING', hash: 'abc123' });

    const result = await service.submitPayment(
      StellarSdk.Keypair.random().publicKey(),
      '10',
    );

    expect(result.status).toBe('PENDING');
    expect(sendTransactionMock).toHaveBeenCalledTimes(2);
    expect(getAccountMock).toHaveBeenCalledTimes(2);
  });

  it('bounds retries and fails loudly when bad_seq persists', async () => {
    getAccountMock.mockResolvedValue(new StellarSdk.Account(publicKey(service), '1'));
    sendTransactionMock.mockRejectedValue(makeBadSeqError());

    await expect(
      service.submitPayment(StellarSdk.Keypair.random().publicKey(), '10'),
    ).rejects.toThrow();

    // Bounded: retries must not exceed the configured budget (default maxRetries = 3).
    const maxRetries = (service as any).maxRetries;
    expect(sendTransactionMock.mock.calls.length).toBeLessThanOrEqual(maxRetries + 1);
    expect(sendTransactionMock.mock.calls.length).toBeGreaterThan(1);
  });

  it('fails loudly, without hanging, on a stuck sequence gap (e.g. account merged away)', async () => {
    getAccountMock
      .mockResolvedValueOnce(new StellarSdk.Account(publicKey(service), '1')) // initial fetch
      .mockRejectedValue(makeAccountNotFoundError()); // account no longer exists — merge scenario

    sendTransactionMock.mockRejectedValue(makeBadSeqError());

    await expect(
      service.submitPayment(StellarSdk.Keypair.random().publicKey(), '10'),
    ).rejects.toThrow();

    // Must terminate (not hang) and must not retry unboundedly even though
    // the recovery path itself is also failing.
    expect(sendTransactionMock.mock.calls.length).toBeLessThan(20);
  });
});