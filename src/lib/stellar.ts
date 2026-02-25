/**
 * Stellar Horizon Client Wrapper (Read-Only)
 * 
 * Provides read-only access to Stellar Horizon API for fetching account info,
 * balances, and transaction history. No signing capabilities.
 */

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
}

/**
 * Stellar Horizon API Client (Read-Only)
 */
export class HorizonClient {
  private readonly serverUrl: string;
  private readonly timeout: number;

  constructor(config: HorizonClientConfig = {}) {
    this.serverUrl = config.serverUrl || 'https://horizon.stellar.org';
    this.timeout = config.timeout || 30000;
  }

  /**
   * Fetches account information for a given public key
   * @param publicKey - Stellar account public key
   * @returns Account information including balances, signers, and flags
   * @throws Error if account not found or request fails
   */
  async getAccount(publicKey: string): Promise<StellarAccount> {
    if (!publicKey || typeof publicKey !== 'string') {
      throw new Error('Public key must be a non-empty string');
    }

    try {
      const response = await this.fetchWithTimeout(
        `${this.serverUrl}/accounts/${publicKey}`
      );

      if (!response.ok) {
        if (response.status === 404) {
          throw new Error(`Account not found: ${publicKey}`);
        }
        throw new Error(
          `Failed to fetch account: ${response.status} ${response.statusText}`
        );
      }

      return await response.json();
    } catch (error) {
      if (error instanceof Error) {
        throw error;
      }
      throw new Error(`Failed to fetch account: ${String(error)}`);
    }
  }

  /**
   * Fetches balances for a given public key
   * @param publicKey - Stellar account public key
   * @returns Array of account balances
   * @throws Error if account not found or request fails
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
   * @throws Error if account not found or request fails
   */
  async getTransactions(
    accountId: string,
    limit: number = 10
  ): Promise<StellarTransactionsResponse> {
    if (!accountId || typeof accountId !== 'string') {
      throw new Error('Account ID must be a non-empty string');
    }

    if (limit < 1 || limit > 200) {
      throw new Error('Limit must be between 1 and 200');
    }

    try {
      const url = new URL(
        `${this.serverUrl}/accounts/${accountId}/transactions`
      );
      url.searchParams.set('limit', limit.toString());
      url.searchParams.set('order', 'desc');

      const response = await this.fetchWithTimeout(url.toString());

      if (!response.ok) {
        if (response.status === 404) {
          throw new Error(`Account not found: ${accountId}`);
        }
        throw new Error(
          `Failed to fetch transactions: ${response.status} ${response.statusText}`
        );
      }

      return await response.json();
    } catch (error) {
      if (error instanceof Error) {
        throw error;
      }
      throw new Error(`Failed to fetch transactions: ${String(error)}`);
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
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

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
