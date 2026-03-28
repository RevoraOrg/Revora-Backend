import { InvestmentRepository } from '../db/repositories/investmentRepository';
import { DistributionRepository } from '../db/repositories/distributionRepository';
import { OfferingRepository, Offering } from '../db/repositories/offeringRepository';

export interface OfferingStats {
  offeringId: string;
  totalInvested: string;
  totalDistributed: string;
  investorCount: number;
  lastReportDate: Date | null;
}

export class OfferingService {
  private catalogCache: { data: Offering[]; timestamp: number } | null = null;
  private readonly CACHE_TTL_MS = 60 * 1000; // 60 seconds

  constructor(
    private investmentRepo: InvestmentRepository,
    private distributionRepo: DistributionRepository,
    private offeringRepo: OfferingRepository
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

  /**
   * Get public catalog of offerings
   * Implements a simple cache to handle high traffic for public listing
   */
  async getCatalog(limit = 10, offset = 0, statuses = ['active', 'completed']): Promise<Offering[]> {
    // Only use cache for default first-page requests to simplify
    const isCacheableRequest = limit === 10 && offset === 0 && 
                               statuses.length === 2 && 
                               statuses.includes('active') && 
                               statuses.includes('completed');

    if (isCacheableRequest && this.catalogCache) {
      const now = Date.now();
      if (now - this.catalogCache.timestamp < this.CACHE_TTL_MS) {
        return this.catalogCache.data;
      }
    }

    const catalog = await this.offeringRepo.listCatalog({ limit, offset, statuses });

    if (isCacheableRequest) {
      this.catalogCache = {
        data: catalog,
        timestamp: Date.now(),
      };
    }

    return catalog;
  }
}
