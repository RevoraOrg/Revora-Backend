import { Pool, QueryResult } from 'pg';
import {
  InvestmentRepository,
  Investment,
  ListByInvestorOptions,
  CreateInvestmentInput,
} from './investmentRepository';

describe('InvestmentRepository', () => {
  let repository: InvestmentRepository;
  let mockPool: jest.Mocked<Pool>;

  beforeEach(() => {
    // Mock Pool
    mockPool = {
      query: jest.fn(),
    } as unknown as jest.Mocked<Pool>;

    repository = new InvestmentRepository(mockPool);
  });

  describe('listByInvestor', () => {
    const baseRow: Investment = {
      id: 'inv-1',
      investor_id: 'investor-123',
      offering_id: 'offering-abc',
      amount: '5000.00',
      asset: 'USDC',
      status: 'completed',
      created_at: new Date('2024-01-15'),
      updated_at: new Date('2024-01-15'),
    };

    it('should return investments for an investor', async () => {
      const mockResult: QueryResult<Investment> = {
        rows: [baseRow],
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
        rows: [baseRow],
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

  describe('create', () => {
    it('should insert and return a new investment', async () => {
      const input: CreateInvestmentInput = {
        investor_id: 'investor-1',
        offering_id: 'offering-1',
        amount: '1000.00',
        asset: 'USDC',
        status: 'completed',
      };

      const mockResult: Partial<QueryResult<Investment>> = {
        rows: [
          {
            id: 'uuid-1',
            ...input,
            tx_hash: undefined,
            created_at: new Date(),
            updated_at: new Date(),
          } as Investment,
        ],
        rowCount: 1,
      };

      (mockPool.query as jest.Mock).mockResolvedValueOnce(mockResult);

      const result = await repository.create(input);

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO investments'),
        expect.arrayContaining([input.investor_id, input.offering_id, input.amount, input.asset, 'completed'])
      );
      expect(result.id).toBe('uuid-1');
      expect(result.amount).toBe(input.amount);
    });
  });

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
});
