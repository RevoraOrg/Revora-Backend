/**
 * Tests for Stellar Transaction Verifier
 */

import { 
  StellarTransactionVerifierImpl,
  StellarTransactionVerifier,
  TransactionVerificationResult 
} from './stellarTransactionVerifier';
import { Horizon } from '@stellar/stellar-sdk';
import { logger } from './logger';

jest.mock('./logger', () => {
  const mockLoggerInstance = {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: jest.fn().mockReturnThis(),
  };
  
  return {
    logger: {
      child: jest.fn().mockReturnValue(mockLoggerInstance),
      info: jest.fn(),
      debug: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    },
    Logger: jest.fn().mockImplementation(() => mockLoggerInstance),
    LogLevel: {
      EMERGENCY: 0,
      ALERT: 1,
      CRITICAL: 2,
      ERROR: 3,
      WARN: 4,
      INFO: 5,
      DEBUG: 6,
      TRACE: 7,
    },
  };
});

describe('StellarTransactionVerifierImpl', () => {
  let verifier: StellarTransactionVerifier;
  let mockHorizonServer: jest.Mocked<Horizon.Server>;

  const txHash = 'abc123def456';
  const expectedAmount = '1000.00';

  beforeEach(() => {
    jest.clearAllMocks();
    
    // Mock Horizon.Server
    mockHorizonServer = {
      transactions: jest.fn().mockReturnThis(),
      operations: jest.fn().mockReturnThis(),
      forTransaction: jest.fn().mockReturnThis(),
      transaction: jest.fn().mockReturnThis(),
      call: jest.fn(),
    } as any;

    // Create verifier with mocked server
    verifier = new StellarTransactionVerifierImpl({
      horizonUrl: 'https://horizon-testnet.stellar.org',
      timeout: 5000,
      amountTolerance: 0.01,
    });

    // Replace the internal server with our mock
    (verifier as any).horizonServer = mockHorizonServer;
  });

  describe('verifyTransaction', () => {
    it('should successfully verify a valid transaction', async () => {
      const mockTransaction = {
        successful: true,
        created_at: '2023-01-15T10:00:00Z',
        hash: txHash,
      };

      const mockOperations = {
        records: [
          { type: 'payment', amount: '500.00' },
          { type: 'payment', amount: '500.00' },
        ],
      };

      mockHorizonServer.call
        .mockResolvedValueOnce(mockTransaction)
        .mockResolvedValueOnce(mockOperations);

      const result = await verifier.verifyTransaction(txHash, expectedAmount);

      expect(result.isValid).toBe(true);
      expect(result.actualAmount).toBe('1000.00');
      expect(result.timestamp).toBe('2023-01-15T10:00:00Z');
      expect(result.errors).toBeUndefined();
    });

    it('should detect amount mismatch', async () => {
      const mockTransaction = {
        successful: true,
        created_at: '2023-01-15T10:00:00Z',
        hash: txHash,
      };

      const mockOperations = {
        records: [
          { type: 'payment', amount: '450.00' },
          { type: 'payment', amount: '450.00' },
        ],
      };

      mockHorizonServer.call
        .mockResolvedValueOnce(mockTransaction)
        .mockResolvedValueOnce(mockOperations);

      const result = await verifier.verifyTransaction(txHash, expectedAmount);

      expect(result.isValid).toBe(false);
      expect(result.actualAmount).toBe('900.00');
      expect(result.errors).toContain(
        'Transaction amount mismatch: expected 1000.00, found 900.00'
      );
    });

    it('should handle transaction not found (404)', async () => {
      const notFoundError = {
        response: { status: 404 },
      };

      mockHorizonServer.call.mockRejectedValueOnce(notFoundError);

      const result = await verifier.verifyTransaction(txHash, expectedAmount);

      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('Transaction not found on chain');
    });

    it('should handle failed transaction', async () => {
      const mockTransaction = {
        successful: false,
        created_at: '2023-01-15T10:00:00Z',
        hash: txHash,
      };

      mockHorizonServer.call.mockResolvedValueOnce(mockTransaction);

      const result = await verifier.verifyTransaction(txHash, expectedAmount);

      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('Transaction failed on chain');
      expect(result.timestamp).toBe('2023-01-15T10:00:00Z');
    });

    it('should handle timeout errors', async () => {
      const timeoutError = new Error('Request timeout');
      timeoutError.name = 'AbortError';

      mockHorizonServer.call.mockRejectedValueOnce(timeoutError);

      await expect(
        verifier.verifyTransaction(txHash, expectedAmount)
      ).rejects.toThrow();
    });

    it('should handle rate limit errors', async () => {
      const rateLimitError = new Error('Rate limit exceeded');
      (rateLimitError as any).response = { status: 429 };

      mockHorizonServer.call.mockRejectedValueOnce(rateLimitError);

      await expect(
        verifier.verifyTransaction(txHash, expectedAmount)
      ).rejects.toThrow();
    });

    it('should sum multiple payment operations', async () => {
      const mockTransaction = {
        successful: true,
        created_at: '2023-01-15T10:00:00Z',
        hash: txHash,
      };

      const mockOperations = {
        records: [
          { type: 'payment', amount: '250.00' },
          { type: 'payment', amount: '250.00' },
          { type: 'payment', amount: '250.00' },
          { type: 'payment', amount: '250.00' },
        ],
      };

      mockHorizonServer.call
        .mockResolvedValueOnce(mockTransaction)
        .mockResolvedValueOnce(mockOperations);

      const result = await verifier.verifyTransaction(txHash, expectedAmount);

      expect(result.isValid).toBe(true);
      expect(result.actualAmount).toBe('1000.00');
    });

    it('should handle path payment operations', async () => {
      const mockTransaction = {
        successful: true,
        created_at: '2023-01-15T10:00:00Z',
        hash: txHash,
      };

      const mockOperations = {
        records: [
          { type: 'path_payment_strict_send', amount: '500.00' },
          { type: 'path_payment_strict_receive', amount: '500.00' },
        ],
      };

      mockHorizonServer.call
        .mockResolvedValueOnce(mockTransaction)
        .mockResolvedValueOnce(mockOperations);

      const result = await verifier.verifyTransaction(txHash, expectedAmount);

      expect(result.isValid).toBe(true);
      expect(result.actualAmount).toBe('1000.00');
    });

    it('should ignore non-payment operations', async () => {
      const mockTransaction = {
        successful: true,
        created_at: '2023-01-15T10:00:00Z',
        hash: txHash,
      };

      const mockOperations = {
        records: [
          { type: 'payment', amount: '1000.00' },
          { type: 'create_account', amount: '100.00' },
          { type: 'manage_data', amount: '50.00' },
        ],
      };

      mockHorizonServer.call
        .mockResolvedValueOnce(mockTransaction)
        .mockResolvedValueOnce(mockOperations);

      const result = await verifier.verifyTransaction(txHash, expectedAmount);

      expect(result.isValid).toBe(true);
      expect(result.actualAmount).toBe('1000.00');
    });

    it('should accept amounts within tolerance', async () => {
      const mockTransaction = {
        successful: true,
        created_at: '2023-01-15T10:00:00Z',
        hash: txHash,
      };

      const mockOperations = {
        records: [
          { type: 'payment', amount: '1000.005' }, // Within 0.01 tolerance
        ],
      };

      mockHorizonServer.call
        .mockResolvedValueOnce(mockTransaction)
        .mockResolvedValueOnce(mockOperations);

      const result = await verifier.verifyTransaction(txHash, expectedAmount);

      expect(result.isValid).toBe(true);
    });

    it('should reject amounts outside tolerance', async () => {
      const mockTransaction = {
        successful: true,
        created_at: '2023-01-15T10:00:00Z',
        hash: txHash,
      };

      const mockOperations = {
        records: [
          { type: 'payment', amount: '1000.02' }, // Outside 0.01 tolerance
        ],
      };

      mockHorizonServer.call
        .mockResolvedValueOnce(mockTransaction)
        .mockResolvedValueOnce(mockOperations);

      const result = await verifier.verifyTransaction(txHash, expectedAmount);

      expect(result.isValid).toBe(false);
      expect(result.errors).toBeDefined();
    });

    it('should handle network errors', async () => {
      const networkError = new Error('Network connection failed');
      networkError.name = 'NetworkError';

      mockHorizonServer.call.mockRejectedValueOnce(networkError);

      await expect(
        verifier.verifyTransaction(txHash, expectedAmount)
      ).rejects.toThrow();
    });

    it('should handle transactions with no payment operations', async () => {
      const mockTransaction = {
        successful: true,
        created_at: '2023-01-15T10:00:00Z',
        hash: txHash,
      };

      const mockOperations = {
        records: [
          { type: 'create_account', amount: '100.00' },
          { type: 'manage_data', amount: '50.00' },
        ],
      };

      mockHorizonServer.call
        .mockResolvedValueOnce(mockTransaction)
        .mockResolvedValueOnce(mockOperations);

      const result = await verifier.verifyTransaction(txHash, '0.00');

      expect(result.isValid).toBe(true);
      expect(result.actualAmount).toBe('0.00');
    });
  });
});
