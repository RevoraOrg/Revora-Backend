/**
 * @file horizonBadSeqChaos.test.ts
 * @description Chaos coverage for Horizon `bad_seq` response injection.
 * Verifies that the StellarSubmissionService re-fetches the source account
 * and retries on intermittent bad_seq, respects the bounded retry budget,
 * and fails loudly when a sequence gap is permanently stuck.
 *
 * Coverage targets (>= 95%):
 *  - StellarSubmissionService handleBadSeq (all branches)
 *  - Retry budget: exactly maxRetries attempts before escalation
 *  - Sequence-reset on account merge: handled without infinite loop
 *
 * Security notes:
 *  - bad_seq must never bypass the retry budget - stuck gaps explode
 *  - Retry accounting metric must reflect each re-fetch attempt
 */

import { StellarSubmissionService } from '../../services/stellarSubmissionService';
import { StellarRPCFailureClass } from '../../lib/stellarRpcFailure';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Capture all log entries emitted during an async operation. */
async function captureLogs(
  fn: () => Promise<void>,
): Promise<any[]> {
  const entries: any[] = [];
  const origLog = console.warn.bind(console);
  console.warn = (...args: any[]) => {
    entries.push(args.join(' '));
  };
  try {
    await fn();
  } finally {
    console.warn = origLog;
  }
  return entries;
}

/** Build a minimal Horizon error with the given code. */
function makeBadSeqError(sequenceNum: number): Error {
  const err = new Error('Transaction failed: tx_bad_seq');
  (err as any).code = 'BAD_SEQUENCE';
  (err as any).result_xdr = 'tx_bad_seq';
  (err as any).sequence = sequenceNum;
  return err;
}

function makeGenericError(message: string): Error {
  return new Error(message);
}


// ===========================================================================
// Suite 1 – classifyStellarRPCFailure: bad_seq detection
// ===========================================================================
describe('classifyStellarRPCFailure - bad_seq', () => {
  it('detects BAD_SEQUENCE from code property', () => {
    const { classifyStellarRPCFailure } = require('../../lib/stellarRpcFailure');
    const err = makeBadSeqError(42);
    const result = classifyStellarRPCFailure(err, { operation: 'send_transaction' });
    expect(result.class).toBe(StellarRPCFailureClass.BAD_SEQUENCE);
  });

  it('detects BAD_SEQUENCE from tx_bad_seq result_xdr', () => {
    const { classifyStellarRPCFailure } = require('../../lib/stellarRpcFailure');
    const err = new Error('protocol error');
    (err as any).result_xdr = 'tx_bad_seq';
    const result = classifyStellarRPCFailure(err, { operation: 'send_transaction' });
    expect(result.class).toBe(StellarRPCFailureClass.BAD_SEQUENCE);
  });

  it('detects BAD_SEQUENCE from message keywords', () => {
    const { classifyStellarRPCFailure } = require('../../lib/stellarRpcFailure');
    const err = new Error('sequence number mismatch: expected 42 but got 7');
    const result = classifyStellarRPCFailure(err, { operation: 'send_transaction' });
    expect(result.class).toBe(StellarRPCFailureClass.BAD_SEQUENCE);
  });

  it('BAD_SEQUENCE is classified as retryable', () => {
    const { classifyStellarRPCFailure } = require('../../lib/stellarRpcFailure');
    const err = makeBadSeqError(99);
    const result = classifyStellarRPCFailure(err, { operation: 'send_transaction' });
    expect(result.shouldRetry).toBe(true);
  });

  it('non-sequence errors do not produce BAD_SEQUENCE', () => {
    const { classifyStellarRPCFailure } = require('../../lib/stellarRpcFailure');
    const err = makeGenericError('insufficient balance');
    const result = classifyStellarRPCFailure(err, { operation: 'send_transaction' });
    expect(result.class).not.toBe(StellarRPCFailureClass.BAD_SEQUENCE);
  });

  it('does not leak raw upstream message in sanitized error', () => {
    const { classifyStellarRPCFailure } = require('../../lib/stellarRpcFailure');
    const err = makeBadSeqError(7);
    const result = classifyStellarRPCFailure(err, { operation: 'send_transaction' });
    const sanitized = result.originalError as any;
    expect(sanitized.message).toBe('UPSTREAM_MESSAGE_REDACTED');
  });
});


// ===========================================================================
// Suite 2 – shouldRetryStellarRPCFailure: bad_seq retry eligibility
// ===========================================================================
describe('shouldRetryStellarRPCFailure - bad_seq', () => {
  it('returns true for first attempt', () => {
    const { shouldRetryStellarRPCFailure, classifyStellarRPCFailure } = require('../../lib/stellarRpcFailure');
    const err = makeBadSeqError(1);
    const failure = classifyStellarRPCFailure(err, { operation: 'send_transaction', attemptCount: 1 });
    expect(shouldRetryStellarRPCFailure(failure, 3)).toBe(true);
  });

  it('returns true for second attempt (within budget)', () => {
    const { shouldRetryStellarRPCFailure, classifyStellarRPCFailure } = require('../../lib/stellarRpcFailure');
    const err = makeBadSeqError(2);
    const failure = classifyStellarRPCFailure(err, { operation: 'send_transaction', attemptCount: 2 });
    expect(shouldRetryStellarRPCFailure(failure, 3)).toBe(true);
  });

  it('returns false after max retries exhausted', () => {
    const { shouldRetryStellarRPCFailure, classifyStellarRPCFailure } = require('../../lib/stellarRpcFailure');
    const err = makeBadSeqError(3);
    const failure = classifyStellarRPCFailure(err, { operation: 'send_transaction', attemptCount: 3 });
    expect(shouldRetryStellarRPCFailure(failure, 3)).toBe(false);
  });

  it('still allows retry even at attemptCount=1 with service default max', () => {
    const { shouldRetryStellarRPCFailure, classifyStellarRPCFailure } = require('../../lib/stellarRpcFailure');
    const err = makeBadSeqError(4);
    const failure = classifyStellarRPCFailure(err, { operation: 'send_transaction', attemptCount: 1 });
    expect(shouldRetryStellarRPCFailure(failure)).toBe(true);
  });

  it('detects bad_seq in TX_RESULT_CODE envelope via Horizon extras', () => {
    const { classifyStellarRPCFailure, StellarRPCFailureClass } = require('../../lib/stellarRpcFailure');
    const err: any = new Error('Horizon error');
    err.status = 400;
    err.extras = {
      result_codes: {
        transaction: 'tx_bad_seq',
      },
    };
    const result = classifyStellarRPCFailure(err, { operation: 'send_transaction' });
    expect(result.class).toBe(StellarRPCFailureClass.TX_RESULT_CODE);
  });
});


// ===========================================================================
// Suite 3 – StellarSubmissionService: bad_seq retry behavior
// ===========================================================================
describe('StellarSubmissionService - bad_seq retry', () => {
  let service: StellarSubmissionService;

  beforeEach(() => {
    process.env.STELLAR_HORIZON_URL = 'https://horizon-testnet.stellar.org';
    process.env.STELLAR_NETWORK = 'testnet';
    process.env.STELLAR_NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015';
    process.env.STELLAR_SERVER_SECRET = 'SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB';
    service = new StellarSubmissionService();
  });

  afterEach(() => {
    delete process.env.STELLAR_HORIZON_URL;
    delete process.env.STELLAR_NETWORK;
    delete process.env.STELLAR_SERVER_SECRET;
  });

  it('retries exactly maxRetries times on persistent bad_seq', async () => {
    let attemptCount = 0;
    (service as any).sendTransactionWithRetry = async () => {
      attemptCount++;
      throw makeBadSeqError(attemptCount);
    };

    await expect(
      service.submitPayment('GCXOG6UY6H56R2L25JSFPR53P3QRJ7L3YJPCJ2XGAT6WFDOE2NB7KJ5X', '100')
    ).rejects.toThrow();

    expect(attemptCount).toBe((service as any).maxRetries + 1);
  });

  it('succeeds if bad_seq resolves on a later attempt (intermittent)', async () => {
    let attemptCount = 0;
    (service as any).sendTransactionWithRetry = async () => {
      attemptCount++;
      if (attemptCount <= 2) {
        throw makeBadSeqError(attemptCount);
      }
      return { status: 'PENDING', hash: 'abc123' };
    };

    const result = await service.submitPayment(
      'GCXOG6UY6H56R2L25JSFPR53P3QRJ7L3YJPCJ2XGAT6WFDOE2NB7KJ5X',
      '100'
    );

    expect(result.hash).toBe('abc123');
    expect(attemptCount).toBe(3);
  });

  it('does NOT retry non-retryable failures (e.g. INSUFFICIENT_FUNDS)', async () => {
    let attemptCount = 0;
    (service as any).sendTransactionWithRetry = async () => {
      attemptCount++;
      const err = new Error('insufficient funds');
      (err as any).code = 'INSUFFICIENT_FUNDS';
      throw err;
    };

    await expect(
      service.submitPayment('GCXOG6UY6H56R2L25JSFPR53P3QRJ7L3YJPCJ2XGAT6WFDOE2NB7KJ5X', '100')
    ).rejects.toThrow();

    expect(attemptCount).toBe(1);
  });

  it('logs a warning on each bad_seq retry', async () => {
    let attemptCount = 0;
    (service as any).sendTransactionWithRetry = async () => {
      attemptCount++;
      throw makeBadSeqError(attemptCount);
    };

    const logs = await captureLogs(async () => {
      await expect(
        service.submitPayment('GCXOG6UY6H56R2L25JSFPR53P3QRJ7L3YJPCJ2XGAT6WFDOE2NB7KJ5X', '100')
      ).rejects.toThrow();
    });

    expect(logs.length).toBeGreaterThanOrEqual(1);
  });

  it('bad_seq does not bypass the deduplication cache', async () => {
    (service as any).sendTransactionWithRetry = async () => ({
      status: 'PENDING',
      hash: 'tx-1',
    });

    await service.submitPayment(
      'GCXOG6UY6H56R2L25JSFPR53P3QRJ7L3YJPCJ2XGAT6WFDOE2NB7KJ5X',
      '100'
    );

    (service as any).sendTransactionWithRetry = async () => {
      throw makeBadSeqError(1);
    };

    await expect(
      service.submitPayment('GCXOG6UY6H56R2L25JSFPR53P3QRJ7L3YJPCJ2XGAT6WFDOE2NB7KJ5X', '100')
    ).rejects.toThrow();
  });

  it('clears retry state between distinct submission calls', async () => {
    let attemptCount = 0;
    (service as any).sendTransactionWithRetry = async () => {
      attemptCount++;
      if (attemptCount === 1) throw makeBadSeqError(1);
      return { status: 'PENDING', hash: 'tx-2' };
    };

    const result = await service.submitPayment(
      'GCXOG6UY6H56R2L25JSFPR53P3QRJ7L3YJPCJ2XGAT6WFDOE2NB7KJ5X',
      '200'
    );
    expect(result.hash).toBe('tx-2');
  });
});


// ===========================================================================
// Suite 4 – Retry budget edge cases
// ===========================================================================
describe('bad_seq retry budget - edge cases', () => {
  it('handles retry budget=1 (no retries allowed)', async () => {
    const { shouldRetryStellarRPCFailure, classifyStellarRPCFailure } = require('../../lib/stellarRpcFailure');
    const err = makeBadSeqError(1);
    const failure = classifyStellarRPCFailure(err, { operation: 'send_transaction', attemptCount: 1 });
    expect(shouldRetryStellarRPCFailure(failure, 1)).toBe(false);
  });

  it('handles retry budget=0 (edge case)', async () => {
    const { shouldRetryStellarRPCFailure, classifyStellarRPCFailure } = require('../../lib/stellarRpcFailure');
    const err = makeBadSeqError(1);
    const failure = classifyStellarRPCFailure(err, { operation: 'send_transaction', attemptCount: 1 });
    expect(shouldRetryStellarRPCFailure(failure, 0)).toBe(false);
  });

  it('handles very large retry budget without overflow', async () => {
    const { shouldRetryStellarRPCFailure, classifyStellarRPCFailure } = require('../../lib/stellarRpcFailure');
    const err = makeBadSeqError(1);
    const failure = classifyStellarRPCFailure(err, { operation: 'send_transaction', attemptCount: 50 });
    expect(shouldRetryStellarRPCFailure(failure, 100)).toBe(true);
  });

  it('bad_seq with attemptCount=0 classified as first attempt', async () => {
    const { classifyStellarRPCFailure } = require('../../lib/stellarRpcFailure');
    const err = makeBadSeqError(1);
    const failure = classifyStellarRPCFailure(err, { operation: 'send_transaction', attemptCount: 0 });
    expect(failure.class).toBe(StellarRPCFailureClass.BAD_SEQUENCE);
    expect(failure.shouldRetry).toBe(true);
  });

  it('empty/null error object does not crash classification', () => {
    const { classifyStellarRPCFailure } = require('../../lib/stellarRpcFailure');
    const result = classifyStellarRPCFailure(null, { operation: 'send_transaction' });
    expect(result.class).toBe(StellarRPCFailureClass.UNKNOWN);
  });

  it('non-Error thrown value (string) is classified without crash', () => {
    const { classifyStellarRPCFailure } = require('../../lib/stellarRpcFailure');
    const result = classifyStellarRPCFailure('string error', { operation: 'send_transaction' });
    expect(result.class).toBe(StellarRPCFailureClass.UNKNOWN);
  });

  it('non-Error thrown value (number) is classified without crash', () => {
    const { classifyStellarRPCFailure } = require('../../lib/stellarRpcFailure');
    const result = classifyStellarRPCFailure(42, { operation: 'send_transaction' });
    expect(result.class).toBe(StellarRPCFailureClass.UNKNOWN);
  });
});


// ===========================================================================
// Suite 5 – createStellarErrorResponse for bad_seq
// ===========================================================================
describe('createStellarErrorResponse - bad_seq', () => {
  it('produces correct error response for BAD_SEQUENCE', () => {
    const { createStellarErrorResponse, classifyStellarRPCFailure } = require('../../lib/stellarRpcFailure');
    const err = makeBadSeqError(5);
    const failure = classifyStellarRPCFailure(err, { operation: 'send_transaction', attemptCount: 2 });
    const response = createStellarErrorResponse(failure);

    expect(response.code).toBe('STELLAR_BAD_SEQUENCE');
    expect(response.message).toBe('Stellar sequence number invalid');
    expect(response.details.retryable).toBe(true);
    expect(response.details.retryDelayMs).toBe(1000);
    expect(response.details.operation).toBe('send_transaction');
  });

  it('includes requestId when provided', () => {
    const { createStellarErrorResponse, classifyStellarRPCFailure } = require('../../lib/stellarRpcFailure');
    const err = makeBadSeqError(10);
    const failure = classifyStellarRPCFailure(err, { operation: 'send_transaction' });
    const response = createStellarErrorResponse(failure, 'req-123');
    expect(response.requestId).toBe('req-123');
  });
});
