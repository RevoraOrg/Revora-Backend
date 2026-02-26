import { BalanceSnapshotService, BalanceProvider, HolderBalance, SnapshotBalancesInput, StellarBalanceClient } from './balanceSnapshotService';
import { BalanceSnapshotRepository, TokenBalanceSnapshot } from '../db/repositories/balanceSnapshotRepository';
import { OfferingRepository, Offering } from '../db/repositories/offeringRepository';

describe('BalanceSnapshotService', () => {
  let mockSnapshotRepo: jest.Mocked<BalanceSnapshotRepository>;
  let mockOfferingRepo: jest.Mocked<OfferingRepository>;
  let mockStellarClient: jest.Mocked<StellarBalanceClient>;
  let mockDbProvider: jest.Mocked<BalanceProvider>;
  let serviceWithDb: BalanceSnapshotService;
  let serviceWithStellar: BalanceSnapshotService;

  const baseOffering: Offering = {
    id: 'offering-1',
    contract_address: 'CONTRACT_XYZ',
    status: 'active',
    total_raised: '0',
    created_at: new Date(),
    updated_at: new Date(),
  } as any;

  const baseSnapshot: TokenBalanceSnapshot = {
    id: 'snap-1',
    offering_id: 'offering-1',
    period_id: '2024-01',
    holder_address_or_id: 'holder-1',
    balance: '100.00',
    snapshot_at: new Date('2024-02-01T00:00:00.000Z'),
    created_at: new Date('2024-02-01T00:00:00.000Z'),
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
  });

  const defaultInput: SnapshotBalancesInput = {
    offeringId: 'offering-1',
    periodId: '2024-01',
  };

  it('throws if offering does not exist', async () => {
    mockOfferingRepo.findById.mockResolvedValueOnce(null);

    await expect(serviceWithDb.snapshotBalances(defaultInput)).rejects.toThrow(
      'Offering offering-1 not found'
    );
  });

  it('returns existing snapshots when skipIfExists is true (default)', async () => {
    mockOfferingRepo.findById.mockResolvedValueOnce(baseOffering);
    mockSnapshotRepo.findByOfferingAndPeriod.mockResolvedValueOnce([
      baseSnapshot,
    ]);

    const result = await serviceWithDb.snapshotBalances(defaultInput);

    expect(mockSnapshotRepo.findByOfferingAndPeriod).toHaveBeenCalledWith(
      'offering-1',
      '2024-01'
    );
    expect(mockSnapshotRepo.insertMany).not.toHaveBeenCalled();
    expect(result.snapshots).toEqual([baseSnapshot]);
  });

  it('uses DB balance provider when source is db', async () => {
    mockOfferingRepo.findById.mockResolvedValueOnce(baseOffering);
    mockSnapshotRepo.findByOfferingAndPeriod.mockResolvedValueOnce([]);

    const balances: HolderBalance[] = [
      { holderAddressOrId: 'investor-1', balance: '50' },
      { holderAddressOrId: 'investor-2', balance: '150.25' },
    ];

    mockDbProvider.getBalances.mockResolvedValueOnce(balances);

    const createdSnapshots: TokenBalanceSnapshot[] = [
      {
        ...baseSnapshot,
        id: 'snap-2',
        holder_address_or_id: 'investor-1',
        balance: '50',
      },
      {
        ...baseSnapshot,
        id: 'snap-3',
        holder_address_or_id: 'investor-2',
        balance: '150.25',
      },
    ];

    mockSnapshotRepo.insertMany.mockResolvedValueOnce(createdSnapshots);

    const result = await serviceWithDb.snapshotBalances({
      ...defaultInput,
      source: 'db',
      skipIfExists: false,
    });

    expect(mockDbProvider.getBalances).toHaveBeenCalledWith(
      'offering-1',
      '2024-01'
    );
    expect(mockSnapshotRepo.insertMany).toHaveBeenCalled();
    expect(result.snapshots).toEqual(createdSnapshots);
    expect(result.fromSource).toBe('db');
  });

  it('uses Stellar client when source is stellar', async () => {
    mockOfferingRepo.findById.mockResolvedValueOnce(baseOffering);
    mockSnapshotRepo.findByOfferingAndPeriod.mockResolvedValueOnce([]);

    const balances: HolderBalance[] = [
      { holderAddressOrId: 'GABC123', balance: '10.5' },
    ];

    mockStellarClient.getHolderBalances.mockResolvedValueOnce(balances);

    const createdSnapshots: TokenBalanceSnapshot[] = [
      {
        ...baseSnapshot,
        id: 'snap-4',
        holder_address_or_id: 'GABC123',
        balance: '10.5',
      },
    ];

    mockSnapshotRepo.insertMany.mockResolvedValueOnce(createdSnapshots);

    const result = await serviceWithStellar.snapshotBalances({
      ...defaultInput,
      source: 'stellar',
      skipIfExists: false,
    });

    expect(mockStellarClient.getHolderBalances).toHaveBeenCalledWith(
      'CONTRACT_XYZ',
      '2024-01'
    );
    expect(mockSnapshotRepo.insertMany).toHaveBeenCalled();
    expect(result.snapshots).toEqual(createdSnapshots);
    expect(result.fromSource).toBe('stellar');
  });

  it('throws if no balances returned from source', async () => {
    mockOfferingRepo.findById.mockResolvedValueOnce(baseOffering);
    mockSnapshotRepo.findByOfferingAndPeriod.mockResolvedValueOnce([]);
    mockDbProvider.getBalances.mockResolvedValueOnce([]);

    await expect(
      serviceWithDb.snapshotBalances({
        ...defaultInput,
        source: 'db',
        skipIfExists: false,
      })
    ).rejects.toThrow(
      'No balances found for offering offering-1 and period 2024-01'
    );
  });

  it('throws when DB source is selected but provider is not configured', async () => {
    mockOfferingRepo.findById.mockResolvedValueOnce(baseOffering);
    mockSnapshotRepo.findByOfferingAndPeriod.mockResolvedValueOnce([]);

    const service = new BalanceSnapshotService(
      mockSnapshotRepo,
      mockOfferingRepo,
      mockStellarClient,
      undefined
    );

    await expect(
      service.snapshotBalances({
        ...defaultInput,
        source: 'db',
        skipIfExists: false,
      })
    ).rejects.toThrow('DB balance provider is not configured');
  });

  it('throws when stellar source is selected but client is not configured', async () => {
    mockOfferingRepo.findById.mockResolvedValueOnce(baseOffering);
    mockSnapshotRepo.findByOfferingAndPeriod.mockResolvedValueOnce([]);

    const service = new BalanceSnapshotService(
      mockSnapshotRepo,
      mockOfferingRepo,
      undefined,
      mockDbProvider
    );

    await expect(
      service.snapshotBalances({
        ...defaultInput,
        source: 'stellar',
        skipIfExists: false,
      })
    ).rejects.toThrow('Stellar/Soroban client is not configured');
  });
});

