/**
 * Dedicated regression suite for HolderBalance normalization and the
 * DB-derived balance provider.
 *
 * `balanceSnapshotService.test.ts` walks the snapshot lifecycle (determinism,
 * mismatch guard, source routing) and only touches normalization through the
 * single "all balances are zero or negative" case. Its `describe` blocks never
 * mention `normalizeBalances` or `createDbBalanceProviderFromInvestments`, so
 * the coercions that decide whether a holder ends up in a snapshot are
 * unverified. This file pins them:
 *
 * - which `balance` strings survive `Number(...)` coercion and the `> 0` gate
 *   (whitespace, exponent, hex, `Infinity`, `-0`, trailing garbage),
 * - that rows are projected down to exactly `{ holderAddressOrId, balance }`,
 *   with `balance` left as the original *string* rather than the coerced number,
 * - that a falsy `holderAddressOrId` is dropped while a whitespace-only one is
 *   kept, since only falsiness is tested,
 * - that the filtered list is what reaches `insertMany`,
 * - and `createDbBalanceProviderFromInvestments` end-to-end: completed-only
 *   aggregation per investor, skipping non-numeric and non-positive amounts,
 *   stringifying the summed balance, and keying by `String(investor_id)`.
 */

import {
  BalanceSnapshotService,
  BalanceProvider,
  HolderBalance,
  StellarBalanceClient,
  createDbBalanceProviderFromInvestments,
} from '../balanceSnapshotService';
import { BalanceSnapshotRepository } from '../../db/repositories/balanceSnapshotRepository';
import { OfferingRepository, Offering } from '../../db/repositories/offeringRepository';

const PERIOD_END = new Date('2024-02-01T00:00:00.000Z');

const offering = {
  id: 'offering-1',
  contract_address: 'CONTRACT_XYZ',
  status: 'active',
  total_raised: '0',
  created_at: new Date(),
  updated_at: new Date(),
} as unknown as Offering;

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function makeService(balances: HolderBalance[]) {
  const snapshotRepo = {
    findByOfferingAndPeriod: jest.fn().mockResolvedValue([]),
    insertMany: jest.fn().mockImplementation(async (rows: unknown[]) => rows),
  };
  const offeringRepo = { findById: jest.fn().mockResolvedValue(offering) };
  const dbProvider: BalanceProvider = { getBalances: jest.fn().mockResolvedValue(balances) };
  const stellarClient = {
    getOfferingState: jest.fn(),
    getHolderBalances: jest.fn().mockResolvedValue(balances),
  };

  const service = new BalanceSnapshotService(
    snapshotRepo as unknown as BalanceSnapshotRepository,
    offeringRepo as unknown as OfferingRepository,
    stellarClient as unknown as StellarBalanceClient,
    dbProvider,
  );

  return { service, snapshotRepo, offeringRepo, dbProvider, stellarClient };
}

const run = (service: BalanceSnapshotService, source: 'db' | 'stellar', extra = {}) =>
  service.snapshotBalances({
    offeringId: 'offering-1',
    periodId: '2024-01',
    periodEnd: PERIOD_END,
    source,
    ...extra,
  });

/**
 * Returns the holder ids that survived normalization, in order.
 *
 * A sentinel row is appended so the service never hits its "no balances found"
 * guard when a case is expected to filter everything out; the sentinel is
 * stripped from the result.
 */
async function survivors(balances: HolderBalance[], source: 'db' | 'stellar' = 'db') {
  const { service, snapshotRepo } = makeService([
    ...balances,
    { holderAddressOrId: '__sentinel__', balance: '1' },
  ]);
  await run(service, source);
  const rows = snapshotRepo.insertMany.mock.calls[0][0] as { holder_address_or_id: string }[];
  return rows.map((r) => r.holder_address_or_id).filter((id) => id !== '__sentinel__');
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('HolderBalance normalization', () => {
  describe('balance coercion gate', () => {
    it('keeps a plain positive integer', async () => {
      expect(await survivors([{ holderAddressOrId: 'h', balance: '42' }])).toEqual(['h']);
    });

    it('keeps a positive decimal', async () => {
      expect(await survivors([{ holderAddressOrId: 'h', balance: '0.0001' }])).toEqual(['h']);
    });

    it('keeps a value with surrounding whitespace', async () => {
      // Number(" 5 ") === 5, so the row is retained.
      expect(await survivors([{ holderAddressOrId: 'h', balance: '  5  ' }])).toEqual(['h']);
    });

    it('keeps exponent notation', async () => {
      expect(await survivors([{ holderAddressOrId: 'h', balance: '1e3' }])).toEqual(['h']);
    });

    it('keeps hex notation because Number("0x10") is 16', async () => {
      expect(await survivors([{ holderAddressOrId: 'h', balance: '0x10' }])).toEqual(['h']);
    });

    it('keeps an infinite balance, since Infinity > 0 holds', async () => {
      expect(await survivors([{ holderAddressOrId: 'h', balance: 'Infinity' }])).toEqual(['h']);
    });

    it('keeps a tiny negative exponent that is still positive', async () => {
      expect(await survivors([{ holderAddressOrId: 'h', balance: '5e-3' }])).toEqual(['h']);
    });

    it('drops a zero balance', async () => {
      expect(await survivors([{ holderAddressOrId: 'h', balance: '0' }])).toEqual([]);
    });

    it('drops negative zero', async () => {
      expect(await survivors([{ holderAddressOrId: 'h', balance: '-0' }])).toEqual([]);
    });

    it('drops a negative balance', async () => {
      expect(await survivors([{ holderAddressOrId: 'h', balance: '-10' }])).toEqual([]);
    });

    it('drops a non-numeric balance', async () => {
      expect(await survivors([{ holderAddressOrId: 'h', balance: 'abc' }])).toEqual([]);
    });

    it('drops a partially numeric balance', async () => {
      expect(await survivors([{ holderAddressOrId: 'h', balance: '5abc' }])).toEqual([]);
    });

    it('drops an empty balance string', async () => {
      expect(await survivors([{ holderAddressOrId: 'h', balance: '' }])).toEqual([]);
    });

    it('drops NaN spelled out', async () => {
      expect(await survivors([{ holderAddressOrId: 'h', balance: 'NaN' }])).toEqual([]);
    });
  });

  describe('holder identifier gate', () => {
    it('drops an empty holder id', async () => {
      expect(await survivors([{ holderAddressOrId: '', balance: '1' }])).toEqual([]);
    });

    it('keeps a whitespace-only holder id because only falsiness is tested', async () => {
      expect(await survivors([{ holderAddressOrId: ' ', balance: '1' }])).toEqual([' ']);
    });

    it('keeps a zero-like holder id', async () => {
      expect(await survivors([{ holderAddressOrId: '0', balance: '1' }])).toEqual(['0']);
    });

    it('drops a holder with a good id but a bad balance', async () => {
      expect(
        await survivors([
          { holderAddressOrId: 'keep', balance: '1' },
          { holderAddressOrId: 'drop', balance: 'oops' },
        ]),
      ).toEqual(['keep']);
    });
  });

  describe('projection into snapshot rows', () => {
    it('emits exactly the four repository fields plus snapshot_at', async () => {
      const { service, snapshotRepo } = makeService([{ holderAddressOrId: 'h1', balance: '7' }]);
      await run(service, 'db');

      expect(snapshotRepo.insertMany.mock.calls[0][0]).toEqual([
        {
          offering_id: 'offering-1',
          period_id: '2024-01',
          holder_address_or_id: 'h1',
          balance: '7',
          snapshot_at: PERIOD_END,
        },
      ]);
    });

    it('preserves the original balance string rather than the coerced number', async () => {
      const { service, snapshotRepo } = makeService([
        { holderAddressOrId: 'h1', balance: '  007.50  ' },
      ]);
      await run(service, 'db');

      const row = (snapshotRepo.insertMany.mock.calls[0][0] as { balance: string }[])[0];
      expect(row.balance).toBe('  007.50  ');
      expect(typeof row.balance).toBe('string');
    });

    it('drops extra properties the provider attached to a HolderBalance', async () => {
      const { service, snapshotRepo } = makeService([
        {
          holderAddressOrId: 'h1',
          balance: '5',
          balanceSource: 'legacy',
        } as unknown as HolderBalance,
      ]);
      await run(service, 'db');

      const row = (snapshotRepo.insertMany.mock.calls[0][0] as Record<string, unknown>[])[0];
      expect(Object.keys(row).sort()).toEqual(
        ['balance', 'holder_address_or_id', 'offering_id', 'period_id', 'snapshot_at'].sort(),
      );
      expect(row).not.toHaveProperty('balanceSource');
    });

    it('preserves provider ordering among survivors', async () => {
      expect(
        await survivors([
          { holderAddressOrId: 'zeta', balance: '1' },
          { holderAddressOrId: 'skip', balance: '0' },
          { holderAddressOrId: 'alpha', balance: '2' },
        ]),
      ).toEqual(['zeta', 'alpha']);
    });

    it('throws when every balance is filtered out', async () => {
      const { service } = makeService([
        { holderAddressOrId: 'a', balance: '0' },
        { holderAddressOrId: 'b', balance: 'nope' },
      ]);

      await expect(run(service, 'db')).rejects.toThrow(
        'No balances found for offering offering-1 and period 2024-01',
      );
    });

    it('normalizes the same way when reading from the Stellar client', async () => {
      expect(
        await survivors(
          [
            { holderAddressOrId: 'ok', balance: '1e1' },
            { holderAddressOrId: 'bad', balance: '-1' },
          ],
          'stellar',
        ),
      ).toEqual(['ok']);
    });

    it('throws for a Stellar offering with no contract address before asking for balances', async () => {
      const snapshotRepo = {
        findByOfferingAndPeriod: jest.fn().mockResolvedValue([]),
        insertMany: jest.fn(),
      };
      const offeringRepo = {
        findById: jest.fn().mockResolvedValue({ ...offering, contract_address: null }),
      };
      const stellarClient = { getOfferingState: jest.fn(), getHolderBalances: jest.fn() };
      const service = new BalanceSnapshotService(
        snapshotRepo as unknown as BalanceSnapshotRepository,
        offeringRepo as unknown as OfferingRepository,
        stellarClient as unknown as StellarBalanceClient,
      );

      await expect(run(service, 'stellar')).rejects.toThrow(
        'Offering offering-1 does not have a contract_address configured',
      );
      expect(stellarClient.getHolderBalances).not.toHaveBeenCalled();
    });
  });
});

describe('createDbBalanceProviderFromInvestments', () => {
  const investmentRepo = (investments: unknown[]) => ({
    findByOffering: jest.fn().mockResolvedValue(investments),
  });

  it('returns an empty list when the offering has no investments', async () => {
    const provider = createDbBalanceProviderFromInvestments(investmentRepo([]));
    expect(await provider.getBalances('offering-1', '2024-01')).toEqual([]);
  });

  it('sums completed investments per investor', async () => {
    const provider = createDbBalanceProviderFromInvestments(
      investmentRepo([
        { status: 'completed', investor_id: 'inv-1', amount: '100' },
        { status: 'completed', investor_id: 'inv-1', amount: '50.5' },
        { status: 'completed', investor_id: 'inv-2', amount: 20 },
      ]),
    );

    expect(await provider.getBalances('offering-1', '2024-01')).toEqual([
      { holderAddressOrId: 'inv-1', balance: '150.5' },
      { holderAddressOrId: 'inv-2', balance: '20' },
    ]);
  });

  it('ignores investments that are not completed', async () => {
    const provider = createDbBalanceProviderFromInvestments(
      investmentRepo([
        { status: 'pending', investor_id: 'inv-1', amount: '100' },
        { status: 'failed', investor_id: 'inv-2', amount: '100' },
        { status: 'refunded', investor_id: 'inv-3', amount: '100' },
        { status: 'completed', investor_id: 'inv-4', amount: '100' },
      ]),
    );

    expect(await provider.getBalances('offering-1', '2024-01')).toEqual([
      { holderAddressOrId: 'inv-4', balance: '100' },
    ]);
  });

  it('skips non-numeric and non-positive amounts', async () => {
    const provider = createDbBalanceProviderFromInvestments(
      investmentRepo([
        { status: 'completed', investor_id: 'nan', amount: 'not-a-number' },
        { status: 'completed', investor_id: 'zero', amount: '0' },
        { status: 'completed', investor_id: 'negative', amount: '-5' },
        { status: 'completed', investor_id: 'missing', amount: undefined },
        { status: 'completed', investor_id: 'good', amount: '3' },
      ]),
    );

    expect(await provider.getBalances('offering-1', '2024-01')).toEqual([
      { holderAddressOrId: 'good', balance: '3' },
    ]);
  });

  it('does not let a skipped amount reset a previously accumulated balance', async () => {
    const provider = createDbBalanceProviderFromInvestments(
      investmentRepo([
        { status: 'completed', investor_id: 'inv-1', amount: '10' },
        { status: 'completed', investor_id: 'inv-1', amount: 'rubbish' },
        { status: 'completed', investor_id: 'inv-1', amount: '5' },
      ]),
    );

    expect(await provider.getBalances('offering-1', '2024-01')).toEqual([
      { holderAddressOrId: 'inv-1', balance: '15' },
    ]);
  });

  it('stringifies a numeric investor_id so aggregation does not split', async () => {
    const provider = createDbBalanceProviderFromInvestments(
      investmentRepo([
        { status: 'completed', investor_id: 7, amount: '1' },
        { status: 'completed', investor_id: '7', amount: '2' },
      ]),
    );

    expect(await provider.getBalances('offering-1', '2024-01')).toEqual([
      { holderAddressOrId: '7', balance: '3' },
    ]);
  });

  it('keys an undefined investor_id as the literal string "undefined"', async () => {
    // Documents current behaviour: no investor_id yields a holder-shaped row that
    // normalizeBalances will then accept, because the key is truthy.
    const provider = createDbBalanceProviderFromInvestments(
      investmentRepo([{ status: 'completed', investor_id: undefined, amount: '9' }]),
    );

    expect(await provider.getBalances('offering-1', '2024-01')).toEqual([
      { holderAddressOrId: 'undefined', balance: '9' },
    ]);
  });

  it('honours insertion order of first appearance per investor', async () => {
    const provider = createDbBalanceProviderFromInvestments(
      investmentRepo([
        { status: 'completed', investor_id: 'b', amount: '1' },
        { status: 'completed', investor_id: 'a', amount: '1' },
        { status: 'completed', investor_id: 'b', amount: '1' },
      ]),
    );

    expect(await provider.getBalances('offering-1', '2024-01')).toEqual([
      { holderAddressOrId: 'b', balance: '2' },
      { holderAddressOrId: 'a', balance: '1' },
    ]);
  });

  it('forwards the requested offeringId to the investment repository', async () => {
    const repo = investmentRepo([]);
    const provider = createDbBalanceProviderFromInvestments(repo);
    await provider.getBalances('offering-xyz', '2024-01');

    expect(repo.findByOffering).toHaveBeenCalledWith('offering-xyz');
  });

  it('plugs into BalanceSnapshotService as a drop-in provider', async () => {
    const provider = createDbBalanceProviderFromInvestments(
      investmentRepo([
        { status: 'completed', investor_id: 'inv-1', amount: '25' },
        { status: 'completed', investor_id: 'inv-2', amount: '75' },
      ]),
    );
    const snapshotRepo = {
      findByOfferingAndPeriod: jest.fn().mockResolvedValue([]),
      insertMany: jest.fn().mockImplementation(async (rows: unknown[]) => rows),
    };
    const service = new BalanceSnapshotService(
      snapshotRepo as unknown as BalanceSnapshotRepository,
      { findById: jest.fn().mockResolvedValue(offering) } as unknown as OfferingRepository,
      undefined,
      provider,
    );

    const result = await service.snapshotBalances({
      offeringId: 'offering-1',
      periodId: '2024-01',
      periodEnd: PERIOD_END,
      source: 'auto',
    });

    expect(result.fromSource).toBe('db');
    expect(result.snapshots).toEqual([
      {
        offering_id: 'offering-1',
        period_id: '2024-01',
        holder_address_or_id: 'inv-1',
        balance: '25',
        snapshot_at: PERIOD_END,
      },
      {
        offering_id: 'offering-1',
        period_id: '2024-01',
        holder_address_or_id: 'inv-2',
        balance: '75',
        snapshot_at: PERIOD_END,
      },
    ]);
  });
});
