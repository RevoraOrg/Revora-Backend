import { createPublicKey, KeyObject } from 'crypto';
import { globalMetrics } from '../../lib/metrics';

interface JwksCacheEntry {
  keys: Map<string, KeyObject>;
  fetchedAt: number;
  issuer?: string;
}

interface JwksCacheMetrics {
  setGauge(name: string, value: number, labels?: Record<string, string>, help?: string): void;
}

interface JwksCacheServiceOptions {
  metrics?: JwksCacheMetrics;
}

const JWKS_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * In-memory JWKS cache per jwks_uri.
 * On signature failure call evict() then getKey() again — the cache
 * will re-fetch, transparently handling provider key rotation.
 */
export class JwksCacheService {
  private readonly cache = new Map<string, JwksCacheEntry>();
  private readonly issuerLastRefresh = new Map<string, number>();
  private readonly inFlightRefreshes = new Map<string, Promise<JwksCacheEntry>>();
  private readonly metrics: JwksCacheMetrics;

  constructor(options: JwksCacheServiceOptions = {}) {
    this.metrics = options.metrics ?? globalMetrics;
  }

  async getKey(jwksUri: string, kid: string, issuer?: string): Promise<KeyObject> {
    let entry = this.cache.get(jwksUri);
    if (!entry || Date.now() - entry.fetchedAt > JWKS_TTL_MS) {
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

  getCacheAgeSeconds(issuer: string): number {
    const lastRefresh = this.issuerLastRefresh.get(issuer);
    if (!lastRefresh) return 0;
    return Math.max(0, Math.floor((Date.now() - lastRefresh) / 1000));
  }

  async refresh(jwksUri: string, issuer?: string): Promise<JwksCacheEntry> {
    const existing = this.inFlightRefreshes.get(jwksUri);
    if (existing) return existing;

    const pending = this.fetchAndCache(jwksUri, issuer)
      .then((entry) => {
        if (issuer) {
          this.issuerLastRefresh.set(issuer, entry.fetchedAt);
          this.metrics.setGauge(
            'oidc.jwks.age_seconds',
            this.getCacheAgeSeconds(issuer),
            { issuer },
            'Age in seconds of the cached JWKS bundle per issuer',
          );
        }
        return entry;
      })
      .finally(() => {
        this.inFlightRefreshes.delete(jwksUri);
      });

    this.inFlightRefreshes.set(jwksUri, pending);
    return pending;
  }

  evict(jwksUri: string): void {
    this.cache.delete(jwksUri);
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

    const entry: JwksCacheEntry = { keys: keyMap, fetchedAt: Date.now(), issuer };
    this.cache.set(jwksUri, entry);
    return entry;
  }
}
