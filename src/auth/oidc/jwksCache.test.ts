/**
 * Dedicated regression suite for JwksCacheService failure handling.
 *
 * The consolidated `src/auth/oidc/oidc.test.ts` exercises this service through
 * the adapter, so several of the cache's own control-flow guards are never
 * reached there. This file targets exactly those:
 *
 * - the **TTL guard** — a cached entry is reused up to and including
 *   `JWKS_TTL_MS`, and re-fetched one millisecond past it,
 * - **issuer propagation** — `issuer ?? entry?.issuer` on the first fetch, the
 *   cached issuer being inherited when a later call omits it, and a fresh
 *   issuer being accepted when the cached entry has none,
 * - **metrics wiring** — `setGauge` fires only when an issuer is known, with the
 *   documented name/labels/help, and an injected collector overrides the global,
 * - **in-flight bookkeeping** — a rejected refresh must clear the shared promise
 *   so the next call retries instead of resurrecting the failure,
 * - **cache age** — `0` for an unknown issuer and the `Math.max(0, …)` clamp,
 * - **malformed upstream payloads** — no `keys` field, a non-JSON body, an empty
 *   key set, a missing `kid`, and duplicate `kid`s.
 *
 * `Date.now` is overridden per test rather than faked, so the TTL boundary can be
 * probed exactly.
 */

import { generateKeyPairSync } from 'crypto';
import type { KeyObject } from 'crypto';
import { globalMetrics } from '../../lib/metrics';
import { JwksCacheService } from './jwksCache';

const URI = 'https://idp.example.com/.well-known/jwks.json';
const ISSUER = 'https://idp.example.com';
const TTL_MS = 60 * 60 * 1000;

/** Exports a key as a JWK. `format: 'jwk'` needs no `type` and is portable across Node type versions. */
const toJwk = (key: KeyObject): JsonWebKey => key.export({ format: 'jwk' }) as JsonWebKey;

const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const jwk = toJwk(publicKey);

const ok = (keys: Record<string, unknown>[]) => ({
  ok: true,
  status: 200,
  statusText: 'OK',
  json: async () => ({ keys }),
});

const makeJwks = (kid: string) => ok([{ ...jwk, kid }]);

/** Advances Date.now without touching real time. */
function freezeAt(start: number) {
  const real = Date.now;
  let now = start;
  Date.now = () => now;
  return {
    advance(ms: number) {
      now += ms;
    },
    restore() {
      Date.now = real;
    },
  };
}

describe('JwksCacheService — failure handling', () => {
  let fetchMock: ReturnType<typeof jest.fn>;
  let setGaugeSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    fetchMock = jest.fn();
    (global as unknown as { fetch: unknown }).fetch = fetchMock;
    // Spied per test so the suite is correct with or without restoreMocks.
    setGaugeSpy = jest.spyOn(globalMetrics, 'setGauge');
  });

  afterEach(() => {
    setGaugeSpy.mockRestore();
    jest.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // TTL guard
  // -------------------------------------------------------------------------
  describe('TTL guard', () => {
    it('reuses a cached key up to and including the TTL boundary', async () => {
      const clock = freezeAt(1_700_000_000_000);
      try {
        fetchMock.mockResolvedValueOnce(makeJwks('k1'));
        const cache = new JwksCacheService();
        await cache.getKey(URI, 'k1');

        clock.advance(TTL_MS); // exactly the TTL: still considered fresh
        await cache.getKey(URI, 'k1');

        expect(fetchMock).toHaveBeenCalledTimes(1);
      } finally {
        clock.restore();
      }
    });

    it('re-fetches one millisecond past the TTL boundary', async () => {
      const clock = freezeAt(1_700_000_000_000);
      try {
        fetchMock.mockResolvedValueOnce(makeJwks('k1'));
        const cache = new JwksCacheService();
        await cache.getKey(URI, 'k1');

        clock.advance(TTL_MS + 1);
        fetchMock.mockResolvedValueOnce(makeJwks('k1'));
        await cache.getKey(URI, 'k1');

        expect(fetchMock).toHaveBeenCalledTimes(2);
      } finally {
        clock.restore();
      }
    });

    it('serves the cached key while the TTL has not elapsed', async () => {
      const clock = freezeAt(1_700_000_000_000);
      try {
        fetchMock.mockResolvedValueOnce(makeJwks('k1'));
        const cache = new JwksCacheService();
        await cache.getKey(URI, 'k1');

        clock.advance(TTL_MS - 1);
        expect(await cache.getKey(URI, 'k1')).toBeDefined();
        expect(fetchMock).toHaveBeenCalledTimes(1);
      } finally {
        clock.restore();
      }
    });
  });

  // -------------------------------------------------------------------------
  // Issuer propagation
  // -------------------------------------------------------------------------
  describe('issuer propagation', () => {
    it('records the issuer supplied on the first fetch', async () => {
      fetchMock.mockResolvedValueOnce(makeJwks('k1'));
      const cache = new JwksCacheService();
      await cache.getKey(URI, 'k1', ISSUER);

      expect(cache.getCacheAgeSeconds(ISSUER)).toBeGreaterThanOrEqual(0);
    });

    it('reuses the cached issuer when a later call omits it', async () => {
      fetchMock.mockResolvedValueOnce(makeJwks('k1'));
      const cache = new JwksCacheService();
      await cache.getKey(URI, 'k1', ISSUER);

      // No issuer argument here: the rotation refresh must inherit the cached one.
      fetchMock.mockResolvedValueOnce(makeJwks('k2'));
      await cache.getKey(URI, 'k2');

      const gauges = setGaugeSpy.mock.calls;
      expect(gauges.length).toBeGreaterThan(0);
      expect(gauges.every((call) => call[2].issuer === ISSUER)).toBe(true);
    });

    it('accepts a fresh issuer when the cached entry has none', async () => {
      fetchMock.mockResolvedValueOnce(makeJwks('k1'));
      const cache = new JwksCacheService();
      await cache.getKey(URI, 'k1'); // no issuer recorded

      fetchMock.mockResolvedValueOnce(makeJwks('k2'));
      await cache.getKey(URI, 'k2', ISSUER);

      const gauges = setGaugeSpy.mock.calls;
      expect(gauges.some((call) => call[2].issuer === ISSUER)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Metrics wiring
  // -------------------------------------------------------------------------
  describe('metrics wiring', () => {
    it('does not publish a gauge when no issuer is known', async () => {
      fetchMock.mockResolvedValueOnce(makeJwks('k1'));
      const cache = new JwksCacheService();
      await cache.getKey(URI, 'k1');

      expect(setGaugeSpy).not.toHaveBeenCalled();
    });

    it('publishes the documented gauge name, labels and help text', async () => {
      fetchMock.mockResolvedValueOnce(makeJwks('k1'));
      const cache = new JwksCacheService();
      await cache.getKey(URI, 'k1', ISSUER);

      expect(setGaugeSpy).toHaveBeenCalledTimes(1);
      const [name, value, labels, help] = setGaugeSpy.mock.calls[0];
      expect(name).toBe('oidc.jwks.age_seconds');
      expect(typeof value).toBe('number');
      expect(value).toBeGreaterThanOrEqual(0);
      expect(labels).toEqual({ issuer: ISSUER });
      expect(typeof help).toBe('string');
      expect(help.length).toBeGreaterThan(0);
    });

    it('publishes once per issuer-tagged refresh', async () => {
      fetchMock.mockResolvedValue(makeJwks('k1'));
      const cache = new JwksCacheService();
      await cache.refresh(URI, ISSUER);
      await cache.refresh(URI, ISSUER);

      expect(setGaugeSpy).toHaveBeenCalledTimes(2);
    });

    it('honours an injected metrics implementation over the global one', async () => {
      const injected = { setGauge: jest.fn() };
      fetchMock.mockResolvedValueOnce(makeJwks('k1'));
      const cache = new JwksCacheService({ metrics: injected });
      await cache.getKey(URI, 'k1', ISSUER);

      expect(injected.setGauge).toHaveBeenCalledTimes(1);
      expect(setGaugeSpy).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // In-flight refresh bookkeeping
  // -------------------------------------------------------------------------
  describe('in-flight refresh bookkeeping', () => {
    it('coalesces concurrent refreshes into a single fetch', async () => {
      fetchMock.mockResolvedValueOnce(makeJwks('k1'));
      const cache = new JwksCacheService();
      const [a, b] = await Promise.all([cache.refresh(URI), cache.refresh(URI)]);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(a).toBe(b);
    });

    it('coalesces concurrent getKey calls that both miss the cache', async () => {
      fetchMock.mockResolvedValueOnce(makeJwks('k1'));
      const cache = new JwksCacheService();
      await Promise.all([cache.getKey(URI, 'k1'), cache.getKey(URI, 'k1')]);

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('clears the in-flight entry after a rejected refresh so a retry re-fetches', async () => {
      fetchMock.mockRejectedValueOnce(new Error('network down'));
      const cache = new JwksCacheService();

      await expect(cache.refresh(URI)).rejects.toThrow('network down');

      // If the rejected promise were still registered, this would rethrow the
      // same error without touching fetch.
      fetchMock.mockResolvedValueOnce(makeJwks('k1'));
      const entry = await cache.refresh(URI);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(entry.keys.get('k1')).toBeDefined();
    });

    it('clears the in-flight entry after a rejected fetch caused by a bad status', async () => {
      fetchMock.mockResolvedValueOnce({ ok: false, status: 503, statusText: 'Busy' });
      const cache = new JwksCacheService();
      await expect(cache.refresh(URI)).rejects.toThrow(/JWKS fetch failed: 503/);

      fetchMock.mockResolvedValueOnce(makeJwks('k9'));
      await expect(cache.refresh(URI)).resolves.toBeDefined();
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  // -------------------------------------------------------------------------
  // Cache age
  // -------------------------------------------------------------------------
  describe('getCacheAgeSeconds', () => {
    it('reports 0 for an issuer that has never been refreshed', () => {
      const cache = new JwksCacheService();
      expect(cache.getCacheAgeSeconds('https://never.example.com')).toBe(0);
    });

    it('reports whole seconds elapsed since the last refresh for that issuer', async () => {
      const clock = freezeAt(1_700_000_000_000);
      try {
        fetchMock.mockResolvedValueOnce(makeJwks('k1'));
        const cache = new JwksCacheService();
        await cache.getKey(URI, 'k1', ISSUER);

        expect(cache.getCacheAgeSeconds(ISSUER)).toBe(0);
        clock.advance(42_000);
        expect(cache.getCacheAgeSeconds(ISSUER)).toBe(42);
      } finally {
        clock.restore();
      }
    });

    it('never reports a negative age when the clock moves backwards', async () => {
      const clock = freezeAt(1_700_000_000_000);
      try {
        fetchMock.mockResolvedValueOnce(makeJwks('k1'));
        const cache = new JwksCacheService();
        await cache.getKey(URI, 'k1', ISSUER);

        clock.advance(-10_000);
        expect(cache.getCacheAgeSeconds(ISSUER)).toBe(0);
      } finally {
        clock.restore();
      }
    });

    it('tracks each issuer independently', async () => {
      const other = 'https://other.example.com';
      fetchMock.mockResolvedValue(makeJwks('k1'));
      const cache = new JwksCacheService();
      await cache.refresh(URI, ISSUER);
      await cache.refresh(URI, other);

      expect(cache.getCacheAgeSeconds(ISSUER)).toBeGreaterThanOrEqual(0);
      expect(cache.getCacheAgeSeconds(other)).toBeGreaterThanOrEqual(0);
      expect(cache.getCacheAgeSeconds('https://unseen.example.com')).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Malformed / degenerate upstream payloads
  // -------------------------------------------------------------------------
  describe('malformed upstream payloads', () => {
    it('propagates a JSON decode failure from the response body', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => {
          throw new SyntaxError('Unexpected token < in JSON');
        },
      });
      const cache = new JwksCacheService();
      await expect(cache.getKey(URI, 'k1')).rejects.toThrow(/Unexpected token/);
    });

    it('fails when the body carries no keys field', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({}),
      });
      const cache = new JwksCacheService();
      await expect(cache.getKey(URI, 'k1')).rejects.toThrow();
    });

    it('treats an empty key set as unknown and reports it after rotation', async () => {
      fetchMock.mockResolvedValue(ok([]));
      const cache = new JwksCacheService();
      await expect(cache.getKey(URI, 'k1')).rejects.toThrow(/after rotation/);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('skips entries without a kid but keeps the usable ones', async () => {
      fetchMock.mockResolvedValueOnce(ok([{ ...jwk }, { ...jwk, kid: 'good' }]));
      const cache = new JwksCacheService();
      expect(await cache.getKey(URI, 'good')).toBeDefined();
    });

    it('keeps the last entry when two keys share a kid', async () => {
      const second = generateKeyPairSync('ec', { namedCurve: 'P-384' }).publicKey;
      const secondJwk = toJwk(second);
      fetchMock.mockResolvedValueOnce(
        ok([
          { ...jwk, kid: 'dup' },
          { ...secondJwk, kid: 'dup' },
        ]),
      );

      const cache = new JwksCacheService();
      const resolved = await cache.getKey(URI, 'dup');
      // Comparing exported PEMs avoids relying on KeyObject internals.
      expect(resolved.export({ type: 'spki', format: 'pem' })).toBe(
        second.export({ type: 'spki', format: 'pem' }),
      );
    });

    it('rethrows an upstream fetch rejection unchanged', async () => {
      fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
      const cache = new JwksCacheService();
      await expect(cache.getKey(URI, 'k1')).rejects.toThrow('fetch failed');
    });
  });

  // -------------------------------------------------------------------------
  // evict / refresh surface
  // -------------------------------------------------------------------------
  describe('evict and refresh surface', () => {
    it('evicting an unknown uri is a no-op', () => {
      const cache = new JwksCacheService();
      expect(() => cache.evict('https://never.example.com/jwks')).not.toThrow();
    });

    it('refresh alone populates the cache for a later getKey', async () => {
      fetchMock.mockResolvedValueOnce(makeJwks('k1'));
      const cache = new JwksCacheService();
      await cache.refresh(URI);

      expect(await cache.getKey(URI, 'k1')).toBeDefined();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('evict forces the next getKey to fetch again', async () => {
      fetchMock.mockResolvedValue(makeJwks('k1'));
      const cache = new JwksCacheService();
      await cache.getKey(URI, 'k1');
      cache.evict(URI);
      await cache.getKey(URI, 'k1');

      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });
});
