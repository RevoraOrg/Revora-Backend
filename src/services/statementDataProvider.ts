/**
 * Statement data provider (Issue #540, PDF/UA).
 *
 * Fetches all data required to render an investor statement PDF:
 *  - Investor info (name, id)
 *  - Offering info (name, symbol)
 *  - Period holdings/balances
 *  - Period investments/transactions
 *  - Period distributions/payouts
 *  - Revenue report for the period
 */

import { Pool } from 'pg';
import { UserRepository } from '../db/repositories/userRepository';
import { OfferingRepository } from '../db/repositories/offeringRepository';
import { BalanceSnapshotRepository } from '../db/repositories/balanceSnapshotRepository';
import { InvestmentRepository } from '../db/repositories/investmentRepository';
import { DistributionRepository } from '../db/repositories/distributionRepository';
import { RevenueReportRepository } from '../db/repositories/revenueReportRepository';

// ── Data types for statement content ──────────────────────────────────────

export interface StatementHolding {
  offeringName: string;
  offeringSymbol: string;
  balance: string;
}

export interface StatementTransaction {
  date: Date;
  type: 'investment' | 'distribution' | 'revenue';
  description: string;
  amount: string;
  status: string;
}

export interface StatementDistributionEntry {
  date: Date;
  amount: string;
  status: string;
}

export interface StatementContent {
  investorId: string;
  investorName: string;
  periodId: string;
  periodLabel: string;
  generatedAt: Date;
  holdings: StatementHolding[];
  transactions: StatementTransaction[];
  distributionSummary: {
    totalDistributed: string;
    distributions: StatementDistributionEntry[];
  };
  revenueSummary: {
    totalAmount: string;
    periodStart?: Date;
    periodEnd?: Date;
  } | null;
}

// ── Data provider interface ───────────────────────────────────────────────

export interface StatementDataProvider {
  getStatementContent(investorId: string, periodId: string): Promise<StatementContent>;
}

/**
 * In-memory / mock provider used by unit tests.
 * Allows tests to inject deterministic statement content.
 */
export class InMemoryStatementDataProvider implements StatementDataProvider {
  private readonly contentMap = new Map<string, StatementContent>();

  setContent(investorId: string, periodId: string, content: StatementContent): void {
    this.contentMap.set(`${investorId}:${periodId}`, content);
  }

  async getStatementContent(investorId: string, periodId: string): Promise<StatementContent> {
    const key = `${investorId}:${periodId}`;
    const content = this.contentMap.get(key);
    if (!content) {
      throw new Error(`No statement content found for ${key}`);
    }
    return content;
  }

  clear(): void {
    this.contentMap.clear();
  }
}

// ── Default Postgres-backed provider ──────────────────────────────────────

/**
 * Default implementation that queries Postgres repositories to assemble
 * the full statement content for an investor + period.
 */
export class DefaultStatementDataProvider implements StatementDataProvider {
  private readonly userRepo: UserRepository;
  private readonly offeringRepo: OfferingRepository;
  private readonly balanceSnapshotRepo: BalanceSnapshotRepository;
  private readonly investmentRepo: InvestmentRepository;
  private readonly distributionRepo: DistributionRepository;
  private readonly revenueReportRepo: RevenueReportRepository;

  constructor(db: Pool) {
    this.userRepo = new UserRepository(db);
    this.offeringRepo = new OfferingRepository(db);
    this.balanceSnapshotRepo = new BalanceSnapshotRepository(db);
    this.investmentRepo = new InvestmentRepository(db);
    this.distributionRepo = new DistributionRepository(db);
    this.revenueReportRepo = new RevenueReportRepository(db);
  }

  async getStatementContent(investorId: string, periodId: string): Promise<StatementContent> {
    // 1. Investor info
    let investorName = investorId;
    try {
      const user = await this.userRepo.findById(investorId);
      if (user?.name) {
        investorName = user.name;
      } else if (user?.email) {
        investorName = user.email;
      }
    } catch {
      // Fallback to investor ID
    }

    // 2. Period label
    const periodLabel = this.derivePeriodLabel(periodId);

    // 3. Fetch holdings
    const holdings = await this.fetchHoldings(investorId, periodId);

    // 4. Fetch transactions
    const transactions = await this.fetchTransactions(investorId, periodId);

    // 5. Fetch distribution summary
    const distributionSummary = await this.fetchDistributionSummary(investorId, periodId);

    // 6. Fetch revenue report
    const revenueSummary = await this.fetchRevenueSummary(periodId);

    return {
      investorId,
      investorName,
      periodId,
      periodLabel,
      generatedAt: new Date(),
      holdings,
      transactions,
      distributionSummary,
      revenueSummary,
    };
  }
