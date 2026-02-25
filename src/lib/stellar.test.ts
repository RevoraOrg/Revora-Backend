import {
  HorizonClient,
  createHorizonClient,
  getAccount,
  getBalances,
  getTransactions,
  StellarAccount,
  StellarBalance,
  StellarTransactionsResponse,
} from './stellar';

// Mock fetch globally
global.fetch = jest.fn();

describe('HorizonClient', () => {
  let client: HorizonClient;
  const mockFetch = global.fetch as jest.MockedFunction<typeof fetch>;

  beforeEach(() => {
    client = new HorizonClient();
    jest.clearAllMocks();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('getAccount', () => {
    const mockAccount: StellarAccount = {
      account_id: 'GABC1234567890',
      sequence: '123456789',
      subentry_count: 0,
      last_modified_ledger: 12345,
      thresholds: {
        low_threshold: 0,
        med_threshold: 0,
        high_threshold: 0,
      },
      flags: {
        auth_required: false,
        auth_revocable: false,
        auth_immutable: false,
        auth_clawback_enabled: false,
      },
      balances: [
        {
          balance: '1000.0000000',
          asset_type: 'native',
        },
      ],
      signers: [
        {
          key: 'GABC1234567890',
          weight: 1,
          type: 'ed25519_public_key',
        },
      ],
      data: {},
      num_sponsoring: 0,
      num_sponsored: 0,
    };

    it('should fetch account information successfully', async () => {
      const mockResponse = {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: jest.fn().mockResolvedValue(mockAccount),
      } as unknown as Response;

      mockFetch.mockResolvedValueOnce(mockResponse);

      const result = await client.getAccount('GABC1234567890');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://horizon.stellar.org/accounts/GABC1234567890',
        expect.objectContaining({
          signal: expect.any(AbortSignal),
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
          }),
        })
      );
      expect(result).toEqual(mockAccount);
    });

    it('should throw error if account not found', async () => {
      const mockResponse = {
        ok: false,
        status: 404,
        statusText: 'Not Found',
      } as unknown as Response;

      mockFetch.mockResolvedValueOnce(mockResponse);

      await expect(client.getAccount('GINVALID')).rejects.toThrow(
        'Account not found: GINVALID'
      );
    });

    it('should throw error for invalid public key', async () => {
      await expect(client.getAccount('')).rejects.toThrow(
        'Public key must be a non-empty string'
      );
      await expect(client.getAccount(null as any)).rejects.toThrow(
        'Public key must be a non-empty string'
      );
    });

    it('should handle network errors', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      await expect(client.getAccount('GABC1234567890')).rejects.toThrow(
        'Network error'
      );
    });

    it('should use custom server URL when provided', async () => {
      const testnetClient = new HorizonClient({
        serverUrl: 'https://horizon-testnet.stellar.org',
      });

      const mockResponse = {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: jest.fn().mockResolvedValue(mockAccount),
      } as unknown as Response;

      mockFetch.mockResolvedValueOnce(mockResponse);

      await testnetClient.getAccount('GABC1234567890');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://horizon-testnet.stellar.org/accounts/GABC1234567890',
        expect.any(Object)
      );
    });
  });

  describe('getBalances', () => {
    const mockBalances: StellarBalance[] = [
      {
        balance: '1000.0000000',
        asset_type: 'native',
      },
      {
        balance: '500.0000000',
        asset_type: 'credit_alphanum4',
        asset_code: 'USDC',
        asset_issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
        limit: '10000.0000000',
      },
    ];

    it('should fetch account balances successfully', async () => {
      const mockAccount: StellarAccount = {
        account_id: 'GABC1234567890',
        sequence: '123456789',
        subentry_count: 0,
        last_modified_ledger: 12345,
        thresholds: {
          low_threshold: 0,
          med_threshold: 0,
          high_threshold: 0,
        },
        flags: {
          auth_required: false,
          auth_revocable: false,
          auth_immutable: false,
          auth_clawback_enabled: false,
        },
        balances: mockBalances,
        signers: [],
        data: {},
        num_sponsoring: 0,
        num_sponsored: 0,
      };

      const mockResponse = {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: jest.fn().mockResolvedValue(mockAccount),
      } as unknown as Response;

      mockFetch.mockResolvedValueOnce(mockResponse);

      const result = await client.getBalances('GABC1234567890');

      expect(result).toEqual(mockBalances);
      expect(result).toHaveLength(2);
      expect(result[0].asset_type).toBe('native');
      expect(result[1].asset_code).toBe('USDC');
    });

    it('should throw error if account not found', async () => {
      const mockResponse = {
        ok: false,
        status: 404,
        statusText: 'Not Found',
      } as unknown as Response;

      mockFetch.mockResolvedValueOnce(mockResponse);

      await expect(client.getBalances('GINVALID')).rejects.toThrow(
        'Account not found: GINVALID'
      );
    });
  });

  describe('getTransactions', () => {
    const mockTransactionsResponse: StellarTransactionsResponse = {
      _links: {
        self: {
          href: 'https://horizon.stellar.org/accounts/GABC1234567890/transactions?limit=10&order=desc',
        },
        next: {
          href: 'https://horizon.stellar.org/accounts/GABC1234567890/transactions?limit=10&order=desc&cursor=123',
        },
      },
      _embedded: {
        records: [
          {
            id: 'tx-1',
            paging_token: '123',
            successful: true,
            hash: 'abc123',
            ledger: 12345,
            created_at: '2024-01-01T00:00:00Z',
            source_account: 'GABC1234567890',
            source_account_sequence: '123456789',
            fee_charged: '100',
            operation_count: 1,
            envelope_xdr: 'envelope',
            result_xdr: 'result',
            result_meta_xdr: 'meta',
            fee_meta_xdr: 'fee_meta',
            memo_type: 'none',
            signatures: ['sig1'],
          },
          {
            id: 'tx-2',
            paging_token: '124',
            successful: true,
            hash: 'def456',
            ledger: 12346,
            created_at: '2024-01-02T00:00:00Z',
            source_account: 'GABC1234567890',
            source_account_sequence: '123456790',
            fee_charged: '100',
            operation_count: 1,
            envelope_xdr: 'envelope2',
            result_xdr: 'result2',
            result_meta_xdr: 'meta2',
            fee_meta_xdr: 'fee_meta2',
            memo_type: 'text',
            memo: 'test memo',
            signatures: ['sig2'],
          },
        ],
      },
    };

    it('should fetch transactions successfully with default limit', async () => {
      const mockResponse = {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: jest.fn().mockResolvedValue(mockTransactionsResponse),
      } as unknown as Response;

      mockFetch.mockResolvedValueOnce(mockResponse);

      const result = await client.getTransactions('GABC1234567890');

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining(
          'https://horizon.stellar.org/accounts/GABC1234567890/transactions'
        ),
        expect.any(Object)
      );
      expect(result._embedded.records).toHaveLength(2);
      expect(result._embedded.records[0].id).toBe('tx-1');
      expect(result._embedded.records[1].id).toBe('tx-2');
    });

    it('should fetch transactions with custom limit', async () => {
      const mockResponse = {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: jest.fn().mockResolvedValue(mockTransactionsResponse),
      } as unknown as Response;

      mockFetch.mockResolvedValueOnce(mockResponse);

      await client.getTransactions('GABC1234567890', 50);

      const callUrl = (mockFetch.mock.calls[0][0] as string).toString();
      const url = new URL(callUrl);
      expect(url.searchParams.get('limit')).toBe('50');
      expect(url.searchParams.get('order')).toBe('desc');
    });

    it('should throw error for invalid limit', async () => {
      await expect(
        client.getTransactions('GABC1234567890', 0)
      ).rejects.toThrow('Limit must be between 1 and 200');
      await expect(
        client.getTransactions('GABC1234567890', 201)
      ).rejects.toThrow('Limit must be between 1 and 200');
    });

    it('should throw error for invalid account ID', async () => {
      await expect(client.getTransactions('')).rejects.toThrow(
        'Account ID must be a non-empty string'
      );
    });

    it('should throw error if account not found', async () => {
      const mockResponse = {
        ok: false,
        status: 404,
        statusText: 'Not Found',
      } as unknown as Response;

      mockFetch.mockResolvedValueOnce(mockResponse);

      await expect(client.getTransactions('GINVALID')).rejects.toThrow(
        'Account not found: GINVALID'
      );
    });
  });

  describe('timeout handling', () => {
    it('should timeout after specified duration', async () => {
      const timeoutClient = new HorizonClient({ timeout: 5000 });
      const abortError = new Error('Aborted');
      abortError.name = 'AbortError';

      mockFetch.mockImplementation(
        () =>
          new Promise((_resolve, reject) => {
            setTimeout(() => reject(abortError), 10000);
          })
      );

      const promise = timeoutClient.getAccount('GABC1234567890');
      jest.advanceTimersByTime(5000);

      await expect(promise).rejects.toThrow();
    });
  });
});

describe('Convenience functions', () => {
  const mockFetch = global.fetch as jest.MockedFunction<typeof fetch>;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('createHorizonClient', () => {
    it('should create a client with default config', () => {
      const client = createHorizonClient();
      expect(client).toBeInstanceOf(HorizonClient);
    });

    it('should create a client with custom config', () => {
      const client = createHorizonClient({
        serverUrl: 'https://horizon-testnet.stellar.org',
        timeout: 10000,
      });
      expect(client).toBeInstanceOf(HorizonClient);
    });
  });

  describe('getAccount convenience function', () => {
    it('should fetch account using convenience function', async () => {
      const mockAccount: StellarAccount = {
        account_id: 'GABC1234567890',
        sequence: '123456789',
        subentry_count: 0,
        last_modified_ledger: 12345,
        thresholds: {
          low_threshold: 0,
          med_threshold: 0,
          high_threshold: 0,
        },
        flags: {
          auth_required: false,
          auth_revocable: false,
          auth_immutable: false,
          auth_clawback_enabled: false,
        },
        balances: [],
        signers: [],
        data: {},
        num_sponsoring: 0,
        num_sponsored: 0,
      };

      const mockResponse = {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: jest.fn().mockResolvedValue(mockAccount),
      } as unknown as Response;

      mockFetch.mockResolvedValueOnce(mockResponse);

      const result = await getAccount('GABC1234567890');

      expect(result).toEqual(mockAccount);
    });
  });

  describe('getBalances convenience function', () => {
    it('should fetch balances using convenience function', async () => {
      const mockAccount: StellarAccount = {
        account_id: 'GABC1234567890',
        sequence: '123456789',
        subentry_count: 0,
        last_modified_ledger: 12345,
        thresholds: {
          low_threshold: 0,
          med_threshold: 0,
          high_threshold: 0,
        },
        flags: {
          auth_required: false,
          auth_revocable: false,
          auth_immutable: false,
          auth_clawback_enabled: false,
        },
        balances: [
          {
            balance: '1000.0000000',
            asset_type: 'native',
          },
        ],
        signers: [],
        data: {},
        num_sponsoring: 0,
        num_sponsored: 0,
      };

      const mockResponse = {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: jest.fn().mockResolvedValue(mockAccount),
      } as unknown as Response;

      mockFetch.mockResolvedValueOnce(mockResponse);

      const result = await getBalances('GABC1234567890');

      expect(result).toHaveLength(1);
      expect(result[0].balance).toBe('1000.0000000');
    });
  });

  describe('getTransactions convenience function', () => {
    it('should fetch transactions using convenience function', async () => {
      const mockTransactionsResponse: StellarTransactionsResponse = {
        _links: {
          self: {
            href: 'https://horizon.stellar.org/accounts/GABC1234567890/transactions',
          },
        },
        _embedded: {
          records: [],
        },
      };

      const mockResponse = {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: jest.fn().mockResolvedValue(mockTransactionsResponse),
      } as unknown as Response;

      mockFetch.mockResolvedValueOnce(mockResponse);

      const result = await getTransactions('GABC1234567890', 10);

      expect(result._embedded.records).toHaveLength(0);
    });
  });
});
