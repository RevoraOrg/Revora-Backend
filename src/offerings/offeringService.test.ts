import { DistributionRepository } from '../db/repositories/distributionRepository';
import { InvestmentRepository } from '../db/repositories/investmentRepository';
import { Offering } from '../db/repositories/offeringRepository';
import { Logger, LogLevel } from '../lib/logger';
import { OfferingSyncService, SyncResult } from '../services/offeringSyncService';
import { OfferingService } from './offeringService';

describe('OfferingService', () => {
  let service: OfferingService;
  let mockInvestmentRepo: jest.Mocked<Pick<InvestmentRepository, 'getAggregateStats'>>;
  let mockDistributionRepo: jest.Mocked<Pick<DistributionRepository, 'getAggregateStats'>>;
  let mockOfferingRepo: jest.Mocked<{
    listCatalog: jest.Mock<Promise<Offering[]>, [any]>;
    findById: jest.Mock<Promise<Offering | null>, [string]>;
    updateStatus: jest.Mock<Promise<Offering | null>, [string, string]>;
  }>;
  let mockOfferingSyncService: jest.Mocked<Pick<OfferingSyncService, 'syncOfferingRecord'>>;

  const logger = new Logger({ level: LogLevel.TRACE, pretty: false });
  const catalogRows: Offering[] = [
    {
      id: 'offering-1',
      contract_address: 'CONTRACT_A',
      status: 'active',
      total_raised: '10',
    },
    {
      id: 'offering-2',
      contract_address: 'CONTRACT_B',
      status: 'completed',
      total_raised: '20',
    },
  ];

  beforeEach(() => {
    mockInvestmentRepo = {
      getAggregateStats: jest.fn(),
    };

    mockDistributionRepo = {
      getAggregateStats: jest.fn(),
    };

    mockOfferingRepo = {
      listCatalog: jest.fn(),
      findById: jest.fn(),
      updateStatus: jest.fn(),
    };

    mockOfferingSyncService = {
      syncOfferingRecord: jest.fn(),
    };

    service = new OfferingService(
      mockInvestmentRepo,
      mockDistributionRepo,
      mockOfferingRepo as any,
      {
        offeringSyncService: mockOfferingSyncService as OfferingSyncService,
        logger,
      },
    );
  });

  it('compiles aggregate stats from both repositories', async () => {
    const lastReportDate = new Date();

    mockInvestmentRepo.getAggregateStats.mockResolvedValue({
      totalInvested: '10000',
      investorCount: 5,
    } as any);

    mockDistributionRepo.getAggregateStats.mockResolvedValue({
      totalDistributed: '2000',
      lastReportDate,
    } as any);

    const stats = await service.getOfferingStats('offering-1');

    expect(stats).toEqual({
      offeringId: 'offering-1',
      totalInvested: '10000',
      totalDistributed: '2000',
      investorCount: 5,
      lastReportDate,
    });
  });

  it('synchronizes catalog rows with on-chain state before returning cacheable catalog data', async () => {
    const syncedRows: SyncResult[] = [
      {
        offeringId: 'offering-1',
        contractAddress: 'CONTRACT_A',
        success: true,
        updated: true,
        offering: { ...catalogRows[0], status: 'completed', total_raised: '55' },
      },
      {
        offeringId: 'offering-2',
        contractAddress: 'CONTRACT_B',
        success: true,
        updated: false,
        offering: catalogRows[1],
      },
    ];

    mockOfferingRepo.listCatalog.mockResolvedValueOnce(catalogRows);
    mockOfferingSyncService.syncOfferingRecord
      .mockResolvedValueOnce(syncedRows[0])
      .mockResolvedValueOnce(syncedRows[1]);

    const catalog = await service.getCatalog();

    expect(mockOfferingRepo.listCatalog).toHaveBeenCalledWith({
      limit: 10,
      offset: 0,
      statuses: ['active', 'completed'],
    });
    expect(catalog[0].status).toBe('completed');
    expect(catalog[0].total_raised).toBe('55');
    expect(catalog[1]).toEqual(catalogRows[1]);
  });

  it('returns cached catalog for the default request shape', async () => {
    mockOfferingRepo.listCatalog.mockResolvedValueOnce(catalogRows);
    mockOfferingSyncService.syncOfferingRecord
      .mockResolvedValueOnce({
        offeringId: 'offering-1',
        contractAddress: 'CONTRACT_A',
        success: true,
        updated: false,
        offering: catalogRows[0],
      })
      .mockResolvedValueOnce({
        offeringId: 'offering-2',
        contractAddress: 'CONTRACT_B',
        success: true,
        updated: false,
        offering: catalogRows[1],
      });

    const first = await service.getCatalog();
    const second = await service.getCatalog();

    expect(first).toEqual(second);
    expect(mockOfferingRepo.listCatalog).toHaveBeenCalledTimes(1);
    expect(mockOfferingSyncService.syncOfferingRecord).toHaveBeenCalledTimes(2);
  });

  it('does not use the default cache for custom filters', async () => {
    mockOfferingRepo.listCatalog
      .mockResolvedValueOnce([catalogRows[0]])
      .mockResolvedValueOnce([catalogRows[0]]);
    mockOfferingSyncService.syncOfferingRecord.mockResolvedValue({
      offeringId: 'offering-1',
      contractAddress: 'CONTRACT_A',
      success: true,
      updated: false,
      offering: catalogRows[0],
    });

    await service.getCatalog(5, 0, ['active']);
    await service.getCatalog(5, 0, ['active']);

    expect(mockOfferingRepo.listCatalog).toHaveBeenCalledTimes(2);
  });

  it('keeps catalog rows when on-chain sync fails for one offering', async () => {
    mockOfferingRepo.listCatalog.mockResolvedValueOnce(catalogRows);
    mockOfferingSyncService.syncOfferingRecord
      .mockResolvedValueOnce({
        offeringId: 'offering-1',
        contractAddress: 'CONTRACT_A',
        success: false,
        updated: false,
        offering: catalogRows[0],
        error: 'Unable to sync offering from Stellar',
      })
      .mockResolvedValueOnce({
        offeringId: 'offering-2',
        contractAddress: 'CONTRACT_B',
        success: true,
        updated: false,
        offering: catalogRows[1],
      });

    const catalog = await service.getCatalog();

    expect(catalog).toEqual(catalogRows);
  });

  it('returns an empty catalog without invoking sync work', async () => {
    mockOfferingRepo.listCatalog.mockResolvedValueOnce([]);

    const catalog = await service.getCatalog(5, 1, ['active']);

    expect(catalog).toEqual([]);
    expect(mockOfferingSyncService.syncOfferingRecord).not.toHaveBeenCalled();
  });

  // ── Status transition guardrails (issue #345) ─────────────────────────────

  describe('updateStatus', () => {
    it('allows a valid transition (draft → open)', async () => {
      const draft: Offering = { id: 'o1', status: 'draft' };
      const updated: Offering = { id: 'o1', status: 'open' };
      mockOfferingRepo.findById.mockResolvedValue(draft);
      mockOfferingRepo.updateStatus.mockResolvedValue(updated);

      const result = await service.updateStatus('o1', 'open');
      expect(result.status).toBe('open');
      expect(mockOfferingRepo.updateStatus).toHaveBeenCalledWith('o1', 'open');
    });

    it('allows open → paused → closed lifecycle', async () => {
      const open: Offering = { id: 'o2', status: 'open' };
      mockOfferingRepo.findById.mockResolvedValue(open);
      mockOfferingRepo.updateStatus.mockResolvedValue({ id: 'o2', status: 'paused' });
      await service.updateStatus('o2', 'paused');

      const paused: Offering = { id: 'o2', status: 'paused' };
      mockOfferingRepo.findById.mockResolvedValue(paused);
      mockOfferingRepo.updateStatus.mockResolvedValue({ id: 'o2', status: 'closed' });
      const result = await service.updateStatus('o2', 'closed');
      expect(result.status).toBe('closed');
    });

    it('throws conflict on illegal transition (closed → open)', async () => {
      mockOfferingRepo.findById.mockResolvedValue({ id: 'o3', status: 'closed' });

      await expect(service.updateStatus('o3', 'open')).rejects.toMatchObject({
        statusCode: 409,
        message: expect.stringContaining('not allowed'),
      });
      expect(mockOfferingRepo.updateStatus).not.toHaveBeenCalled();
    });

    it('throws conflict when cancelling from a terminal state', async () => {
      mockOfferingRepo.findById.mockResolvedValue({ id: 'o4', status: 'completed' });

      await expect(service.cancel('o4')).rejects.toMatchObject({ statusCode: 409 });
    });

    it('throws notFound when offering does not exist', async () => {
      mockOfferingRepo.findById.mockResolvedValue(null);

      await expect(service.updateStatus('missing', 'open')).rejects.toMatchObject({
        statusCode: 404,
      });
    });

    it('publish() transitions draft → open', async () => {
      mockOfferingRepo.findById.mockResolvedValue({ id: 'o5', status: 'draft' });
      mockOfferingRepo.updateStatus.mockResolvedValue({ id: 'o5', status: 'open' });

      const result = await service.publish('o5');
      expect(result.status).toBe('open');
    });

    it('close() transitions open → closed', async () => {
      mockOfferingRepo.findById.mockResolvedValue({ id: 'o6', status: 'open' });
      mockOfferingRepo.updateStatus.mockResolvedValue({ id: 'o6', status: 'closed' });

      const result = await service.close('o6');
      expect(result.status).toBe('closed');
    });

    it('cancel() transitions open → cancelled', async () => {
      mockOfferingRepo.findById.mockResolvedValue({ id: 'o7', status: 'open' });
      mockOfferingRepo.updateStatus.mockResolvedValue({ id: 'o7', status: 'cancelled' });

      const result = await service.cancel('o7');
      expect(result.status).toBe('cancelled');
    });
  });
});
