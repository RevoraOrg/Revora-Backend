/**
 * FX Provider Budget Registry
 *
 * Tracks per-provider API spend on a per-tenant, per-calendar-month basis and
 * enforces a configurable monthly budget cap.  When a tenant is approaching (or
 * has exceeded) its cap for a given provider, the registry signals that the
 * engine should degrade to a cheaper alternative.
 *
 * Security Assumptions
 * --------------------
 * 1. `tenantId` is an opaque identifier that has already been authenticated and
 *    authorised by the caller; the registry performs no auth itself.
 * 2. Spend amounts are always non-negative USD values; the registry rejects
 *    negative increments to prevent underflow manipulation.
 * 3. The in-memory store is single-process only.  Production deployments MUST
 *    wire the `SpendStore` interface to a durable, atomically-updated backend
 *    (e.g. a Postgres row with `FOR UPDATE` locking) to prevent race-condition
 *    double-spending across replicas.
 * 4. Budget caps must be set explicitly per tenant; there is no implicit global
 *    default so that misconfiguration is loud rather than silent.
 * 5. This registry never blocks a conversion – it only advises which provider
 *    tier to use.  The caller is responsible for ensuring a zero-cost fallback
 *    always exists (see `CostAwareRateSelector`).
 *
 * @module services/fxProviderBudgetRegistry
 */

/** Opaque month key in the form `YYYY-MM`. */
export type MonthKey = string;

/**
 * Returns the current calendar month key in the form `YYYY-MM`.
 * Uses UTC so that rollover is deterministic across time zones.
 */
export function currentMonthKey(): MonthKey {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

/**
 * Persistent spend record for a single (tenant, provider, month) triple.
 */
export interface SpendRecord {
  tenantId: string;
  providerId: string;
  monthKey: MonthKey;
  /** Accumulated spend in USD (always ≥ 0). */
  spendUsd: number;
}

/**
 * Pluggable storage backend for spend records.
 *
 * Implementations must be atomically safe: `increment` must use
 * optimistic-locking / `SELECT FOR UPDATE` / Redis atomic add, etc.
 */
export interface SpendStore {
  /**
   * Atomically add `amountUsd` to the running total for the given key.
   * Must reject (throw) if `amountUsd` is negative.
   */
  increment(tenantId: string, providerId: string, monthKey: MonthKey, amountUsd: number): Promise<void>;

  /**
   * Return the accumulated spend for the given key, or 0 if no record exists.
   */
  get(tenantId: string, providerId: string, monthKey: MonthKey): Promise<number>;

  /**
   * Return all spend records for a tenant in the given month (for reporting).
   */
  listByTenant(tenantId: string, monthKey: MonthKey): Promise<SpendRecord[]>;
}

// ─── In-Memory Implementation ─────────────────────────────────────────────────

/**
 * Non-durable, single-process spend store suitable for testing and local dev.
 *
 * @remarks
 * NOT safe for multi-replica deployments.  Replace with a Postgres-backed
 * implementation in production.
 */
export class InMemorySpendStore implements SpendStore {
  /** key: `${tenantId}:${providerId}:${monthKey}` */
  private readonly records = new Map<string, SpendRecord>();

  private key(tenantId: string, providerId: string, monthKey: MonthKey): string {
    return `${tenantId}:${providerId}:${monthKey}`;
  }

  async increment(
    tenantId: string,
    providerId: string,
    monthKey: MonthKey,
    amountUsd: number
  ): Promise<void> {
    if (amountUsd < 0) {
      throw new RangeError(
        `spend increment must be non-negative (got ${amountUsd})`
      );
    }
    const k = this.key(tenantId, providerId, monthKey);
    const existing = this.records.get(k);
    if (existing) {
      existing.spendUsd += amountUsd;
    } else {
      this.records.set(k, { tenantId, providerId, monthKey, spendUsd: amountUsd });
    }
  }

  async get(tenantId: string, providerId: string, monthKey: MonthKey): Promise<number> {
    return this.records.get(this.key(tenantId, providerId, monthKey))?.spendUsd ?? 0;
  }

  async listByTenant(tenantId: string, monthKey: MonthKey): Promise<SpendRecord[]> {
    const results: SpendRecord[] = [];
    for (const record of this.records.values()) {
      if (record.tenantId === tenantId && record.monthKey === monthKey) {
        results.push({ ...record });
      }
    }
    return results;
  }

  /** Test / dev helper: reset all data. */
  clear(): void {
    this.records.clear();
  }
}

// ─── Budget Registry ──────────────────────────────────────────────────────────

/**
 * Per-tenant monthly budget cap for a single FX provider.
 */
export interface ProviderBudgetConfig {
  /** Unique provider identifier (e.g. `"bloomberg"`, `"ecb"`, `"open_exchange"`). */
  providerId: string;
  /** Monthly budget ceiling in USD.  Must be > 0. */
  monthlyCapUsd: number;
  /**
   * Fraction of the cap (0–1) at which the registry signals "near limit" so
   * the engine can preemptively degrade to a cheaper provider.
   *
   * @default 0.9
   */
  degradationThreshold?: number;
}

/**
 * Budget status for a single (tenant, provider, month) triple.
 */
export interface BudgetStatus {
  tenantId: string;
  providerId: string;
  monthKey: MonthKey;
  /** Accumulated spend in USD this month. */
  spendUsd: number;
  /** Configured cap in USD. */
  capUsd: number;
  /** Remaining budget in USD (may be negative if overspent). */
  remainingUsd: number;
  /** True when spend ≥ cap. */
  isExhausted: boolean;
  /**
   * True when spend ≥ (cap × degradationThreshold).
   * The engine should prefer cheaper providers when this is true.
   */
  isNearLimit: boolean;
}

/**
 * FxProviderBudgetRegistry
 *
 * Manages monthly budget caps across tenants and FX rate providers.
 * The registry is the single source of truth for budget-aware provider
 * selection decisions.
 *
 * Usage:
 * ```typescript
 * const store = new InMemorySpendStore();
 * const registry = new FxProviderBudgetRegistry(store);
 *
 * registry.configureProvider('tenant-1', {
 *   providerId: 'bloomberg',
 *   monthlyCapUsd: 500,
 *   degradationThreshold: 0.9,
 * });
 *
 * await registry.recordSpend('tenant-1', 'bloomberg', 1.20);
 * const status = await registry.getBudgetStatus('tenant-1', 'bloomberg');
 * console.log(status.isNearLimit); // false – only $1.20 of $500 used
 * ```
 */
export class FxProviderBudgetRegistry {
  /**
   * key: `${tenantId}:${providerId}` → budget config
   * Kept in memory; configs are typically loaded at startup.
   */
  private readonly configs = new Map<string, ProviderBudgetConfig & { tenantId: string }>();

  constructor(private readonly store: SpendStore) {}

  /**
   * Register (or overwrite) the monthly budget cap for a provider under a
   * specific tenant.
   *
   * @param tenantId  Authenticated tenant identifier.
   * @param config    Budget configuration for the provider.
   * @throws {RangeError} if `monthlyCapUsd` is not a positive finite number.
   */
  configureProvider(tenantId: string, config: ProviderBudgetConfig): void {
    if (!Number.isFinite(config.monthlyCapUsd) || config.monthlyCapUsd <= 0) {
      throw new RangeError(
        `monthlyCapUsd must be a positive finite number (got ${config.monthlyCapUsd})`
      );
    }
    const threshold = config.degradationThreshold ?? 0.9;
    if (threshold <= 0 || threshold > 1) {
      throw new RangeError(
        `degradationThreshold must be in (0, 1] (got ${threshold})`
      );
    }
    this.configs.set(`${tenantId}:${config.providerId}`, {
      ...config,
      tenantId,
      degradationThreshold: threshold,
    });
  }

  /**
   * Record API spend for a provider call.
   *
   * @param tenantId    Authenticated tenant identifier.
   * @param providerId  Provider that was called.
   * @param amountUsd   Cost of the call in USD.  Must be ≥ 0.
   * @param monthKey    Optional override for the month key (defaults to current
   *                    UTC month).  Useful in tests.
   */
  async recordSpend(
    tenantId: string,
    providerId: string,
    amountUsd: number,
    monthKey?: MonthKey
  ): Promise<void> {
    if (amountUsd < 0) {
      throw new RangeError(
        `spend amount must be non-negative (got ${amountUsd})`
      );
    }
    if (amountUsd === 0) return; // free calls don't need a record
    await this.store.increment(tenantId, providerId, monthKey ?? currentMonthKey(), amountUsd);
  }

  /**
   * Return the current budget status for a (tenant, provider) pair.
   *
   * @param tenantId    Authenticated tenant identifier.
   * @param providerId  Provider to query.
   * @param monthKey    Optional override for the month key.
   * @throws {Error} if no budget config has been registered for the pair.
   */
  async getBudgetStatus(
    tenantId: string,
    providerId: string,
    monthKey?: MonthKey
  ): Promise<BudgetStatus> {
    const config = this.configs.get(`${tenantId}:${providerId}`);
    if (!config) {
      throw new Error(
        `No budget config for provider "${providerId}" under tenant "${tenantId}". ` +
        `Call configureProvider() first.`
      );
    }
    const month = monthKey ?? currentMonthKey();
    const spendUsd = await this.store.get(tenantId, providerId, month);
    const remainingUsd = config.monthlyCapUsd - spendUsd;
    const threshold = config.degradationThreshold ?? 0.9;

    return {
      tenantId,
      providerId,
      monthKey: month,
      spendUsd,
      capUsd: config.monthlyCapUsd,
      remainingUsd,
      isExhausted: spendUsd >= config.monthlyCapUsd,
      isNearLimit: spendUsd >= config.monthlyCapUsd * threshold,
    };
  }

  /**
   * Returns true if the given provider is available for use by the tenant.
   *
   * A provider is considered *unavailable* only when its budget is fully
   * exhausted (`isExhausted`).  Being "near limit" still allows usage; it
   * merely triggers a preference for cheaper alternatives.
   *
   * @remarks
   * If no config is registered for the pair the provider is assumed available
   * (open budget), so that misconfiguration is non-blocking.
   */
  async isProviderAvailable(
    tenantId: string,
    providerId: string,
    monthKey?: MonthKey
  ): Promise<boolean> {
    const config = this.configs.get(`${tenantId}:${providerId}`);
    if (!config) return true; // no budget config → treat as free

    try {
      const status = await this.getBudgetStatus(tenantId, providerId, monthKey);
      return !status.isExhausted;
    } catch {
      // Defensive: storage failure → fail open (do not block distributions)
      return true;
    }
  }

  /**
   * Returns true if the given provider is operating near its budget limit.
   * When true the engine should prefer cheaper alternatives if available.
   */
  async isProviderNearLimit(
    tenantId: string,
    providerId: string,
    monthKey?: MonthKey
  ): Promise<boolean> {
    const config = this.configs.get(`${tenantId}:${providerId}`);
    if (!config) return false;

    try {
      const status = await this.getBudgetStatus(tenantId, providerId, monthKey);
      return status.isNearLimit;
    } catch {
      return false;
    }
  }

  /**
   * Return all spend records for a tenant in the current (or specified) month.
   * Useful for building dashboards and the `fx.provider.spend_month` gauge.
   */
  async listTenantSpend(
    tenantId: string,
    monthKey?: MonthKey
  ): Promise<SpendRecord[]> {
    return this.store.listByTenant(tenantId, monthKey ?? currentMonthKey());
  }

  /**
   * Check whether a budget config exists for the given (tenant, provider) pair.
   */
  hasConfig(tenantId: string, providerId: string): boolean {
    return this.configs.has(`${tenantId}:${providerId}`);
  }
}
