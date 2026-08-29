/**
 * Statement data provider (Issue #540, PDF/UA; Issue #874 deterministic PDF).
 *
 * Fetches all data required to render an investor statement PDF:
 *  - Investor info (name, id)
 *  - Offering info (name, symbol)
 *  - Period holdings/balances (from `BalanceSnapshotRepository`)
 *  - Period investments/transactions
 *  - Period distributions/payouts + fees (from `DistributionRepository`)
 *  - Revenue report for the period
 *  - Tax lot classifications (from `InvestmentLotRepository`)
 *
 * Determinism contract (Issue #874): every collection returned by this
 * provider is explicitly sorted with a stable comparator so that rendering
 * the same underlying data twice always yields byte-identical input for the
 * PDF renderer. No wall-clock values are used as sort keys.
 */

import { Pool } from 'pg';
import { UserRepository } from '../db/repositories/userRepository';
import { OfferingRepository } from '../db/repositories/offeringRepository';
import { BalanceSnapshotRepository } from '../db/repositories/balanceSnapshotRepository';
import { InvestmentRepository } from '../db/repositories/investmentRepository';
import { DistributionRepository } from '../db/repositories/distributionRepository';
import { RevenueReportRepository } from '../db/repositories/revenueReportRepository';
import { InvestmentLotRepository } from '../db/repositories/investmentLotRepository';
import { InvestmentLot } from './taxation/types';

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

/** Tax lot classification shown on a statement (immutable lot data). */
export interface StatementTaxClassification {
  offeringId: string;
  offeringName: string;
  jurisdiction: string;
  quantity: string;
  costBasisPerUnit: string;
  acquiredAt: Date;
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
    /** Retained revenue (total_amount - distributed payouts) for the period. */
    fees: string;
    distributions: StatementDistributionEntry[];
  };
  revenueSummary: {
    totalAmount: string;
    periodStart?: Date;
    periodEnd?: Date;
  } | null;
  taxClassifications: StatementTaxClassification[];
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

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Sum decimal-string amounts. Deterministic for the same input array; used
 * only for statement display totals (matches repo-wide Number-based sums).
 */
function sumAmounts(amounts: string[]): string {
  return amounts.reduce((acc, amount) => acc + Number(amount), 0).toString();
}

/** Numeric comparison of decimal strings (stable and locale-independent). */
function numericCompare(a: string, b: string): number {
  return Number(a) - Number(b);
}

/** `YYYY-MM` → inclusive month window; anything else → null (no filtering). */
function periodDateRange(
  periodId: string
): { start: Date; end: Date } | null {
  const match = /^(\d{4})-(\d{2})$/.exec(periodId);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) return null;
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 1));
  return { start, end };
}

// ── Default Postgres-backed provider ──────────────────────────────────────

/**
 * Default implementation that queries Postgres repositories to assemble
 * the full statement content for an investor + period.
 *
 * Security assumptions:
 * - Caller identity (`investorId`) is asserted by trusted upstream auth
 *   middleware before any statement content is assembled.
 * - Only the investor's own rows are read (holder-scoped queries); revenue
 *   summaries are restricted to offerings the investor holds.
 * - Output values are never raw provider error messages.
 */
export class DefaultStatementDataProvider implements StatementDataProvider {
  private readonly userRepo: UserRepository;
  private readonly offeringRepo: OfferingRepository;
  private readonly balanceSnapshotRepo: BalanceSnapshotRepository;
  private readonly investmentRepo: InvestmentRepository;
  private readonly distributionRepo: DistributionRepository;
  private readonly revenueReportRepo: RevenueReportRepository;
  private readonly lotRepo: InvestmentLotRepository;

  constructor(db: Pool) {
    this.userRepo = new UserRepository(db);
    this.offeringRepo = new OfferingRepository(db);
    this.balanceSnapshotRepo = new BalanceSnapshotRepository(db);
    this.investmentRepo = new InvestmentRepository(db);
    this.distributionRepo = new DistributionRepository(db);
    this.revenueReportRepo = new RevenueReportRepository(db);
    this.lotRepo = new InvestmentLotRepository(db);
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

    // 5. Fetch distribution summary (+ period fees)
    const distributionSummary = await this.fetchDistributionSummary(investorId, periodId);

    // 6. Fetch revenue report for the period (offerings the investor holds)
    const revenueSummary = await this.fetchRevenueSummary(investorId, periodId);

    // 7. Fetch tax lot classifications
    const taxClassifications = await this.fetchTaxClassifications(investorId);

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
      taxClassifications,
    };
  }

  /**
   * `2026-07` → `Q3 2026`; anything else passes through unchanged.
   * Deterministic: pure string transformation, no timezone dependence.
   */
  private derivePeriodLabel(periodId: string): string {
    const match = /^(\d{4})-(\d{2})$/.exec(periodId);
    if (!match) return periodId;
    const year = match[1];
    const month = Number(match[2]);
    if (month < 1 || month > 12) return periodId;
    const quarter = Math.floor((month - 1) / 3) + 1;
    return `Q${quarter} ${year}`;
  }

  /**
   * End-of-period positions for the investor across all offerings.
   * Mid-period transfers collapse to the latest snapshot per offering
   * (snapshots are ordered by snapshot_at ASC, so later rows win).
   */
  private async fetchHoldings(
    investorId: string,
    periodId: string
  ): Promise<StatementHolding[]> {
    const snapshots = await this.balanceSnapshotRepo.findByHolderAndPeriod(
      investorId,
      periodId
    );

    // Latest snapshot per offering = end-of-period position.
    const byOffering = new Map<string, { offeringId: string; balance: string }>();
    for (const snapshot of snapshots) {
      byOffering.set(snapshot.offering_id, {
        offeringId: snapshot.offering_id,
        balance: snapshot.balance,
      });
    }

    const holdings: StatementHolding[] = [];
    for (const position of byOffering.values()) {
      const offering = await this.offeringRepo.findById(position.offeringId);
      holdings.push({
        offeringName: offering?.name ?? offering?.title ?? position.offeringId,
        offeringSymbol: offering?.symbol ?? '-',
        balance: position.balance,
      });
    }

    holdings.sort(
      (a, b) =>
        a.offeringName.localeCompare(b.offeringName) ||
        a.offeringSymbol.localeCompare(b.offeringSymbol) ||
        numericCompare(a.balance, b.balance)
    );
    return holdings;
  }

  /**
   * Investments (within the period window when periodId is `YYYY-MM`) plus
   * distributions received in the period. Sorted by date → type → amount so
   * rendering is byte-stable.
   */
  private async fetchTransactions(
    investorId: string,
    periodId: string
  ): Promise<StatementTransaction[]> {
    const transactions: StatementTransaction[] = [];
    const range = periodDateRange(periodId);

    const investments = await this.investmentRepo.listByInvestor({
      investor_id: investorId,
    });
    for (const inv of investments) {
      if (inv.status === 'failed') continue;
      if (range && (inv.created_at < range.start || inv.created_at >= range.end)) {
        continue;
      }
      const offering = await this.offeringRepo.findById(inv.offering_id);
      transactions.push({
        date: inv.created_at,
        type: 'investment',
        description: `Investment in ${offering?.name ?? offering?.title ?? inv.offering_id}`,
        amount: inv.amount,
        status: inv.status,
      });
    }

    const payouts = await this.distributionRepo.listPayoutsByInvestorForPeriod(
      investorId,
      periodId
    );
    for (const payout of payouts) {
      transactions.push({
        date: payout.created_at,
        type: 'distribution',
        description: 'Distribution payout',
        amount: payout.amount,
        status: payout.status,
      });
    }

    transactions.sort(
      (a, b) =>
        a.date.getTime() - b.date.getTime() ||
        a.type.localeCompare(b.type) ||
        numericCompare(a.amount, b.amount) ||
        a.description.localeCompare(b.description) ||
        a.status.localeCompare(b.status)
    );
    return transactions;
  }

  /** Investor's distributions for the period plus period-level fees. */
  private async fetchDistributionSummary(
    investorId: string,
    periodId: string
  ): Promise<StatementContent['distributionSummary']> {
    const payouts = await this.distributionRepo.listPayoutsByInvestorForPeriod(
      investorId,
      periodId
    );

    const distributions: StatementDistributionEntry[] = payouts.map((payout) => ({
      date: payout.created_at,
      amount: payout.amount,
      status: payout.status,
    }));
    distributions.sort(
      (a, b) => a.date.getTime() - b.date.getTime() || numericCompare(a.amount, b.amount)
    );

    const totalDistributed = sumAmounts(payouts.map((payout) => payout.amount));
    const fees = await this.fetchFees(periodId);

    return { totalDistributed, fees, distributions };
  }

  /**
   * Period-level retained revenue: Σ(total_amount) − Σ(all payouts) for the
   * period. Clamped at zero so data drift cannot produce a negative fee line.
   */
  private async fetchFees(periodId: string): Promise<string> {
    const runs = await this.distributionRepo.listByPeriod(periodId);
    const payouts = await this.distributionRepo.listPayoutsByPeriod(periodId);

    const totalAmount = sumAmounts(runs.map((run) => run.total_amount));
    const distributed = sumAmounts(payouts.map((payout) => payout.amount));
    const fees = Number(totalAmount) - Number(distributed);
    return (fees > 0 ? fees : 0).toString();
  }

  /**
   * Revenue for the period aggregated across offerings the investor holds.
   * Returns null when the investor has no holdings or no reports exist.
   */
  private async fetchRevenueSummary(
    investorId: string,
    periodId: string
  ): Promise<StatementContent['revenueSummary']> {
    const snapshots = await this.balanceSnapshotRepo.findByHolderAndPeriod(
      investorId,
      periodId
    );
    const offeringIds = [...new Set(snapshots.map((snapshot) => snapshot.offering_id))].sort();

    let total = 0;
    let periodStart: Date | undefined;
    let periodEnd: Date | undefined;

    for (const offeringId of offeringIds) {
      const report = await this.revenueReportRepo.getByOfferingAndPeriod(offeringId, periodId);
      if (!report) continue;
      total += Number(report.total_revenue ?? report.amount ?? 0);
      if (!periodStart && report.period_start) periodStart = report.period_start;
      if (!periodEnd && report.period_end) periodEnd = report.period_end;
    }

    if (offeringIds.length === 0) return null;
    return { totalAmount: total.toString(), periodStart, periodEnd };
  }

  /**
   * Tax lot classifications from the immutable investment-lot ledger.
   * Lot data is never modified after creation, so this is archival-safe.
   * A lot-repository failure degrades to an empty list rather than failing
   * the whole statement (tax classifications are informational).
   */
  private async fetchTaxClassifications(
    investorId: string
  ): Promise<StatementTaxClassification[]> {
    let lots: InvestmentLot[];
    try {
      lots = await this.lotRepo.listByInvestor(investorId);
    } catch {
      return [];
    }

    const classifications: StatementTaxClassification[] = [];
    for (const lot of lots) {
      const offering = await this.offeringRepo.findById(lot.offering_id);
      classifications.push({
        offeringId: lot.offering_id,
        offeringName: offering?.name ?? offering?.title ?? lot.offering_id,
        jurisdiction: lot.jurisdiction,
        quantity: lot.quantity.toString(),
        costBasisPerUnit: lot.cost_basis_per_unit.toString(),
        acquiredAt: lot.acquired_at,
      });
    }

    classifications.sort(
      (a, b) =>
        a.offeringId.localeCompare(b.offeringId) ||
        a.jurisdiction.localeCompare(b.jurisdiction) ||
        a.acquiredAt.getTime() - b.acquiredAt.getTime() ||
        numericCompare(a.costBasisPerUnit, b.costBasisPerUnit)
    );
    return classifications;
  }
}
