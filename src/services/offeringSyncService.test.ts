import { Offering } from '../db/repositories/offeringRepository';
import { Logger, LogLevel } from '../lib/logger';
import { StellarRPCFailureClass } from '../lib/stellarRpcFailure';
import { OfferingSyncService, StellarClient } from './offeringSyncService';

describe('OfferingSyncService', () => {
  const logger = new Logger({ level: LogLevel.TRACE, pretty: false });
  const mockOffering: Offering = {
    id: 'offering-1',
    contract_address: 'CONTRACT_ABC',
    status: 'active',
    total_raised: '5000.00',
    created_at: new Date(),
    updated_at: new Date(),
  };

  let mockOfferingRepo: {
    findById: jest.Mock;
    listAll: jest.Mock;
    updateState: jest.Mock;
  };
  let mockStellarClient: jest.Mocked<StellarClient>;
  let service: OfferingSyncService;

  beforeEach(() => {
    jest.clearAllMocks();

    mockOfferingRepo = {
      findById: jest.fn(),
      listAll: jest.fn(),
      updateState: jest.fn(),
    };

    mockStellarClient = {
      getOfferingState: jest.fn(),
      getAccountInfo: jest.fn(),
      validateContractAddress: jest.fn(),
    };

    service = new OfferingSyncService(
      mockOfferingRepo as any,
      mockStellarClient,
      logger,
    );
  });

  it('returns a sanitized error when an offering does not exist', async () => {
    mockOfferingRepo.findById.mockResolvedValueOnce(null);

    const result = await service.syncOffering('missing-id');

    expect(result).toMatchObject({
      offeringId: 'missing-id',
      success: false,
      updated: false,
      error: 'Offering missing-id not found',
    });
  });

  it('skips updates when on-chain state matches the local catalog row', async () => {
    mockOfferingRepo.findById.mockResolvedValueOnce(mockOffering);
    mockStellarClient.getOfferingState.mockResolvedValueOnce({
      status: 'active',
      total_raised: '5000.00',
    });

    const result = await service.syncOffering('offering-1');

    expect(result.success).toBe(true);
    expect(result.updated).toBe(false);
    expect(result.offering).toEqual(mockOffering);
    expect(mockOfferingRepo.updateState).not.toHaveBeenCalled();
  });

  it('updates the catalog when a valid on-chain transition is detected', async () => {
    const updatedOffering = {
      ...mockOffering,
      status: 'closed',
      total_raised: '9000.00',
    };

    mockOfferingRepo.findById.mockResolvedValueOnce(mockOffering);
    mockStellarClient.getOfferingState.mockResolvedValueOnce({
      status: 'closed',
      total_raised: '9000.00',
    });
    mockOfferingRepo.updateState.mockResolvedValueOnce(updatedOffering);

    const result = await service.syncOffering('offering-1');

    expect(result.success).toBe(true);
    expect(result.updated).toBe(true);
    expect(result.offering).toEqual(updatedOffering);
    expect(mockOfferingRepo.updateState).toHaveBeenCalledWith('offering-1', {
      status: 'closed',
      total_raised: '9000.00',
      max_investor_share_bps: null,
    });
  });

  it('rejects incompatible catalog vs on-chain transitions without writing to the database', async () => {
    mockOfferingRepo.findById.mockResolvedValueOnce({
      ...mockOffering,
      status: 'completed',
    });
    mockStellarClient.getOfferingState.mockResolvedValueOnce({
      status: 'active',
      total_raised: '9000.00',
    });

    const result = await service.syncOffering('offering-1');

    expect(result).toMatchObject({
      success: false,
      updated: false,
      error: 'On-chain status is not compatible with catalog state',
    });
    expect(mockOfferingRepo.updateState).not.toHaveBeenCalled();
  });

  it('updates catalog rows even when the local status is currently unknown', async () => {
    mockOfferingRepo.findById.mockResolvedValueOnce(mockOffering);
    mockStellarClient.getOfferingState.mockResolvedValueOnce({
      status: 'active',
      total_raised: '9000.00',
      extra: 'ignored',
    } as any);

    const result = await service.syncOfferingRecord({
      ...mockOffering,
      status: undefined,
      contract_address: 'CONTRACT_ABC',
    });

    expect(result.success).toBe(true);
    expect(result.updated).toBe(true);
  });

  it('returns a sanitized sync error when Stellar fails and exposes the classified failure bucket', async () => {
    mockOfferingRepo.findById.mockResolvedValueOnce(mockOffering);
    mockStellarClient.getOfferingState.mockRejectedValueOnce(
      Object.assign(new Error('request timeout while talking to horizon'), {
        status: 504,
      }),
    );

    const result = await service.syncOffering('offering-1');

    expect(result).toMatchObject({
      success: false,
      updated: false,
      error: 'Unable to sync offering from Stellar',
      failureClass: StellarRPCFailureClass.TIMEOUT,
    });
  });

  it('returns a sanitized configuration error when a contract address is missing', async () => {
    const result = await service.syncOfferingRecord({
      ...mockOffering,
      contract_address: undefined,
    });

    expect(result).toMatchObject({
      success: false,
      updated: false,
      error: 'Offering is not configured for on-chain sync',
    });
  });

  it('returns an invalid-state error when the on-chain status cannot be normalized', async () => {
    mockStellarClient.getOfferingState.mockResolvedValueOnce({
      status: 'published',
      total_raised: '1',
    } as any);

    const result = await service.syncOfferingRecord(mockOffering);

    expect(result).toMatchObject({
      success: false,
      updated: false,
      error: 'On-chain offering state is invalid',
    });
  });

  it('syncs all offerings and keeps per-offering results stable', async () => {
    mockOfferingRepo.listAll.mockResolvedValueOnce([
      mockOffering,
      { ...mockOffering, id: 'offering-2', contract_address: 'CONTRACT_2' },
    ]);
    mockStellarClient.getOfferingState
      .mockResolvedValueOnce({
        status: 'closed',
        total_raised: '9000.00',
      })
      .mockRejectedValueOnce({ status: 429 });
    mockOfferingRepo.updateState.mockResolvedValueOnce({
      ...mockOffering,
      status: 'closed',
      total_raised: '9000.00',
    });

    const results = await service.syncAll();

    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ success: true, updated: true });
    expect(results[1]).toMatchObject({
      success: false,
      error: 'Unable to sync offering from Stellar',
      failureClass: StellarRPCFailureClass.RATE_LIMIT,
    });
  });

  it('maps rejected sync promises in syncAll to sanitized failure results', async () => {
    const secondOffering = {
      ...mockOffering,
      id: 'offering-2',
      contract_address: 'CONTRACT_2',
    };

    mockOfferingRepo.listAll.mockResolvedValueOnce([mockOffering, secondOffering]);
    const syncSpy = jest
      .spyOn(service, 'syncOfferingRecord')
      .mockResolvedValueOnce({
        offeringId: 'offering-1',
        contractAddress: 'CONTRACT_ABC',
        success: true,
        updated: false,
        offering: mockOffering,
      })
      .mockRejectedValueOnce({ status: 503 });

    const results = await service.syncAll();

    expect(syncSpy).toHaveBeenCalledTimes(2);
    expect(results[1]).toMatchObject({
      offeringId: 'offering-2',
      success: false,
      error: 'Unable to sync offering from Stellar',
      failureClass: StellarRPCFailureClass.UPSTREAM_ERROR,
    });
  });

  describe('max_investor_share_bps sync', () => {
    it('syncs max_investor_share_bps when the on-chain value changes', async () => {
      const offeringWithCap = { ...mockOffering, max_investor_share_bps: null };
      const updatedOffering = { ...offeringWithCap, max_investor_share_bps: 500 };

      mockStellarClient.getOfferingState.mockResolvedValueOnce({
        status: 'active',
        total_raised: '5000.00',
        max_investor_share_bps: 500,
      });
      mockOfferingRepo.updateState.mockResolvedValueOnce(updatedOffering);

      const result = await service.syncOfferingRecord(offeringWithCap);

      expect(result.success).toBe(true);
      expect(result.updated).toBe(true);
      expect(mockOfferingRepo.updateState).toHaveBeenCalledWith(
        'offering-1',
        expect.objectContaining({ max_investor_share_bps: 500 }),
      );
    });

    it('treats missing on-chain max_investor_share_bps as null (no cap)', async () => {
      // On-chain config returns no cap field → should persist null
      const offeringWithCap = { ...mockOffering, max_investor_share_bps: 1000 };
      const updatedOffering = { ...offeringWithCap, max_investor_share_bps: null };

      mockStellarClient.getOfferingState.mockResolvedValueOnce({
        status: 'active',
        total_raised: '5000.00',
        // max_investor_share_bps intentionally absent
      });
      mockOfferingRepo.updateState.mockResolvedValueOnce(updatedOffering);

      const result = await service.syncOfferingRecord(offeringWithCap);

      expect(result.updated).toBe(true);
      expect(mockOfferingRepo.updateState).toHaveBeenCalledWith(
        'offering-1',
        expect.objectContaining({ max_investor_share_bps: null }),
      );
    });

    it('does not update when max_investor_share_bps is unchanged', async () => {
      const offeringWithCap = { ...mockOffering, max_investor_share_bps: 1000 };

      mockStellarClient.getOfferingState.mockResolvedValueOnce({
        status: 'active',
        total_raised: '5000.00',
        max_investor_share_bps: 1000,
      });

      const result = await service.syncOfferingRecord(offeringWithCap);

      expect(result.updated).toBe(false);
      expect(mockOfferingRepo.updateState).not.toHaveBeenCalled();
    });
  });
});
