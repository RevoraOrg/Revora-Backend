import {
  BalanceSnapshotService,
  BalanceProvider,
  HolderBalance,
  SnapshotBalancesInput,
  StellarBalanceClient,
} from './balanceSnapshotService';
import {
  BalanceSnapshotRepository,
  TokenBalanceSnapshot,
} from '../db/repositories/balanceSnapshotRepository';
import { OfferingRepository, Offering } from '../db/repositories/offeringRepository';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const PERIOD_END = new Date('2024-02-01T00:00:00.000Z');
const OTHER_PERIOD_END = new Date('2024-02-01T12:00:00.000Z');

const baseOffering: Offering = {
  id: 'offering-1',
  contract_address: 'CONTRACT_XYZ',
  status: 'active',
  total_raised: '0',
  created_at: new Date(),
  updated_at: new Date(),
} as any;

const makeSnapshot = (overrides: Partial<TokenBalanceSnapshot> = {}): TokenBalanceSnapshot => ({
  id: 'snap-1',
  offering_id: 'offering-1',
  period_id: '2024-01',
  holder_address_or_id: 'holder-1',
  balance: '100.00',
  snapshot_at: PERIOD_END,
  created_at: PERIOD_END,
  ...overrides,
});

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('BalanceSnapshotService', () => {
  let mockSnapshotRepo: jest.Mocked<BalanceSnapshotRepository>;
  let mockOfferingRepo: jest.Mocked<OfferingRepository>;
  let mockStellarClient: jest.Mocked<StellarBalanceClient>;
  let mockDbProvider: jest.Mocked<BalanceProvider>;
  let serviceWithDb: BalanceSnapshotService;
  let serviceWithStellar: BalanceSnapshotService;

  const defaultHolders: HolderBalance[] = [
    { holderAddressOrId: 'investor-1', balance: '50' },
    { holderAddressOrId: 'investor-2', balance: '150.25' },
  ];

  const defaultInput: SnapshotBalancesInput = {
    offeringId: 'offering-1',
    periodId: '2024-01',
  };

  beforeEach(() => {
    mockSnapshotRepo = {
      findByOfferingAndPeriod: jest.fn(),
      insertMany: jest.fn(),
    } as any;

    mockOfferingRepo = {
      findById: jest.fn(),
    } as any;

    mockStellarClient = {
      getOfferingState: jest.fn(),
      getHolderBalances: jest.fn(),
    } as any;

    mockDbProvider = {
      getBalances: jest.fn(),
    } as any;

    serviceWithDb = new BalanceSnapshotService(
      mockSnapshotRepo,
      mockOfferingRepo,
      undefined,
      mockDbProvider
    );

    serviceWithStellar = new BalanceSnapshotService(
      mockSnapshotRepo,
      mockOfferingRepo,
      mockStellarClient,
      undefined
    );

    jest.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // Input validation
  // -------------------------------------------------------------------------
  describe('Input Validation', () => {
    it('throws if offeringId is missing', async () => {
      await expect(
        serviceWithDb.snapshotBalances({ offeringId: '', periodId: '2024-01' })
      ).rejects.toThrow('offeringId is required');
    });

    it('throws if periodId is missing', async () => {
      await expect(
        serviceWithDb.snapshotBalances({ offeringId: 'offering-1', periodId: '' })
      ).rejects.toThrow('periodId is required');
    });

    it('throws if offering does not exist', async () => {
      mockOfferingRepo.findById.mockResolvedValueOnce(null);
      await expect(serviceWithDb.snapshotBalances(defaultInput)).rejects.toThrow(
        'Offering offering-1 not found'
      );
    });
  });

  // -------------------------------------------------------------------------
  // Deterministic snapshot_at pinning to period boundary
  // -------------------------------------------------------------------------
  describe('Period Boundary Pinning (Determinism)', () => {
    it('pins snapshot_at to periodEnd when snapshotAt is not supplied', async () => {
      mockOfferingRepo.findById.mockResolvedValueOnce(baseOffering);
      mockSnapshotRepo.findByOfferingAndPeriod.mockResolvedValueOnce([]);
      mockDbProvider.getBalances.mockResolvedValueOnce(defaultHolders);
      mockSnapshotRepo.insertMany.mockResolvedValueOnce([makeSnapshot()]);

      await serviceWithDb.snapshotBalances({
        ...defaultInput,
        periodEnd: PERIOD_END,
        skipIfExists: false,
      });

      const insertCall = mockSnapshotRepo.insertMany.mock.calls[0][0];
      expect(insertCall[0].snapshot_at).toEqual(PERIOD_END);
      expect(insertCall[1].snapshot_at).toEqual(PERIOD_END);
    });

    it('uses explicit snapshotAt over periodEnd when both are supplied', async () => {
      const explicitTs = new Date('2024-01-31T22:00:00.000Z');
      mockOfferingRepo.findById.mockResolvedValueOnce(baseOffering);
      mockSnapshotRepo.findByOfferingAndPeriod.mockResolvedValueOnce([]);
      mockDbProvider.getBalances.mockResolvedValueOnce(defaultHolders);
      mockSnapshotRepo.insertMany.mockResolvedValueOnce([makeSnapshot({ snapshot_at: explicitTs })]);

      await serviceWithDb.snapshotBalances({
        ...defaultInput,
        periodEnd: PERIOD_END,
        snapshotAt: explicitTs,
        skipIfExists: false,
      });

      const insertCall = mockSnapshotRepo.insertMany.mock.calls[0][0];
      expect(insertCall[0].snapshot_at).toEqual(explicitTs);
    });

    it('all rows in a single run share the same snapshot_at', async () => {
      const holders: HolderBalance[] = [
        { holderAddressOrId: 'h1', balance: '10' },
        { holderAddressOrId: 'h2', balance: '20' },
        { holderAddressOrId: 'h3', balance: '30' },
      ];

      mockOfferingRepo.findById.mockResolvedValueOnce(baseOffering);
      mockSnapshotRepo.findByOfferingAndPeriod.mockResolvedValueOnce([]);
      mockDbProvider.getBalances.mockResolvedValueOnce(holders);
      mockSnapshotRepo.insertMany.mockResolvedValueOnce(
        holders.map((h) => makeSnapshot({ holder_address_or_id: h.holderAddressOrId }))
      );

      await serviceWithDb.snapshotBalances({
        ...defaultInput,
        periodEnd: PERIOD_END,
        skipIfExists: false,
      });

      const insertCall = mockSnapshotRepo.insertMany.mock.calls[0][0];
      const timestamps = insertCall.map((r: any) => r.snapshot_at.getTime());
      expect(new Set(timestamps).size).toBe(1); // all identical
    });

    it('is deterministic across two identical re-runs (idempotent mode returns existing)', async () => {
      const existing = [makeSnapshot({ snapshot_at: PERIOD_END })];
      mockOfferingRepo.findById.mockResolvedValue(baseOffering);
      mockSnapshotRepo.findByOfferingAndPeriod.mockResolvedValue(existing);

      const run1 = await serviceWithDb.snapshotBalances({
        ...defaultInput,
        periodEnd: PERIOD_END,
      });

      const run2 = await serviceWithDb.snapshotBalances({
        ...defaultInput,
        periodEnd: PERIOD_END,
      });

      // No new rows inserted on either call
      expect(mockSnapshotRepo.insertMany).not.toHaveBeenCalled();
      // Both calls return the same committed snapshot
      expect(run1.snapshots).toEqual(run2.snapshots);
      expect(run1.snapshots[0].snapshot_at).toEqual(PERIOD_END);
    });
  });

  // -------------------------------------------------------------------------
  // Mismatch guard (re-run with a different snapshotAt rejected)
  // -------------------------------------------------------------------------
  describe('Mismatch Guard', () => {
    it('throws when a re-run supplies a different periodEnd from the committed snapshot_at', async () => {
      const existing = [makeSnapshot({ snapshot_at: PERIOD_END })];
      mockOfferingRepo.findById.mockResolvedValueOnce(baseOffering);
      mockSnapshotRepo.findByOfferingAndPeriod.mockResolvedValueOnce(existing);

      await expect(
        serviceWithDb.snapshotBalances({
          ...defaultInput,
          periodEnd: OTHER_PERIOD_END, // differs from committed PERIOD_END
        })
      ).rejects.toThrow('snapshot_at mismatch');
    });

    it('throws when a re-run supplies a different explicit snapshotAt from the committed value', async () => {
      const existing = [makeSnapshot({ snapshot_at: PERIOD_END })];
      mockOfferingRepo.findById.mockResolvedValueOnce(baseOffering);
      mockSnapshotRepo.findByOfferingAndPeriod.mockResolvedValueOnce(existing);

      await expect(
        serviceWithDb.snapshotBalances({
          ...defaultInput,
          snapshotAt: OTHER_PERIOD_END, // differs from committed PERIOD_END
        })
      ).rejects.toThrow('snapshot_at mismatch');
    });

    it('mismatch error includes committed and requested timestamps', async () => {
      const existing = [makeSnapshot({ snapshot_at: PERIOD_END })];
      mockOfferingRepo.findById.mockResolvedValueOnce(baseOffering);
      mockSnapshotRepo.findByOfferingAndPeriod.mockResolvedValueOnce(existing);

      await expect(
        serviceWithDb.snapshotBalances({
          ...defaultInput,
          periodEnd: OTHER_PERIOD_END,
        })
      ).rejects.toThrow(PERIOD_END.toISOString());
    });

    it('does NOT enforce mismatch guard when neither snapshotAt nor periodEnd is supplied', async () => {
      // Caller provided no timestamp => non-deterministic mode; guard is intentionally skipped
      const existing = [makeSnapshot({ snapshot_at: PERIOD_END })];
      mockOfferingRepo.findById.mockResolvedValueOnce(baseOffering);
      mockSnapshotRepo.findByOfferingAndPeriod.mockResolvedValueOnce(existing);

      const result = await serviceWithDb.snapshotBalances(defaultInput);

      expect(mockSnapshotRepo.insertMany).not.toHaveBeenCalled();
      expect(result.snapshots).toEqual(existing);
    });

    it('does NOT throw when re-run supplies matching periodEnd', async () => {
      const existing = [makeSnapshot({ snapshot_at: PERIOD_END })];
      mockOfferingRepo.findById.mockResolvedValueOnce(baseOffering);
      mockSnapshotRepo.findByOfferingAndPeriod.mockResolvedValueOnce(existing);

      const result = await serviceWithDb.snapshotBalances({
        ...defaultInput,
        periodEnd: PERIOD_END, // same as committed
      });

      expect(result.snapshots).toEqual(existing);
      expect(mockSnapshotRepo.insertMany).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Idempotent mode (skipIfExists = true, the default)
  // -------------------------------------------------------------------------
  describe('Idempotent Mode (skipIfExists = true)', () => {
    it('returns existing snapshots without inserting new rows', async () => {
      const existing = [makeSnapshot()];
      mockOfferingRepo.findById.mockResolvedValueOnce(baseOffering);
      mockSnapshotRepo.findByOfferingAndPeriod.mockResolvedValueOnce(existing);

      const result = await serviceWithDb.snapshotBalances(defaultInput);

      expect(mockSnapshotRepo.findByOfferingAndPeriod).toHaveBeenCalledWith(
        'offering-1',
        '2024-01'
      );
      expect(mockSnapshotRepo.insertMany).not.toHaveBeenCalled();
      expect(result.snapshots).toEqual(existing);
    });
  });

  // -------------------------------------------------------------------------
  // Non-idempotent mode (skipIfExists = false)
  // -------------------------------------------------------------------------
  describe('Non-idempotent Mode (skipIfExists = false)', () => {
    it('always inserts a fresh snapshot, never consults the existing rows', async () => {
      mockOfferingRepo.findById.mockResolvedValueOnce(baseOffering);
      mockDbProvider.getBalances.mockResolvedValueOnce(defaultHolders);
      mockSnapshotRepo.insertMany.mockResolvedValueOnce([makeSnapshot()]);

      await serviceWithDb.snapshotBalances({
        ...defaultInput,
        skipIfExists: false,
      });

      expect(mockSnapshotRepo.findByOfferingAndPeriod).not.toHaveBeenCalled();
      expect(mockSnapshotRepo.insertMany).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // DST (Daylight Saving Time) period boundary edge case
  // -------------------------------------------------------------------------
  describe('DST Boundary Edge Case', () => {
    it('preserves UTC millisecond precision across a DST transition boundary', async () => {
      // Europe/London clocks go forward at 2024-03-31T01:00:00Z
      const dstBoundary = new Date('2024-03-31T01:00:00.000Z');

      mockOfferingRepo.findById.mockResolvedValueOnce(baseOffering);
      mockSnapshotRepo.findByOfferingAndPeriod.mockResolvedValueOnce([]);
      mockDbProvider.getBalances.mockResolvedValueOnce([
        { holderAddressOrId: 'dst-holder', balance: '42' },
      ]);
      mockSnapshotRepo.insertMany.mockResolvedValueOnce([
        makeSnapshot({ snapshot_at: dstBoundary }),
      ]);

      await serviceWithDb.snapshotBalances({
        ...defaultInput,
        periodEnd: dstBoundary,
        skipIfExists: false,
      });

      const insertCall = mockSnapshotRepo.insertMany.mock.calls[0][0];
      expect(insertCall[0].snapshot_at.getTime()).toBe(dstBoundary.getTime());
    });
  });

  // -------------------------------------------------------------------------
  // Empty holder set
  // -------------------------------------------------------------------------
  describe('Empty Holder Set', () => {
    it('throws when no balances are returned from DB source', async () => {
      mockOfferingRepo.findById.mockResolvedValueOnce(baseOffering);
      mockSnapshotRepo.findByOfferingAndPeriod.mockResolvedValueOnce([]);
      mockDbProvider.getBalances.mockResolvedValueOnce([]);

      await expect(
        serviceWithDb.snapshotBalances({
          ...defaultInput,
          source: 'db',
          skipIfExists: false,
        })
      ).rejects.toThrow('No balances found for offering offering-1 and period 2024-01');
    });

    it('throws when all balances have zero or negative amounts (filtered out)', async () => {
      mockOfferingRepo.findById.mockResolvedValueOnce(baseOffering);
      mockSnapshotRepo.findByOfferingAndPeriod.mockResolvedValueOnce([]);
      mockDbProvider.getBalances.mockResolvedValueOnce([
        { holderAddressOrId: 'h1', balance: '0' },
        { holderAddressOrId: 'h2', balance: '-10' },
      ]);

      await expect(
        serviceWithDb.snapshotBalances({
          ...defaultInput,
          source: 'db',
          skipIfExists: false,
        })
      ).rejects.toThrow('No balances found');
    });
  });

  // -------------------------------------------------------------------------
  // Balance source routing
  // -------------------------------------------------------------------------
  describe('Balance Source Routing', () => {
    it('uses DB balance provider when source is db', async () => {
      mockOfferingRepo.findById.mockResolvedValueOnce(baseOffering);
      mockSnapshotRepo.findByOfferingAndPeriod.mockResolvedValueOnce([]);
      mockDbProvider.getBalances.mockResolvedValueOnce(defaultHolders);
      mockSnapshotRepo.insertMany.mockResolvedValueOnce([makeSnapshot()]);

      const result = await serviceWithDb.snapshotBalances({
        ...defaultInput,
        source: 'db',
        skipIfExists: false,
      });

      expect(mockDbProvider.getBalances).toHaveBeenCalledWith('offering-1', '2024-01');
      expect(result.fromSource).toBe('db');
    });

    it('uses Stellar client when source is stellar', async () => {
      mockOfferingRepo.findById.mockResolvedValueOnce(baseOffering);
      mockSnapshotRepo.findByOfferingAndPeriod.mockResolvedValueOnce([]);
      mockStellarClient.getHolderBalances.mockResolvedValueOnce([
        { holderAddressOrId: 'GABC123', balance: '10.5' },
      ]);
      mockSnapshotRepo.insertMany.mockResolvedValueOnce([makeSnapshot()]);

      const result = await serviceWithStellar.snapshotBalances({
        ...defaultInput,
        source: 'stellar',
        skipIfExists: false,
      });

      expect(mockStellarClient.getHolderBalances).toHaveBeenCalledWith('CONTRACT_XYZ', '2024-01');
      expect(result.fromSource).toBe('stellar');
    });

    it('throws when DB source selected but provider is not configured', async () => {
      mockOfferingRepo.findById.mockResolvedValueOnce(baseOffering);
      mockSnapshotRepo.findByOfferingAndPeriod.mockResolvedValueOnce([]);

      const service = new BalanceSnapshotService(
        mockSnapshotRepo,
        mockOfferingRepo,
        mockStellarClient,
        undefined
      );

      await expect(
        service.snapshotBalances({ ...defaultInput, source: 'db', skipIfExists: false })
      ).rejects.toThrow('DB balance provider is not configured');
    });

    it('throws when stellar source selected but client is not configured', async () => {
      mockOfferingRepo.findById.mockResolvedValueOnce(baseOffering);
      mockSnapshotRepo.findByOfferingAndPeriod.mockResolvedValueOnce([]);

      const service = new BalanceSnapshotService(
        mockSnapshotRepo,
        mockOfferingRepo,
        undefined,
        mockDbProvider
      );

      await expect(
        service.snapshotBalances({ ...defaultInput, source: 'stellar', skipIfExists: false })
      ).rejects.toThrow('Stellar/Soroban client is not configured');
    });
  });
});
