/**
 * Unit tests for DefaultStatementDataProvider (#874).
 *
 * Verifies that statement content is assembled from the snapshot, investment,
 * distribution, revenue, and tax-lot repositories with deterministic ordering
 * and safe fallbacks for missing data.
 */

import { UserRepository } from '../db/repositories/userRepository';
import { OfferingRepository } from '../db/repositories/offeringRepository';
import { BalanceSnapshotRepository } from '../db/repositories/balanceSnapshotRepository';
import { InvestmentRepository } from '../db/repositories/investmentRepository';
import { DistributionRepository } from '../db/repositories/distributionRepository';
import { RevenueReportRepository } from '../db/repositories/revenueReportRepository';
import { InvestmentLotRepository } from '../db/repositories/investmentLotRepository';
import {
  DefaultStatementDataProvider,
  InMemoryStatementDataProvider,
  StatementContent,
} from './statementDataProvider';

const mockPool = {} as never;

function makeContent(overrides: Partial<StatementContent> = {}): StatementContent {
  return {
    investorId: 'inv-1',
    investorName: 'Jane Doe',
    periodId: '2026-07',
    periodLabel: 'Q3 2026',
    generatedAt: new Date('2026-08-01T00:00:00.000Z'),
    holdings: [],
    transactions: [],
    distributionSummary: { totalDistributed: '0', fees: '0', distributions: [] },
    revenueSummary: null,
    taxClassifications: [],
    ...overrides,
  };
}

/** Default empty mocks for every repo method the provider touches. */
function mockAllRepos() {
  jest.spyOn(UserRepository.prototype, 'findById').mockResolvedValue(null as never);
  jest
    .spyOn(BalanceSnapshotRepository.prototype, 'findByHolderAndPeriod')
    .mockResolvedValue([] as never);
  jest.spyOn(OfferingRepository.prototype, 'findById').mockResolvedValue(null as never);
  jest.spyOn(InvestmentRepository.prototype, 'listByInvestor').mockResolvedValue([] as never);
  jest
    .spyOn(DistributionRepository.prototype, 'listPayoutsByInvestorForPeriod')
    .mockResolvedValue([] as never);
  jest.spyOn(DistributionRepository.prototype, 'listByPeriod').mockResolvedValue([] as never);
  jest.spyOn(DistributionRepository.prototype, 'listPayoutsByPeriod').mockResolvedValue([] as never);
  jest
    .spyOn(RevenueReportRepository.prototype, 'getByOfferingAndPeriod')
    .mockResolvedValue(null as never);
  jest.spyOn(InvestmentLotRepository.prototype, 'listByInvestor').mockResolvedValue([] as never);
}

describe('DefaultStatementDataProvider', () => {
  let provider: DefaultStatementDataProvider;

  beforeEach(() => {
    jest.restoreAllMocks();
    mockAllRepos();
    provider = new DefaultStatementDataProvider(mockPool);
  });

  it('assembles full statement content from all repositories', async () => {
    jest
      .spyOn(UserRepository.prototype, 'findById')
      .mockResolvedValue({ id: 'inv-1', name: 'Jane Doe', email: 'jane@x.io' } as never);
    jest.spyOn(BalanceSnapshotRepository.prototype, 'findByHolderAndPeriod').mockResolvedValue([
      {
        id: 's1',
        offering_id: 'off-1',
        period_id: '2026-07',
        holder_address_or_id: 'inv-1',
        balance: '1000.00',
        snapshot_at: new Date('2026-07-01T00:00:00.000Z'),
        created_at: new Date('2026-07-01T00:00:00.000Z'),
      },
    ] as never);
    jest
      .spyOn(OfferingRepository.prototype, 'findById')
      .mockImplementation(async (id: string) =>
        ({ id, name: 'Alpha Fund', symbol: 'ALPHA' } as never)
      );
    jest.spyOn(InvestmentRepository.prototype, 'listByInvestor').mockResolvedValue([
      {
        id: 'i1',
        investor_id: 'inv-1',
        offering_id: 'off-1',
        amount: '1000.00',
        asset: 'ALPHA',
        status: 'completed',
        created_at: new Date('2026-07-05T00:00:00.000Z'),
      },
    ] as never);
    jest.spyOn(DistributionRepository.prototype, 'listPayoutsByInvestorForPeriod').mockResolvedValue([
      {
        id: 'p1',
        distribution_id: 'd1',
        investor_id: 'inv-1',
        amount: '120.00',
        status: 'processed',
        created_at: new Date('2026-07-15T00:00:00.000Z'),
      },
    ] as never);
    jest.spyOn(DistributionRepository.prototype, 'listByPeriod').mockResolvedValue([
      {
        id: 'd1',
        offering_id: 'off-1',
        period_id: '2026-07',
        total_amount: '500.00',
        status: 'completed',
        run_at: new Date('2026-07-14T00:00:00.000Z'),
      },
    ] as never);
    jest.spyOn(DistributionRepository.prototype, 'listPayoutsByPeriod').mockResolvedValue([
      { id: 'p1', amount: '120.00' },
      { id: 'p2', amount: '80.00' },
    ] as never);
    jest.spyOn(RevenueReportRepository.prototype, 'getByOfferingAndPeriod').mockResolvedValue({
      id: 'r1',
      offering_id: 'off-1',
      period_id: '2026-07',
      total_revenue: '500.00',
      period_start: new Date('2026-07-01T00:00:00.000Z'),
      period_end: new Date('2026-07-31T00:00:00.000Z'),
    } as never);
    jest.spyOn(InvestmentLotRepository.prototype, 'listByInvestor').mockResolvedValue([
      {
        id: 'l1',
        investor_id: 'inv-1',
        offering_id: 'off-1',
        asset: 'ALPHA',
        quantity: 100,
        cost_basis_per_unit: 10,
        jurisdiction: 'US',
        acquired_at: new Date('2026-06-01T00:00:00.000Z'),
        status: 'open',
        remaining_quantity: 100,
      },
    ] as never);

    const content = await provider.getStatementContent('inv-1', '2026-07');

    expect(content.investorName).toBe('Jane Doe');
    expect(content.periodLabel).toBe('Q3 2026');
    expect(content.holdings).toEqual([
      { offeringName: 'Alpha Fund', offeringSymbol: 'ALPHA', balance: '1000.00' },
    ]);
    expect(content.transactions).toHaveLength(2);
    expect(content.transactions[0].type).toBe('investment');
    expect(content.transactions[1].type).toBe('distribution');
    expect(content.distributionSummary.totalDistributed).toBe('120');
    // 500 total_amount − 200 distributed = 300 retained as fees
    expect(content.distributionSummary.fees).toBe('300');
    expect(content.revenueSummary?.totalAmount).toBe('500');
    expect(content.revenueSummary?.periodStart?.toISOString()).toBe('2026-07-01T00:00:00.000Z');
    expect(content.taxClassifications).toHaveLength(1);
    expect(content.taxClassifications[0]).toEqual({
      offeringId: 'off-1',
      offeringName: 'Alpha Fund',
      jurisdiction: 'US',
      quantity: '100',
      costBasisPerUnit: '10',
      acquiredAt: new Date('2026-06-01T00:00:00.000Z'),
    });
  });

  it('falls back to investor id when user lookup fails or is empty', async () => {
    jest.spyOn(UserRepository.prototype, 'findById').mockRejectedValue(new Error('db down') as never);

    const content = await provider.getStatementContent('inv-9', '2026-07');
    expect(content.investorName).toBe('inv-9');
  });

  it('collapses mid-period transfers to the latest snapshot per offering', async () => {
    jest.spyOn(BalanceSnapshotRepository.prototype, 'findByHolderAndPeriod').mockResolvedValue([
      {
        id: 's-old',
        offering_id: 'off-1',
        period_id: '2026-07',
        holder_address_or_id: 'inv-1',
        balance: '500.00',
        snapshot_at: new Date('2026-07-10T00:00:00.000Z'),
        created_at: new Date('2026-07-10T00:00:00.000Z'),
      },
      {
        id: 's-new',
        offering_id: 'off-1',
        period_id: '2026-07',
        holder_address_or_id: 'inv-1',
        balance: '1250.00',
        snapshot_at: new Date('2026-07-31T00:00:00.000Z'),
        created_at: new Date('2026-07-31T00:00:00.000Z'),
      },
    ] as never);
    jest
      .spyOn(OfferingRepository.prototype, 'findById')
      .mockImplementation(async (id: string) => ({ id, name: 'Beta Fund', symbol: 'BETA' } as never));

    const content = await provider.getStatementContent('inv-1', '2026-07');
    expect(content.holdings).toEqual([
      { offeringName: 'Beta Fund', offeringSymbol: 'BETA', balance: '1250.00' },
    ]);
  });

  it('filters investments outside the period window and keeps zero-distribution periods', async () => {
    jest.spyOn(BalanceSnapshotRepository.prototype, 'findByHolderAndPeriod').mockResolvedValue([
      {
        id: 's1',
        offering_id: 'off-1',
        period_id: '2026-07',
        holder_address_or_id: 'inv-1',
        balance: '10.00',
        snapshot_at: new Date('2026-07-01T00:00:00.000Z'),
        created_at: new Date('2026-07-01T00:00:00.000Z'),
      },
    ] as never);
    jest
      .spyOn(OfferingRepository.prototype, 'findById')
      .mockImplementation(async (id: string) => ({ id, name: 'Off' } as never));
    jest.spyOn(InvestmentRepository.prototype, 'listByInvestor').mockResolvedValue([
      {
        id: 'in-period',
        investor_id: 'inv-1',
        offering_id: 'off-1',
        amount: '10.00',
        asset: 'X',
        status: 'completed',
        created_at: new Date('2026-07-20T00:00:00.000Z'),
      },
      {
        id: 'out-period',
        investor_id: 'inv-1',
        offering_id: 'off-1',
        amount: '99.00',
        asset: 'X',
        status: 'completed',
        created_at: new Date('2026-05-01T00:00:00.000Z'),
      },
    ] as never);
    jest.spyOn(DistributionRepository.prototype, 'listByPeriod').mockResolvedValue([
      {
        id: 'd1',
        offering_id: 'off-1',
        period_id: '2026-07',
        total_amount: '0.00',
        status: 'failed',
        run_at: new Date('2026-07-14T00:00:00.000Z'),
      },
    ] as never);

    const content = await provider.getStatementContent('inv-1', '2026-07');
    expect(content.transactions).toHaveLength(1);
    expect(content.transactions[0].description).toContain('Investment in Off');
    expect(content.transactions[0].amount).toBe('10.00');
    expect(content.distributionSummary.totalDistributed).toBe('0');
    expect(content.distributionSummary.fees).toBe('0');
  });

  it('returns null revenue summary when the investor has no holdings', async () => {
    const content = await provider.getStatementContent('inv-1', '2026-07');
    expect(content.holdings).toEqual([]);
    expect(content.revenueSummary).toBeNull();
  });

  it('degrades tax classifications to empty when the lot repository fails', async () => {
    jest
      .spyOn(InvestmentLotRepository.prototype, 'listByInvestor')
      .mockRejectedValue(new Error('boom') as never);

    const content = await provider.getStatementContent('inv-1', '2026-07');
    expect(content.taxClassifications).toEqual([]);
  });

  it('derives quarter labels deterministically and passes through non-month ids', async () => {
    const expectations: Array<[string, string]> = [
      ['2026-01', 'Q1 2026'],
      ['2026-04', 'Q2 2026'],
      ['2026-07', 'Q3 2026'],
      ['2026-10', 'Q4 2026'],
      ['2026-13', '2026-13'],
      ['H1-2026', 'H1-2026'],
    ];
    for (const [periodId, expectedLabel] of expectations) {
      const content = await provider.getStatementContent('inv-1', periodId);
      expect(content.periodLabel).toBe(expectedLabel);
    }
  });
});

describe('InMemoryStatementDataProvider', () => {
  it('stores and returns injected content deterministically', async () => {
    const provider = new InMemoryStatementDataProvider();
    const content = makeContent();
    provider.setContent('inv-1', '2026-07', content);
    const result = await provider.getStatementContent('inv-1', '2026-07');
    expect(result).toEqual(content);
  });

  it('throws for unknown investor/period pairs', async () => {
    const provider = new InMemoryStatementDataProvider();
    await expect(provider.getStatementContent('inv-x', '2026-07')).rejects.toThrow(
      'No statement content found'
    );
  });

  it('clears stored content', async () => {
    const provider = new InMemoryStatementDataProvider();
    provider.setContent('inv-1', '2026-07', makeContent());
    provider.clear();
    await expect(provider.getStatementContent('inv-1', '2026-07')).rejects.toThrow();
  });
});
