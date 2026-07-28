import { Pool, QueryResult } from 'pg';
import {
  DistributionRepository,
  DistributionRun,
  Payout,
  CreateDistributionRunInput,
  CreatePayoutInput,
} from './distributionRepository';

describe('DistributionRepository', () => {
  let repository: DistributionRepository;
  let mockPool: { query: jest.Mock };

  beforeEach(() => {
    // Mock Pool
    mockPool = {
      query: jest.fn(),
    } as any;

    repository = new DistributionRepository(mockPool as unknown as Pool);
  });

  describe('createDistributionRun', () => {
    it('should create a distribution run with default status', async () => {
      const input: CreateDistributionRunInput = {
        offering_id: 'offering-123',
        period_id: 'period-456',
        total_amount: '10000.50',
      };

      const mockResult: QueryResult<DistributionRun> = {
        rows: [
          {
            id: 'run-123',
            offering_id: 'offering-123',
            period_id: 'period-456',
            total_amount: '10000.50',
            status: 'pending',
            run_at: new Date(),
            created_at: new Date(),
            updated_at: new Date(),
          },
        ],
        rowCount: 1,
        command: 'INSERT',
        oid: 0,
        fields: [],
      };

      mockPool.query.mockResolvedValueOnce(mockResult);

      const result = await repository.createDistributionRun(input);

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringMatching(/INSERT\s+INTO\s+distributions/i),
        ['offering-123', 'period-456', '10000.50', expect.any(Date), 'pending']
      );
      expect(result.id).toBe('run-123');
    });
  });

  describe('findRunByParams', () => {
    it('should return a run if parameters match', async () => {
      const mockRun = {
        id: 'run-123',
        offering_id: 'offering-123',
        period_id: 'period-456',
        total_amount: '1000.00',
        status: 'completed',
        run_at: new Date(),
      };

      mockPool.query.mockResolvedValueOnce({ rows: [mockRun] });

      const result = await repository.findRunByParams('offering-123', 'period-456', '1000.00');

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringMatching(/SELECT\s+\*\s+FROM\s+distributions/i),
        ['offering-123', 'period-456', '1000.00']
      );
      expect(result?.id).toBe('run-123');
    });
  });

  describe('getPayoutsForRun', () => {
    it('should return all payouts for a run', async () => {
      const mockPayouts = [{ id: 'p1', distribution_id: 'run-1', investor_id: 'i1', amount: '100.00' }];
      mockPool.query.mockResolvedValueOnce({ rows: mockPayouts });
      const result = await repository.getPayoutsForRun('run-1');
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringMatching(/FROM\s+distribution_payouts\s+WHERE\s+distribution_id\s+=\s+\$1/i),
        ['run-1']
      );
      expect(result).toHaveLength(1);
    });
  });

  describe('updateRunStatus', () => {
    it('should update the status of a run', async () => {
      mockPool.query.mockResolvedValueOnce({ rowCount: 1 });
      await repository.updateRunStatus('run-1', 'completed');
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringMatching(/UPDATE\s+distributions\s+SET\s+status\s+=\s+\$1/i),
        ['completed', 'run-1']
      );
    });
  });
});
