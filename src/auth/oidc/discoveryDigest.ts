import { createHash } from 'crypto';
import { OidcDiscoveryDocument } from './types';

/**
 * Deterministic JSON for discovery documents so digest compares semantic
 * content, not formatting (whitespace / key order).
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

/** Public discovery fields only — never include cache metadata in the digest. */
export function discoveryPayloadForDigest(doc: OidcDiscoveryDocument): Record<string, unknown> {
  const { _cachedUntil: _ignored, ...payload } = doc;
  return payload;
}

export function digestDiscoveryDocument(doc: OidcDiscoveryDocument): string {
  return createHash('sha256')
    .update(stableStringify(discoveryPayloadForDigest(doc)))
    .digest('hex');
}
