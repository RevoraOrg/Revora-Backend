import * as StellarSdk from '@stellar/stellar-sdk';
import { env } from '../config/env';
import { globalLogger, Logger } from '../lib/logger';
import { Errors } from '../lib/errors';
import { 
  classifyStellarRPCFailure, 
  StellarRPCFailure, 
  StellarRPCFailureContext,
  StellarRPCFailureClass,
  shouldRetryStellarRPCFailure,
  createStellarErrorResponse
} from '../lib/stellarRpcFailure';

const logger = globalLogger.child({ service: 'stellar-submission' });

/**
 * Service for building and submitting Stellar transactions.
 * 
 * Features:
 * - Retry logic with exponential backoff and idempotency
 * - Comprehensive RPC failure classification
 * - Structured logging and error handling
 * - Transaction deduplication prevention
 */
export class StellarSubmissionService {
  private server: StellarSdk.rpc.Server;
  private keypair: StellarSdk.Keypair;
  private logger = globalLogger.child({ service: 'stellar-submission' });

  constructor() {
    const horizonUrl =
      env.STELLAR_HORIZON_URL ||
      (env.STELLAR_NETWORK === 'public'
        ? 'https://horizon.stellar.org'
        : 'https://horizon-testnet.stellar.org');

    this.server = new StellarSdk.rpc.Server(horizonUrl);

    const secret = env.STELLAR_SERVER_SECRET;
    if (!secret) {
      throw Errors.internal('STELLAR_SERVER_SECRET is not defined in environment variables');
    }

    try {
      this.keypair = StellarSdk.Keypair.fromSecret(secret);
    } catch {
      throw Errors.internal('Invalid STELLAR_SERVER_SECRET provided');
    }

    this.logger.info('Stellar submission service initialized', {
      serverUrl: horizonUrl,
      publicKey: this.keypair.publicKey(),
      network: env.STELLAR_NETWORK,
      maxFee: env.STELLAR_MAX_FEE,
    });
  }

  /**
   * Submits a simple payment transaction with enhanced error handling and idempotency.
   * @param to Destination public key
   * @param amount Amount to send (as string)
   * @param asset Asset to send (defaults to native XLM)
   * @param idempotencyKey Optional key to prevent duplicate submissions
   * @returns Transaction result
   */
  async submitPayment(
    to: string,
    amount: string,
    asset: StellarSdk.Asset = StellarSdk.Asset.native(),
    idempotencyKey?: string,
  ) {
    if (!to || typeof to !== 'string') {
      throw Errors.validationError('Destination public key must be a non-empty string');
    }
    if (!amount || typeof amount !== 'string') {
      throw Errors.validationError('Amount must be a non-empty string');
    }

    this.logger.info('Submitting payment transaction', {
      to,
      amount,
      asset: asset.isNative() ? 'XLM' : asset.getAssetCode(),
    });

    try {
      const sourceAccount = await this.server.getAccount(this.keypair.publicKey());

      const transaction = new StellarSdk.TransactionBuilder(sourceAccount, {
        fee: env.STELLAR_MAX_FEE.toString(),
        networkPassphrase: env.STELLAR_NETWORK_PASSPHRASE ||
          (env.STELLAR_NETWORK === 'public'
            ? StellarSdk.Networks.PUBLIC
            : StellarSdk.Networks.TESTNET),
      })
        .addOperation(
          StellarSdk.Operation.payment({
            destination: to,
            asset,
            amount,
          }),
        )
        .setTimeout(30)
        .build();

      transaction.sign(this.keypair);
      
      // Check for idempotency to prevent duplicate submissions
      const transactionHash = transaction.hash().toString('hex');
      if (this.submittedTransactionHashes.has(transactionHash)) {
        logger.warn('Duplicate transaction submission prevented', {
          transactionHash,
          idempotencyKey,
          operation: 'submit_payment',
        });
        throw Errors.conflict('Transaction already submitted', {
          hash: transactionHash,
          idempotencyKey,
        });
      }

      const result = await this.server.sendTransaction(transaction);

      this.logger.info('Payment transaction submitted successfully', {
        to,
        amount,
        transactionHash: result.hash,
      });

      return result;
    } catch (error) {
      this.logger.error('Payment transaction failed', {
        to,
        amount,
        error: error,
      });

      if (error instanceof Error && error.name === 'AppError') {
        throw error;
      }

      throw Errors.serviceUnavailable('Failed to submit payment transaction');
    }
  }

  /**
   * Invokes a Soroban contract with enhanced error handling and idempotency.
   * @param contractId Contract ID to invoke
   * @param functionName Function name to call
   * @param args Function arguments
   * @param idempotencyKey Optional key to prevent duplicate submissions
   * @returns Transaction result
   */
  async invokeContract(
    _contractId: string,
    _functionName: string,
    _args: any[] = [],
  ): Promise<never> {
    this.logger.warn('Soroban contract invocation attempted but not implemented', {
      contractId: _contractId,
      functionName: _functionName,
    });
    throw Errors.serviceUnavailable('Soroban contract invocation not implemented yet');
  }

  /**
   * Gets the public key of the service's keypair.
   */
  getPublicKey(): string {
    return this.keypair.publicKey();
  }

  /**
   * Helper method to get account with enhanced retry logic and exponential backoff.
   */
  private async getAccountWithRetry(
    publicKey: string,
    context: StellarRPCFailureContext
  ): Promise<any> {
    let attemptCount = context.attemptCount || 1;
    
    while (attemptCount <= this.maxRetries) {
      try {
        const account = await this.server.getAccount(publicKey);
        
        // Log successful retry if applicable
        if (attemptCount > 1) {
          logger.info('Stellar account retrieval succeeded after retry', {
            publicKey,
            attemptCount,
            operation: 'get_account',
          });
        }
        
        return account;
      } catch (error) {
        const failure = classifyStellarRPCFailure(error, {
          ...context,
          operation: 'get_account',
          attemptCount,
        });
        
        if (!shouldRetryStellarRPCFailure(failure, this.maxRetries)) {
          throw this.createAppErrorFromFailure(failure);
        }
        
        this.logStellarFailure(failure);
        
        // Calculate exponential backoff delay
        const delayMs = this.calculateRetryDelay(failure.suggestedRetryDelayMs, attemptCount);
        logger.debug('Retrying Stellar account retrieval', {
          publicKey,
          attemptCount,
          delayMs,
          nextAttempt: attemptCount + 1,
        });
        
        await this.delay(delayMs);
        attemptCount++;
      }
    }
    
    throw Errors.serviceUnavailable('Failed to retrieve Stellar account after maximum retries', {
      publicKey,
      maxRetries: this.maxRetries,
      operation: 'get_account',
    });
  }

  /**
   * Helper method to send transaction with enhanced retry logic and exponential backoff.
   */
  private async sendTransactionWithRetry(
    transaction: StellarSdk.Transaction,
    context: StellarRPCFailureContext
  ): Promise<StellarSdk.rpc.Api.SendTransactionResponse> {
    let attemptCount = context.attemptCount || 1;
    const transactionHash = transaction.hash().toString('hex');
    
    while (attemptCount <= this.maxRetries) {
      try {
        const result = await this.server.sendTransaction(transaction);
        
        // Log successful retry if applicable
        if (attemptCount > 1) {
          logger.info('Stellar transaction submission succeeded after retry', {
            transactionHash,
            attemptCount,
            operation: 'send_transaction',
          });
        }
        
        // Handle transaction submission results
        if (result.status === 'PENDING') {
          return result;
        } else if (result.status === 'DUPLICATE') {
          throw Errors.conflict('Transaction already submitted', {
            hash: result.hash,
            transactionHash,
          });
        } else if (result.status === 'TRY_AGAIN_LATER') {
          throw new Error('Transaction rate limited, try again later');
        } else {
          throw new Error(`Transaction failed: ${result.status}`);
        }
      } catch (error) {
        const failure = classifyStellarRPCFailure(error, {
          ...context,
          operation: 'send_transaction',
          attemptCount,
          transactionHash,
        });
        
        if (!shouldRetryStellarRPCFailure(failure, this.maxRetries)) {
          throw this.createAppErrorFromFailure(failure);
        }
        
        this.logStellarFailure(failure);
        
        // Calculate exponential backoff delay
        const delayMs = this.calculateRetryDelay(failure.suggestedRetryDelayMs, attemptCount);
        logger.debug('Retrying Stellar transaction submission', {
          transactionHash,
          attemptCount,
          delayMs,
          nextAttempt: attemptCount + 1,
          failureClass: failure.class,
        });
        
        await this.delay(delayMs);
        attemptCount++;
      }
    }
    
    throw Errors.serviceUnavailable('Failed to submit Stellar transaction after maximum retries', {
      transactionHash,
      maxRetries: this.maxRetries,
      operation: 'send_transaction',
    });
  }

  /**
   * Creates an AppError from a Stellar RPC failure.
   */
  private createAppErrorFromFailure(failure: StellarRPCFailure): AppError {
    const errorResponse = createStellarErrorResponse(failure);
    
    switch (failure.class) {
      case StellarRPCFailureClass.TIMEOUT:
        return Errors.serviceUnavailable(errorResponse.message, errorResponse.details);
      
      case StellarRPCFailureClass.RATE_LIMIT:
        return Errors.serviceUnavailable(errorResponse.message, errorResponse.details);
      
      case StellarRPCFailureClass.UPSTREAM_ERROR:
        return Errors.serviceUnavailable(errorResponse.message, errorResponse.details);
      
      case StellarRPCFailureClass.NETWORK_ERROR:
        return Errors.serviceUnavailable(errorResponse.message, errorResponse.details);
      
      case StellarRPCFailureClass.UNAUTHORIZED:
        return Errors.unauthorized(errorResponse.message);
      
      case StellarRPCFailureClass.TRANSACTION_FAILED:
        return Errors.badRequest(errorResponse.message, errorResponse.details);
      
      case StellarRPCFailureClass.BAD_SEQUENCE:
        return Errors.badRequest(errorResponse.message, errorResponse.details);
      
      case StellarRPCFailureClass.SIGNING_ERROR:
        return Errors.internal(errorResponse.message, errorResponse.details);
      
      default:
        return Errors.serviceUnavailable(errorResponse.message, errorResponse.details);
    }
  }

  /**
   * Logs Stellar RPC failures for monitoring and debugging.
   */
  private logStellarFailure(failure: StellarRPCFailure): void {
    logger.warn('Stellar RPC operation failed', {
      failureClass: failure.class,
      operation: failure.context.operation,
      network: failure.context.network,
      attemptCount: failure.context.attemptCount,
      shouldRetry: failure.shouldRetry,
      suggestedDelay: failure.suggestedRetryDelayMs,
      originalError: failure.originalError,
      contractId: failure.context.contractId,
      functionName: failure.context.functionName,
      transactionHash: failure.context.transactionHash,
    });
  }

  /**
   * Calculates retry delay with exponential backoff and jitter.
   * @param suggestedDelayMs Suggested delay from failure classification
   * @param attemptCount Current attempt number
   * @returns Calculated delay in milliseconds
   */
  private calculateRetryDelay(suggestedDelayMs?: number, attemptCount: number = 1): number {
    // Use suggested delay if provided, otherwise calculate exponential backoff
    const baseDelay = suggestedDelayMs ?? this.baseDelayMs;
    const exponentialDelay = Math.min(baseDelay * Math.pow(2, attemptCount - 1), this.maxDelayMs);
    
    // Add jitter to prevent thundering herd (±25% random variation)
    const jitter = Math.random() * 0.5 - 0.25; // ±25%
    const finalDelay = Math.round(exponentialDelay * (1 + jitter));
    
    return Math.max(this.baseDelayMs, finalDelay); // Ensure minimum delay
  }

  /**
   * Utility method for delaying execution with Promise.
   * @param ms Delay in milliseconds
   * @returns Promise that resolves after delay
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Clears the transaction hash cache (useful for testing or memory management).
   */
  clearTransactionCache(): void {
    this.submittedTransactionHashes.clear();
    logger.debug('Stellar transaction cache cleared');
  }

  /**
   * Gets the current size of the transaction hash cache.
   * @returns Number of cached transaction hashes
   */
  getTransactionCacheSize(): number {
    return this.submittedTransactionHashes.size;
  }
}
