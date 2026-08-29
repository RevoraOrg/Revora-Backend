import * as StellarSdk from '@stellar/stellar-sdk';
import { StellarSubmissionService } from './stellarSubmissionService';
import { env } from '../config/env';
import { Errors } from '../lib/errors';
import { StellarRPCFailureClass } from '../lib/stellarRpcFailure';

// Define mock transaction before jest.mock (mocks are hoisted)
const mockTransaction = {
  hash: () => Buffer.from('mock-hash', 'hex'),
  sign: jest.fn(),
  toXDR: jest.fn().mockReturnValue('mock-xdr'),
};

// Mock env
jest.mock('../config/env', () => ({
  env: {
    STELLAR_HORIZON_URL: 'https://horizon.stellar.org',
    STELLAR_TIMEOUT: 30000,
    STELLAR_MAX_FEE: 100000,
    STELLAR_NETWORK_PASSPHRASE: 'Public Global Stellar Network ; September 2015',
    STELLAR_NETWORK: 'public',
  },
}));

jest.mock('@stellar/stellar-sdk', () => {
  return {
    rpc: {
      Server: jest.fn().mockImplementation(() => ({
        getAccount: jest.fn().mockResolvedValue({
          accountId: () => 'G-MOCK-PUBLIC-KEY',
          sequenceNumber: () => '1',
          incrementSequenceNumber: jest.fn(),
        }),
        sendTransaction: jest
          .fn()
          .mockResolvedValue({ 
            hash: 'mock-hash', 
            status: 'PENDING',
            latestLedger: 12345,
            latestLedgerCloseTime: 1234567890,
          }),
      })),
    },
    Keypair: {
      fromSecret: jest.fn().mockReturnValue({
        publicKey: jest.fn().mockReturnValue('G-MOCK-PUBLIC-KEY'),
        sign: jest.fn(),
      }),
    },
    Asset: {
      native: jest.fn().mockReturnValue({ 
        isNative: jest.fn().mockReturnValue(true),
        getAssetCode: jest.fn().mockReturnValue('XLM')
      }),
    },
    TransactionBuilder: jest.fn().mockImplementation(() => ({
      addOperation: jest.fn().mockReturnThis(),
      setTimeout: jest.fn().mockReturnThis(),
      build: jest.fn().mockReturnValue(mockTransaction),
    })),
    Operation: {
      payment: jest.fn(),
      invokeContractFunction: jest.fn(),
    },
    BASE_FEE: '100',
    Networks: {
      TESTNET: 'Test SDF Network ; September 2015',
      PUBLIC: 'Public Global Stellar Network ; September 2015',
    },
  };
});

// Mock environment
jest.mock('../config/env', () => {
  const actualEnv = jest.requireActual('../config/env');
  return {
    ...actualEnv,
    env: {
      STELLAR_HORIZON_URL: 'https://horizon-testnet.stellar.org',
      STELLAR_TIMEOUT: 30000,
      STELLAR_MAX_FEE: 100000,
      STELLAR_NETWORK_PASSPHRASE: 'Test SDF Network ; September 2015',
      STELLAR_NETWORK: 'testnet',
      STELLAR_SERVER_SECRET: 'SAXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    },
  };
});

describe('StellarSubmissionService', () => {
  let service: StellarSubmissionService;
  let mockServer: jest.Mocked<StellarSdk.rpc.Server>;
  const mockSecret = 'SAXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';

  beforeEach(() => {
    process.env.STELLAR_SERVER_SECRET = mockSecret;
    jest.clearAllMocks();
    jest.useFakeTimers();
    service = new StellarSubmissionService();
    mockServer = (StellarSdk.rpc.Server as jest.Mock).mock.results[0].value;
    // Mock the delay function to avoid actual waiting in tests
    jest.spyOn(service as any, 'delay').mockImplementation(() => Promise.resolve());
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('should initialize with the correct horizon URL and keypair', () => {
    expect(StellarSdk.Keypair.fromSecret).toHaveBeenCalledWith(mockSecret);
    expect(StellarSdk.rpc.Server).toHaveBeenCalled();
  });

  it('should throw error if secret is missing', () => {
    const { env } = require('../config/env');
    const originalSecret = env.STELLAR_SERVER_SECRET;
    try {
      delete env.STELLAR_SERVER_SECRET;
      expect(() => new StellarSubmissionService()).toThrow(
        'STELLAR_SERVER_SECRET is not defined in environment variables',
      );
    } finally {
      env.STELLAR_SERVER_SECRET = originalSecret;
    }
  });

  it('should throw error if secret is invalid', () => {
    (StellarSdk.Keypair.fromSecret as jest.Mock).mockImplementationOnce(() => {
      throw new Error('invalid secret');
    });
    expect(() => new StellarSubmissionService()).toThrow(
      'Invalid STELLAR_SERVER_SECRET provided'
    );
  });

  it('should submit a payment successfully', async () => {
    const to = 'G-DESTINATION';
    const amount = '10.0';

    const result = await service.submitPayment(to, amount);

    expect(result).toEqual({ hash: 'mock-hash', status: 'PENDING', latestLedger: 12345, latestLedgerCloseTime: 1234567890 });
    expect(StellarSdk.Operation.payment).toHaveBeenCalledWith({
      destination: to,
      amount,
      asset: expect.anything(),
    });
    expect(StellarSdk.TransactionBuilder).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        fee: '100000', // Should use env.STELLAR_MAX_FEE
        networkPassphrase: env.STELLAR_NETWORK_PASSPHRASE,
      })
    );
  });

  it('should submit a payment with a non-native asset', async () => {
    const to = 'G-DESTINATION';
    const amount = '10.0';
    const asset = {
      isNative: jest.fn().mockReturnValue(false),
      getAssetCode: jest.fn().mockReturnValue('USDC'),
    } as any;

    const result = await service.submitPayment(to, amount, asset);

    expect(result).toEqual({ hash: 'mock-hash', status: 'PENDING', latestLedger: 12345, latestLedgerCloseTime: 1234567890 });
    expect(asset.isNative).toHaveBeenCalled();
    expect(StellarSdk.Operation.payment).toHaveBeenCalledWith({
      destination: to,
      amount,
      asset,
    });
  });

  it('should throw serviceUnavailable when transaction submission fails', async () => {
    (StellarSdk.rpc.Server as jest.Mock).mockImplementationOnce(() => ({
      getAccount: jest.fn().mockResolvedValue({ sequenceNumber: () => '1', incrementSequenceNumber: jest.fn() }),
      sendTransaction: jest.fn().mockRejectedValue(new Error('submit failure')),
    }));

    const localService = new StellarSubmissionService();
    jest.spyOn(localService as any, 'delay').mockImplementation(() => Promise.resolve());

    await expect(localService.submitPayment('G-DESTINATION', '10.0')).rejects.toThrow(
      'Unknown Stellar network error'
    );
  });

  it('should re-throw AppError from transaction failures', async () => {
    const appError = new Error('AppError occurred');
    appError.name = 'AppError';

    (StellarSdk.rpc.Server as jest.Mock).mockImplementationOnce(() => ({
      getAccount: jest.fn().mockResolvedValue({ sequenceNumber: () => '1', incrementSequenceNumber: jest.fn() }),
      sendTransaction: jest.fn().mockRejectedValue(appError),
    }));

    const localService = new StellarSubmissionService();

    await expect(localService.submitPayment('G-DESTINATION', '10.0')).rejects.toThrow(
      'AppError occurred'
    );
  });

  it('should throw validation error for invalid destination', async () => {
    await expect(service.submitPayment('', '10.0')).rejects.toThrow(
      'Destination public key must be a non-empty string'
    );
  });

  it('should throw validation error for invalid amount', async () => {
    await expect(service.submitPayment('G-DESTINATION', '')).rejects.toThrow(
      'Amount must be a non-empty string'
    );
  });

  it('should throw validation error for empty idempotency key', async () => {
    await expect(service.submitPayment('G-DESTINATION', '10.0', undefined, '   ')).rejects.toThrow(
      'Idempotency key must be a non-empty string when provided'
    );
  });

  it('should return the public key', () => {
    expect(service.getPublicKey()).toBe('G-MOCK-PUBLIC-KEY');
  });

  it('should throw error on invokeContract as it is a placeholder', async () => {
    await expect(service.invokeContract('CID', 'func')).rejects.toThrow(
      'Soroban contract invocation not implemented yet',
    );
  });

  describe('Retry Logic', () => {
    it('should retry on timeout failure and eventually succeed', async () => {
      let attemptCount = 0;
      const timeoutError = new Error('Request timeout');
      timeoutError.name = 'AbortError';

      mockServer.sendTransaction = jest.fn()
        .mockImplementationOnce(() => {
          attemptCount++;
          return Promise.reject(timeoutError);
        })
        .mockImplementationOnce(() => {
          attemptCount++;
          return Promise.resolve({
            hash: 'mock-hash',
            status: 'PENDING',
            latestLedger: 12345,
            latestLedgerCloseTime: 1234567890,
          });
        });

      const result = await service.submitPayment('G-DESTINATION', '10.0');

      expect(result.status).toBe('PENDING');
      expect(attemptCount).toBe(2);
    });

    it('should retry on rate limit failure and eventually succeed', async () => {
      let attemptCount = 0;
      const rateLimitError = {
        status: 429,
        message: 'Rate limit exceeded',
      };

      mockServer.sendTransaction = jest.fn()
        .mockImplementationOnce(() => {
          attemptCount++;
          return Promise.reject(rateLimitError);
        })
        .mockImplementationOnce(() => {
          attemptCount++;
          return Promise.resolve({
            hash: 'mock-hash',
            status: 'PENDING',
            latestLedger: 12345,
            latestLedgerCloseTime: 1234567890,
          });
        });

      const result = await service.submitPayment('G-DESTINATION', '10.0');

      expect(result.status).toBe('PENDING');
      expect(attemptCount).toBe(2);
    });

    it('should retry on network error and eventually succeed', async () => {
      let attemptCount = 0;
      const networkError = new Error('Network error');
      networkError.name = 'NetworkError';

      mockServer.sendTransaction = jest.fn()
        .mockImplementationOnce(() => {
          attemptCount++;
          return Promise.reject(networkError);
        })
        .mockImplementationOnce(() => {
          attemptCount++;
          return Promise.resolve({
            hash: 'mock-hash',
            status: 'PENDING',
            latestLedger: 12345,
            latestLedgerCloseTime: 1234567890,
          });
        });

      const result = await service.submitPayment('G-DESTINATION', '10.0');

      expect(result.status).toBe('PENDING');
      expect(attemptCount).toBe(2);
    });

    it('should retry on upstream error (500) and eventually succeed', async () => {
      let attemptCount = 0;
      const upstreamError = {
        status: 500,
        message: 'Internal server error',
      };

      mockServer.sendTransaction = jest.fn()
        .mockImplementationOnce(() => {
          attemptCount++;
          return Promise.reject(upstreamError);
        })
        .mockImplementationOnce(() => {
          attemptCount++;
          return Promise.resolve({
            hash: 'mock-hash',
            status: 'PENDING',
            latestLedger: 12345,
            latestLedgerCloseTime: 1234567890,
          });
        });

      const result = await service.submitPayment('G-DESTINATION', '10.0');

      expect(result.status).toBe('PENDING');
      expect(attemptCount).toBe(2);
    });

    it('should retry getAccount in submitPayment and eventually succeed', async () => {
      let accountAttempts = 0;
      const timeoutError = new Error('Request timeout');
      timeoutError.name = 'AbortError';

      mockServer.getAccount = jest.fn()
        .mockImplementationOnce(() => {
          accountAttempts++;
          return Promise.reject(timeoutError);
        })
        .mockImplementationOnce(() => {
          accountAttempts++;
          return Promise.resolve({
            accountId: () => 'G-MOCK-PUBLIC-KEY',
            sequenceNumber: () => '2',
            incrementSequenceNumber: jest.fn(),
          });
        });

      const result = await service.submitPayment('G-DESTINATION', '10.0');

      expect(result.status).toBe('PENDING');
      expect(accountAttempts).toBe(2);
      expect(mockServer.sendTransaction).toHaveBeenCalledTimes(1);
    });

    it('should exhaust max retries and throw error', async () => {
      let attemptCount = 0;
      const timeoutError = new Error('Request timeout');
      timeoutError.name = 'AbortError';

      mockServer.sendTransaction = jest.fn().mockImplementation(() => {
        attemptCount++;
        return Promise.reject(timeoutError);
      });

      await expect(service.submitPayment('G-DESTINATION', '10.0')).rejects.toThrow();

      // Should attempt exactly maxRetries times (3)
      expect(attemptCount).toBe(3);
    });
  });

  describe('Non-Retryable Failures', () => {
    it('should not retry on insufficient funds error', async () => {
      let attemptCount = 0;
      const insufficientFundsError = {
        code: 'INSUFFICIENT_FUNDS',
        message: 'Insufficient funds',
      };

      mockServer.sendTransaction = jest.fn().mockImplementation(() => {
        attemptCount++;
        return Promise.reject(insufficientFundsError);
      });

      await expect(service.submitPayment('G-DESTINATION', '10.0')).rejects.toThrow();

      // Should only attempt once (no retry for insufficient funds)
      expect(attemptCount).toBe(1);
    });

    it('should not retry on transaction failed error', async () => {
      let attemptCount = 0;
      const transactionFailedError = {
        code: 'TRANSACTION_FAILED',
        message: 'Transaction failed',
      };

      mockServer.sendTransaction = jest.fn().mockImplementation(() => {
        attemptCount++;
        return Promise.reject(transactionFailedError);
      });

      await expect(service.submitPayment('G-DESTINATION', '10.0')).rejects.toThrow();

      // Should only attempt once (no retry for transaction failed)
      expect(attemptCount).toBe(1);
    });

    it('should not retry on unauthorized error (401)', async () => {
      let attemptCount = 0;
      const unauthorizedError = {
        status: 401,
        message: 'Unauthorized',
      };

      mockServer.sendTransaction = jest.fn().mockImplementation(() => {
        attemptCount++;
        return Promise.reject(unauthorizedError);
      });

      await expect(service.submitPayment('G-DESTINATION', '10.0')).rejects.toThrow();

      // Should only attempt once (no retry for unauthorized)
      expect(attemptCount).toBe(1);
    });

    it('should not retry on signing error', async () => {
      let attemptCount = 0;
      const signingError = {
        code: 'SIGNING_ERROR',
        message: 'Invalid signature',
      };

      mockServer.sendTransaction = jest.fn().mockImplementation(() => {
        attemptCount++;
        return Promise.reject(signingError);
      });

      await expect(service.submitPayment('G-DESTINATION', '10.0')).rejects.toThrow();

      // Should only attempt once (no retry for signing error)
      expect(attemptCount).toBe(1);
    });
  });

  describe('Secret Safety', () => {
    it('should never log the secret in error messages', async () => {
      const logSpy = jest.spyOn(console, 'error').mockImplementation();
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
      const infoSpy = jest.spyOn(console, 'info').mockImplementation();

      const error = new Error('Test error');
      mockServer.sendTransaction = jest.fn().mockRejectedValue(error);

      await expect(service.submitPayment('G-DESTINATION', '10.0')).rejects.toThrow();

      // Check that secret never appears in any log output
      const allLogs = [
        ...logSpy.mock.calls.map(call => JSON.stringify(call)),
        ...warnSpy.mock.calls.map(call => JSON.stringify(call)),
        ...infoSpy.mock.calls.map(call => JSON.stringify(call)),
      ].join(' ');

      expect(allLogs).not.toContain(mockSecret);
      expect(allLogs).not.toContain('SAXXXXXXXX');

      logSpy.mockRestore();
      warnSpy.mockRestore();
      infoSpy.mockRestore();
    });

    it('should never serialize secret into error objects', async () => {
      const error = new Error('Test error');
      mockServer.sendTransaction = jest.fn().mockRejectedValue(error);

      try {
        await service.submitPayment('G-DESTINATION', '10.0');
      } catch (err: any) {
        const errorString = JSON.stringify(err);
        expect(errorString).not.toContain(mockSecret);
        expect(errorString).not.toContain('SAXXXXXXXX');
      }
    });
  });

  describe('Idempotent Resubmission', () => {
    it('should prevent duplicate transaction submission', async () => {
      const mockTransaction = {
        hash: () => Buffer.from('duplicate-hash-123', 'hex'),
        sign: jest.fn(),
      };

      (StellarSdk.TransactionBuilder as unknown as jest.Mock).mockImplementationOnce(() => ({
        addOperation: jest.fn().mockReturnThis(),
        setTimeout: jest.fn().mockReturnThis(),
        build: jest.fn().mockReturnValue(mockTransaction),
      }));

      const sendTransactionSpy = jest.fn().mockResolvedValue({
        hash: 'mock-hash',
        status: 'PENDING',
        latestLedger: 12345,
        latestLedgerCloseTime: 1234567890,
      });

      mockServer.sendTransaction = sendTransactionSpy;

      // First submission should succeed
      await service.submitPayment('G-DESTINATION', '10.0');

      // Second submission with same transaction should fail
      await expect(service.submitPayment('G-DESTINATION', '10.0')).rejects.toThrow(
        'Transaction already submitted'
      );

      // Should only call sendTransaction once
      expect(sendTransactionSpy).toHaveBeenCalledTimes(1);
    });

    it('should clear transaction cache when requested', async () => {
      const mockTransaction = {
        hash: () => Buffer.from('cache-test-hash', 'hex'),
        sign: jest.fn(),
      };

      (StellarSdk.TransactionBuilder as unknown as jest.Mock).mockImplementationOnce(() => ({
        addOperation: jest.fn().mockReturnThis(),
        setTimeout: jest.fn().mockReturnThis(),
        build: jest.fn().mockReturnValue(mockTransaction),
      }));

      const sendTransactionSpy = jest.fn().mockResolvedValue({
        hash: 'mock-hash',
        status: 'PENDING',
        latestLedger: 12345,
        latestLedgerCloseTime: 1234567890,
      });

      mockServer.sendTransaction = sendTransactionSpy;

      // First submission
      await service.submitPayment('G-DESTINATION', '10.0');
      expect(service.getTransactionCacheSize()).toBe(1);

      // Clear cache
      service.clearTransactionCache();
      expect(service.getTransactionCacheSize()).toBe(0);
    });

    it('should use idempotency key when provided', async () => {
      const mockTransaction = {
        hash: () => Buffer.from('idempotency-hash', 'hex'),
        sign: jest.fn(),
      };

      (StellarSdk.TransactionBuilder as unknown as jest.Mock).mockImplementationOnce(() => ({
        addOperation: jest.fn().mockReturnThis(),
        setTimeout: jest.fn().mockReturnThis(),
        build: jest.fn().mockReturnValue(mockTransaction),
      }));

      const sendTransactionSpy = jest.fn().mockResolvedValue({
        hash: 'mock-hash',
        status: 'PENDING',
        latestLedger: 12345,
        latestLedgerCloseTime: 1234567890,
      });

      mockServer.sendTransaction = sendTransactionSpy;

      // Submit with idempotency key
      await service.submitPayment('G-DESTINATION', '10.0', undefined, 'test-idempotency-key');

      // Should succeed
      expect(sendTransactionSpy).toHaveBeenCalledTimes(1);
    });

    it('should return cached result for repeated idempotency key without resubmitting', async () => {
      const sendTransactionSpy = jest.fn().mockResolvedValue({
        hash: 'idempotent-hash',
        status: 'PENDING',
        latestLedger: 12345,
        latestLedgerCloseTime: 1234567890,
      });

      mockServer.sendTransaction = sendTransactionSpy;

      const first = await service.submitPayment('G-DESTINATION', '10.0', undefined, 'idem-key-1');
      const second = await service.submitPayment('G-DESTINATION', '10.0', undefined, 'idem-key-1');

      expect(first).toBe(second);
      expect(second.hash).toBe('idempotent-hash');
      expect(sendTransactionSpy).toHaveBeenCalledTimes(1);
    });

    it('should coalesce concurrent submissions with the same idempotency key', async () => {
      let resolveSubmission: (value: any) => void = jest.fn();
      const pendingSubmission = new Promise((resolve) => {
        resolveSubmission = resolve;
      });
      const sendTransactionSpy = jest.fn().mockReturnValue(pendingSubmission);

      mockServer.sendTransaction = sendTransactionSpy;

      const first = service.submitPayment('G-DESTINATION', '10.0', undefined, 'idem-key-concurrent');
      const second = service.submitPayment('G-DESTINATION', '10.0', undefined, 'idem-key-concurrent');

      resolveSubmission({
        hash: 'concurrent-hash',
        status: 'PENDING',
        latestLedger: 12345,
        latestLedgerCloseTime: 1234567890,
      });

      await expect(first).resolves.toEqual(expect.objectContaining({ hash: 'concurrent-hash' }));
      await expect(second).resolves.toEqual(expect.objectContaining({ hash: 'concurrent-hash' }));
      expect(sendTransactionSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('getAccountWithRetry', () => {
    it('should retry getAccount on timeout and eventually succeed', async () => {
      let attemptCount = 0;
      const timeoutError = new Error('Request timeout');
      timeoutError.name = 'AbortError';

      mockServer.getAccount = jest.fn()
        .mockImplementationOnce(() => {
          attemptCount++;
          return Promise.reject(timeoutError);
        })
        .mockImplementationOnce(() => {
          attemptCount++;
          return Promise.resolve({
            accountId: () => 'G-MOCK-PUBLIC-KEY',
            sequenceNumber: () => '2',
            incrementSequenceNumber: jest.fn(),
          });
        });

      // Access private method via prototype
      const getAccountWithRetry = (service as any).getAccountWithRetry.bind(service);
      const result = await getAccountWithRetry('G-MOCK-PUBLIC-KEY', {
        operation: 'get_account',
        network: 'testnet',
        attemptCount: 1,
      });

      expect(result).toBeDefined();
      expect(attemptCount).toBe(2);
    });

    it('should retry getAccount on network error and eventually succeed', async () => {
      let attemptCount = 0;
      const networkError = new Error('Network error');
      networkError.name = 'NetworkError';

      mockServer.getAccount = jest.fn()
        .mockImplementationOnce(() => {
          attemptCount++;
          return Promise.reject(networkError);
        })
        .mockImplementationOnce(() => {
          attemptCount++;
          return Promise.resolve({
            accountId: () => 'G-MOCK-PUBLIC-KEY',
            sequenceNumber: () => '2',
            incrementSequenceNumber: jest.fn(),
          });
        });

      const getAccountWithRetry = (service as any).getAccountWithRetry.bind(service);
      const result = await getAccountWithRetry('G-MOCK-PUBLIC-KEY', {
        operation: 'get_account',
        network: 'testnet',
        attemptCount: 1,
      });

      expect(result).toBeDefined();
      expect(attemptCount).toBe(2);
    });

    it('should not retry getAccount on non-retryable errors', async () => {
      let attemptCount = 0;
      const unauthorizedError = {
        status: 401,
        message: 'Unauthorized',
      };

      mockServer.getAccount = jest.fn().mockImplementation(() => {
        attemptCount++;
        return Promise.reject(unauthorizedError);
      });

      const getAccountWithRetry = (service as any).getAccountWithRetry.bind(service);
      
      await expect(
        getAccountWithRetry('G-MOCK-PUBLIC-KEY', {
          operation: 'get_account',
          network: 'testnet',
          attemptCount: 1,
        })
      ).rejects.toThrow();

      expect(attemptCount).toBe(1);
    });
  });

  describe('Edge Cases', () => {
    it('should handle BAD_SEQUENCE error with retry', async () => {
      let attemptCount = 0;
      const badSequenceError = {
        code: 'BAD_SEQUENCE',
        message: 'Bad sequence number',
      };

      mockServer.sendTransaction = jest.fn()
        .mockImplementationOnce(() => {
          attemptCount++;
          return Promise.reject(badSequenceError);
        })
        .mockImplementationOnce(() => {
          attemptCount++;
          return Promise.resolve({
            hash: 'mock-hash',
            status: 'PENDING',
            latestLedger: 12345,
            latestLedgerCloseTime: 1234567890,
          });
        });

      const result = await service.submitPayment('G-DESTINATION', '10.0');

      expect(result.status).toBe('PENDING');
      expect(attemptCount).toBe(2);
    });

    it('should handle INSUFFICIENT_FUNDS error without retry', async () => {
      let attemptCount = 0;
      const insufficientFundsError = {
        code: 'INSUFFICIENT_FUNDS',
        message: 'Insufficient funds for transaction',
      };

      mockServer.sendTransaction = jest.fn().mockImplementation(() => {
        attemptCount++;
        return Promise.reject(insufficientFundsError);
      });

      await expect(service.submitPayment('G-DESTINATION', '10.0')).rejects.toThrow();

      // Should only attempt once (INSUFFICIENT_FUNDS is non-retryable)
      expect(attemptCount).toBe(1);
    });

    it('should handle timeout with retry and backoff', async () => {
      let attemptCount = 0;
      const timeoutError = new Error('Request timeout');
      timeoutError.name = 'AbortError';

      mockServer.sendTransaction = jest.fn()
        .mockImplementationOnce(() => {
          attemptCount++;
          return Promise.reject(timeoutError);
        })
        .mockImplementationOnce(() => {
          attemptCount++;
          return Promise.reject(timeoutError);
        })
        .mockImplementationOnce(() => {
          attemptCount++;
          return Promise.resolve({
            hash: 'mock-hash',
            status: 'PENDING',
            latestLedger: 12345,
            latestLedgerCloseTime: 1234567890,
          });
        });

      const result = await service.submitPayment('G-DESTINATION', '10.0');

      expect(result.status).toBe('PENDING');
      expect(attemptCount).toBe(3);
    });

    it('should handle DUPLICATE status from server', async () => {
      mockServer.sendTransaction = jest.fn().mockResolvedValue({
        hash: 'duplicate-hash',
        status: 'DUPLICATE',
        latestLedger: 12345,
        latestLedgerCloseTime: 1234567890,
      });

      await expect(service.submitPayment('G-DESTINATION', '10.0')).rejects.toThrow(
        'Transaction already submitted'
      );
    });

    it('should retry TRY_AGAIN_LATER status from server and eventually succeed', async () => {
      let attemptCount = 0;
      mockServer.sendTransaction = jest.fn()
        .mockImplementationOnce(() => {
          attemptCount++;
          return Promise.resolve({
            hash: 'rate-limited-hash',
            status: 'TRY_AGAIN_LATER',
            latestLedger: 12345,
            latestLedgerCloseTime: 1234567890,
          });
        })
        .mockImplementationOnce(() => {
          attemptCount++;
          return Promise.resolve({
            hash: 'success-after-rate-limit',
            status: 'PENDING',
            latestLedger: 12346,
            latestLedgerCloseTime: 1234567891,
          });
        });

      const result = await service.submitPayment('G-DESTINATION', '10.0');

      expect(result.hash).toBe('success-after-rate-limit');
      expect(attemptCount).toBe(2);
    });

    it('should classify TRY_AGAIN_LATER as rate limited after retry budget is exhausted', async () => {
      mockServer.sendTransaction = jest.fn().mockResolvedValue({
        hash: 'rate-limited-hash',
        status: 'TRY_AGAIN_LATER',
        latestLedger: 12345,
        latestLedgerCloseTime: 1234567890,
      });

      await expect(service.submitPayment('G-DESTINATION', '10.0')).rejects.toThrow(
        'Stellar network rate limit exceeded'
      );
      expect(mockServer.sendTransaction).toHaveBeenCalledTimes(3);
    });

    it('should classify terminal Stellar submission statuses as transaction failures', async () => {
      mockServer.sendTransaction = jest.fn().mockResolvedValue({
        hash: 'failed-hash',
        status: 'ERROR',
        latestLedger: 12345,
        latestLedgerCloseTime: 1234567890,
      });

      await expect(service.submitPayment('G-DESTINATION', '10.0')).rejects.toThrow(
        'Stellar transaction failed'
      );
      expect(mockServer.sendTransaction).toHaveBeenCalledTimes(1);
    });

    it('should handle Horizon result codes (tx_bad_seq)', async () => {
      let attemptCount = 0;
      const txBadSeqError = {
        status: 400,
        extras: {
          result_codes: {
            transaction: 'tx_bad_seq',
            operations: [],
          },
        },
      };

      mockServer.sendTransaction = jest.fn().mockImplementation(() => {
        attemptCount++;
        return Promise.reject(txBadSeqError);
      });

      await expect(service.submitPayment('G-DESTINATION', '10.0')).rejects.toThrow();

      // tx_bad_seq is a protocol error, should not retry
      expect(attemptCount).toBe(1);
    });

    it('should handle Horizon operation result codes (op_underfunded)', async () => {
      let attemptCount = 0;
      const opUnderfundedError = {
        status: 400,
        extras: {
          result_codes: {
            transaction: 'tx_success',
            operations: ['op_underfunded'],
          },
        },
      };

      mockServer.sendTransaction = jest.fn().mockImplementation(() => {
        attemptCount++;
        return Promise.reject(opUnderfundedError);
      });

      await expect(service.submitPayment('G-DESTINATION', '10.0')).rejects.toThrow();

      // op_underfunded is a protocol error, should not retry
      expect(attemptCount).toBe(1);
    });
  });

  describe('Private Helper Branches', () => {
    it('should classify unexpected transaction build failures without exposing raw messages', async () => {
      (StellarSdk.TransactionBuilder as unknown as jest.Mock).mockImplementationOnce(() => {
        throw new SyntaxError('raw parser secret');
      });

      await expect(service.submitPayment('G-DESTINATION', '10.0')).rejects.toThrow(
        'Invalid response from Stellar network'
      );
    });

    it('should map retryable Stellar failures to client-safe service unavailable errors', () => {
      const createAppErrorFromFailure = (service as any).createAppErrorFromFailure.bind(service);
      const timestamp = new Date().toISOString();

      for (const failureClass of [
        StellarRPCFailureClass.RATE_LIMIT,
        StellarRPCFailureClass.UPSTREAM_ERROR,
        StellarRPCFailureClass.NETWORK_ERROR,
      ]) {
        const result = createAppErrorFromFailure({
          class: failureClass,
          context: { operation: 'send_transaction' },
          originalError: { message: 'UPSTREAM_MESSAGE_REDACTED' },
          timestamp,
          shouldRetry: true,
        });

        expect(result.code).toBe('SERVICE_UNAVAILABLE');
        expect(result.message).not.toContain('secret');
      }
    });

    it('should map bad sequence to a client-safe bad request', () => {
      const createAppErrorFromFailure = (service as any).createAppErrorFromFailure.bind(service);
      const result = createAppErrorFromFailure({
        class: StellarRPCFailureClass.BAD_SEQUENCE,
        context: { operation: 'send_transaction' },
        originalError: { message: 'UPSTREAM_MESSAGE_REDACTED' },
        timestamp: new Date().toISOString(),
        shouldRetry: false,
      });

      expect(result.code).toBe('BAD_REQUEST');
      expect(result.message).toBe('Stellar sequence number invalid');
    });

    it('should expose maximum retry fallback errors from account and submission helpers', async () => {
      (service as any).maxRetries = 0;

      await expect(
        (service as any).getAccountWithRetry('G-MOCK-PUBLIC-KEY', { operation: 'get_account' })
      ).rejects.toThrow('Failed to retrieve Stellar account after maximum retries');

      await expect(
        (service as any).sendTransactionWithRetry(mockTransaction, { operation: 'send_transaction' })
      ).rejects.toThrow('Failed to submit Stellar transaction after maximum retries');
    });

    it('should use the real delay helper when not mocked', async () => {
      (service as any).delay.mockRestore();

      const pendingDelay = (service as any).delay(10);
      jest.advanceTimersByTime(10);

      await expect(pendingDelay).resolves.toBeUndefined();
    });
  });
});
