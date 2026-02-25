import { OfferingService } from './offeringService';
import { InvestmentRepository } from '../db/repositories/investmentRepository';
import { DistributionRepository } from '../db/repositories/distributionRepository';

describe('OfferingService', () => {
  let service: OfferingService;
  let mockInvestmentRepo: jest.Mocked<InvestmentRepository>;
  let mockDistributionRepo: jest.Mocked<DistributionRepository>;

  beforeEach(() => {
    mockInvestmentRepo = {
      getAggregateStats: jest.fn(),
    } as any;

    mockDistributionRepo = {
      getAggregateStats: jest.fn(),
    } as any;

    service = new OfferingService(mockInvestmentRepo, mockDistributionRepo);
  });

  it('should compile aggregate stats from both repositories', async () => {
    const offeringId = 'offering-1';
    const lastReportDate = new Date();

    mockInvestmentRepo.getAggregateStats.mockResolvedValue({
      totalInvested: '10000',
      investorCount: 5,
    });

    mockDistributionRepo.getAggregateStats.mockResolvedValue({
      totalDistributed: '2000',
      lastReportDate: lastReportDate,
    });

    const stats = await service.getOfferingStats(offeringId);

    expect(stats).toEqual({
      offeringId,
      totalInvested: '10000',
      totalDistributed: '2000',
      investorCount: 5,
      lastReportDate: lastReportDate,
    });
  });
});
