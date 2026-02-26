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
});
