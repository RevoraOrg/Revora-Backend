import { createPublicKey, KeyObject } from 'crypto';

interface JwksCacheEntry {
  keys: Map<string, KeyObject>;
  fetchedAt: number;
}

const JWKS_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * In-memory JWKS cache per jwks_uri.
 * On signature failure call evict() then getKey() again — the cache
 * will re-fetch, transparently handling provider key rotation.
 */
export class JwksCacheService {
  private readonly cache = new Map<string, JwksCacheEntry>();

  async getKey(jwksUri: string, kid: string): Promise<KeyObject> {
    let entry = this.cache.get(jwksUri);
    if (!entry || Date.now() - entry.fetchedAt > JWKS_TTL_MS) {
      entry = await this.fetchAndCache(jwksUri);
    }

    const key = entry.keys.get(kid);
    if (key) return key;

    // kid missing — may be a provider rotation; evict and retry once
    this.cache.delete(jwksUri);
    entry = await this.fetchAndCache(jwksUri);

    const rotated = entry.keys.get(kid);
    if (!rotated) throw new Error(`Unknown kid="${kid}" at ${jwksUri} after rotation`);
    return rotated;
  }

  evict(jwksUri: string): void {
    this.cache.delete(jwksUri);
  }

  private async fetchAndCache(jwksUri: string): Promise<JwksCacheEntry> {
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

    const entry: JwksCacheEntry = { keys: keyMap, fetchedAt: Date.now() };
    this.cache.set(jwksUri, entry);
    return entry;
  }
}
