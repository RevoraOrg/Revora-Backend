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
        ['offering-123', 'period-456', '10000.50', expect.any(Date), 'pending', null]
      );
      expect(result.id).toBe('run-123');
    });

    it('should create a distribution run with frozen_fx_rate_id', async () => {
      const input: CreateDistributionRunInput = {
        offering_id: 'offering-123',
        period_id: 'period-456',
        total_amount: '10000.50',
        frozen_fx_rate_id: 'rate-frozen-99',
      };

      const mockResult: QueryResult<DistributionRun> = {
        rows: [
          {
            id: 'run-123',
            offering_id: 'offering-123',
            period_id: 'period-456',
            total_amount: '10000.50',
            status: 'pending',
            frozen_fx_rate_id: 'rate-frozen-99',
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
        ['offering-123', 'period-456', '10000.50', expect.any(Date), 'pending', 'rate-frozen-99']
      );
      expect(result.frozen_fx_rate_id).toBe('rate-frozen-99');
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

  describe('createPayout', () => {
    it('should create a payout with frozen_fx_rate_id', async () => {
      const input: CreatePayoutInput = {
        distribution_id: 'run-1',
        investor_id: 'inv-1',
        amount: '250.00',
        frozen_fx_rate_id: 'rate-frozen-42',
      };

      const mockPayoutRow = {
        id: 'p-1',
        distribution_id: 'run-1',
        investor_id: 'inv-1',
        amount: '250.00',
        status: 'pending',
        frozen_fx_rate_id: 'rate-frozen-42',
        created_at: new Date(),
        updated_at: new Date(),
      };

      mockPool.query.mockResolvedValueOnce({ rows: [mockPayoutRow] });

      const result = await repository.createPayout(input);

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringMatching(/INSERT\s+INTO\s+distribution_payouts/i),
        ['run-1', 'inv-1', '250.00', 'pending', null, 'rate-frozen-42']
      );
      expect(result.frozen_fx_rate_id).toBe('rate-frozen-42');
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

  describe('listByPeriod', () => {
    it('lists distribution runs for a period ordered by run_at ascending', async () => {
      const runs = [
        {
          id: 'run-1',
          offering_id: 'off-1',
          period_id: '2026-07',
          total_amount: '500.00',
          status: 'completed',
          run_at: new Date('2026-07-14T00:00:00.000Z'),
          created_at: new Date(),
          updated_at: new Date(),
        },
      ];
      mockPool.query.mockResolvedValueOnce({ rows: runs });
      const result = await repository.listByPeriod('2026-07');
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringMatching(/FROM\s+distributions\s+WHERE\s+period_id\s+=\s+\$1/i),
        ['2026-07']
      );
      expect(result).toHaveLength(1);
      expect(result[0].total_amount).toBe('500.00');
    });

    it('returns empty array when no runs exist for the period', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] });
      expect(await repository.listByPeriod('1999-01')).toEqual([]);
    });
  });

  describe('listPayoutsByInvestorForPeriod', () => {
    it('joins payouts to distributions on period_id', async () => {
      const payouts = [
        {
          id: 'p1',
          distribution_id: 'run-1',
          investor_id: 'inv-1',
          amount: '120.00',
          status: 'processed',
          created_at: new Date(),
          updated_at: new Date(),
        },
      ];
      mockPool.query.mockResolvedValueOnce({ rows: payouts });
      const result = await repository.listPayoutsByInvestorForPeriod('inv-1', '2026-07');
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringMatching(/INNER\s+JOIN\s+distributions\s+d\s+ON\s+d\.id\s+=\s+p\.distribution_id/i),
        ['inv-1', '2026-07']
      );
      expect(result).toHaveLength(1);
      expect(result[0].amount).toBe('120.00');
    });
  });

  describe('listPayoutsByPeriod', () => {
    it('lists all payouts for a period', async () => {
      const payouts = [{ id: 'p1', amount: '10.00' }, { id: 'p2', amount: '20.00' }];
      mockPool.query.mockResolvedValueOnce({ rows: payouts });
      const result = await repository.listPayoutsByPeriod('2026-07');
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringMatching(/WHERE\s+d\.period_id\s+=\s+\$1/i),
        ['2026-07']
      );
      expect(result).toHaveLength(2);
    });
  });
});
