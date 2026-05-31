import { QueryResult } from 'pg';
import {
  CreateRevenueReportInput,
  RevenueReport,
  RevenueReportRepository,
} from './revenueReportRepository';

type RevenueReportRow = RevenueReport;

const mockQuery = jest.fn();
const mockPool = {
  query: mockQuery,
} as any;

describe('RevenueReportRepository', () => {
  let repository: RevenueReportRepository;

  const mockReport: RevenueReportRow = {
    id: 'report-1',
    offering_id: 'offering-1',
    period_id: 'period-1',
    total_revenue: '25000.00',
    created_at: new Date('2025-01-10T00:00:00.000Z'),
    updated_at: new Date('2025-01-10T00:00:00.000Z'),
  };

  beforeEach(() => {
    jest.clearAllMocks();

    repository = new RevenueReportRepository(mockPool);
  });

  describe('create', () => {
    it('creates a revenue report', async () => {
      const input: CreateRevenueReportInput = {
        offering_id: 'offering-1',
        period_id: 'period-1',
        total_revenue: '25000.00',
      };

      const mockResult: QueryResult<RevenueReportRow> = {
        rows: [mockReport],
        rowCount: 1,
        command: 'INSERT',
        oid: 0,
        fields: [],
      };

      mockPool.query.mockResolvedValueOnce(mockResult);

      const result = await repository.create(input);

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO revenue_reports'),
        ['offering-1', 'period-1', '25000.00']
      );
      expect(result.id).toBe('report-1');
      expect(result.offering_id).toBe('offering-1');
      expect(result.period_id).toBe('period-1');
      expect(result.total_revenue).toBe('25000.00');
    });

    it('throws if insert returns no rows', async () => {
      const input: CreateRevenueReportInput = {
        offering_id: 'offering-1',
        period_id: 'period-1',
        total_revenue: '25000.00',
      };

      const mockResult: QueryResult<RevenueReportRow> = {
        rows: [],
        rowCount: 0,
        command: 'INSERT',
        oid: 0,
        fields: [],
      };

      mockPool.query.mockResolvedValueOnce(mockResult);

      await expect(repository.create(input)).rejects.toThrow(
        'Failed to create revenue report'
      );
    });
  });

  describe('getByOfferingAndPeriod', () => {
    it('returns matching report', async () => {
      const mockResult: QueryResult<RevenueReportRow> = {
        rows: [mockReport],
        rowCount: 1,
        command: 'SELECT',
        oid: 0,
        fields: [],
      };

      mockPool.query.mockResolvedValueOnce(mockResult);

      const result = await repository.getByOfferingAndPeriod('offering-1', 'period-1');

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('FROM revenue_reports'),
        ['offering-1', 'period-1']
      );
      expect(result?.id).toBe('report-1');
    });

    it('returns null when not found', async () => {
      const mockResult: QueryResult<RevenueReportRow> = {
        rows: [],
        rowCount: 0,
        command: 'SELECT',
        oid: 0,
        fields: [],
      };

      mockPool.query.mockResolvedValueOnce(mockResult);

      const result = await repository.getByOfferingAndPeriod('offering-1', 'period-1');
      expect(result).toBeNull();
    });
  });

  describe('listByOffering', () => {
    it('returns all reports for an offering', async () => {
      const secondReport: RevenueReportRow = {
        ...mockReport,
        id: 'report-2',
        period_id: 'period-2',
      };

      const mockResult: QueryResult<RevenueReportRow> = {
        rows: [mockReport, secondReport],
        rowCount: 2,
        command: 'SELECT',
        oid: 0,
        fields: [],
      };

      mockPool.query.mockResolvedValueOnce(mockResult);

      const result = await repository.listByOffering('offering-1');

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('WHERE offering_id = $1'),
        ['offering-1']
      );
      expect(result).toHaveLength(2);
      expect(result[0].offering_id).toBe('offering-1');
    });
  });

  describe('distribution status lifecycle', () => {
    it('claims an approved report for distribution', async () => {
      const mockResult: QueryResult<RevenueReportRow> = {
        rows: [{
          ...mockReport,
          distribution_status: 'in_progress',
          distribution_status_updated_at: new Date('2025-01-10T00:00:00.000Z'),
        }],
        rowCount: 1,
        command: 'UPDATE',
        oid: 0,
        fields: [],
      };

      mockPool.query.mockResolvedValueOnce(mockResult);

      const result = await repository.claimApprovedReportForDistribution('report-1');

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE revenue_reports'),
        ['report-1']
      );
      expect(result?.distribution_status).toBe('in_progress');
    });

    it('returns null when a report cannot be claimed', async () => {
      const mockResult: QueryResult<RevenueReportRow> = {
        rows: [],
        rowCount: 0,
        command: 'UPDATE',
        oid: 0,
        fields: [],
      };

      mockPool.query.mockResolvedValueOnce(mockResult);

      const result = await repository.claimApprovedReportForDistribution('report-1');

      expect(result).toBeNull();
    });

    it('marks a reported distribution as completed', async () => {
      const mockResult: QueryResult<RevenueReportRow> = {
        rows: [{ id: 'report-1' } as any],
        rowCount: 1,
        command: 'UPDATE',
        oid: 0,
        fields: [],
      };

      mockPool.query.mockResolvedValueOnce(mockResult);

      await repository.markReportDistributionCompleted('report-1');

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('SET distribution_status = '),
        ['report-1']
      );
    });

    it('marks a reported distribution as failed', async () => {
      const mockResult: QueryResult<RevenueReportRow> = {
        rows: [{ id: 'report-1' } as any],
        rowCount: 1,
        command: 'UPDATE',
        oid: 0,
        fields: [],
      };

      mockPool.query.mockResolvedValueOnce(mockResult);

      await repository.markReportDistributionFailed('report-1');

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('SET distribution_status = '),
        ['report-1']
      );
    });
  });
});
