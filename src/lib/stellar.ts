/**
 * Stellar Horizon Client Wrapper (Read-Only)
 * 
 * Provides read-only access to Stellar Horizon API for fetching account info,
 * balances, and transaction history. No signing capabilities.
 */

import { env } from '../config/env';
import { globalLogger } from './logger';
import { Errors } from './errors';
import { classifyStellarRPCFailure } from './stellarRpcFailure';

export interface StellarAccount {
  account_id: string;
  sequence: string;
  subentry_count: number;
  last_modified_ledger: number;
  thresholds: {
    low_threshold: number;
    med_threshold: number;
    high_threshold: number;
  };
  flags: {
    auth_required: boolean;
    auth_revocable: boolean;
    auth_immutable: boolean;
    auth_clawback_enabled: boolean;
  };
  balances: StellarBalance[];
  signers: Array<{
    key: string;
    weight: number;
    type: string;
  }>;
  data: Record<string, string>;
  num_sponsoring: number;
  num_sponsored: number;
  sponsor?: string;
  paging_token?: string;
}

export interface StellarBalance {
  balance: string;
  limit?: string;
  buying_liabilities?: string;
  selling_liabilities?: string;
  asset_type: 'native' | 'credit_alphanum4' | 'credit_alphanum12';
  asset_code?: string;
  asset_issuer?: string;
  last_modified_ledger?: number;
  is_authorized?: boolean;
  is_authorized_to_maintain_liabilities?: boolean;
  is_clawback_enabled?: boolean;
}

export interface StellarTransaction {
  id: string;
  paging_token: string;
  successful: boolean;
  hash: string;
  ledger: number;
  created_at: string;
  source_account: string;
  source_account_sequence: string;
  fee_account?: string;
  fee_charged: string;
  operation_count: number;
  envelope_xdr: string;
  result_xdr: string;
  result_meta_xdr: string;
  fee_meta_xdr: string;
  memo_type: string;
  memo?: string;
  signatures: string[];
  valid_after?: string;
  valid_before?: string;
}

export interface StellarTransactionsResponse {
  _links: {
    self: { href: string };
    next?: { href: string };
    prev?: { href: string };
  };
  _embedded: {
    records: StellarTransaction[];
  };
}

export interface HorizonClientConfig {
  serverUrl?: string;
  timeout?: number;
  maxFee?: number;
  networkPassphrase?: string;
}

/**
 * Stellar Horizon API Client (Read-Only)
 */
export class HorizonClient {
  private readonly serverUrl: string;
  private readonly timeout: number;
  private readonly maxFee: number;
  private readonly networkPassphrase: string;
  private readonly logger = globalLogger.child({ service: 'stellar-client' });

  constructor(config: HorizonClientConfig = {}) {
    // Fail closed: require explicit configuration, no defaults that could be insecure
    this.serverUrl = config.serverUrl || env.STELLAR_HORIZON_URL || this.getDefaultServerUrl();
    this.timeout = config.timeout || env.STELLAR_TIMEOUT;
    this.maxFee = config.maxFee || env.STELLAR_MAX_FEE;
    this.networkPassphrase = config.networkPassphrase || env.STELLAR_NETWORK_PASSPHRASE || this.getDefaultNetworkPassphrase();

    // Validate configuration on construction
    this.validateConfiguration();

    this.logger.info('Stellar Horizon client initialized', {
      serverUrl: this.serverUrl,
      timeout: this.timeout,
      maxFee: this.maxFee,
      network: env.STELLAR_NETWORK,
    });
  }

  private getDefaultServerUrl(): string {
    return env.STELLAR_NETWORK === 'public'
      ? 'https://horizon.stellar.org'
      : 'https://horizon-testnet.stellar.org';
  }

  private getDefaultNetworkPassphrase(): string {
    return env.STELLAR_NETWORK === 'public'
      ? 'Public Global Stellar Network ; September 2015'
      : 'Test SDF Network ; September 2015';
  }

  private validateConfiguration(): void {
    if (!this.serverUrl) {
      throw Errors.internal('Stellar server URL is required');
    }
    if (!this.networkPassphrase) {
      throw Errors.internal('Stellar network passphrase is required');
    }
    if (this.timeout <= 0 || this.timeout > 300000) {
      throw Errors.internal('Stellar timeout must be between 1 and 300000 milliseconds');
    }
    if (this.maxFee <= 0 || this.maxFee > 10000000) {
      throw Errors.internal('Stellar max fee must be between 1 and 10000000 stroops');
    }
  }

  /**
   * Fetches account information for a given public key
   * @param publicKey - Stellar account public key
   * @returns Account information including balances, signers, and flags
   * @throws AppError if account not found or request fails
   */
  async getAccount(publicKey: string): Promise<StellarAccount> {
    if (!publicKey || typeof publicKey !== 'string') {
      throw Errors.validationError('Public key must be a non-empty string');
    }

    this.logger.debug('Fetching account information', { publicKey });

    try {
      const response = await this.fetchWithTimeout(
        `${this.serverUrl}/accounts/${publicKey}`
      );

      if (!response.ok) {
        if (response.status === 404) {
          this.logger.warn('Account not found', { publicKey, status: response.status });
          throw Errors.notFound(`Account not found: ${publicKey}`);
        }
        this.logger.error('Failed to fetch account', {
          publicKey,
          status: response.status,
          statusText: response.statusText,
        });
        throw Errors.serviceUnavailable('Failed to fetch account information');
      }

      const account = (await response.json()) as StellarAccount;
      this.logger.debug('Account information fetched successfully', {
        publicKey,
        sequence: account.sequence,
        balanceCount: account.balances.length,
      });
      return account;
    } catch (error) {
      const failureClass = classifyStellarRPCFailure(error);
      this.logger.error('Account fetch failed', {
        publicKey,
        error: error,
        failureClass,
      });

      if (error instanceof Error && error.name === 'AppError') {
        throw error; // Re-throw our own errors
      }

      throw Errors.serviceUnavailable('Failed to fetch account information');
    }
  }

  /**
   * Fetches balances for a given public key
   * @param publicKey - Stellar account public key
   * @returns Array of account balances
   * @throws AppError if account not found or request fails
   */
  async getBalances(publicKey: string): Promise<StellarBalance[]> {
    const account = await this.getAccount(publicKey);
    return account.balances;
  }

  /**
   * Fetches transaction history for an account
   * @param accountId - Stellar account ID
   * @param limit - Maximum number of transactions to return (default: 10, max: 200)
   * @returns Transaction history response with records and pagination links
   * @throws AppError if account not found or request fails
   */
  async getTransactions(
    accountId: string,
    limit: number = 10
  ): Promise<StellarTransactionsResponse> {
    if (!accountId || typeof accountId !== 'string') {
      throw Errors.validationError('Account ID must be a non-empty string');
    }

    if (limit < 1 || limit > 200) {
      throw Errors.validationError('Limit must be between 1 and 200');
    }

    this.logger.debug('Fetching transaction history', { accountId, limit });

    try {
      const url = new URL(
        `${this.serverUrl}/accounts/${accountId}/transactions`
      );
      url.searchParams.set('limit', limit.toString());
      url.searchParams.set('order', 'desc');

      const response = await this.fetchWithTimeout(url.toString());

      if (!response.ok) {
        if (response.status === 404) {
          this.logger.warn('Account not found for transactions', { accountId, status: response.status });
          throw Errors.notFound(`Account not found: ${accountId}`);
        }
        this.logger.error('Failed to fetch transactions', {
          accountId,
          status: response.status,
          statusText: response.statusText,
        });
        throw Errors.serviceUnavailable('Failed to fetch transaction history');
      }

      const transactionsResponse = (await response.json()) as StellarTransactionsResponse;
      this.logger.debug('Transaction history fetched successfully', {
        accountId,
        transactionCount: transactionsResponse._embedded.records.length,
      });
      return transactionsResponse;
    } catch (error) {
      const failureClass = classifyStellarRPCFailure(error);
      this.logger.error('Transaction fetch failed', {
        accountId,
        limit,
        error: error,
        failureClass,
      });

      if (error instanceof Error && error.name === 'AppError') {
        throw error; // Re-throw our own errors
      }

      throw Errors.serviceUnavailable('Failed to fetch transaction history');
    }
  }

  /**
   * Internal method to fetch with timeout
   */
  private async fetchWithTimeout(
    url: string,
    options: RequestInit = {}
  ): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
      this.logger.warn('Request timed out', { url, timeout: this.timeout });
    }, this.timeout);

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          ...options.headers,
        },
      });
      return response;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Get the configured server URL
   */
  getServerUrl(): string {
    return this.serverUrl;
  }

  /**
   * Get the configured timeout
   */
  getTimeout(): number {
    return this.timeout;
  }

  /**
   * Get the configured max fee
   */
  getMaxFee(): number {
    return this.maxFee;
  }

  /**
   * Get the configured network passphrase
   */
  getNetworkPassphrase(): string {
    return this.networkPassphrase;
  }
}

/**
 * Convenience function to create a Horizon client instance
 */
export function createHorizonClient(
  config?: HorizonClientConfig
): HorizonClient {
  return new HorizonClient(config);
}

/**
 * Convenience function to get account information
 */
export async function getAccount(
  publicKey: string,
  config?: HorizonClientConfig
): Promise<StellarAccount> {
  const client = createHorizonClient(config);
  return client.getAccount(publicKey);
}

/**
 * Convenience function to get account balances
 */
export async function getBalances(
  publicKey: string,
  config?: HorizonClientConfig
): Promise<StellarBalance[]> {
  const client = createHorizonClient(config);
  return client.getBalances(publicKey);
}

/**
 * Convenience function to get account transactions
 */
export async function getTransactions(
  accountId: string,
  limit?: number,
  config?: HorizonClientConfig
): Promise<StellarTransactionsResponse> {
  const client = createHorizonClient(config);
  return client.getTransactions(accountId, limit);
}
