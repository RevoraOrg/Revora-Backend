import { PayoutDriftDetector } from './payoutDriftDetector';
import { MetricsCollector } from '../lib/metrics';
import {
  PayoutDriftRepository,
  PayoutForVerification,
  DriftDetail,
} from '../db/repositories/payoutDriftRepository';
import { StellarTransactionVerifier } from '../lib/stellarTransactionVerifier';

function makeMockRepo(): jest.Mocked<PayoutDriftRepository> {
  return {
    getPayoutsByOffering: jest.fn(),
    getAggregatedDriftSummary: jest.fn(),
    saveReport: jest.fn(),
    getPayoutsForVerification: jest.fn(),
    getProcessedPayoutsWithoutTxHash: jest.fn(),
    getPayoutsWithDuplicateTxHashes: jest.fn(),
    getLatestReport: jest.fn(),
    getReportsSince: jest.fn(),
  } as any;
}

function makeMockVerifier(): jest.Mocked<StellarTransactionVerifier> {
  return {
    verifyTransaction: jest.fn(),
  } as any;
}

function makePayout(overrides: Partial<PayoutForVerification> = {}): PayoutForVerification {
  const now = new Date();
  return {
    id: overrides.id ?? 'payout-001',
    distribution_id: overrides.distribution_id ?? 'dist-001',
    investor_id: overrides.investor_id ?? 'inv-001',
    amount: overrides.amount ?? '100.00',
    status: overrides.status ?? 'processed',
    tx_hash: overrides.tx_hash ?? 'tx-hash-001',
    created_at: overrides.created_at ?? now,
    updated_at: overrides.updated_at ?? now,
    ...overrides,
  };
}

describe('PayoutDriftDetector', () => {
  let metrics: MetricsCollector;
  let mockRepo: jest.Mocked<PayoutDriftRepository>;
  let mockVerifier: jest.Mocked<StellarTransactionVerifier>;
  let detector: PayoutDriftDetector;

  beforeEach(() => {
    metrics = new MetricsCollector({ enabled: true, enablePIIDetection: false });
    mockRepo = makeMockRepo();
    mockVerifier = makeMockVerifier();

    detector = new PayoutDriftDetector(
      {} as any,
      mockRepo,
      metrics,
      mockVerifier,
      { intervalMs: 999999, driftThresholdHours: 24 }
    );
  });

  afterEach(() => {
    detector.stop();
  });

  describe('runDriftDetection', () => {
    it('returns zero counts when no payouts exist', async () => {
      mockRepo.getPayoutsByOffering.mockResolvedValue([]);
      mockRepo.getAggregatedDriftSummary.mockResolvedValue({
        total_missing: 0,
        total_underfunded: 0,
        total_overfunded: 0,
        total_duplicate_tx: 0,
        total_drift_amount: '0',
        oldest_drift_hours: 0,
      });

      const result = await detector.runDriftDetection();

      expect(result.offeringsChecked).toBe(0);
      expect(result.totalMissing).toBe(0);
      expect(result.totalUnderfunded).toBe(0);
      expect(result.totalOverfunded).toBe(0);
      expect(result.totalDuplicateTx).toBe(0);
      expect(result.alarmRaised).toBe(false);
      expect(mockRepo.saveReport).not.toHaveBeenCalled();
    });

    it('detects missing tx_hash on processed payouts', async () => {
      const noTxPayout = makePayout({
        id: 'payout-001',
        investor_id: 'inv-001',
        amount: '100.00',
        tx_hash: null,
        created_at: new Date(Date.now() - 48 * 3600000),
      });

      mockRepo.getPayoutsByOffering.mockResolvedValue([
        { offering_id: 'offering-001', payouts: [noTxPayout] },
      ]);
      mockRepo.getAggregatedDriftSummary.mockResolvedValue({
        total_missing: 1,
        total_underfunded: 0,
        total_overfunded: 0,
        total_duplicate_tx: 0,
        total_drift_amount: '100.00',
        oldest_drift_hours: 48,
      });

      const result = await detector.runDriftDetection();

      expect(result.offeringsChecked).toBe(1);
      expect(result.totalMissing).toBe(1);
      expect(result.alarmRaised).toBe(true);
      expect(mockRepo.saveReport).toHaveBeenCalledWith(
        expect.objectContaining({
          offering_id: 'offering-001',
          missing_count: 1,
          total_payouts: 1,
          verified_count: 0,
        })
      );
    });

    it('detects duplicate tx_hash across payouts', async () => {
      const payout1 = makePayout({
        id: 'payout-001',
        investor_id: 'inv-001',
        amount: '100.00',
        tx_hash: 'duplicate-hash',
      });
      const payout2 = makePayout({
        id: 'payout-002',
        investor_id: 'inv-002',
        amount: '100.00',
        tx_hash: 'duplicate-hash',
      });

      mockRepo.getPayoutsByOffering.mockResolvedValue([
        { offering_id: 'offering-001', payouts: [payout1, payout2] },
      ]);
      mockRepo.getAggregatedDriftSummary.mockResolvedValue({
        total_missing: 0,
        total_underfunded: 0,
        total_overfunded: 0,
        total_duplicate_tx: 1,
        total_drift_amount: '0',
        oldest_drift_hours: 0,
      });

      const result = await detector.runDriftDetection();

      expect(result.totalDuplicateTx).toBe(1);
      expect(mockRepo.saveReport).toHaveBeenCalledWith(
        expect.objectContaining({
          duplicate_tx_count: 1,
        })
      );
    });

    it('detects underfunded payouts via on-chain verification', async () => {
      const payout = makePayout({
        id: 'payout-001',
        investor_id: 'inv-001',
        amount: '100.00',
        tx_hash: 'real-hash',
      });

      mockVerifier.verifyTransaction.mockResolvedValue({
        isValid: false,
        actualAmount: '95.00',
        timestamp: new Date().toISOString(),
        errors: ['Transaction amount mismatch'],
      });

      mockRepo.getPayoutsByOffering.mockResolvedValue([
        { offering_id: 'offering-001', payouts: [payout] },
      ]);
      mockRepo.getAggregatedDriftSummary.mockResolvedValue({
        total_missing: 0,
        total_underfunded: 1,
        total_overfunded: 0,
        total_duplicate_tx: 0,
        total_drift_amount: '5.00',
        oldest_drift_hours: 0,
      });

      const result = await detector.runDriftDetection();

      expect(result.totalUnderfunded).toBe(1);
      expect(mockVerifier.verifyTransaction).toHaveBeenCalledWith('real-hash', '100.00');
    });

    it('detects overfunded payouts via on-chain verification', async () => {
      const payout = makePayout({
        id: 'payout-001',
        investor_id: 'inv-001',
        amount: '100.00',
        tx_hash: 'real-hash',
      });

      mockVerifier.verifyTransaction.mockResolvedValue({
        isValid: false,
        actualAmount: '105.00',
        timestamp: new Date().toISOString(),
        errors: ['Transaction amount mismatch'],
      });

      mockRepo.getPayoutsByOffering.mockResolvedValue([
        { offering_id: 'offering-001', payouts: [payout] },
      ]);
      mockRepo.getAggregatedDriftSummary.mockResolvedValue({
        total_missing: 0,
        total_underfunded: 0,
        total_overfunded: 1,
        total_duplicate_tx: 0,
        total_drift_amount: '5.00',
        oldest_drift_hours: 0,
      });

      const result = await detector.runDriftDetection();

      expect(result.totalOverfunded).toBe(1);
    });

    it('handles on-chain verification errors gracefully', async () => {
      const payout = makePayout({
        id: 'payout-001',
        investor_id: 'inv-001',
        amount: '100.00',
        tx_hash: 'error-hash',
      });

      mockVerifier.verifyTransaction.mockRejectedValue(new Error('RPC timeout'));

      mockRepo.getPayoutsByOffering.mockResolvedValue([
        { offering_id: 'offering-001', payouts: [payout] },
      ]);
      mockRepo.getAggregatedDriftSummary.mockResolvedValue({
        total_missing: 0,
        total_underfunded: 0,
        total_overfunded: 0,
        total_duplicate_tx: 0,
        total_drift_amount: '0',
        oldest_drift_hours: 0,
      });

      const result = await detector.runDriftDetection();

      expect(result.errors).toHaveLength(0);
      // Verification errors are skipped (logged) — no drift detail is recorded,
      // so no report is persisted for a clean single-payout that only failed RPC.
      expect(mockRepo.saveReport).not.toHaveBeenCalled();
    });

    it('sets alarm when drift is older than threshold', async () => {
      const oldPayout = makePayout({
        id: 'payout-001',
        investor_id: 'inv-001',
        amount: '100.00',
        tx_hash: null,
        created_at: new Date(Date.now() - 48 * 3600000),
      });

      mockRepo.getPayoutsByOffering.mockResolvedValue([
        { offering_id: 'offering-001', payouts: [oldPayout] },
      ]);
      mockRepo.getAggregatedDriftSummary.mockResolvedValue({
        total_missing: 1,
        total_underfunded: 0,
        total_overfunded: 0,
        total_duplicate_tx: 0,
        total_drift_amount: '100.00',
        oldest_drift_hours: 48,
      });

      const result = await detector.runDriftDetection();

      expect(result.alarmRaised).toBe(true);
    });

    it('clears alarm when no drift exists', async () => {
      mockRepo.getPayoutsByOffering.mockResolvedValue([]);
      mockRepo.getAggregatedDriftSummary.mockResolvedValue({
        total_missing: 0,
        total_underfunded: 0,
        total_overfunded: 0,
        total_duplicate_tx: 0,
        total_drift_amount: '0',
        oldest_drift_hours: 0,
      });

      await detector.runDriftDetection();

      expect(metrics.exportPrometheus()).toMatch(/payout_drift_alarm(\{\})? 0/);
    });

    it('handles multiple offerings independently', async () => {
      const offering1Payouts = [
        makePayout({ id: 'p1', investor_id: 'inv-1', amount: '50.00', tx_hash: null }),
      ];
      const offering2Payouts = [
        makePayout({ id: 'p2', investor_id: 'inv-2', amount: '75.00', tx_hash: 'hash-2' }),
        makePayout({ id: 'p3', investor_id: 'inv-3', amount: '75.00', tx_hash: 'hash-2' }),
      ];

      mockRepo.getPayoutsByOffering.mockResolvedValue([
        { offering_id: 'offering-001', payouts: offering1Payouts },
        { offering_id: 'offering-002', payouts: offering2Payouts },
      ]);
      mockRepo.getAggregatedDriftSummary.mockResolvedValue({
        total_missing: 1,
        total_underfunded: 0,
        total_overfunded: 0,
        total_duplicate_tx: 1,
        total_drift_amount: '50.00',
        oldest_drift_hours: 0,
      });

      const result = await detector.runDriftDetection();

      expect(result.offeringsChecked).toBe(2);
      expect(mockRepo.saveReport).toHaveBeenCalledTimes(2);
    });

    it('reports repo-level errors without crashing', async () => {
      mockRepo.getPayoutsByOffering.mockRejectedValue(new Error('DB connection lost'));

      const result = await detector.runDriftDetection();

      expect(result.offeringsChecked).toBe(0);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain('DB connection lost');
    });

    it('emits metrics to MetricsCollector', async () => {
      const noTxPayout = makePayout({
        id: 'payout-001',
        tx_hash: null,
        amount: '100.00',
        created_at: new Date(Date.now() - 48 * 3600000),
      });

      mockRepo.getPayoutsByOffering.mockResolvedValue([
        { offering_id: 'offering-001', payouts: [noTxPayout] },
      ]);
      mockRepo.getAggregatedDriftSummary.mockResolvedValue({
        total_missing: 1,
        total_underfunded: 0,
        total_overfunded: 0,
        total_duplicate_tx: 0,
        total_drift_amount: '100.00',
        oldest_drift_hours: 48,
      });

      await detector.runDriftDetection();

      const promOutput = metrics.exportPrometheus();
      expect(promOutput).toContain('payout_drift_missing_total');
      expect(promOutput).toContain('payout_drift_alarm');
      expect(promOutput).toContain('payout_drift_oldest_age_hours');
    });
  });

  describe('start/stop lifecycle', () => {
    it('start() triggers an immediate run', async () => {
      mockRepo.getPayoutsByOffering.mockResolvedValue([]);
      mockRepo.getAggregatedDriftSummary.mockResolvedValue({
        total_missing: 0,
        total_underfunded: 0,
        total_overfunded: 0,
        total_duplicate_tx: 0,
        total_drift_amount: '0',
        oldest_drift_hours: 0,
      });

      detector.start();
      await new Promise((r) => setTimeout(r, 50));

      expect(mockRepo.getPayoutsByOffering).toHaveBeenCalled();
      detector.stop();
    });

    it('stop() clears the interval', () => {
      mockRepo.getPayoutsByOffering.mockResolvedValue([]);
      mockRepo.getAggregatedDriftSummary.mockResolvedValue({
        total_missing: 0,
        total_underfunded: 0,
        total_overfunded: 0,
        total_duplicate_tx: 0,
        total_drift_amount: '0',
        oldest_drift_hours: 0,
      });
      detector.start();
      const clearSpy = jest.spyOn(global, 'clearInterval');
      detector.stop();
      expect(clearSpy).toHaveBeenCalled();
      clearSpy.mockRestore();
    });

    it('start() replaces an existing interval', () => {
      mockRepo.getPayoutsByOffering.mockResolvedValue([]);
      mockRepo.getAggregatedDriftSummary.mockResolvedValue({
        total_missing: 0,
        total_underfunded: 0,
        total_overfunded: 0,
        total_duplicate_tx: 0,
        total_drift_amount: '0',
        oldest_drift_hours: 0,
      });

      detector.start();
      const firstInterval = (detector as any).intervalId;
      detector.start();
      const secondInterval = (detector as any).intervalId;

      expect(firstInterval).not.toBe(secondInterval);
      detector.stop();
    });
  });
});
