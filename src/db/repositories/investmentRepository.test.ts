import { Pool, QueryResult } from 'pg';
import { InvestmentRepository, CreateInvestmentInput, Investment } from './investmentRepository';

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
      const mockResult: Partial<QueryResult<any>> = {
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
