import { InvestmentRepository } from '../db/repositories/investmentRepository';
import { DistributionRepository } from '../db/repositories/distributionRepository';

export interface OfferingStats {
  offeringId: string;
  totalInvested: string;
  totalDistributed: string;
  investorCount: number;
  lastReportDate: Date | null;
}

export class OfferingService {
  constructor(
    private investmentRepo: InvestmentRepository,
    private distributionRepo: DistributionRepository
  ) {}

  /**
   * Get aggregate statistics for an offering
   * @param offeringId Offering ID
   * @returns Offering statistics
   */
  async getOfferingStats(offeringId: string): Promise<OfferingStats> {
    const [investmentStats, distributionStats] = await Promise.all([
      this.investmentRepo.getAggregateStats(offeringId),
      this.distributionRepo.getAggregateStats(offeringId),
    ]);

    return {
      offeringId,
      totalInvested: investmentStats.totalInvested,
      totalDistributed: distributionStats.totalDistributed,
      investorCount: investmentStats.investorCount,
      lastReportDate: distributionStats.lastReportDate,
    };
  }
}
