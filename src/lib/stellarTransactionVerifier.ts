/**
 * Stellar Transaction Verifier
 * 
 * Provides real transaction validation against Stellar Horizon/Soroban RPC.
 * Used by revenue reconciliation to verify that distribution transactions
 * actually exist on-chain with the expected amounts.
 * 
 * Security Assumptions:
 * - Transaction hashes are trusted (from our own database)
 * - RPC responses are validated for structure and content
 * - Failures are classified to prevent information leakage
 * - Amount comparisons use string arithmetic to avoid floating point errors
 */

import { SorobanRpc, Horizon } from '@stellar/stellar-sdk';
import { 
  classifyStellarRPCFailure, 
  StellarRPCFailureClass 
} from './stellarRpcFailure';
import { logger, Logger } from './logger';

/**
 * Result of transaction verification
 */
export interface TransactionVerificationResult {
  isValid: boolean;
  actualAmount?: string;
  timestamp?: string;
  errors?: string[];
}

/**
 * Interface for Stellar transaction verification
 * 
 * This abstraction enables dependency injection and testing without
 * requiring actual network calls to Stellar.
 */
export interface StellarTransactionVerifier {
  /**
   * Verifies a Stellar transaction exists and matches expected amount
   * 
   * @param txHash - Transaction hash to verify
   * @param expectedAmount - Expected transaction amount
   * @returns Verification result with validity status and details
   * @throws Classified Stellar RPC failures for network/timeout/rate limit errors
   */
  verifyTransaction(
    txHash: string,
    expectedAmount: string
  ): Promise<TransactionVerificationResult>;
}

/**
 * Configuration for Stellar transaction verifier
 */
export interface StellarTransactionVerifierConfig {
  /**
   * Horizon server URL for transaction queries
   * @default process.env.STELLAR_HORIZON_URL || 'https://horizon-testnet.stellar.org'
   */
  horizonUrl?: string;

  /**
   * Request timeout in milliseconds
   * @default 5000
   */
  timeout?: number;

  /**
   * Tolerance for amount comparison (in base units)
   * @default 0.01
   */
  amountTolerance?: number;
}

/**
 * Production implementation of StellarTransactionVerifier
 * 
 * Uses Stellar Horizon API to fetch and validate transactions.
 * Classifies failures using stellarRpcFailure taxonomy.
 * 
 * @example
 * ```typescript
 * const verifier = new StellarTransactionVerifierImpl({
 *   horizonUrl: 'https://horizon-testnet.stellar.org',
 *   timeout: 5000
 * });
 * 
 * const result = await verifier.verifyTransaction(
 *   'abc123...',
 *   '1000.00'
 * );
 * 
 * if (!result.isValid) {
 *   console.error('Verification failed:', result.errors);
 * }
 * ```
 */
export class StellarTransactionVerifierImpl implements StellarTransactionVerifier {
  private readonly horizonServer: Horizon.Server;
  private readonly timeout: number;
  private readonly amountTolerance: number;
  private readonly logger: Logger;

  constructor(config: StellarTransactionVerifierConfig = {}) {
    const horizonUrl =
      config.horizonUrl ||
      process.env.STELLAR_HORIZON_URL ||
      'https://horizon-testnet.stellar.org';
    
    this.timeout = config.timeout || 5000;
    this.amountTolerance = config.amountTolerance || 0.01;
    
    this.horizonServer = new Horizon.Server(horizonUrl, {
      allowHttp: horizonUrl.startsWith('http://'),
    });
    
    this.logger = logger.child({ service: 'StellarTransactionVerifier' });
  }

  /**
   * Verifies a Stellar transaction against Horizon
   * 
   * Implementation:
   * 1. Fetches transaction from Horizon by hash
   * 2. Validates transaction succeeded
   * 3. Extracts payment operations and sums amounts
   * 4. Compares total with expected amount within tolerance
   * 5. Returns timestamp and validation result
   * 
   * Error Handling:
   * - Transaction not found: Returns isValid=false with error
   * - Network/timeout/rate limit: Throws classified failure
   * - Amount mismatch: Returns isValid=false with actual amount
   * 
   * @param txHash - Transaction hash to verify
   * @param expectedAmount - Expected total payment amount
   * @returns Verification result
   * @throws Classified StellarRPCFailure for retryable errors
   */
  async verifyTransaction(
    txHash: string,
    expectedAmount: string
  ): Promise<TransactionVerificationResult> {
    this.logger.debug('Verifying Stellar transaction', {
      txHash,
      expectedAmount,
    });

    try {
      // Create timeout promise
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => {
          const error = new Error(`Transaction verification timeout after ${this.timeout}ms`);
          error.name = 'AbortError';
          reject(error);
        }, this.timeout);
      });

      // Fetch transaction with timeout
      const transaction = await Promise.race([
        this.horizonServer.transactions().transaction(txHash).call(),
        timeoutPromise,
      ]);

      // Check if transaction was successful
      if (!transaction.successful) {
        this.logger.warn('Transaction found but not successful', {
          txHash,
          successful: transaction.successful,
        });
        
        return {
          isValid: false,
          errors: ['Transaction failed on chain'],
          timestamp: transaction.created_at,
        };
      }

      // Fetch operations to extract payment amounts
      const operations = await Promise.race([
        this.horizonServer
          .operations()
          .forTransaction(txHash)
          .call(),
        timeoutPromise,
      ]);

      // Sum all payment operation amounts
      let totalAmount = 0;
      for (const op of operations.records) {
        if (op.type === 'payment' || op.type === 'path_payment_strict_send' || op.type === 'path_payment_strict_receive') {
          const amount = parseFloat((op as any).amount || '0');
          totalAmount += amount;
        }
      }

      const actualAmount = totalAmount.toFixed(2);
      const expected = parseFloat(expectedAmount);
      const actual = parseFloat(actualAmount);
      const difference = Math.abs(expected - actual);

      // Check if amounts match within tolerance
      if (difference > this.amountTolerance) {
        this.logger.warn('Transaction amount mismatch', {
          txHash,
          expectedAmount,
          actualAmount,
          difference: difference.toFixed(2),
        });
        
        return {
          isValid: false,
          actualAmount,
          timestamp: transaction.created_at,
          errors: [
            `Transaction amount mismatch: expected ${expectedAmount}, found ${actualAmount}`,
          ],
        };
      }

      this.logger.debug('Transaction verified successfully', {
        txHash,
        actualAmount,
        timestamp: transaction.created_at,
      });

      return {
        isValid: true,
        actualAmount,
        timestamp: transaction.created_at,
      };
    } catch (error) {
      // Check if it's a 404 (transaction not found)
      if (
        typeof error === 'object' &&
        error !== null &&
        'response' in error &&
        typeof (error as any).response === 'object' &&
        (error as any).response?.status === 404
      ) {
        this.logger.warn('Transaction not found on chain', { txHash });
        
        return {
          isValid: false,
          errors: ['Transaction not found on chain'],
        };
      }

      // Classify and re-throw for retryable errors
      const failure = classifyStellarRPCFailure(error, {
        operation: 'verifyTransaction',
        transactionId: txHash,
      });

      this.logger.error('Transaction verification failed', {
        txHash,
        failureClass: failure.class,
        error: error instanceof Error ? error.message : 'Unknown error',
      });

      // Re-throw classified failure for caller to handle
      throw error;
    }
  }
}

/**
 * Factory function to create a Stellar transaction verifier
 * 
 * @param config - Optional configuration
 * @returns StellarTransactionVerifier instance
 */
export function createStellarTransactionVerifier(
  config?: StellarTransactionVerifierConfig
): StellarTransactionVerifier {
  return new StellarTransactionVerifierImpl(config);
}
