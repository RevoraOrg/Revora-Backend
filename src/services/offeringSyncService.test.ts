import { OfferingSyncService, StellarClient } from './offeringSyncService';
import { OfferingRepository, Offering } from '../db/repositories/offeringRepository';

const mockOffering: Offering = {
  id: 'offering-1',
  contract_address: 'CONTRACT_ABC',
  status: 'active',
  total_raised: '5000.00',
  created_at: new Date(),
  updated_at: new Date(),
};

const mockOfferingRepo = {
  findById: jest.fn(),
  listAll: jest.fn(),
  updateState: jest.fn(),
  findByContractAddress: jest.fn(),
} as unknown as OfferingRepository;

const mockStellarClient: StellarClient = {
  getOfferingState: jest.fn(),
};

const service = new OfferingSyncService(mockOfferingRepo, mockStellarClient);

beforeEach(() => jest.clearAllMocks());

describe('OfferingSyncService', () => {
  describe('syncOffering', () => {
    it('returns error if offering not found', async () => {
      (mockOfferingRepo.findById as jest.Mock).mockResolvedValueOnce(null);
      const result = await service.syncOffering('missing-id');
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/not found/);
    });

    it('does not update if state is unchanged', async () => {
      (mockOfferingRepo.findById as jest.Mock).mockResolvedValueOnce(mockOffering);
      (mockStellarClient.getOfferingState as jest.Mock).mockResolvedValueOnce({
        status: 'active',
        total_raised: '5000.00',
      });
      const result = await service.syncOffering('offering-1');
      expect(result.success).toBe(true);
      expect(result.updated).toBe(false);
      expect(mockOfferingRepo.updateState).not.toHaveBeenCalled();
    });

    it('updates DB if state has changed', async () => {
      (mockOfferingRepo.findById as jest.Mock).mockResolvedValueOnce(mockOffering);
      (mockStellarClient.getOfferingState as jest.Mock).mockResolvedValueOnce({
        status: 'closed',
        total_raised: '9000.00',
      });
      (mockOfferingRepo.updateState as jest.Mock).mockResolvedValueOnce({
        ...mockOffering,
        status: 'closed',
        total_raised: '9000.00',
      });
      const result = await service.syncOffering('offering-1');
      expect(result.success).toBe(true);
      expect(result.updated).toBe(true);
      expect(mockOfferingRepo.updateState).toHaveBeenCalledWith('offering-1', {
        status: 'closed',
        total_raised: '9000.00',
      });
    });

    it('returns error if stellar client throws', async () => {
      (mockOfferingRepo.findById as jest.Mock).mockResolvedValueOnce(mockOffering);
      (mockStellarClient.getOfferingState as jest.Mock).mockRejectedValueOnce(
        new Error('Network error')
      );
      const result = await service.syncOffering('offering-1');
      expect(result.success).toBe(false);
      expect(result.error).toBe('Network error');
    });
  });

  describe('syncAll', () => {
    it('syncs all offerings and returns results', async () => {
      (mockOfferingRepo.listAll as jest.Mock).mockResolvedValueOnce([mockOffering]);
      (mockStellarClient.getOfferingState as jest.Mock).mockResolvedValueOnce({
        status: 'closed',
        total_raised: '9000.00',
      });
      (mockOfferingRepo.updateState as jest.Mock).mockResolvedValueOnce({
        ...mockOffering,
        status: 'closed',
      });
      const results = await service.syncAll();
      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(true);
      expect(results[0].updated).toBe(true);
    });

    it('returns failure result if one offering fails', async () => {
      (mockOfferingRepo.listAll as jest.Mock).mockResolvedValueOnce([mockOffering]);
      (mockStellarClient.getOfferingState as jest.Mock).mockRejectedValueOnce(
        new Error('Timeout')
      );
      const results = await service.syncAll();
      expect(results[0].success).toBe(false);
      expect(results[0].error).toBe('Timeout');
    });
  });
});