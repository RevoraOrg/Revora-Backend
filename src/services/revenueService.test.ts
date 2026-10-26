/** Revenue submission validation and transaction-bound persistence behavior. */

import { RevenueService, SubmitRevenueReportInput } from './revenueService';
import { ErrorCode } from '../lib/errors';
import { Pool, PoolClient } from 'pg';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockOffering = {
  id: 'offering-123',
  issuer_id: 'issuer-abc',
  title: 'Test Offering',
  status: 'active',
  amount: '1000000',
  created_at: new Date(),
};

const mockReport = {
  id: 'report-1',
  offering_id: 'offering-123',
  amount: '100.50',
  period_start: new Date('2023-01-01T00:00:00Z'),
  period_end: new Date('2023-01-31T23:59:59Z'),
  created_at: new Date(),
};

// OfferingRepository mock — exposes findById matching the real repo
const mockOfferingRepo = {
  findById: jest.fn(),
  getById: jest.fn(),
  listByIssuer: jest.fn(),
  countByIssuer: jest.fn(),
  create: jest.fn(),
  update: jest.fn(),
  delete: jest.fn(),
};

// RevenueReportRepository mock — exposes create + findOverlappingReport
const mockRevenueReportRepo = {
  create: jest.fn(),
  findOverlappingReport: jest.fn(),
  findById: jest.fn(),
  findByOfferingId: jest.fn(),
};

const mockTransactionClient = {
  query: jest.fn().mockResolvedValue({ rows: [] }),
  release: jest.fn(),
} as unknown as PoolClient;

const mockPool = {
  connect: jest.fn().mockResolvedValue(mockTransactionClient),
} as unknown as Pool;

const mockLedgerLockRepo = {
  isPeriodLocked: jest.fn(),
};

// ── Shared valid input ────────────────────────────────────────────────────────

const validInput: SubmitRevenueReportInput = {
  offeringId: 'offering-123',
  issuerId: 'issuer-abc',
  amount: '100.50',
  periodStart: new Date('2023-01-01T00:00:00Z'),
  periodEnd: new Date('2023-01-31T23:59:59Z'),
};

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('RevenueService', () => {
  let service: RevenueService;

  beforeEach(() => {
    jest.clearAllMocks();
    (mockPool.connect as jest.Mock).mockResolvedValue(mockTransactionClient);
    (mockTransactionClient.query as jest.Mock).mockResolvedValue({ rows: [] });
    service = new RevenueService(
      mockOfferingRepo as any,
      mockRevenueReportRepo as any,
      mockLedgerLockRepo as any,
      mockPool
    );
  });

  // ── Happy path ────────────────────────────────────────────────────────────

  describe('submitReport', () => {
    it('creates and returns a revenue report for valid input', async () => {
      mockOfferingRepo.findById.mockResolvedValue(mockOffering);
      mockRevenueReportRepo.findOverlappingReport.mockResolvedValue(null);
      mockLedgerLockRepo.isPeriodLocked.mockResolvedValue(false);
      mockRevenueReportRepo.create.mockResolvedValue(mockReport);

      const result = await service.submitReport(validInput);

      expect(result).toBeDefined();
      expect(result.id).toBe('report-1');
      expect(mockOfferingRepo.findById).toHaveBeenCalledWith('offering-123');
      expect(mockTransactionClient.query).toHaveBeenCalledWith(
        'SELECT pg_advisory_xact_lock(hashtext($1))',
        ['offering-123']
      );
      expect(mockRevenueReportRepo.findOverlappingReport).toHaveBeenCalledWith(
        'offering-123',
        validInput.periodStart,
        validInput.periodEnd,
        mockTransactionClient
      );
      expect(mockLedgerLockRepo.isPeriodLocked).toHaveBeenCalledWith(
        'offering-123',
        '2023-01-01',
        mockTransactionClient
      );
      expect(mockRevenueReportRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ offering_id: 'offering-123' }),
        mockTransactionClient
      );
    });

    // ── NOT NULL columns (migration 016) ────────────────────────────────────

    it('passes issuer_id and reported_by to the repository', async () => {
      mockOfferingRepo.findById.mockResolvedValue(mockOffering);
      mockRevenueReportRepo.findOverlappingReport.mockResolvedValue(null);
      mockLedgerLockRepo.isPeriodLocked.mockResolvedValue(false);
      mockRevenueReportRepo.create.mockResolvedValue(mockReport);

      await service.submitReport(validInput);

      expect(mockRevenueReportRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          issuer_id: 'issuer-abc',
          reported_by: 'issuer-abc',
        }),
        mockTransactionClient
      );
    });

    it('uses reportedBy for reported_by when provided', async () => {
      mockOfferingRepo.findById.mockResolvedValue(mockOffering);
      mockRevenueReportRepo.findOverlappingReport.mockResolvedValue(null);
      mockLedgerLockRepo.isPeriodLocked.mockResolvedValue(false);
      mockRevenueReportRepo.create.mockResolvedValue(mockReport);

      await service.submitReport({ ...validInput, reportedBy: 'user-xyz' });

      expect(mockRevenueReportRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          issuer_id: 'issuer-abc',
          reported_by: 'user-xyz',
        }),
        mockTransactionClient
      );
    });

    it('satisfies a repository that enforces the NOT NULL columns', async () => {
      mockOfferingRepo.findById.mockResolvedValue(mockOffering);
      mockRevenueReportRepo.findOverlappingReport.mockResolvedValue(null);
      mockLedgerLockRepo.isPeriodLocked.mockResolvedValue(false);
      mockRevenueReportRepo.create.mockImplementation(async (data: Record<string, unknown>) => {
        for (const column of ['issuer_id', 'reported_by']) {
          if (data[column] == null) {
            throw new Error(`null value in column "${column}" violates not-null constraint`);
          }
        }
        return mockReport;
      });

      await expect(service.submitReport(validInput)).resolves.toBe(mockReport);
    });

    // ── Offering not found ──────────────────────────────────────────────────

    it('throws NOT_FOUND when offering does not exist', async () => {
      mockOfferingRepo.findById.mockResolvedValue(null);

      await expect(service.submitReport(validInput)).rejects.toMatchObject({
        code: ErrorCode.NOT_FOUND,
      });
      expect(mockRevenueReportRepo.create).not.toHaveBeenCalled();
    });

    // ── Ownership guard ────────────────────────────────────────────────────

    it('throws FORBIDDEN when issuerId does not own the offering', async () => {
      mockOfferingRepo.findById.mockResolvedValue({
        ...mockOffering,
        issuer_id: 'someone-else',
      });

      await expect(service.submitReport(validInput)).rejects.toMatchObject({
        code: ErrorCode.FORBIDDEN,
      });
      expect(mockRevenueReportRepo.create).not.toHaveBeenCalled();
    });

    // ── Amount validation ──────────────────────────────────────────────────

    it('throws VALIDATION_ERROR for a non-numeric amount', async () => {
      mockOfferingRepo.findById.mockResolvedValue(mockOffering);

      await expect(
        service.submitReport({ ...validInput, amount: 'not-a-number' }),
      ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
    });

    it('throws VALIDATION_ERROR for zero amount', async () => {
      mockOfferingRepo.findById.mockResolvedValue(mockOffering);

      await expect(
        service.submitReport({ ...validInput, amount: '0' }),
      ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
    });

    it('throws VALIDATION_ERROR for negative amount', async () => {
      mockOfferingRepo.findById.mockResolvedValue(mockOffering);

      await expect(
        service.submitReport({ ...validInput, amount: '-50' }),
      ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
    });

    it('throws VALIDATION_ERROR when decimal places exceed 10', async () => {
      mockOfferingRepo.findById.mockResolvedValue(mockOffering);

      // 11 decimal places — exceeds the NUMERIC(30,10) limit
      await expect(
        service.submitReport({ ...validInput, amount: '1.00000000001' }),
      ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
    });

    it('throws VALIDATION_ERROR when integer digits exceed 20', async () => {
      mockOfferingRepo.findById.mockResolvedValue(mockOffering);

      // 21 integer digits
      await expect(
        service.submitReport({ ...validInput, amount: '999999999999999999999' }),
      ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
    });

    // ── Period validation ──────────────────────────────────────────────────

    it('throws VALIDATION_ERROR when periodEnd is before periodStart', async () => {
      mockOfferingRepo.findById.mockResolvedValue(mockOffering);

      await expect(
        service.submitReport({
          ...validInput,
          periodStart: new Date('2023-01-31T00:00:00Z'),
          periodEnd: new Date('2023-01-01T00:00:00Z'),
        }),
      ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
    });

    it('throws VALIDATION_ERROR when periodEnd equals periodStart', async () => {
      mockOfferingRepo.findById.mockResolvedValue(mockOffering);
      const same = new Date('2023-01-15T00:00:00Z');

      await expect(
        service.submitReport({ ...validInput, periodStart: same, periodEnd: same }),
      ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
    });

    // ── Overlap detection ──────────────────────────────────────────────────

    it('throws CONFLICT when period overlaps an existing report', async () => {
      mockOfferingRepo.findById.mockResolvedValue(mockOffering);
      mockLedgerLockRepo.isPeriodLocked.mockResolvedValue(false);
      mockRevenueReportRepo.findOverlappingReport.mockResolvedValue({ id: 'existing' });

      await expect(service.submitReport(validInput)).rejects.toMatchObject({
        code: ErrorCode.CONFLICT,
      });
      expect(mockRevenueReportRepo.create).not.toHaveBeenCalled();
      expect(mockRevenueReportRepo.findOverlappingReport).toHaveBeenCalledWith(
        'offering-123',
        validInput.periodStart,
        validInput.periodEnd,
        mockTransactionClient
      );
    });

    // ── Repository failure ─────────────────────────────────────────────────

    it('propagates errors thrown by create()', async () => {
      mockOfferingRepo.findById.mockResolvedValue(mockOffering);
      mockLedgerLockRepo.isPeriodLocked.mockResolvedValue(false);
      mockRevenueReportRepo.findOverlappingReport.mockResolvedValue(null);
      mockRevenueReportRepo.create.mockRejectedValue(new Error('DB connection lost'));

      await expect(service.submitReport(validInput)).rejects.toThrow('DB connection lost');
    });

    it('throws CONFLICT when the period lock is visible in the transaction', async () => {
      mockOfferingRepo.findById.mockResolvedValue(mockOffering);
      mockRevenueReportRepo.findOverlappingReport.mockResolvedValue(null);
      mockLedgerLockRepo.isPeriodLocked.mockResolvedValue(true);

      await expect(service.submitReport(validInput)).rejects.toMatchObject({
        code: ErrorCode.CONFLICT,
      });

      expect(mockRevenueReportRepo.findOverlappingReport).toHaveBeenCalledWith(
        'offering-123',
        validInput.periodStart,
        validInput.periodEnd,
        mockTransactionClient
      );
      expect(mockLedgerLockRepo.isPeriodLocked).toHaveBeenCalledWith(
        'offering-123',
        '2023-01-01',
        mockTransactionClient
      );
      expect(mockRevenueReportRepo.create).not.toHaveBeenCalled();
    });

    // ── Optional requestId ─────────────────────────────────────────────────

    it('succeeds with an optional requestId provided', async () => {
      mockOfferingRepo.findById.mockResolvedValue(mockOffering);
      mockRevenueReportRepo.findOverlappingReport.mockResolvedValue(null);
      mockLedgerLockRepo.isPeriodLocked.mockResolvedValue(false);
      mockRevenueReportRepo.create.mockResolvedValue(mockReport);

      await expect(
        service.submitReport({ ...validInput, requestId: 'req-abc-123' }),
      ).resolves.toBeDefined();
    });
  });
});
