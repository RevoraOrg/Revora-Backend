import { createPublicKey, KeyObject } from 'crypto';
import { globalMetrics } from '../../lib/metrics';

interface JwksCacheEntry {
  keys: Map<string, KeyObject>;
  fetchedAt: number;
  issuer?: string;
}

export interface JwksCacheMetrics {
  setGauge(name: string, value: number, labels?: Record<string, string>, help?: string): void;
}

export interface JwksCacheServiceOptions {
  metrics?: JwksCacheMetrics;
  /** Interval (ms) at which the `oidc.jwks.age_seconds` gauges are re-emitted. Default 60s. */
  ageGaugeIntervalMs?: number;
  /** Injectable clock (epoch ms) for deterministic tests. Defaults to Date.now. */
  now?: () => number;
}

const JWKS_TTL_MS = 60 * 60 * 1000; // 1 hour
const AGE_GAUGE_INTERVAL_MS = 60 * 1000; // 1 minute
const AGE_GAUGE_NAME = 'oidc.jwks.age_seconds';
const AGE_GAUGE_HELP =
  'Age in seconds of the cached JWKS bundle per issuer (0 when unknown or freshly refreshed)';

/**
 * In-memory JWKS cache per jwks_uri.
 * On signature failure call evict() then getKey() again — the cache
 * will re-fetch, transparently handling provider key rotation.
 *
 * Concurrency model:
 * - All refreshes to the same `jwks_uri` are coalesced into a single
 *   in-flight `fetch()`. Callers that arrive while a fetch is pending
 *   share the same promise; they register the issuer they care about so
 *   the per-issuer age bookkeeping is updated for every waiter on success.
 * - A failed fetch removes the in-flight entry, so a retry performs a
 *   fresh upstream fetch (no poisoned cache of failures).
 *
 * Staleness alarm:
 * - `startAgeGaugeTicker()` re-emits `oidc.jwks.age_seconds{issuer=...}`
 *   on an interval so the gauge tracks real elapsed time, not only the
 *   value captured at the moment of the last refresh. The ticker is
 *   `unref()`'d so it never keeps the process alive, and `stopAgeGaugeTicker()`
 *   shuts it down (used in tests and on graceful shutdown).
 */
export class JwksCacheService {
  private readonly cache = new Map<string, JwksCacheEntry>();
  private readonly issuerLastRefresh = new Map<string, number>();
  private readonly inFlightRefreshes = new Map<string, Promise<JwksCacheEntry>>();
  /** Issuers waiting on an in-flight fetch, per jwks_uri — each gets age bookkeeping on success. */
  private readonly pendingIssuers = new Map<string, Set<string>>();
  private readonly metrics: JwksCacheMetrics;
  private readonly ageGaugeIntervalMs: number;
  private readonly now: () => number;
  private ageTicker: ReturnType<typeof setInterval> | null = null;

  constructor(options: JwksCacheServiceOptions = {}) {
    this.metrics = options.metrics ?? globalMetrics;
    this.ageGaugeIntervalMs = options.ageGaugeIntervalMs ?? AGE_GAUGE_INTERVAL_MS;
    this.now = options.now ?? (() => Date.now());
  }

  async getKey(jwksUri: string, kid: string, issuer?: string): Promise<KeyObject> {
    let entry = this.cache.get(jwksUri);
    if (!entry || this.now() - entry.fetchedAt > JWKS_TTL_MS) {
      entry = await this.refresh(jwksUri, issuer ?? entry?.issuer);
    }

    const key = entry.keys.get(kid);
    if (key) return key;

    // kid missing — may be a provider rotation; evict and retry once
    this.cache.delete(jwksUri);
    entry = await this.refresh(jwksUri, issuer ?? entry?.issuer);

    const rotated = entry.keys.get(kid);
    if (!rotated) throw new Error(`Unknown kid="${kid}" at ${jwksUri} after rotation`);
    return rotated;
  }

  /**
   * Age in seconds of the last successful JWKS refresh for `issuer`.
   * Returns 0 when the issuer has never had a successful refresh recorded.
   */
  getCacheAgeSeconds(issuer: string): number {
    const lastRefresh = this.issuerLastRefresh.get(issuer);
    if (!lastRefresh) return 0;
    return Math.max(0, Math.floor((this.now() - lastRefresh) / 1000));
  }

  /** Issuers with at least one recorded successful refresh. */
  getTrackedIssuers(): string[] {
    return [...this.issuerLastRefresh.keys()];
  }

  /** Re-emit the age gauge for every tracked issuer (used by the ticker and on refresh). */
  emitAgeGauges(): void {
    for (const issuer of this.getTrackedIssuers()) {
      this.metrics.setGauge(AGE_GAUGE_NAME, this.getCacheAgeSeconds(issuer), { issuer }, AGE_GAUGE_HELP);
    }
  }

  /**
   * Start re-emitting `oidc.jwks.age_seconds` per tracked issuer on an interval.
   * Idempotent — a second call while running is a no-op. The timer is unref'd.
   */
  startAgeGaugeTicker(intervalMs: number = this.ageGaugeIntervalMs): void {
    if (this.ageTicker) return;
    this.ageTicker = setInterval(() => {
      this.emitAgeGauges();
    }, intervalMs);
    if (typeof this.ageTicker.unref === 'function') {
      this.ageTicker.unref();
    }
  }

  /** Stop the age-gauge ticker. Safe to call when not running. */
  stopAgeGaugeTicker(): void {
    if (this.ageTicker !== null) {
      clearInterval(this.ageTicker);
      this.ageTicker = null;
    }
  }

  /**
   * Force a JWKS fetch for `jwksUri` (bypasses the TTL), coalesced per URI:
   * concurrent callers for the same URI share one upstream fetch. On success
   * every issuer that waited on this fetch is recorded with the new fetchedAt.
   */
  async refresh(jwksUri: string, issuer?: string): Promise<JwksCacheEntry> {
    const existing = this.inFlightRefreshes.get(jwksUri);
    if (existing) {
      if (issuer) this.registerPendingIssuer(jwksUri, issuer);
      return existing;
    }
    if (issuer) this.registerPendingIssuer(jwksUri, issuer);

    const pending = this.fetchAndCache(jwksUri, issuer)
      .then((entry) => {
        const issuers = this.pendingIssuers.get(jwksUri);
        if (issuers) {
          for (const waitingIssuer of issuers) {
            this.issuerLastRefresh.set(waitingIssuer, entry.fetchedAt);
          }
        }
        this.emitAgeGauges();
        return entry;
      })
      .finally(() => {
        this.inFlightRefreshes.delete(jwksUri);
        this.pendingIssuers.delete(jwksUri);
      });

    this.inFlightRefreshes.set(jwksUri, pending);
    return pending;
  }

  evict(jwksUri: string): void {
    this.cache.delete(jwksUri);
  }

  private registerPendingIssuer(jwksUri: string, issuer: string): void {
    let issuers = this.pendingIssuers.get(jwksUri);
    if (!issuers) {
      issuers = new Set();
      this.pendingIssuers.set(jwksUri, issuers);
    }
    issuers.add(issuer);
  }

  private async fetchAndCache(jwksUri: string, issuer?: string): Promise<JwksCacheEntry> {
    const res = await fetch(jwksUri);
    if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status} ${res.statusText}`);

    const { keys: rawKeys } = (await res.json()) as { keys: Record<string, unknown>[] };
    const keyMap = new Map<string, KeyObject>();

    for (const raw of rawKeys) {
      const kid = raw['kid'] as string | undefined;
      if (!kid) continue;
      try {
        keyMap.set(kid, createPublicKey({ key: raw as object, format: 'jwk' }));
      } catch { /* skip malformed entries */ }
    }

    const entry: JwksCacheEntry = { keys: keyMap, fetchedAt: this.now(), issuer };
    this.cache.set(jwksUri, entry);
    return entry;
  }
}
