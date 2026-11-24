/**
 * Unit tests for FxProviderBudgetRegistry and supporting types.
 *
 * These tests directly exercise the registry's public contract:
 *   - Per-tenant isolation: spend and config are scoped to their tenant.
 *   - Cap reached / cap exceeded status (isNearLimit, isExhausted, remainingUsd).
 *   - Month rollover at the UTC boundary using fake timers.
 *   - Zero-cost calls: free calls never create a spend record.
 *   - listByTenant copy semantics: mutating results never corrupts the store.
 *
 * All tests are deterministic: fake timers pin the clock, no network, no I/O.
 *
 * Companion coverage: the regression suite
 * `src/services/regression/fxProviderBudgetRegistry.monthKey.regression.test.ts`
 * pins the evidence branch (getBudgetStatus missing-config), opaque-key
 * semantics and storage-failure (fail-open/-closed) behavior in more depth.
 *
 * @module services/fxProviderBudgetRegistry.test
 */

import {
  FxProviderBudgetRegistry,
  InMemorySpendStore,
  currentMonthKey,
  type MonthKey,
  type SpendRecord,
  type BudgetStatus,
} from './fxProviderBudgetRegistry';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const T1 = 'tenant-one';
const T2 = 'tenant-two';
const P_PREMIUM = 'bloomberg';
const P_MID = 'refinitiv';
const P_FREE = 'ecb';
const MONTH: MonthKey = '2026-06';
const CAP = 200;

/** Build a fresh store + registry with a single configured provider for T1. */
function makeRegistry(
  capUsd = CAP,
  degradationThreshold?: number,
): { registry: FxProviderBudgetRegistry; store: InMemorySpendStore } {
  const store = new InMemorySpendStore();
  const registry = new FxProviderBudgetRegistry(store);
  registry.configureProvider(T1, {
    providerId: P_PREMIUM,
    monthlyCapUsd: capUsd,
    ...(degradationThreshold !== undefined ? { degradationThreshold } : {}),
  });
  return { registry, store };
}

// ─── §1  currentMonthKey ──────────────────────────────────────────────────────

describe('currentMonthKey()', () => {
  afterEach(() => jest.useRealTimers());

  it('returns the current UTC month in YYYY-MM format', () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-06-15T09:30:00Z'));
    expect(currentMonthKey()).toBe('2026-06');
  });

  it('zero-pads single-digit months', () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    expect(currentMonthKey()).toBe('2026-01');
  });

  it('uses UTC, not local time — midnight UTC is still the new month in every timezone', () => {
    jest.useFakeTimers();
    // 2026-02-01T00:00:00Z is 2026-01-31 in UTC-5 but must resolve to 2026-02.
    jest.setSystemTime(new Date('2026-02-01T00:00:00Z'));
    expect(currentMonthKey()).toBe('2026-02');
  });

  it('advances exactly when the month boundary crosses midnight UTC', () => {
    jest.useFakeTimers();

    jest.setSystemTime(new Date('2026-03-31T23:59:59.999Z'));
    expect(currentMonthKey()).toBe('2026-03');

    jest.setSystemTime(new Date('2026-04-01T00:00:00.000Z'));
    expect(currentMonthKey()).toBe('2026-04');
  });
});

// ─── §2  configureProvider validation ────────────────────────────────────────

describe('FxProviderBudgetRegistry.configureProvider()', () => {
  it('registers a config successfully with valid inputs', () => {
    const { registry } = makeRegistry();
    expect(registry.hasConfig(T1, P_PREMIUM)).toBe(true);
  });

  it('overwrites an existing config when called again', async () => {
    const { registry } = makeRegistry(100);
    registry.configureProvider(T1, { providerId: P_PREMIUM, monthlyCapUsd: 500 });

    const status = await registry.getBudgetStatus(T1, P_PREMIUM, MONTH);
    expect(status.capUsd).toBe(500);
  });

  it.each([0, -1, -100, Infinity, NaN])(
    'throws RangeError for invalid monthlyCapUsd=%s',
    (bad) => {
      const store = new InMemorySpendStore();
      const r = new FxProviderBudgetRegistry(store);
      expect(() =>
        r.configureProvider(T1, { providerId: P_PREMIUM, monthlyCapUsd: bad }),
      ).toThrow(RangeError);
      // Rejected config must leave no trace.
      expect(r.hasConfig(T1, P_PREMIUM)).toBe(false);
    },
  );

  it.each([0, -0.1, 1.1, 2, Infinity])(
    'throws RangeError for degradationThreshold=%s outside (0, 1]',
    (bad) => {
      const store = new InMemorySpendStore();
      const r = new FxProviderBudgetRegistry(store);
      expect(() =>
        r.configureProvider(T1, {
          providerId: P_PREMIUM,
          monthlyCapUsd: 100,
          degradationThreshold: bad,
        }),
      ).toThrow(RangeError);
    },
  );

  it('accepts degradationThreshold = 1 (inclusive upper bound)', () => {
    const store = new InMemorySpendStore();
    const r = new FxProviderBudgetRegistry(store);
    expect(() =>
      r.configureProvider(T1, {
        providerId: P_PREMIUM,
        monthlyCapUsd: 100,
        degradationThreshold: 1,
      }),
    ).not.toThrow();
  });
});

// ─── §3  hasConfig ────────────────────────────────────────────────────────────

describe('FxProviderBudgetRegistry.hasConfig()', () => {
  it('returns false before any config is registered', () => {
    const r = new FxProviderBudgetRegistry(new InMemorySpendStore());
    expect(r.hasConfig(T1, P_PREMIUM)).toBe(false);
  });

  it('returns false for a different tenant even if the provider is registered elsewhere', () => {
    const { registry } = makeRegistry(); // T1:bloomberg configured
    expect(registry.hasConfig(T2, P_PREMIUM)).toBe(false);
  });

  it('returns false for a different provider even if the tenant is known', () => {
    const { registry } = makeRegistry();
    expect(registry.hasConfig(T1, P_MID)).toBe(false);
  });
});

// ─── §4  recordSpend and getBudgetStatus — basic accumulation ─────────────────

describe('FxProviderBudgetRegistry — spend accumulation and status', () => {
  it('starts with zero spend', async () => {
    const { registry } = makeRegistry();
    const status = await registry.getBudgetStatus(T1, P_PREMIUM, MONTH);
    expect(status.spendUsd).toBe(0);
    expect(status.capUsd).toBe(CAP);
    expect(status.remainingUsd).toBe(CAP);
    expect(status.isExhausted).toBe(false);
    expect(status.isNearLimit).toBe(false);
  });

  it('accumulates multiple calls correctly', async () => {
    const { registry } = makeRegistry();
    await registry.recordSpend(T1, P_PREMIUM, 10, MONTH);
    await registry.recordSpend(T1, P_PREMIUM, 25.5, MONTH);
    await registry.recordSpend(T1, P_PREMIUM, 4.5, MONTH);

    const status = await registry.getBudgetStatus(T1, P_PREMIUM, MONTH);
    expect(status.spendUsd).toBeCloseTo(40);
    expect(status.remainingUsd).toBeCloseTo(160);
  });

  it('throws when no config is registered for the queried (tenant, provider) pair', async () => {
    const { registry } = makeRegistry();
    await expect(
      registry.getBudgetStatus(T1, 'unconfigured', MONTH),
    ).rejects.toThrow(/No budget config for provider "unconfigured"/);
  });

  it('getBudgetStatus response includes all required fields', async () => {
    const { registry } = makeRegistry();
    await registry.recordSpend(T1, P_PREMIUM, 50, MONTH);
    const status = await registry.getBudgetStatus(T1, P_PREMIUM, MONTH);

    expect(status).toMatchObject<BudgetStatus>({
      tenantId: T1,
      providerId: P_PREMIUM,
      monthKey: MONTH,
      spendUsd: 50,
      capUsd: CAP,
      remainingUsd: 150,
      isExhausted: false,
      isNearLimit: false,
    });
  });
});

// ─── §5  Zero-cost calls ──────────────────────────────────────────────────────

describe('FxProviderBudgetRegistry — zero-cost calls', () => {
  it('skips store write for a zero-amount recordSpend call', async () => {
    const { registry, store } = makeRegistry();
    await registry.recordSpend(T1, P_PREMIUM, 0, MONTH);

    // No record should exist in the store.
    expect(await store.listByTenant(T1, MONTH)).toEqual([]);
    expect((await registry.getBudgetStatus(T1, P_PREMIUM, MONTH)).spendUsd).toBe(0);
  });

  it('zero-amount call does not change accumulated spend when prior spend exists', async () => {
    const { registry } = makeRegistry();
    await registry.recordSpend(T1, P_PREMIUM, 30, MONTH);
    await registry.recordSpend(T1, P_PREMIUM, 0, MONTH);

    expect((await registry.getBudgetStatus(T1, P_PREMIUM, MONTH)).spendUsd).toBe(30);
  });

  it('rejects negative spend with RangeError, leaving no store record', async () => {
    const { registry, store } = makeRegistry();
    await expect(
      registry.recordSpend(T1, P_PREMIUM, -0.01, MONTH),
    ).rejects.toThrow(RangeError);
    expect(await store.listByTenant(T1, MONTH)).toEqual([]);
  });
});

// ─── §6  Cap reached / cap exceeded status ────────────────────────────────────

describe('FxProviderBudgetRegistry — cap reached and exceeded', () => {
  it('isNearLimit is false one dollar below the default 90 % threshold', async () => {
    const { registry } = makeRegistry(100);
    // 89 / 100 = 0.89 < 0.9
    await registry.recordSpend(T1, P_PREMIUM, 89, MONTH);

    const s = await registry.getBudgetStatus(T1, P_PREMIUM, MONTH);
    expect(s.isNearLimit).toBe(false);
    expect(s.isExhausted).toBe(false);
    expect(s.remainingUsd).toBe(11);
  });

  it('isNearLimit flips exactly at cap × 0.9 (the default threshold)', async () => {
    const { registry } = makeRegistry(100);
    await registry.recordSpend(T1, P_PREMIUM, 90, MONTH); // 100 × 0.9 exactly

    const s = await registry.getBudgetStatus(T1, P_PREMIUM, MONTH);
    expect(s.isNearLimit).toBe(true);
    expect(s.isExhausted).toBe(false);
  });

  it('isExhausted flips exactly at the cap with zero remaining', async () => {
    const { registry } = makeRegistry(100);
    await registry.recordSpend(T1, P_PREMIUM, 100, MONTH);

    const s = await registry.getBudgetStatus(T1, P_PREMIUM, MONTH);
    expect(s.isExhausted).toBe(true);
    expect(s.isNearLimit).toBe(true);
    expect(s.remainingUsd).toBe(0);
  });

  it('remainingUsd is negative when spend exceeds cap', async () => {
    const { registry } = makeRegistry(100);
    await registry.recordSpend(T1, P_PREMIUM, 150, MONTH);

    const s = await registry.getBudgetStatus(T1, P_PREMIUM, MONTH);
    expect(s.isExhausted).toBe(true);
    expect(s.remainingUsd).toBe(-50);
  });

  it('honours a custom degradationThreshold (0.75)', async () => {
    const { registry } = makeRegistry(200, 0.75);
    // 149 / 200 = 0.745 — just below threshold
    await registry.recordSpend(T1, P_PREMIUM, 149, MONTH);
    expect((await registry.getBudgetStatus(T1, P_PREMIUM, MONTH)).isNearLimit).toBe(false);

    // 150 / 200 = 0.75 — exactly at threshold
    await registry.recordSpend(T1, P_PREMIUM, 1, MONTH);
    expect((await registry.getBudgetStatus(T1, P_PREMIUM, MONTH)).isNearLimit).toBe(true);
  });

  it('isProviderAvailable returns false only when exhausted', async () => {
    const { registry } = makeRegistry(100);

    // Near-limit but not exhausted → still available.
    await registry.recordSpend(T1, P_PREMIUM, 95, MONTH);
    await expect(registry.isProviderAvailable(T1, P_PREMIUM, MONTH)).resolves.toBe(true);

    // Exactly at cap → exhausted → unavailable.
    await registry.recordSpend(T1, P_PREMIUM, 5, MONTH);
    await expect(registry.isProviderAvailable(T1, P_PREMIUM, MONTH)).resolves.toBe(false);
  });

  it('isProviderNearLimit mirrors the status field', async () => {
    const { registry } = makeRegistry(100);

    await registry.recordSpend(T1, P_PREMIUM, 89, MONTH);
    await expect(registry.isProviderNearLimit(T1, P_PREMIUM, MONTH)).resolves.toBe(false);

    await registry.recordSpend(T1, P_PREMIUM, 1, MONTH); // 90 total
    await expect(registry.isProviderNearLimit(T1, P_PREMIUM, MONTH)).resolves.toBe(true);
  });

  it('isProviderAvailable returns true for unconfigured provider (open budget)', async () => {
    const r = new FxProviderBudgetRegistry(new InMemorySpendStore());
    await expect(r.isProviderAvailable(T1, 'unconfigured', MONTH)).resolves.toBe(true);
  });

  it('isProviderNearLimit returns false for unconfigured provider', async () => {
    const r = new FxProviderBudgetRegistry(new InMemorySpendStore());
    await expect(r.isProviderNearLimit(T1, 'unconfigured', MONTH)).resolves.toBe(false);
  });
});

// ─── §7  Per-tenant isolation ─────────────────────────────────────────────────

describe('FxProviderBudgetRegistry — per-tenant isolation', () => {
  it("T2's spend does not affect T1's budget status", async () => {
    const store = new InMemorySpendStore();
    const registry = new FxProviderBudgetRegistry(store);

    registry.configureProvider(T1, { providerId: P_PREMIUM, monthlyCapUsd: 100 });
    registry.configureProvider(T2, { providerId: P_PREMIUM, monthlyCapUsd: 100 });

    await registry.recordSpend(T2, P_PREMIUM, 99, MONTH);

    const t1Status = await registry.getBudgetStatus(T1, P_PREMIUM, MONTH);
    expect(t1Status.spendUsd).toBe(0);
    expect(t1Status.isExhausted).toBe(false);
  });

  it("T1 becoming exhausted does not affect T2's availability", async () => {
    const store = new InMemorySpendStore();
    const registry = new FxProviderBudgetRegistry(store);

    registry.configureProvider(T1, { providerId: P_PREMIUM, monthlyCapUsd: 100 });
    registry.configureProvider(T2, { providerId: P_PREMIUM, monthlyCapUsd: 100 });

    await registry.recordSpend(T1, P_PREMIUM, 100, MONTH);

    await expect(registry.isProviderAvailable(T1, P_PREMIUM, MONTH)).resolves.toBe(false);
    await expect(registry.isProviderAvailable(T2, P_PREMIUM, MONTH)).resolves.toBe(true);
  });

  it('configs are scoped per tenant:provider — registering for T2 does not create T1 config', () => {
    const store = new InMemorySpendStore();
    const registry = new FxProviderBudgetRegistry(store);
    registry.configureProvider(T2, { providerId: P_PREMIUM, monthlyCapUsd: 100 });

    expect(registry.hasConfig(T1, P_PREMIUM)).toBe(false);
    expect(registry.hasConfig(T2, P_PREMIUM)).toBe(true);
  });

  it('a tenant can hold independent configs for multiple providers', async () => {
    const store = new InMemorySpendStore();
    const registry = new FxProviderBudgetRegistry(store);
    registry.configureProvider(T1, { providerId: P_PREMIUM, monthlyCapUsd: 100 });
    registry.configureProvider(T1, { providerId: P_MID, monthlyCapUsd: 50 });

    await registry.recordSpend(T1, P_PREMIUM, 90, MONTH);
    await registry.recordSpend(T1, P_MID, 10, MONTH);

    expect((await registry.getBudgetStatus(T1, P_PREMIUM, MONTH)).isNearLimit).toBe(true);
    expect((await registry.getBudgetStatus(T1, P_MID, MONTH)).isNearLimit).toBe(false);
  });
});

// ─── §8  Month rollover at UTC boundary ───────────────────────────────────────

describe('FxProviderBudgetRegistry — month rollover at UTC boundary', () => {
  afterEach(() => jest.useRealTimers());

  it('spend recorded one second before midnight lands in the old month', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-05-31T23:59:59Z'));
    const { registry } = makeRegistry();

    await registry.recordSpend(T1, P_PREMIUM, 80); // goes into 2026-05

    // Advance to the first second of the new month.
    jest.setSystemTime(new Date('2026-06-01T00:00:00Z'));

    const juneStatus = await registry.getBudgetStatus(T1, P_PREMIUM);
    expect(juneStatus.monthKey).toBe('2026-06');
    expect(juneStatus.spendUsd).toBe(0);
    expect(juneStatus.isExhausted).toBe(false);

    // May spend must still be intact.
    const mayStatus = await registry.getBudgetStatus(T1, P_PREMIUM, '2026-05');
    expect(mayStatus.spendUsd).toBe(80);
  });

  it('a tenant that was near-limit in one month starts fresh the next month', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-07-31T23:59:59Z'));
    const { registry } = makeRegistry(100);

    await registry.recordSpend(T1, P_PREMIUM, 95); // 2026-07, near limit
    expect(
      (await registry.getBudgetStatus(T1, P_PREMIUM, '2026-07')).isNearLimit,
    ).toBe(true);

    jest.setSystemTime(new Date('2026-08-01T00:00:01Z'));
    const aug = await registry.getBudgetStatus(T1, P_PREMIUM);
    expect(aug.monthKey).toBe('2026-08');
    expect(aug.isNearLimit).toBe(false);
    expect(aug.isExhausted).toBe(false);
  });

  it('spend recorded after rollover accumulates in the new month only', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-31T23:59:59Z'));
    const { registry } = makeRegistry();

    await registry.recordSpend(T1, P_PREMIUM, 50); // 2026-08

    jest.setSystemTime(new Date('2026-09-01T00:00:00Z'));
    await registry.recordSpend(T1, P_PREMIUM, 20); // 2026-09

    expect((await registry.getBudgetStatus(T1, P_PREMIUM, '2026-08')).spendUsd).toBe(50);
    expect((await registry.getBudgetStatus(T1, P_PREMIUM, '2026-09')).spendUsd).toBe(20);
  });

  it('year boundary: December → January rolls correctly', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-12-31T23:59:59Z'));
    const { registry } = makeRegistry();
    await registry.recordSpend(T1, P_PREMIUM, 10); // 2026-12

    jest.setSystemTime(new Date('2027-01-01T00:00:00Z'));
    await registry.recordSpend(T1, P_PREMIUM, 7); // 2027-01

    expect((await registry.getBudgetStatus(T1, P_PREMIUM, '2026-12')).spendUsd).toBe(10);
    expect((await registry.getBudgetStatus(T1, P_PREMIUM, '2027-01')).spendUsd).toBe(7);
  });
});

// ─── §9  listByTenant / listTenantSpend copy semantics ───────────────────────

describe('FxProviderBudgetRegistry — listByTenant copy semantics', () => {
  it('listTenantSpend returns all records for the tenant in the given month', async () => {
    const store = new InMemorySpendStore();
    const registry = new FxProviderBudgetRegistry(store);
    registry.configureProvider(T1, { providerId: P_PREMIUM, monthlyCapUsd: 100 });
    registry.configureProvider(T1, { providerId: P_FREE, monthlyCapUsd: 100 });

    await registry.recordSpend(T1, P_PREMIUM, 20, MONTH);
    await registry.recordSpend(T1, P_FREE, 5, MONTH);
    await registry.recordSpend(T2, P_PREMIUM, 99, MONTH); // different tenant — must be excluded

    const records = await registry.listTenantSpend(T1, MONTH);
    expect(records).toHaveLength(2);
    const premiumRecord = records.find((r) => r.providerId === P_PREMIUM);
    const freeRecord = records.find((r) => r.providerId === P_FREE);
    expect(premiumRecord?.spendUsd).toBe(20);
    expect(freeRecord?.spendUsd).toBe(5);
  });

  it('mutating a record returned by listTenantSpend does not corrupt the store', async () => {
    const { registry, store } = makeRegistry();
    await registry.recordSpend(T1, P_PREMIUM, 42, MONTH);

    const [record] = await registry.listTenantSpend(T1, MONTH);
    // Mutate the returned copy.
    (record as SpendRecord).spendUsd = 999_999;

    // The store must be unaffected.
    expect(await store.get(T1, P_PREMIUM, MONTH)).toBe(42);
    const [fresh] = await registry.listTenantSpend(T1, MONTH);
    expect(fresh.spendUsd).toBe(42);
  });

  it('listTenantSpend returns an empty array for a month with no spend', async () => {
    const { registry } = makeRegistry();
    const records = await registry.listTenantSpend(T1, '2020-01');
    expect(records).toEqual([]);
  });

  it('listTenantSpend excludes records from other months', async () => {
    const { registry } = makeRegistry();
    await registry.recordSpend(T1, P_PREMIUM, 10, '2026-05');
    await registry.recordSpend(T1, P_PREMIUM, 20, '2026-06');

    const may = await registry.listTenantSpend(T1, '2026-05');
    expect(may).toHaveLength(1);
    expect(may[0].spendUsd).toBe(10);

    const jun = await registry.listTenantSpend(T1, '2026-06');
    expect(jun).toHaveLength(1);
    expect(jun[0].spendUsd).toBe(20);
  });

  it('each call to listTenantSpend returns an independent copy (two successive mutations)', async () => {
    const { registry } = makeRegistry();
    await registry.recordSpend(T1, P_PREMIUM, 55, MONTH);

    const first = await registry.listTenantSpend(T1, MONTH);
    first[0].spendUsd = 1;

    const second = await registry.listTenantSpend(T1, MONTH);
    expect(second[0].spendUsd).toBe(55); // unaffected by mutation of first
  });
});

// ─── §10  InMemorySpendStore direct contract ──────────────────────────────────

describe('InMemorySpendStore', () => {
  it('get returns 0 for a key that has never been written', async () => {
    const store = new InMemorySpendStore();
    expect(await store.get(T1, P_PREMIUM, MONTH)).toBe(0);
  });

  it('increment accumulates correctly across multiple calls', async () => {
    const store = new InMemorySpendStore();
    await store.increment(T1, P_PREMIUM, MONTH, 10);
    await store.increment(T1, P_PREMIUM, MONTH, 5.5);
    expect(await store.get(T1, P_PREMIUM, MONTH)).toBeCloseTo(15.5);
  });

  it('increment rejects negative amounts with RangeError', async () => {
    const store = new InMemorySpendStore();
    await expect(store.increment(T1, P_PREMIUM, MONTH, -1)).rejects.toThrow(RangeError);
    // Store must be pristine.
    expect(await store.get(T1, P_PREMIUM, MONTH)).toBe(0);
  });

  it('zero increment creates no record (empty-result invariant)', async () => {
    const store = new InMemorySpendStore();
    await store.increment(T1, P_PREMIUM, MONTH, 0);
    expect(await store.listByTenant(T1, MONTH)).toEqual([]);
    expect(await store.get(T1, P_PREMIUM, MONTH)).toBe(0);
  });

  it('zero increment after a positive one does not alter the existing record', async () => {
    const store = new InMemorySpendStore();
    await store.increment(T1, P_PREMIUM, MONTH, 10);
    await store.increment(T1, P_PREMIUM, MONTH, 0);
    expect(await store.get(T1, P_PREMIUM, MONTH)).toBe(10);
  });

  it('keys are composite: different tenants have isolated buckets', async () => {
    const store = new InMemorySpendStore();
    await store.increment(T1, P_PREMIUM, MONTH, 10);
    await store.increment(T2, P_PREMIUM, MONTH, 99);

    expect(await store.get(T1, P_PREMIUM, MONTH)).toBe(10);
    expect(await store.get(T2, P_PREMIUM, MONTH)).toBe(99);
  });

  it('keys are composite: different providers within the same tenant are isolated', async () => {
    const store = new InMemorySpendStore();
    await store.increment(T1, P_PREMIUM, MONTH, 50);
    await store.increment(T1, P_FREE, MONTH, 0.1);

    expect(await store.get(T1, P_PREMIUM, MONTH)).toBe(50);
    expect(await store.get(T1, P_FREE, MONTH)).toBeCloseTo(0.1);
  });

  it('clear() wipes every record', async () => {
    const store = new InMemorySpendStore();
    await store.increment(T1, P_PREMIUM, MONTH, 42);
    await store.increment(T2, P_FREE, MONTH, 7);

    store.clear();

    expect(await store.get(T1, P_PREMIUM, MONTH)).toBe(0);
    expect(await store.listByTenant(T1, MONTH)).toEqual([]);
    expect(await store.listByTenant(T2, MONTH)).toEqual([]);
  });

  it('listByTenant includes records for the right tenant only', async () => {
    const store = new InMemorySpendStore();
    await store.increment(T1, P_PREMIUM, MONTH, 20);
    await store.increment(T1, P_MID, MONTH, 5);
    await store.increment(T2, P_PREMIUM, MONTH, 99);

    const records = await store.listByTenant(T1, MONTH);
    expect(records).toHaveLength(2);
    expect(records.every((r) => r.tenantId === T1)).toBe(true);
  });

  it('listByTenant records each have the correct tenantId, providerId and monthKey', async () => {
    const store = new InMemorySpendStore();
    await store.increment(T1, P_PREMIUM, MONTH, 30);

    const [record] = await store.listByTenant(T1, MONTH);
    expect(record).toMatchObject<SpendRecord>({
      tenantId: T1,
      providerId: P_PREMIUM,
      monthKey: MONTH,
      spendUsd: 30,
    });
  });
});
