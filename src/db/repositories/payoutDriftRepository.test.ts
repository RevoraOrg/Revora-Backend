import { PayoutDriftRepository, CreateDriftReportInput, DriftDetail } from './payoutDriftRepository';

function makeMockPool() {
  const mockQuery = jest.fn();
  return {
    query: mockQuery,
  } as any;
}

describe('PayoutDriftRepository', () => {
  let mockPool: ReturnType<typeof makeMockPool>;
  let repo: PayoutDriftRepository;

  beforeEach(() => {
    mockPool = makeMockPool();
    repo = new PayoutDriftRepository(mockPool);
  });

  describe('saveReport', () => {
    it('inserts a drift report and returns it', async () => {
      const input: CreateDriftReportInput = {
        offering_id: 'offering-001',
        total_payouts: 10,
        verified_count: 8,
        missing_count: 1,
        underfunded_count: 1,
        overfunded_count: 0,
        duplicate_tx_count: 0,
        total_drift_amount: '100.00',
        oldest_drift_age_hours: 48,
        details: [
          {
            payout_id: 'payout-001',
            investor_id: 'inv-001',
            amount: '100.00',
            tx_hash: null,
            drift_type: 'missing',
            expected_amount: '100.00',
            actual_amount: '0',
            discrepancy: '100.00',
          },
        ],
      };

      const fakeRow = {
        id: 'report-001',
        run_at: new Date(),
        completed_at: new Date(),
        offering_id: 'offering-001',
        total_payouts: 10,
        verified_count: 8,
        missing_count: 1,
        underfunded_count: 1,
        overfunded_count: 0,
        duplicate_tx_count: 0,
        total_drift_amount: '100.00',
        oldest_drift_age_hours: '48',
        details: JSON.stringify(input.details),
        status: 'completed',
        error_message: null,
        created_at: new Date(),
      };

      mockPool.query.mockResolvedValue({ rows: [fakeRow] });

      const result = await repo.saveReport(input);

      expect(result.offering_id).toBe('offering-001');
      expect(result.missing_count).toBe(1);
      expect(result.details).toHaveLength(1);
      expect(result.details[0].drift_type).toBe('missing');
    });

    it('saves error status reports', async () => {
      const input: CreateDriftReportInput = {
        offering_id: 'offering-001',
        total_payouts: 0,
        verified_count: 0,
        missing_count: 0,
        underfunded_count: 0,
        overfunded_count: 0,
        duplicate_tx_count: 0,
        total_drift_amount: '0',
        oldest_drift_age_hours: 0,
        details: [],
        status: 'error',
        error_message: 'Verification failed',
      };

      const fakeRow = {
        id: 'report-002',
        run_at: new Date(),
        completed_at: new Date(),
        offering_id: 'offering-001',
        total_payouts: 0,
        verified_count: 0,
        missing_count: 0,
        underfunded_count: 0,
        overfunded_count: 0,
        duplicate_tx_count: 0,
        total_drift_amount: '0',
        oldest_drift_age_hours: '0',
        details: '[]',
        status: 'error',
        error_message: 'Verification failed',
        created_at: new Date(),
      };

      mockPool.query.mockResolvedValue({ rows: [fakeRow] });

      const result = await repo.saveReport(input);
      expect(result.status).toBe('error');
      expect(result.error_message).toBe('Verification failed');
    });
  });

  describe('getLatestReport', () => {
    it('returns null when no reports exist', async () => {
      mockPool.query.mockResolvedValue({ rows: [] });
      const result = await repo.getLatestReport('offering-001');
      expect(result).toBeNull();
    });

    it('returns the most recent report', async () => {
      const fakeRow = {
        id: 'report-001',
        run_at: new Date(),
        completed_at: new Date(),
        offering_id: 'offering-001',
        total_payouts: 5,
        verified_count: 3,
        missing_count: 2,
        underfunded_count: 0,
        overfunded_count: 0,
        duplicate_tx_count: 0,
        total_drift_amount: '200.00',
        oldest_drift_age_hours: '24',
        details: JSON.stringify([]),
        status: 'completed',
        error_message: null,
        created_at: new Date(),
      };

      mockPool.query.mockResolvedValue({ rows: [fakeRow] });

      const result = await repo.getLatestReport('offering-001');
      expect(result).not.toBeNull();
      expect(result!.offering_id).toBe('offering-001');
    });
  });

  describe('getProcessedPayoutsWithoutTxHash', () => {
    it('returns payouts with processed status and null tx_hash', async () => {
      const fakeRows = [
        {
          id: 'payout-001',
          distribution_id: 'dist-001',
          investor_id: 'inv-001',
          amount: '100.00',
          status: 'processed',
          tx_hash: null,
          created_at: new Date(),
          updated_at: new Date(),
        },
      ];

      mockPool.query.mockResolvedValue({ rows: fakeRows });

      const result = await repo.getProcessedPayoutsWithoutTxHash();
      expect(result).toHaveLength(1);
      expect(result[0].tx_hash).toBeNull();
      expect(result[0].status).toBe('processed');
    });
  });

  describe('getPayoutsWithDuplicateTxHashes', () => {
    it('groups payouts sharing the same tx_hash', async () => {
      mockPool.query
        .mockResolvedValueOnce({
          rows: [{ tx_hash: 'dup-hash', cnt: '2' }],
        })
        .mockResolvedValueOnce({
          rows: [
            {
              id: 'payout-001',
              distribution_id: 'dist-001',
              investor_id: 'inv-001',
              amount: '100.00',
              status: 'processed',
              tx_hash: 'dup-hash',
              created_at: new Date(),
              updated_at: new Date(),
            },
            {
              id: 'payout-002',
              distribution_id: 'dist-001',
              investor_id: 'inv-002',
              amount: '100.00',
              status: 'processed',
              tx_hash: 'dup-hash',
              created_at: new Date(),
              updated_at: new Date(),
            },
          ],
        });

      const result = await repo.getPayoutsWithDuplicateTxHashes();
      expect(result).toHaveLength(1);
      expect(result[0].tx_hash).toBe('dup-hash');
      expect(result[0].payouts).toHaveLength(2);
    });
  });

  describe('getAggregatedDriftSummary', () => {
    it('returns summary with zero values when no drift', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [{ cnt: '0' }] })
        .mockResolvedValueOnce({ rows: [{ cnt: '0' }] })
        .mockResolvedValueOnce({ rows: [{ oldest_hours: null }] });

      const result = await repo.getAggregatedDriftSummary();
      expect(result.total_missing).toBe(0);
      expect(result.total_duplicate_tx).toBe(0);
      expect(result.oldest_drift_hours).toBe(0);
    });

    it('returns correct drift counts', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [{ cnt: '3' }] })
        .mockResolvedValueOnce({ rows: [{ cnt: '1' }] })
        .mockResolvedValueOnce({ rows: [{ oldest_hours: '48.5' }] });

      const result = await repo.getAggregatedDriftSummary();
      expect(result.total_missing).toBe(3);
      expect(result.total_duplicate_tx).toBe(1);
      expect(result.oldest_drift_hours).toBeCloseTo(48.5);
    });
  });

  describe('getPayoutsByOffering', () => {
    it('groups payouts by offering_id', async () => {
      const fakeRows = [
        {
          id: 'p1', distribution_id: 'd1', investor_id: 'i1',
          amount: '100.00', status: 'processed', tx_hash: 'tx1',
          created_at: new Date(), updated_at: new Date(), offering_id: 'off-1',
        },
        {
          id: 'p2', distribution_id: 'd2', investor_id: 'i2',
          amount: '200.00', status: 'processed', tx_hash: null,
          created_at: new Date(), updated_at: new Date(), offering_id: 'off-2',
        },
      ];

      mockPool.query.mockResolvedValue({ rows: fakeRows });

      const result = await repo.getPayoutsByOffering();
      expect(result).toHaveLength(2);
      expect(result[0].offering_id).toBe('off-1');
      expect(result[1].offering_id).toBe('off-2');
      expect(result[0].payouts).toHaveLength(1);
      expect(result[1].payouts).toHaveLength(1);
    });

    it('returns empty when no processed payouts exist', async () => {
      mockPool.query.mockResolvedValue({ rows: [] });
      const result = await repo.getPayoutsByOffering();
      expect(result).toHaveLength(0);
    });
  });

  describe('getReportsSince', () => {
    it('returns reports newer than the specified hours', async () => {
      const fakeRows = [
        {
          id: 'r1', run_at: new Date(), completed_at: new Date(),
          offering_id: 'off-1', total_payouts: 5, verified_count: 3,
          missing_count: 1, underfunded_count: 0, overfunded_count: 0,
          duplicate_tx_count: 0, total_drift_amount: '100.00',
          oldest_drift_age_hours: '24', details: '[]',
          status: 'completed', error_message: null, created_at: new Date(),
        },
      ];

      mockPool.query.mockResolvedValue({ rows: fakeRows });

      const result = await repo.getReportsSince(24);
      expect(result).toHaveLength(1);
      expect(result[0].offering_id).toBe('off-1');
    });
  });
});
