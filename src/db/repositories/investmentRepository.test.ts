import { Pool, QueryResult, QueryResultRow } from 'pg';
import {
  InvestmentRepository,
  Investment,
  ListByInvestorOptions,
  CreateInvestmentInput,
} from './investmentRepository';

// ─── Shared helpers ───────────────────────────────────────────────────────────

/** Build a minimal QueryResult<T> from an array of rows. */
function makeQueryResult<T extends QueryResultRow>(rows: T[]): QueryResult<T> {
  return { rows, rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] };
}

// ─── Shared fixtures ──────────────────────────────────────────────────────────

const BASE_INVESTMENT: Investment = {
  id: 'inv-1',
  investor_id: 'investor-123',
  offering_id: 'offering-abc',
  amount: '5000.00',
  asset: 'USDC',
  status: 'completed',
  created_at: new Date('2024-01-15'),
  updated_at: new Date('2024-01-15'),
};

const MINIMAL_CREATE_INPUT: CreateInvestmentInput = {
  investor_id: 'investor-1',
  offering_id: 'offering-1',
  amount: '1000.00',
  asset: 'USDC',
};

// ─── Suite ────────────────────────────────────────────────────────────────────

describe('InvestmentRepository', () => {
  let repository: InvestmentRepository;
  let mockPool: { query: jest.Mock };

  beforeEach(() => {
    mockPool = { query: jest.fn() };
    repository = new InvestmentRepository(mockPool as unknown as Pool);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ── listByInvestor ────────────────────────────────────────────────────────

  describe('listByInvestor', () => {
    it('should return investments for an investor', async () => {
      const mockResult: QueryResult<Investment> = {
        rows: [BASE_INVESTMENT],
        rowCount: 1,
        command: 'SELECT',
        oid: 0,
        fields: [],
      };

      mockPool.query.mockResolvedValueOnce(mockResult);

      const options: ListByInvestorOptions = { investor_id: 'investor-123' };
      const result = await repository.listByInvestor(options);

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('WHERE investor_id = $1'),
        ['investor-123']
      );
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('inv-1');
      expect(result[0].investor_id).toBe('investor-123');
    });

    it('should filter by offering_id when provided', async () => {
      const mockResult: QueryResult<Investment> = {
        rows: [BASE_INVESTMENT],
        rowCount: 1,
        command: 'SELECT',
        oid: 0,
        fields: [],
      };

      mockPool.query.mockResolvedValueOnce(mockResult);

      const options: ListByInvestorOptions = {
        investor_id: 'investor-123',
        offering_id: 'offering-abc',
      };
      await repository.listByInvestor(options);

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('AND offering_id = $2'),
        ['investor-123', 'offering-abc']
      );
    });

    it('should apply limit when provided', async () => {
      const mockResult: QueryResult<Investment> = {
        rows: [],
        rowCount: 0,
        command: 'SELECT',
        oid: 0,
        fields: [],
      };

      mockPool.query.mockResolvedValueOnce(mockResult);

      const options: ListByInvestorOptions = {
        investor_id: 'investor-123',
        limit: 10,
      };
      await repository.listByInvestor(options);

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('LIMIT $2'),
        ['investor-123', 10]
      );
    });

    it('should apply offset when provided', async () => {
      const mockResult: QueryResult<Investment> = {
        rows: [],
        rowCount: 0,
        command: 'SELECT',
        oid: 0,
        fields: [],
      };

      mockPool.query.mockResolvedValueOnce(mockResult);

      const options: ListByInvestorOptions = {
        investor_id: 'investor-123',
        offset: 20,
      };
      await repository.listByInvestor(options);

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('OFFSET $2'),
        ['investor-123', 20]
      );
    });

    it('should apply offering_id, limit, and offset together', async () => {
      const mockResult: QueryResult<Investment> = {
        rows: [],
        rowCount: 0,
        command: 'SELECT',
        oid: 0,
        fields: [],
      };

      mockPool.query.mockResolvedValueOnce(mockResult);

      const options: ListByInvestorOptions = {
        investor_id: 'investor-123',
        offering_id: 'offering-abc',
        limit: 5,
        offset: 10,
      };
      await repository.listByInvestor(options);

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('AND offering_id = $2'),
        ['investor-123', 'offering-abc', 5, 10]
      );
    });

    it('should return an empty array when no investments are found', async () => {
      const mockResult: QueryResult<Investment> = {
        rows: [],
        rowCount: 0,
        command: 'SELECT',
        oid: 0,
        fields: [],
      };

      mockPool.query.mockResolvedValueOnce(mockResult);

      const result = await repository.listByInvestor({ investor_id: 'investor-999' });
      expect(result).toHaveLength(0);
    });

    it('should propagate database errors', async () => {
      mockPool.query.mockRejectedValueOnce(new Error('db connection lost'));

      await expect(
        repository.listByInvestor({ investor_id: 'investor-123' })
      ).rejects.toThrow('db connection lost');
    });
  });

  // ── create ────────────────────────────────────────────────────────────────
  //
  // Covers the production branch at investmentRepository.ts:130
  //   if (result.rows.length === 0) {
  //     throw new Error('Failed to create investment');
  //   }

  describe('create', () => {
    // ── Success path ────────────────────────────────────────────────────────

    it('inserts and returns a new investment with all required fields', async () => {
      const input: CreateInvestmentInput = {
        investor_id: 'investor-1',
        offering_id: 'offering-1',
        amount: '1000.00',
        asset: 'USDC',
        status: 'completed',
      };

      const returned: Investment = {
        id: 'uuid-1',
        investor_id: input.investor_id,
        offering_id: input.offering_id,
        amount: input.amount,
        asset: input.asset,
        status: 'completed',
        created_at: new Date('2024-06-01'),
        updated_at: new Date('2024-06-01'),
      };

      mockPool.query.mockResolvedValueOnce(makeQueryResult([returned]));

      const result = await repository.create(input);

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO investments'),
        expect.arrayContaining([
          input.investor_id,
          input.offering_id,
          input.amount,
          input.asset,
          'completed',
        ])
      );
      expect(result.id).toBe('uuid-1');
      expect(result.investor_id).toBe('investor-1');
      expect(result.offering_id).toBe('offering-1');
      expect(result.amount).toBe('1000.00');
      expect(result.asset).toBe('USDC');
      expect(result.status).toBe('completed');
    });

    it('defaults status to "pending" when not supplied', async () => {
      const returned: Investment = {
        ...BASE_INVESTMENT,
        id: 'uuid-pending',
        status: 'pending',
      };

      mockPool.query.mockResolvedValueOnce(makeQueryResult([returned]));

      await repository.create(MINIMAL_CREATE_INPUT);

      // The 5th positional parameter passed to pg is the status column
      const [, params] = mockPool.query.mock.calls[0] as [string, unknown[]];
      expect(params[4]).toBe('pending');
    });

    it('passes tx_hash to the database when provided', async () => {
      const input: CreateInvestmentInput = {
        ...MINIMAL_CREATE_INPUT,
        tx_hash: 'tx-abc123',
      };

      const returned: Investment = {
        ...BASE_INVESTMENT,
        tx_hash: 'tx-abc123',
      };

      mockPool.query.mockResolvedValueOnce(makeQueryResult([returned]));

      const result = await repository.create(input);

      const [, params] = mockPool.query.mock.calls[0] as [string, unknown[]];
      expect(params[5]).toBe('tx-abc123');
      expect(result.tx_hash).toBe('tx-abc123');
    });

    it('passes null for tx_hash when not provided', async () => {
      mockPool.query.mockResolvedValueOnce(makeQueryResult([BASE_INVESTMENT]));

      await repository.create(MINIMAL_CREATE_INPUT);

      const [, params] = mockPool.query.mock.calls[0] as [string, unknown[]];
      // tx_hash is the 6th value ($6)
      expect(params[5]).toBeNull();
    });

    it('stores all optional screening fields when provided', async () => {
      const input: CreateInvestmentInput = {
        ...MINIMAL_CREATE_INPUT,
        screening_status: 'passed',
        screening_list_version: 'OFAC-2024-03',
        screening_result: { matched: false, score: 0 },
      };

      const returned: Investment = {
        ...BASE_INVESTMENT,
        screening_status: 'passed',
        screening_list_version: 'OFAC-2024-03',
        screening_result: { matched: false, score: 0 },
      };

      mockPool.query.mockResolvedValueOnce(makeQueryResult([returned]));

      const result = await repository.create(input);

      const [, params] = mockPool.query.mock.calls[0] as [string, unknown[]];
      expect(params[6]).toBe('passed');                          // screening_status
      expect(params[7]).toBe('OFAC-2024-03');                   // screening_list_version
      expect(params[8]).toBe(JSON.stringify({ matched: false, score: 0 })); // screening_result

      expect(result.screening_status).toBe('passed');
      expect(result.screening_list_version).toBe('OFAC-2024-03');
      expect(result.screening_result).toEqual({ matched: false, score: 0 });
    });

    it('sends null for all optional screening fields when omitted', async () => {
      mockPool.query.mockResolvedValueOnce(makeQueryResult([BASE_INVESTMENT]));

      await repository.create(MINIMAL_CREATE_INPUT);

      const [, params] = mockPool.query.mock.calls[0] as [string, unknown[]];
      expect(params[6]).toBeNull(); // screening_status
      expect(params[7]).toBeNull(); // screening_list_version
      expect(params[8]).toBeNull(); // screening_result
    });

    it('includes RETURNING * in the INSERT query', async () => {
      mockPool.query.mockResolvedValueOnce(makeQueryResult([BASE_INVESTMENT]));

      await repository.create(MINIMAL_CREATE_INPUT);

      const [sql] = mockPool.query.mock.calls[0] as [string, unknown[]];
      expect(sql).toMatch(/RETURNING\s+\*/i);
    });

    // ── Failure path ────────────────────────────────────────────────────────
    //
    // Regression guard for investmentRepository.ts:130:
    //   throw new Error('Failed to create investment');
    //
    // Condition: the DB executes the INSERT but RETURNING * yields zero rows
    // (e.g., INSERT…RETURNING suppressed by a trigger, a conditional rule, or
    // a future WHERE clause on the INSERT).

    it('throws "Failed to create investment" when the DB returns zero rows', async () => {
      // Simulate the INSERT executing without returning any row —
      // the exact condition that triggers the production branch.
      mockPool.query.mockResolvedValueOnce(makeQueryResult([]));

      await expect(repository.create(MINIMAL_CREATE_INPUT)).rejects.toThrow(
        'Failed to create investment'
      );
    });

    it('throws an Error instance (not a custom error) when RETURNING yields no rows', async () => {
      mockPool.query.mockResolvedValueOnce(makeQueryResult([]));

      await expect(repository.create(MINIMAL_CREATE_INPUT)).rejects.toBeInstanceOf(Error);
    });

    it('preserves the exact error message from the production branch', async () => {
      mockPool.query.mockResolvedValueOnce(makeQueryResult([]));

      let caught: unknown;
      try {
        await repository.create(MINIMAL_CREATE_INPUT);
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toBe('Failed to create investment');
    });

    it('does not return a value when the failure branch is reached', async () => {
      mockPool.query.mockResolvedValueOnce(makeQueryResult([]));

      // rejects.resolves would catch an unexpected resolution; confirm reject
      const promise = repository.create(MINIMAL_CREATE_INPUT);
      await expect(promise).rejects.toThrow();
    });

    // ── Database error propagation ──────────────────────────────────────────

    it('propagates a database connection error unchanged', async () => {
      mockPool.query.mockRejectedValueOnce(new Error('connection refused'));

      await expect(repository.create(MINIMAL_CREATE_INPUT)).rejects.toThrow(
        'connection refused'
      );
    });

    it('propagates a database constraint violation error unchanged', async () => {
      const constraintError = Object.assign(
        new Error('duplicate key value violates unique constraint "investments_pkey"'),
        { code: '23505' }
      );
      mockPool.query.mockRejectedValueOnce(constraintError);

      await expect(repository.create(MINIMAL_CREATE_INPUT)).rejects.toThrow(
        'duplicate key value violates unique constraint'
      );
    });

    // ── Boundary inputs ─────────────────────────────────────────────────────

    it('accepts amount "0.00" (boundary: zero investment amount)', async () => {
      const input: CreateInvestmentInput = {
        ...MINIMAL_CREATE_INPUT,
        amount: '0.00',
      };

      const returned: Investment = { ...BASE_INVESTMENT, amount: '0.00' };
      mockPool.query.mockResolvedValueOnce(makeQueryResult([returned]));

      const result = await repository.create(input);

      const [, params] = mockPool.query.mock.calls[0] as [string, unknown[]];
      expect(params[2]).toBe('0.00');
      expect(result.amount).toBe('0.00');
    });

    it('accepts a very large amount string without truncation', async () => {
      const bigAmount = '999999999999999.99';
      const input: CreateInvestmentInput = { ...MINIMAL_CREATE_INPUT, amount: bigAmount };
      const returned: Investment = { ...BASE_INVESTMENT, amount: bigAmount };

      mockPool.query.mockResolvedValueOnce(makeQueryResult([returned]));

      const result = await repository.create(input);

      const [, params] = mockPool.query.mock.calls[0] as [string, unknown[]];
      expect(params[2]).toBe(bigAmount);
      expect(result.amount).toBe(bigAmount);
    });

    it('accepts status "failed" as an explicit input', async () => {
      const input: CreateInvestmentInput = {
        ...MINIMAL_CREATE_INPUT,
        status: 'failed',
      };
      const returned: Investment = { ...BASE_INVESTMENT, status: 'failed' };

      mockPool.query.mockResolvedValueOnce(makeQueryResult([returned]));

      const result = await repository.create(input);

      const [, params] = mockPool.query.mock.calls[0] as [string, unknown[]];
      expect(params[4]).toBe('failed');
      expect(result.status).toBe('failed');
    });

    it('accepts screening_status "blocked" (sanctions-blocked path)', async () => {
      const input: CreateInvestmentInput = {
        ...MINIMAL_CREATE_INPUT,
        screening_status: 'blocked',
        screening_result: { list: 'OFAC', match: 'entity-42' },
      };
      const returned: Investment = {
        ...BASE_INVESTMENT,
        screening_status: 'blocked',
        screening_result: { list: 'OFAC', match: 'entity-42' },
      };

      mockPool.query.mockResolvedValueOnce(makeQueryResult([returned]));

      const result = await repository.create(input);

      const [, params] = mockPool.query.mock.calls[0] as [string, unknown[]];
      expect(params[6]).toBe('blocked');
      expect(result.screening_status).toBe('blocked');
    });

    it('accepts screening_status "error" (screening service failure path)', async () => {
      const input: CreateInvestmentInput = {
        ...MINIMAL_CREATE_INPUT,
        screening_status: 'error',
      };
      const returned: Investment = { ...BASE_INVESTMENT, screening_status: 'error' };

      mockPool.query.mockResolvedValueOnce(makeQueryResult([returned]));

      const result = await repository.create(input);

      const [, params] = mockPool.query.mock.calls[0] as [string, unknown[]];
      expect(params[6]).toBe('error');
      expect(result.screening_status).toBe('error');
    });

    it('serialises screening_result as JSON string for storage', async () => {
      const screeningResult = { provider: 'chainalysis', risk: 'low', confidence: 0.98 };
      const input: CreateInvestmentInput = {
        ...MINIMAL_CREATE_INPUT,
        screening_result: screeningResult,
      };
      mockPool.query.mockResolvedValueOnce(makeQueryResult([BASE_INVESTMENT]));

      await repository.create(input);

      const [, params] = mockPool.query.mock.calls[0] as [string, unknown[]];
      expect(params[8]).toBe(JSON.stringify(screeningResult));
    });

    it('passes null for screening_result when it is undefined', async () => {
      mockPool.query.mockResolvedValueOnce(makeQueryResult([BASE_INVESTMENT]));

      await repository.create({ ...MINIMAL_CREATE_INPUT });

      const [, params] = mockPool.query.mock.calls[0] as [string, unknown[]];
      expect(params[8]).toBeNull();
    });
  });

  // ── getAggregateStats ─────────────────────────────────────────────────────

  describe('getAggregateStats', () => {
    it('should return aggregate stats for an offering', async () => {
      const offeringId = 'offering-1';
      const mockResult: Partial<QueryResult<{ total_invested: string; investor_count: string }>> = {
        rows: [
          {
            total_invested: '5000.50',
            investor_count: '10',
          },
        ],
      };

      (mockPool.query as jest.Mock).mockResolvedValueOnce(mockResult);

      const stats = await repository.getAggregateStats(offeringId);

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('SELECT'),
        [offeringId]
      );
      expect(stats.totalInvested).toBe('5000.50');
      expect(stats.investorCount).toBe(10);
    });
  });

  // ── lockOffering ──────────────────────────────────────────────────────────

  describe('lockOffering', () => {
    let mockClient: { query: jest.Mock };

    beforeEach(() => {
      mockClient = { query: jest.fn() };
    });

    it('returns offering row with max_investor_share_bps when found', async () => {
      mockClient.query.mockResolvedValueOnce({
        rows: [{ max_investor_share_bps: 1000, total_raised: '50000' }],
      });

      const result = await repository.lockOffering(mockClient as any, 'offering-1');

      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringContaining('FOR UPDATE'),
        ['offering-1'],
      );
      expect(result).toEqual({ max_investor_share_bps: 1000, total_raised: '50000' });
    });

    it('returns null when offering does not exist', async () => {
      mockClient.query.mockResolvedValueOnce({ rows: [] });

      const result = await repository.lockOffering(mockClient as any, 'missing');

      expect(result).toBeNull();
    });

    it('returns row with null max_investor_share_bps when no cap is set', async () => {
      mockClient.query.mockResolvedValueOnce({
        rows: [{ max_investor_share_bps: null, total_raised: '0' }],
      });

      const result = await repository.lockOffering(mockClient as any, 'offering-1');

      expect(result?.max_investor_share_bps).toBeNull();
    });
  });

  // ── getInvestorTotalForOffering ───────────────────────────────────────────

  describe('getInvestorTotalForOffering', () => {
    let mockClient: { query: jest.Mock };

    beforeEach(() => {
      mockClient = { query: jest.fn() };
    });

    it('returns the summed total as a string', async () => {
      mockClient.query.mockResolvedValueOnce({ rows: [{ total: '75000.50' }] });

      const result = await repository.getInvestorTotalForOffering(
        mockClient as any,
        'investor-1',
        'offering-1',
      );

      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringContaining("status != 'failed'"),
        ['investor-1', 'offering-1'],
      );
      expect(result).toBe('75000.50');
    });

    it('returns "0" when investor has no investments', async () => {
      mockClient.query.mockResolvedValueOnce({ rows: [{ total: '0' }] });

      const result = await repository.getInvestorTotalForOffering(
        mockClient as any,
        'investor-new',
        'offering-1',
      );

      expect(result).toBe('0');
    });

    it('excludes failed investments from the total', async () => {
      // The SQL itself filters these out; verify the WHERE clause is present
      mockClient.query.mockResolvedValueOnce({ rows: [{ total: '1000' }] });

      await repository.getInvestorTotalForOffering(mockClient as any, 'investor-1', 'offering-1');

      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringContaining("status != 'failed'"),
        expect.any(Array),
      );
    });
  });
});
