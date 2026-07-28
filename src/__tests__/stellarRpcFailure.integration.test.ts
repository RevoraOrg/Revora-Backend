/**
 * Integration Tests for Stellar RPC Failure Taxonomy
 * 
 * These tests verify the end-to-end behavior of the RPC failure classification
 * system in realistic scenarios. They test the integration between services,
 * error handling, logging, and client responses.
 */

import { StellarSubmissionService } from '../services/stellarSubmissionService';
import { StellarRPCFailureClass } from '../lib/stellarRpcFailure';
import { AppError } from '../lib/errors';
import { globalLogger as logger } from '../lib/logger';

// Mock external dependencies
jest.mock('@stellar/stellar-sdk', () => {
  const mockServer = {
    getAccount: jest.fn(),
    sendTransaction: jest.fn(),
  };
  
  return {
    rpc: {
      Server: jest.fn(() => mockServer),
    },
    Keypair: {
      fromSecret: jest.fn(() => ({
        publicKey: () => 'G-INTEGRATION-TEST-KEY',
        sign: jest.fn(),
      })),
    },
    Asset: {
      native: jest.fn(() => ({ code: 'XLM', issuer: undefined })),
    },
    TransactionBuilder: jest.fn(() => ({
      addOperation: jest.fn().mockReturnThis(),
      setTimeout: jest.fn().mockReturnThis(),
      build: jest.fn().mockReturnThis(),
      sign: jest.fn(),
    })),
    Operation: {
      payment: jest.fn(),
      invokeContractFunction: jest.fn(),
    },
    BASE_FEE: '100',
    Networks: {
      TESTNET: 'Test SDF Network ; September 2015',
      PUBLIC: 'Public Global Stellar Network ; October 2015',
    },
  };
});

jest.mock('../lib/logger', () => ({
  globalLogger: {
    child: jest.fn().mockReturnThis(),
    warn: jest.fn(),
    info: jest.fn(),
    error: jest.fn(),
  },
}));

jest.mock('../config/env', () => ({
  env: {
    STELLAR_NETWORK: 'testnet',
    STELLAR_NETWORK_PASSPHRASE: 'Test SDF Network ; September 2015',
  },
}));

describe('Stellar RPC Failure Integration Tests', () => {
  let service: StellarSubmissionService;
  let mockServer: any;

  beforeEach(() => {
    process.env.STELLAR_SERVER_SECRET = 'SABERIntegrationTestSecretKey1234567890ABCDEF';
    jest.clearAllMocks();
    
    service = new StellarSubmissionService();
    const StellarSdk = require('@stellar/stellar-sdk');
    mockServer = StellarSdk.rpc.Server();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('End-to-End Error Classification', () => {
    it('should handle complete timeout scenario with retries and logging', async () => {
      jest.useFakeTimers();
      
      // Simulate network timeout
      const timeoutError = new Error('Network request timed out');
      timeoutError.name = 'AbortError';
      
      mockServer.sendTransaction
        .mockRejectedValueOnce(timeoutError)
        .mockRejectedValueOnce(timeoutError)
        .mockRejectedValueOnce(timeoutError); // All attempts fail

      mockServer.getAccount.mockResolvedValue({
        accountId: () => 'G-INTEGRATION-TEST-KEY',
        sequenceNumber: () => '1',
        incrementSequenceNumber: jest.fn(),
      });

      const promise = service.submitPayment('G-DESTINATION-KEY', '10.0');
      
      // Execute all retry attempts
      for (let i = 0; i < 3; i++) {
        jest.advanceTimersByTime(Math.min(1000 * Math.pow(2, i), 30000));
        await Promise.resolve();
      }

      const result = await promise.catch(err => err);

      // Verify final error
      expect(result).toBeInstanceOf(AppError);
      expect(result.code).toBe('SERVICE_UNAVAILABLE');
      expect(result.message).toBe('Stellar network request timed out');

      // Verify logging occurred for each attempt
      expect(logger.warn).toHaveBeenCalledTimes(3);
      
      // Verify retry escalation
      const logCalls = (logger.warn as jest.Mock).mock.calls;
      expect(logCalls[0][1].attemptCount).toBe(1);
      expect(logCalls[1][1].attemptCount).toBe(2);
      expect(logCalls[2][1].attemptCount).toBe(3);
      
      // Verify retry delay escalation
      expect(logCalls[0][1].suggestedDelay).toBe(1000);
      expect(logCalls[1][1].suggestedDelay).toBe(2000);
      expect(logCalls[2][1].suggestedDelay).toBe(4000);
    });

    it('should handle rate limiting with exponential backoff', async () => {
      jest.useFakeTimers();
      
      const rateLimitError = { 
        status: 429, 
        response: { headers: { 'retry-after': '30' } } 
      };
      
      mockServer.sendTransaction
        .mockRejectedValueOnce(rateLimitError)
        .mockRejectedValueOnce(rateLimitError)
        .mockResolvedValueOnce({
          hash: 'success-after-rate-limit',
          status: 'PENDING',
          latestLedger: 12345,
          latestLedgerCloseTime: 1234567890,
        });

      mockServer.getAccount.mockResolvedValue({
        accountId: () => 'G-INTEGRATION-TEST-KEY',
        sequenceNumber: () => '1',
        incrementSequenceNumber: jest.fn(),
      });

      const promise = service.submitPayment('G-DESTINATION-KEY', '5.0');
      
      // First retry after 30 seconds (from retry-after header)
      jest.advanceTimersByTime(30000);
      await Promise.resolve();
      
      // Second retry after another 30 seconds
      jest.advanceTimersByTime(30000);
      await Promise.resolve();

      const result = await promise;
      
      expect(result.hash).toBe('success-after-rate-limit');
      expect(logger.warn).toHaveBeenCalledTimes(2);
      
      // Verify rate limit specific logging
      const logCalls = (logger.warn as jest.Mock).mock.calls;
      expect(logCalls[0][1].failureClass).toBe('RATE_LIMIT');
      expect(logCalls[0][1].suggestedDelay).toBe(30000);
    });

    it('should handle contract invocation with comprehensive error context', async () => {
      const contractError = { 
        code: 'CONTRACT_ERROR',
        message: 'Contract execution failed: insufficient balance',
        result_xdr: 'AAAAAgAAAAEAAAAAbw==' // Contains contract error indicator
      };
      
      mockServer.sendTransaction.mockRejectedValue(contractError);
      mockServer.getAccount.mockResolvedValue({
        accountId: () => 'G-INTEGRATION-TEST-KEY',
        sequenceNumber: () => '1',
        incrementSequenceNumber: jest.fn(),
      });

      const result = await service.invokeContract('CONTRACT-ID-123', 'transfer', ['recipient', '100'])
        .catch(err => err);

      expect(result).toBeInstanceOf(AppError);
      expect(result.code).toBe('BAD_REQUEST');
      expect(result.message).toBe('Contract execution failed');
      expect(result.details).toEqual({
        contractId: 'CONTRACT-ID-123',
        functionName: 'transfer',
        args: ['recipient', '100'],
      });

      // Verify comprehensive logging context
      expect(logger.warn).toHaveBeenCalledWith(
        'Stellar RPC operation failed',
        expect.objectContaining({
          failureClass: 'CONTRACT_ERROR',
          operation: 'invoke_contract',
          contractId: 'CONTRACT-ID-123',
          functionName: 'transfer',
          network: 'testnet',
          attemptCount: 1,
          shouldRetry: false,
        })
      );
    });

    it('should handle insufficient funds with immediate failure', async () => {
      const insufficientFundsError = { 
        code: 'INSUFFICIENT_FUNDS',
        message: 'Account has insufficient balance for this operation'
      };
      
      mockServer.sendTransaction.mockRejectedValue(insufficientFundsError);
      mockServer.getAccount.mockResolvedValue({
        accountId: () => 'G-INTEGRATION-TEST-KEY',
        sequenceNumber: () => '1',
        incrementSequenceNumber: jest.fn(),
      });

      const result = await service.submitPayment('G-DESTINATION-KEY', '999999.0')
        .catch(err => err);

      expect(result).toBeInstanceOf(AppError);
      expect(result.code).toBe('BAD_REQUEST');
      expect(result.message).toBe('Insufficient funds for payment');
      expect(result.details).toEqual({
        operation: 'submit_payment',
        amount: '999999.0',
        asset: 'XLM',
      });

      // Verify no retry attempts for insufficient funds
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(mockServer.sendTransaction).toHaveBeenCalledTimes(1);
    });

    it('should handle sequence number errors with single retry', async () => {
      jest.useFakeTimers();
      
      const badSequenceError = { 
        code: 'BAD_SEQUENCE',
        message: 'Bad sequence number, expected 2 but got 1'
      };
      
      mockServer.sendTransaction
        .mockRejectedValueOnce(badSequenceError)
        .mockResolvedValueOnce({
          hash: 'success-after-sequence-fix',
          status: 'PENDING',
          latestLedger: 12345,
          latestLedgerCloseTime: 1234567890,
        });

      mockServer.getAccount.mockResolvedValue({
        accountId: () => 'G-INTEGRATION-TEST-KEY',
        sequenceNumber: () => '1',
        incrementSequenceNumber: jest.fn(),
      });

      const promise = service.submitPayment('G-DESTINATION-KEY', '1.0');
      
      // Retry after 1 second for sequence error
      jest.advanceTimersByTime(1000);
      await Promise.resolve();

      const result = await promise;
      
      expect(result.hash).toBe('success-after-sequence-fix');
      expect(logger.warn).toHaveBeenCalledTimes(1);
      
      // Verify sequence error specific handling
      const logCall = (logger.warn as jest.Mock).mock.calls[0];
      expect(logCall[1].failureClass).toBe('BAD_SEQUENCE');
      expect(logCall[1].shouldRetry).toBe(true);
      expect(logCall[1].suggestedDelay).toBe(1000);
    });
  });

  describe('Security and Data Sanitization', () => {
    it('should sanitize sensitive error information in logs', async () => {
      const sensitiveError = {
        status: 500,
        message: 'Internal server error',
        stack: 'Error: Internal server error\n    at server.js:123:45',
        headers: {
          'authorization': 'Bearer secret-token-123',
          'x-api-key': 'secret-api-key-456',
        },
        config: {
          url: 'https://horizon.stellar.org/transactions',
          headers: {
            'authorization': 'Bearer secret-token-123',
          },
        },
        sensitive: 'This should not be logged',
        password: 'super-secret',
      };
      
      mockServer.sendTransaction.mockRejectedValue(sensitiveError);
      mockServer.getAccount.mockResolvedValue({
        accountId: () => 'G-INTEGRATION-TEST-KEY',
        sequenceNumber: () => '1',
        incrementSequenceNumber: jest.fn(),
      });

      await service.submitPayment('G-DESTINATION-KEY', '1.0')
        .catch(err => err);

      const logCall = (logger.warn as jest.Mock).mock.calls[0];
      const loggedError = logCall[1].originalError;
      
      // Verify allowed fields are present
      expect(loggedError.status).toBe(500);
      expect(loggedError.message).toBe('Internal server error');
      expect(loggedError.stack).toBeDefined(); // Stack traces allowed in development
      
      // Verify sensitive fields are removed
      expect(loggedError.headers).toBeUndefined();
      expect(loggedError.config).toBeUndefined();
      expect(loggedError.sensitive).toBeUndefined();
      expect(loggedError.password).toBeUndefined();
    });

    it('should prevent raw upstream error messages in client responses', async () => {
      const rawError = {
        status: 500,
        message: 'Database connection failed: postgresql://user:pass@localhost/db',
        stack: 'Detailed stack trace with internal paths',
        internal: 'Internal system details',
      };
      
      mockServer.sendTransaction.mockRejectedValue(rawError);
      mockServer.getAccount.mockResolvedValue({
        accountId: () => 'G-INTEGRATION-TEST-KEY',
        sequenceNumber: () => '1',
        incrementSequenceNumber: jest.fn(),
      });

      const result = await service.submitPayment('G-DESTINATION-KEY', '1.0')
        .catch(err => err);

      expect(result).toBeInstanceOf(AppError);
      expect(result.message).toBe('Stellar network temporarily unavailable');
      expect(result.details).toEqual({
        operation: 'submit_payment',
        retryable: true,
        retryDelayMs: expect.any(Number),
        failureClass: 'UPSTREAM_ERROR',
      });
      
      // Verify raw error details are not exposed
      expect(result.message).not.toContain('Database connection failed');
      expect(result.message).not.toContain('postgresql://');
      expect(result.details).not.toHaveProperty('internal');
    });
  });

  describe('Performance and Reliability', () => {
    it('should handle concurrent requests with independent retry logic', async () => {
      jest.useFakeTimers();
      
      const timeoutError = new Error('Request timeout');
      timeoutError.name = 'AbortError';
      
      mockServer.sendTransaction.mockRejectedValue(timeoutError);
      mockServer.getAccount.mockResolvedValue({
        accountId: () => 'G-INTEGRATION-TEST-KEY',
        sequenceNumber: () => '1',
        incrementSequenceNumber: jest.fn(),
      });

      // Start 3 concurrent requests
      const promises = [
        service.submitPayment('G-DEST-1', '1.0'),
        service.submitPayment('G-DEST-2', '2.0'),
        service.submitPayment('G-DEST-3', '3.0'),
      ];

      // Advance time to trigger retries
      jest.advanceTimersByTime(1000);
      await Promise.resolve();
      jest.advanceTimersByTime(2000);
      await Promise.resolve();
      jest.advanceTimersByTime(4000);
      await Promise.resolve();

      const results = await Promise.allSettled(promises);
      
      // All should fail with service unavailable
      results.forEach(result => {
        expect(result.status).toBe('rejected');
        if (result.status === 'rejected') {
          expect(result.reason).toBeInstanceOf(AppError);
          expect(result.reason.code).toBe('SERVICE_UNAVAILABLE');
        }
      });

      // Each request should have its own logging context
      expect(logger.warn).toHaveBeenCalledTimes(9); // 3 requests × 3 attempts each
    });

    it('should maintain operation context through retry chains', async () => {
      jest.useFakeTimers();
      
      const networkError = new Error('Connection refused');
      networkError.name = 'NetworkError';
      
      mockServer.sendTransaction
        .mockRejectedValueOnce(networkError)
        .mockResolvedValueOnce({
          hash: 'success-after-network-retry',
          status: 'PENDING',
          latestLedger: 12345,
          latestLedgerCloseTime: 1234567890,
        });

      mockServer.getAccount.mockResolvedValue({
        accountId: () => 'G-INTEGRATION-TEST-KEY',
        sequenceNumber: () => '1',
        incrementSequenceNumber: jest.fn(),
      });

      const promise = service.submitPayment('G-DESTINATION-KEY', '10.0');
      
      // Retry after network error
      jest.advanceTimersByTime(2000);
      await Promise.resolve();

      const result = await promise;
      
      expect(result.hash).toBe('success-after-network-retry');
      
      // Verify context preservation across retries
      expect(logger.warn).toHaveBeenCalledTimes(1);
      const logCall = (logger.warn as jest.Mock).mock.calls[0];
      expect(logCall[1]).toMatchObject({
        failureClass: 'NETWORK_ERROR',
        operation: 'submit_payment',
        network: 'testnet',
        attemptCount: 1,
        shouldRetry: true,
        transactionHash: expect.any(String),
      });
    });
  });

  describe('Edge Cases and Invariants', () => {
    it('should handle malformed error responses gracefully', async () => {
      const malformedError = {
        // Missing required fields
        message: undefined,
        status: 'not-a-number',
        code: null,
      };
      
      mockServer.sendTransaction.mockRejectedValue(malformedError);
      mockServer.getAccount.mockResolvedValue({
        accountId: () => 'G-INTEGRATION-TEST-KEY',
        sequenceNumber: () => '1',
        incrementSequenceNumber: jest.fn(),
      });

      const result = await service.submitPayment('G-DESTINATION-KEY', '1.0')
        .catch(err => err);

      expect(result).toBeInstanceOf(AppError);
      expect(result.code).toBe('SERVICE_UNAVAILABLE');
      expect(result.message).toBe('Unknown Stellar network error');
    });

    it('should handle circular error objects safely', async () => {
      const circularError: any = { message: 'Circular error' };
      circularError.self = circularError; // Create circular reference
      
      mockServer.sendTransaction.mockRejectedValue(circularError);
      mockServer.getAccount.mockResolvedValue({
        accountId: () => 'G-INTEGRATION-TEST-KEY',
        sequenceNumber: () => '1',
        incrementSequenceNumber: jest.fn(),
      });

      // Should not throw due to circular reference
      await expect(service.submitPayment('G-DESTINATION-KEY', '1.0')).rejects.toBeInstanceOf(AppError);
    });

    it('should handle very long error messages', async () => {
      const longMessage = 'x'.repeat(10000); // 10KB message
      const longError = { message: longMessage, status: 500 };
      
      mockServer.sendTransaction.mockRejectedValue(longError);
      mockServer.getAccount.mockResolvedValue({
        accountId: () => 'G-INTEGRATION-TEST-KEY',
        sequenceNumber: () => '1',
        incrementSequenceNumber: jest.fn(),
      });

      const result = await service.submitPayment('G-DESTINATION-KEY', '1.0')
        .catch(err => err);

      expect(result).toBeInstanceOf(AppError);
      
      // Verify error message is sanitized but not the long message itself
      expect(result.message).toBe('Stellar network temporarily unavailable');
      
      // Verify logs keep a stable shape without exposing the upstream string
      const logCall = (logger.warn as jest.Mock).mock.calls[0];
      expect(logCall[1].originalError.message).toBe('UPSTREAM_MESSAGE_REDACTED');
      expect(JSON.stringify(logCall[1].originalError)).not.toContain(longMessage);
    });
  });
});
