/**
 * Regression coverage for `MonthKey` failure handling (Issue #1095).
 *
 * Evidence branch exercised (src/services/fxProviderBudgetRegistry.ts:274):
 *   `getBudgetStatus()` — the MonthKey-consuming status API — throws when no
 *   budget config has been registered for the (tenant, provider) pair:
 *     `throw new Error(\`No budget config for provider "..." under tenant "..."...\`)`
 *
 * Because `MonthKey` is an *opaque* `YYYY-MM` string that flows through every
 * spend/status/list API, this suite also pins the month-key failure,
 * empty-result, and boundary behavior that surrounds the evidence branch:
 *   - UTC-deterministic `currentMonthKey()` (no local-timezone drift)
 *   - Month rollover isolation (January spend never leaks into February)
 *   - Explicit `monthKey` overrides and opaque-key contract
 *   - Empty-result paths (`get` → 0, `listByTenant` → [], free-call skip)
 *   - Fail-open advisory helpers vs fail-closed status API on storage failure
 *
 * All tests are deterministic: fake timers pin the clock, no network, no
 * randomness. The public contract is asserted, never modified.
 */

import {
  FxProviderBudgetRegistry,
  InMemorySpendStore,
  SpendStore,
  SpendRecord,
  MonthKey,
  currentMonthKey,
} from '../fxProviderBudgetRegistry';

// ─── Fixtures & helpers ───────────────────────────────────────────────────────

const TENANT = 'tenant-alpha';
const PROVIDER = 'bloomberg';
const MONTH: MonthKey = '2026-03';
const CAP = 100;

/** Fresh registry with a fresh store and a configured provider (cap $100). */
function makeRegistry(capUsd = CAP, degradationThreshold?: number): {
  registry: FxProviderBudgetRegistry;
  store: InMemorySpendStore;
} {
  const store = new InMemorySpendStore();
  const registry = new FxProviderBudgetRegistry(store);
  registry.configureProvider(TENANT, {
    providerId: PROVIDER,
    monthlyCapUsd: capUsd,
    ...(degradationThreshold !== undefined ? { degradationThreshold } : {}),
  });
  return { registry, store };
}

/** Storage backend whose every read/write fails — used to pin fail-open behavior. */
class FailingSpendStore implements SpendStore {
  async increment(): Promise<void> {
    throw new Error('storage unavailable');
  }
  async get(): Promise<number> {
    throw new Error('storage unavailable');
  }
  async listByTenant(): Promise<SpendRecord[]> {
    return [];
  }
}

// ─── §1 Evidence branch: getBudgetStatus without a registered config (L274) ──

describe('MonthKey regression — getBudgetStatus missing-config failure (evidence L274)', () => {
  it('rejects with the documented error when no config was ever registered', async () => {
    const { registry } = makeRegistry();
    // Query a different provider that has no config under the tenant.
    await expect(registry.getBudgetStatus(TENANT, 'unconfigured-provider', MONTH)).rejects.toThrow(
      'No budget config for provider "unconfigured-provider" under tenant "tenant-alpha". ' +
        'Call configureProvider() first.'
    );
  });

  it('interpolates the exact queried tenant and provider into the error', async () => {
    const { registry } = makeRegistry();
    // Config exists for TENANT:bloomberg — querying a different tenant must fail.
    await expect(registry.getBudgetStatus('other-tenant', PROVIDER, MONTH)).rejects.toThrow(
      'No budget config for provider "bloomberg" under tenant "other-tenant". ' +
        'Call configureProvider() first.'
    );
  });

  it('is an Error (not a RangeError) so callers can distinguish config gaps from bad input', async () => {
    const { registry } = makeRegistry();
    const err = await registry.getBudgetStatus(TENANT, 'nope', MONTH).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(RangeError);
  });

  it('recovers once configureProvider() registers the missing config', async () => {
    const store = new InMemorySpendStore();
    const registry = new FxProviderBudgetRegistry(store);

    await expect(registry.getBudgetStatus(TENANT, PROVIDER, MONTH)).rejects.toThrow(
      'No budget config'
    );

    registry.configureProvider(TENANT, { providerId: PROVIDER, monthlyCapUsd: CAP });
    const status = await registry.getBudgetStatus(TENANT, PROVIDER, MONTH);
    expect(status.spendUsd).toBe(0);
    expect(status.capUsd).toBe(CAP);
    expect(status.monthKey).toBe(MONTH);
  });

  it('reflects configuration state via hasConfig (per tenant:provider pair)', () => {
    const { registry } = makeRegistry();
    expect(registry.hasConfig(TENANT, PROVIDER)).toBe(true);
    expect(registry.hasConfig(TENANT, 'unconfigured-provider')).toBe(false);
    expect(registry.hasConfig('other-tenant', PROVIDER)).toBe(false);
  });
});

// ─── §2 MonthKey semantics: UTC determinism, rollover, overrides ─────────────

describe('MonthKey regression — month-key semantics', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('defaults to the current UTC month when monthKey is omitted', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-03-15T12:00:00Z'));
    const { registry } = makeRegistry();

    await registry.recordSpend(TENANT, PROVIDER, 25);

    const status = await registry.getBudgetStatus(TENANT, PROVIDER);
    expect(status.monthKey).toBe(currentMonthKey());
    expect(status.monthKey).toBe('2026-03');
    expect(status.spendUsd).toBe(25);
  });

  it('uses UTC, not local time, at the month boundary (2026-01-01T00:30Z is still 2026-01)', () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-01-01T00:30:00Z')); // 2025-12-31 local in the Americas
    expect(currentMonthKey()).toBe('2026-01');
    expect(currentMonthKey()).toMatch(/^\d{4}-\d{2}$/);
  });

  it('rolls over cleanly: spend recorded before midnight does not leak into the next month', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-01-31T23:59:59Z'));
    const { registry } = makeRegistry();

    await registry.recordSpend(TENANT, PROVIDER, 50); // lands in 2026-01
    jest.setSystemTime(new Date('2026-02-01T00:00:01Z'));

    const feb = await registry.getBudgetStatus(TENANT, PROVIDER); // defaults to 2026-02
    expect(feb.monthKey).toBe('2026-02');
    expect(feb.spendUsd).toBe(0);
    expect(feb.isExhausted).toBe(false);

    const jan = await registry.getBudgetStatus(TENANT, PROVIDER, '2026-01');
    expect(jan.spendUsd).toBe(50);
    expect(jan.monthKey).toBe('2026-01');
  });

  it('honours an explicit monthKey override regardless of the wall clock', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-03-15T12:00:00Z'));
    const { registry } = makeRegistry();

    await registry.recordSpend(TENANT, PROVIDER, 40, '2025-01');

    const status = await registry.getBudgetStatus(TENANT, PROVIDER, '2025-01');
    expect(status.monthKey).toBe('2025-01');
    expect(status.spendUsd).toBe(40);
    // Nothing was recorded for the current month.
    expect((await registry.getBudgetStatus(TENANT, PROVIDER)).spendUsd).toBe(0);
  });

  it('treats MonthKey as opaque: arbitrary keys are stored and isolated verbatim', async () => {
    const { registry } = makeRegistry();

    // Documented contract: "Opaque month key in the form YYYY-MM" — the registry
    // does not parse or validate the format, so malformed keys are isolated
    // buckets rather than corrupting real months.
    await registry.recordSpend(TENANT, PROVIDER, 5, 'not-a-month');
    await registry.recordSpend(TENANT, PROVIDER, 7, '2026-13'); // invalid calendar month

    expect((await registry.getBudgetStatus(TENANT, PROVIDER, 'not-a-month')).spendUsd).toBe(5);
    expect((await registry.getBudgetStatus(TENANT, PROVIDER, '2026-13')).spendUsd).toBe(7);
    expect((await registry.getBudgetStatus(TENANT, PROVIDER, '2026-01')).spendUsd).toBe(0);
  });

  it('isolates spend across months and tenants (empty-result path for unseen keys)', async () => {
    const { registry } = makeRegistry();
    // Second tenant with its own config so status queries are valid for it too.
    registry.configureProvider('tenant-beta', { providerId: PROVIDER, monthlyCapUsd: CAP });

    await registry.recordSpend(TENANT, PROVIDER, 30, '2026-03');
    await registry.recordSpend(TENANT, PROVIDER, 70, '2026-04');
    await registry.recordSpend('tenant-beta', PROVIDER, 99, '2026-03');

    expect((await registry.getBudgetStatus(TENANT, PROVIDER, '2026-03')).spendUsd).toBe(30);
    expect((await registry.getBudgetStatus(TENANT, PROVIDER, '2026-04')).spendUsd).toBe(70);
    // Unseen (tenant, provider, month) triple → empty store result → spend 0.
    expect((await registry.getBudgetStatus('tenant-beta', PROVIDER, '2026-04')).spendUsd).toBe(0);
    // Cross-tenant isolation: beta's spend is invisible to alpha's month total.
    expect((await registry.getBudgetStatus(TENANT, PROVIDER, '2026-03')).spendUsd).toBe(30);
  });
});

// ─── §3 Boundary inputs: caps, thresholds, exhaustion edges ──────────────────

describe('MonthKey regression — budget boundary behavior', () => {
  it('reports not-exhausted one dollar under the cap (89 vs 0.9 threshold of 100)', async () => {
    const { registry } = makeRegistry();
    await registry.recordSpend(TENANT, PROVIDER, 89, MONTH);

    const status = await registry.getBudgetStatus(TENANT, PROVIDER, MONTH);
    expect(status.spendUsd).toBe(89);
    expect(status.remainingUsd).toBe(11);
    expect(status.isNearLimit).toBe(false);
    expect(status.isExhausted).toBe(false);
  });

  it('flips isNearLimit exactly at cap × default 0.9 threshold', async () => {
    const { registry } = makeRegistry();
    await registry.recordSpend(TENANT, PROVIDER, 90, MONTH); // 100 × 0.9

    const status = await registry.getBudgetStatus(TENANT, PROVIDER, MONTH);
    expect(status.isNearLimit).toBe(true);
    expect(status.isExhausted).toBe(false);
    expect(status.remainingUsd).toBe(10);
  });

  it('marks exhausted exactly at the cap with zero remaining', async () => {
    const { registry } = makeRegistry();
    await registry.recordSpend(TENANT, PROVIDER, 100, MONTH);

    const status = await registry.getBudgetStatus(TENANT, PROVIDER, MONTH);
    expect(status.isExhausted).toBe(true);
    expect(status.isNearLimit).toBe(true);
    expect(status.remainingUsd).toBe(0);
  });

  it('allows negative remainingUsd when overspent (documented contract)', async () => {
    const { registry } = makeRegistry();
    await registry.recordSpend(TENANT, PROVIDER, 120, MONTH);

    const status = await registry.getBudgetStatus(TENANT, PROVIDER, MONTH);
    expect(status.isExhausted).toBe(true);
    expect(status.remainingUsd).toBe(-20);
  });

  it('honours degradationThreshold = 1 (boundary of the valid range)', async () => {
    const { registry } = makeRegistry(CAP, 1);
    await registry.recordSpend(TENANT, PROVIDER, 90, MONTH);
    expect((await registry.getBudgetStatus(TENANT, PROVIDER, MONTH)).isNearLimit).toBe(false);

    await registry.recordSpend(TENANT, PROVIDER, 10, MONTH); // total 100 == cap
    expect((await registry.getBudgetStatus(TENANT, PROVIDER, MONTH)).isNearLimit).toBe(true);
  });

  it('rejects invalid caps and thresholds with RangeError (validation failure paths)', () => {
    const store = new InMemorySpendStore();
    const registry = new FxProviderBudgetRegistry(store);

    for (const badCap of [0, -5, Infinity, NaN]) {
      expect(() =>
        registry.configureProvider(TENANT, { providerId: 'p', monthlyCapUsd: badCap })
      ).toThrow(RangeError);
    }
    for (const badThreshold of [0, -0.5, 1.5, Infinity]) {
      expect(() =>
        registry.configureProvider(TENANT, {
          providerId: 'p',
          monthlyCapUsd: CAP,
          degradationThreshold: badThreshold,
        })
      ).toThrow(RangeError);
    }
    // Rejected configs must not linger.
    expect(registry.hasConfig(TENANT, 'p')).toBe(false);
  });

  it('never signals near-limit when the threshold is NaN (observable sharp edge)', async () => {
    // KNOWN SHARP EDGE, pinned as current behavior: `NaN` slips through the
    // (0, 1] validation because both `NaN <= 0` and `NaN > 1` are false. The
    // *safety outcome* is deterministic — `cap × NaN` is NaN, so `spend >= NaN`
    // is always false and degradation never triggers. A future fix that starts
    // rejecting NaN must consciously flip this assertion.
    const { registry } = makeRegistry(CAP, NaN);
    await registry.recordSpend(TENANT, PROVIDER, 1000, MONTH);

    expect((await registry.getBudgetStatus(TENANT, PROVIDER, MONTH)).isNearLimit).toBe(false);
    expect((await registry.getBudgetStatus(TENANT, PROVIDER, MONTH)).isExhausted).toBe(true);
  });
});

// ─── §4 recordSpend failure paths and store-level empty results ──────────────

describe('MonthKey regression — recordSpend and store failure/empty-result paths', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('rejects negative spend with RangeError and creates no record', async () => {
    const { registry, store } = makeRegistry();

    await expect(registry.recordSpend(TENANT, PROVIDER, -5, MONTH)).rejects.toThrow(
      'spend amount must be non-negative (got -5)'
    );
    // Underflow manipulation must leave no trace.
    expect(await store.listByTenant(TENANT, MONTH)).toEqual([]);
  });

  it('skips record creation for zero-cost calls (free-call early return)', async () => {
    const { registry, store } = makeRegistry();

    await registry.recordSpend(TENANT, PROVIDER, 0, MONTH);

    expect(await store.listByTenant(TENANT, MONTH)).toEqual([]);
    expect((await registry.getBudgetStatus(TENANT, PROVIDER, MONTH)).spendUsd).toBe(0);
  });

  it('accumulates repeated increments within the same month', async () => {
    const { registry } = makeRegistry();

    await registry.recordSpend(TENANT, PROVIDER, 1.2, MONTH);
    await registry.recordSpend(TENANT, PROVIDER, 3.8, MONTH);
    await registry.recordSpend(TENANT, PROVIDER, 5, MONTH);

    const status = await registry.getBudgetStatus(TENANT, PROVIDER, MONTH);
    expect(status.spendUsd).toBeCloseTo(10);
  });

  it('enforces non-negative amounts at the store layer too (defense in depth)', async () => {
    const store = new InMemorySpendStore();
    await expect(store.increment(TENANT, PROVIDER, MONTH, -1)).rejects.toThrow(
      'spend increment must be non-negative (got -1)'
    );
    await expect(store.increment(TENANT, PROVIDER, MONTH, -0.01)).rejects.toThrow(RangeError);
    expect(await store.get(TENANT, PROVIDER, MONTH)).toBe(0);
  });

  it('returns empty results for months and tenants with no spend', async () => {
    const { registry, store } = makeRegistry();

    await registry.recordSpend(TENANT, PROVIDER, 10, '2026-03');
    await registry.recordSpend('tenant-beta', PROVIDER, 20, '2026-03');

    expect(await store.listByTenant(TENANT, '2026-02')).toEqual([]); // unseen month
    expect(await store.listByTenant('tenant-gamma', '2026-03')).toEqual([]); // unseen tenant

    const march = await registry.listTenantSpend(TENANT, '2026-03');
    expect(march).toHaveLength(1);
    expect(march[0]).toMatchObject({
      tenantId: TENANT,
      providerId: PROVIDER,
      monthKey: '2026-03',
      spendUsd: 10,
    });
  });

  it('returns defensive copies from listByTenant (mutating a result cannot corrupt the store)', async () => {
    const { store } = makeRegistry();
    await store.increment(TENANT, PROVIDER, MONTH, 42);

    const [record] = await store.listByTenant(TENANT, MONTH);
    record.spendUsd = 999_999;

    expect(await store.get(TENANT, PROVIDER, MONTH)).toBe(42);
  });

  it('zero-amount store increments create no record (empty-result invariant at store level)', async () => {
    const store = new InMemorySpendStore();
    await store.increment(TENANT, PROVIDER, MONTH, 0);

    expect(await store.get(TENANT, PROVIDER, MONTH)).toBe(0);
    expect(await store.listByTenant(TENANT, MONTH)).toEqual([]);
  });

  it('clear() resets every record (documented test/dev helper)', async () => {
    const { registry, store } = makeRegistry();

    await registry.recordSpend(TENANT, PROVIDER, 42, MONTH);
    await registry.recordSpend('tenant-beta', 'ecb', 7, MONTH);
    expect(await store.get(TENANT, PROVIDER, MONTH)).toBe(42);

    store.clear();

    expect(await store.get(TENANT, PROVIDER, MONTH)).toBe(0);
    expect(await store.listByTenant('tenant-beta', MONTH)).toEqual([]);
    // Configs live in the registry, not the store: they survive a store reset.
    expect(registry.hasConfig(TENANT, PROVIDER)).toBe(true);
  });

  it('listTenantSpend defaults to the current UTC month when monthKey is omitted', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-05-10T12:00:00Z'));
    const { registry } = makeRegistry();

    await registry.recordSpend(TENANT, PROVIDER, 15, '2026-05');
    await registry.recordSpend(TENANT, PROVIDER, 99, '2026-04'); // previous month

    const current = await registry.listTenantSpend(TENANT); // no monthKey → currentMonthKey()
    expect(current).toHaveLength(1);
    expect(current[0]).toMatchObject({ tenantId: TENANT, providerId: PROVIDER, monthKey: '2026-05', spendUsd: 15 });
  });
});

// ─── §5 Advisory helpers fail open; the status API fails closed ──────────────

describe('MonthKey regression — storage failure semantics', () => {
  it('isProviderAvailable fails OPEN when storage fails (never blocks distributions)', async () => {
    const registry = new FxProviderBudgetRegistry(new FailingSpendStore());
    registry.configureProvider(TENANT, { providerId: PROVIDER, monthlyCapUsd: CAP });

    await expect(registry.isProviderAvailable(TENANT, PROVIDER, MONTH)).resolves.toBe(true);
  });

  it('isProviderNearLimit fails OPEN (false) when storage fails', async () => {
    const registry = new FxProviderBudgetRegistry(new FailingSpendStore());
    registry.configureProvider(TENANT, { providerId: PROVIDER, monthlyCapUsd: CAP });

    await expect(registry.isProviderNearLimit(TENANT, PROVIDER, MONTH)).resolves.toBe(false);
  });

  it('getBudgetStatus does NOT swallow storage errors (fail-closed status contract)', async () => {
    const registry = new FxProviderBudgetRegistry(new FailingSpendStore());
    registry.configureProvider(TENANT, { providerId: PROVIDER, monthlyCapUsd: CAP });

    // The defensive catch exists only in the advisory helpers; the status API
    // must propagate so callers can observe the real failure.
    await expect(registry.getBudgetStatus(TENANT, PROVIDER, MONTH)).rejects.toThrow(
      'storage unavailable'
    );
  });

  it('isProviderAvailable/isProviderNearLimit reflect real budget state on the success path', async () => {
    const { registry } = makeRegistry(CAP, 0.5);

    // Under threshold: available, not near limit.
    await registry.recordSpend(TENANT, PROVIDER, 25, MONTH);
    await expect(registry.isProviderAvailable(TENANT, PROVIDER, MONTH)).resolves.toBe(true);
    await expect(registry.isProviderNearLimit(TENANT, PROVIDER, MONTH)).resolves.toBe(false);

    // At threshold: still available, but near limit.
    await registry.recordSpend(TENANT, PROVIDER, 25, MONTH); // total 50 == cap × 0.5
    await expect(registry.isProviderAvailable(TENANT, PROVIDER, MONTH)).resolves.toBe(true);
    await expect(registry.isProviderNearLimit(TENANT, PROVIDER, MONTH)).resolves.toBe(true);

    // Fully exhausted: unavailable.
    await registry.recordSpend(TENANT, PROVIDER, 60, MONTH); // total 110 > cap
    await expect(registry.isProviderAvailable(TENANT, PROVIDER, MONTH)).resolves.toBe(false);
  });

  it('unconfigured providers are treated as open budget by the advisory helpers', async () => {
    const registry = new FxProviderBudgetRegistry(new InMemorySpendStore());

    // Documented: no config → assumed free / non-blocking (misconfiguration is
    // non-blocking here even though getBudgetStatus throws for the same pair).
    await expect(registry.isProviderAvailable(TENANT, 'unconfigured', MONTH)).resolves.toBe(true);
    await expect(registry.isProviderNearLimit(TENANT, 'unconfigured', MONTH)).resolves.toBe(false);
    await expect(registry.getBudgetStatus(TENANT, 'unconfigured', MONTH)).rejects.toThrow(
      'No budget config'
    );
  });
});
