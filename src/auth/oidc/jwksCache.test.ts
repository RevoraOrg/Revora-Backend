import { generateKeyPairSync } from 'crypto';
import { JwksCacheService } from './jwksCache';

const uri = 'https://idp.example.com/.well-known/jwks.json';
const issuer = 'https://idp.example.com';
const issuerB = 'https://idp2.example.com';
const uriB = 'https://idp2.example.com/.well-known/jwks.json';

const { publicKey: ecPub } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const jwk = ecPub.export({ type: 'spki', format: 'jwk' });

const mockJwks = (keys: Record<string, unknown>[] = [{ ...jwk, kid: 'k1' }]) =>
  ({ ok: true, json: async () => ({ keys }) } as any);

const mockError = (status: number, statusText: string) =>
  ({ ok: false, status, statusText } as any);

const waitFor = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('JwksCacheService', () => {
  afterEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
  });

  describe('cache primitives', () => {
    it('fetches and returns a key by kid', async () => {
      const cache = new JwksCacheService();
      global.fetch = jest.fn().mockResolvedValueOnce(mockJwks());
      const key = await cache.getKey(uri, 'k1');
      expect(key).toBeDefined();
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it('returns cached key without re-fetching', async () => {
      const cache = new JwksCacheService();
      global.fetch = jest.fn().mockResolvedValue(mockJwks());
      await cache.getKey(uri, 'k1');
      await cache.getKey(uri, 'k1');
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it('re-fetches after the TTL elapses', async () => {
      let now = 1_000_000;
      const cache = new JwksCacheService({ now: () => now });
      global.fetch = jest.fn().mockResolvedValue(mockJwks());
      await cache.getKey(uri, 'k1');
      now += 60 * 60 * 1000 + 1; // past 1h TTL
      await cache.getKey(uri, 'k1');
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it('rotates when kid is missing from cache (evict + refetch once)', async () => {
      const cache = new JwksCacheService();
      global.fetch = jest.fn()
        .mockResolvedValueOnce(mockJwks([{ ...jwk, kid: 'old' }]))
        .mockResolvedValueOnce(mockJwks([{ ...jwk, kid: 'new' }]));
      await cache.getKey(uri, 'old');
      expect(await cache.getKey(uri, 'new')).toBeDefined();
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it('throws after rotation when kid still missing', async () => {
      const cache = new JwksCacheService();
      global.fetch = jest.fn().mockResolvedValue(mockJwks([{ ...jwk, kid: 'other' }]));
      await expect(cache.getKey(uri, 'missing')).rejects.toThrow(/after rotation/);
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it('evict forces a re-fetch on next getKey', async () => {
      const cache = new JwksCacheService();
      global.fetch = jest.fn().mockResolvedValue(mockJwks());
      await cache.getKey(uri, 'k1');
      cache.evict(uri);
      await cache.getKey(uri, 'k1');
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it('skips malformed JWK entries', async () => {
      const cache = new JwksCacheService();
      global.fetch = jest.fn().mockResolvedValueOnce(
        mockJwks([{ kid: 'bad', kty: 'INVALID' }, { kty: 'no-kid-at-all' }, { ...jwk, kid: 'good' }]),
      );
      expect(await cache.getKey(uri, 'good')).toBeDefined();
    });

    it('throws on non-200 JWKS response', async () => {
      const cache = new JwksCacheService();
      global.fetch = jest.fn().mockResolvedValueOnce(mockError(404, 'Not Found'));
      await expect(cache.refresh(uri, issuer)).rejects.toThrow(/JWKS fetch failed/);
    });
  });

  describe('per-issuer age tracking and gauge', () => {
    it('reports 0 age for an issuer with no successful refresh', () => {
      const cache = new JwksCacheService();
      expect(cache.getCacheAgeSeconds(issuer)).toBe(0);
    });

    it('reports ~0 age immediately after a refresh and grows with time', async () => {
      let now = 1_000_000;
      const cache = new JwksCacheService({ now: () => now });
      global.fetch = jest.fn().mockResolvedValue(mockJwks());
      await cache.refresh(uri, issuer);

      expect(cache.getCacheAgeSeconds(issuer)).toBe(0);

      now += 90_000;
      expect(cache.getCacheAgeSeconds(issuer)).toBe(90);

      now += 30_000;
      expect(cache.getCacheAgeSeconds(issuer)).toBe(120);
    });

    it('emits a per-issuer age gauge on refresh', async () => {
      const metrics = { setGauge: jest.fn() };
      const cache = new JwksCacheService({ metrics: metrics as any });
      global.fetch = jest.fn().mockResolvedValue(mockJwks());
      await cache.refresh(uri, issuer);

      expect(metrics.setGauge).toHaveBeenCalledWith(
        'oidc.jwks.age_seconds',
        0,
        { issuer },
        expect.any(String),
      );
    });

    it('does not emit a gauge for an issuer-less refresh', async () => {
      const metrics = { setGauge: jest.fn() };
      const cache = new JwksCacheService({ metrics: metrics as any });
      global.fetch = jest.fn().mockResolvedValue(mockJwks());
      await cache.refresh(uri);
      expect(metrics.setGauge).not.toHaveBeenCalled();
    });

    it('tracks each issuer independently and emits both gauges', async () => {
      const metrics = { setGauge: jest.fn() };
      const cache = new JwksCacheService({ metrics: metrics as any, now: () => 5_000_000 });
      global.fetch = jest.fn().mockResolvedValue(mockJwks());
      await cache.refresh(uri, issuer);
      await cache.refresh(uriB, issuerB);

      expect(cache.getTrackedIssuers().sort()).toEqual([issuer, issuerB].sort());
      expect(metrics.setGauge).toHaveBeenCalledWith('oidc.jwks.age_seconds', 0, { issuer }, expect.any(String));
      expect(metrics.setGauge).toHaveBeenCalledWith('oidc.jwks.age_seconds', 0, { issuer: issuerB }, expect.any(String));
    });

    it('getTrackedIssuers is empty before any successful refresh', () => {
      const cache = new JwksCacheService();
      expect(cache.getTrackedIssuers()).toEqual([]);
    });

    it('refresh-all age reset after force refresh (gauge back to ~0)', async () => {
      let now = 1_000_000;
      const metrics = { setGauge: jest.fn() };
      const cache = new JwksCacheService({ now: () => now, metrics: metrics as any });
      global.fetch = jest.fn().mockResolvedValue(mockJwks());
      await cache.refresh(uri, issuer);
      now += 300_000;
      expect(cache.getCacheAgeSeconds(issuer)).toBe(300);

      await cache.refresh(uri, issuer); // force refresh
      expect(cache.getCacheAgeSeconds(issuer)).toBe(0);
    });

    it('does not update last-refresh bookkeeping when the fetch fails', async () => {
      const metrics = { setGauge: jest.fn() };
      const cache = new JwksCacheService({ metrics: metrics as any, now: () => 5_000_000 });
      global.fetch = jest.fn().mockRejectedValueOnce(new Error('network down'));

      await expect(cache.refresh(uri, issuer)).rejects.toThrow('network down');
      expect(cache.getTrackedIssuers()).toEqual([]);
      expect(cache.getCacheAgeSeconds(issuer)).toBe(0);

      // A retry after failure performs a fresh fetch and records the issuer
      global.fetch = jest.fn().mockResolvedValue(mockJwks());
      await cache.refresh(uri, issuer);
      expect(cache.getTrackedIssuers()).toEqual([issuer]);
      expect(global.fetch).toHaveBeenCalledTimes(1); // only the successful retry counted here
    });
  });

  describe('age-gauge ticker', () => {
    it('re-emits the gauge for tracked issuers on each tick', async () => {
      jest.useFakeTimers();
      const metrics = { setGauge: jest.fn() };
      const cache = new JwksCacheService({ metrics: metrics as any });
      global.fetch = jest.fn().mockResolvedValue(mockJwks());
      await cache.refresh(uri, issuer);

      metrics.setGauge.mockClear();
      cache.startAgeGaugeTicker(60_000);
      jest.advanceTimersByTime(60_000);
      jest.advanceTimersByTime(60_000);

      expect(metrics.setGauge).toHaveBeenCalledTimes(2);
      expect(metrics.setGauge).toHaveBeenLastCalledWith(
        'oidc.jwks.age_seconds',
        expect.any(Number),
        { issuer },
        expect.any(String),
      );
      cache.stopAgeGaugeTicker();
    });

    it('uses the configured default interval when none is passed', async () => {
      jest.useFakeTimers();
      const metrics = { setGauge: jest.fn() };
      const cache = new JwksCacheService({ metrics: metrics as any, ageGaugeIntervalMs: 30_000 });
      global.fetch = jest.fn().mockResolvedValue(mockJwks());
      await cache.refresh(uri, issuer);

      metrics.setGauge.mockClear();
      cache.startAgeGaugeTicker(); // no explicit interval → default 30_000
      jest.advanceTimersByTime(30_000);
      expect(metrics.setGauge).toHaveBeenCalledTimes(1);
      cache.stopAgeGaugeTicker();
    });

    it('unrefs the underlying timer when available (real timers)', async () => {
      const metrics = { setGauge: jest.fn() };
      const cache = new JwksCacheService({ metrics: metrics as any, ageGaugeIntervalMs: 5 });
      global.fetch = jest.fn().mockResolvedValue(mockJwks());
      await cache.refresh(uri, issuer);

      metrics.setGauge.mockClear();
      cache.startAgeGaugeTicker();
      await waitFor(20);
      expect(metrics.setGauge.mock.calls.length).toBeGreaterThanOrEqual(1);
      cache.stopAgeGaugeTicker();
    });

    it('start is idempotent (single timer) and stop halts emission', async () => {
      jest.useFakeTimers();
      const metrics = { setGauge: jest.fn() };
      const cache = new JwksCacheService({ metrics: metrics as any });
      global.fetch = jest.fn().mockResolvedValue(mockJwks());
      await cache.refresh(uri, issuer);

      metrics.setGauge.mockClear();
      cache.startAgeGaugeTicker(60_000);
      cache.startAgeGaugeTicker(60_000);
      jest.advanceTimersByTime(60_000);
      expect(metrics.setGauge).toHaveBeenCalledTimes(1);

      cache.stopAgeGaugeTicker();
      jest.advanceTimersByTime(120_000);
      expect(metrics.setGauge).toHaveBeenCalledTimes(1);
    });

    it('stop when not running is a no-op', () => {
      const cache = new JwksCacheService();
      expect(() => cache.stopAgeGaugeTicker()).not.toThrow();
    });

    it('tolerates timer handles that do not implement unref', () => {
      const originalSetInterval = global.setInterval;
      (global as any).setInterval = jest.fn(() => ({}));
      try {
        const cache = new JwksCacheService();
        expect(() => cache.startAgeGaugeTicker(60_000)).not.toThrow();
        expect(() => cache.stopAgeGaugeTicker()).not.toThrow();
      } finally {
        global.setInterval = originalSetInterval;
      }
    });

    it('ticker reflects elapsed time via the injectable clock', async () => {
      jest.useFakeTimers();
      let now = 1_000_000;
      const metrics = { setGauge: jest.fn() };
      const cache = new JwksCacheService({ metrics: metrics as any, now: () => now });
      global.fetch = jest.fn().mockResolvedValue(mockJwks());
      await cache.refresh(uri, issuer);

      metrics.setGauge.mockClear();
      cache.startAgeGaugeTicker(60_000);
      now += 120_000;
      jest.advanceTimersByTime(60_000);

      const [, value] = metrics.setGauge.mock.calls[0] as [string, number];
      expect(value).toBe(120);
      cache.stopAgeGaugeTicker();
    });

    it('never leaks issuers that were evicted mid-stream (ticker skips untracked)', async () => {
      jest.useFakeTimers();
      const metrics = { setGauge: jest.fn() };
      const cache = new JwksCacheService({ metrics: metrics as any });
      global.fetch = jest.fn().mockResolvedValue(mockJwks());
      await cache.refresh(uri, issuer);
      await cache.refresh(uriB, issuerB);

      // simulate the cache map being pruned without affecting tracked issuers
      (cache as any).cache.clear();

      cache.startAgeGaugeTicker(60_000);
      jest.advanceTimersByTime(60_000);
      expect(metrics.setGauge.mock.calls.filter((c: unknown[]) => c[0] === 'oidc.jwks.age_seconds').length).toBeGreaterThanOrEqual(2);
      cache.stopAgeGaugeTicker();
    });
  });

  describe('concurrent refresh coalescing', () => {
    it('coalesces concurrent refreshes for the same URI into one fetch', async () => {
      const cache = new JwksCacheService();
      let resolveFetch: (v: any) => void;
      const pending = new Promise<any>((resolve) => { resolveFetch = resolve; });
      global.fetch = jest.fn(() => pending);

      const p1 = cache.refresh(uri, issuer);
      const p2 = cache.refresh(uri, issuer);
      const p3 = cache.refresh(uri, issuer);

      resolveFetch!(mockJwks());
      await Promise.all([p1, p2, p3]);
      expect(global.fetch).toHaveBeenCalledTimes(1);
      expect(cache.getTrackedIssuers()).toEqual([issuer]);
    });

    it('registers every issuer that waited on a shared in-flight fetch', async () => {
      let resolveFetch: (v: any) => void;
      const pending = new Promise<any>((resolve) => { resolveFetch = resolve; });
      const cache = new JwksCacheService();
      global.fetch = jest.fn(() => pending);

      const p1 = cache.refresh(uri, issuer);
      const p2 = cache.refresh(uri, issuerB);

      resolveFetch!(mockJwks());
      await Promise.all([p1, p2]);

      expect(global.fetch).toHaveBeenCalledTimes(1);
      expect(cache.getTrackedIssuers().sort()).toEqual([issuer, issuerB].sort());
      expect(cache.getCacheAgeSeconds(issuer)).toBe(0);
      expect(cache.getCacheAgeSeconds(issuerB)).toBe(0);
    });

    it('releases the in-flight slot after success so later refreshes refetch', async () => {
      const cache = new JwksCacheService({ now: () => 1_000_000 });
      global.fetch = jest.fn().mockResolvedValue(mockJwks());
      await Promise.all([cache.refresh(uri, issuer), cache.refresh(uri, issuer)]);
      await cache.refresh(uri, issuer);
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it('releases the in-flight slot after failure so retries fetch again', async () => {
      const cache = new JwksCacheService();
      global.fetch = jest.fn()
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValueOnce(mockJwks());

      const p1 = cache.refresh(uri, issuer);
      const p2 = cache.refresh(uri, issuer);
      await expect(p1).rejects.toThrow('boom');
      await expect(p2).rejects.toThrow('boom');

      await cache.refresh(uri, issuer); // retry performs a fresh fetch
      expect(global.fetch).toHaveBeenCalledTimes(2);
      expect(cache.getTrackedIssuers()).toEqual([issuer]);
    });

    it('coalesces issuer-less concurrent refreshes too', async () => {
      let resolveFetch: (v: any) => void;
      const pending = new Promise<any>((resolve) => { resolveFetch = resolve; });
      const cache = new JwksCacheService();
      global.fetch = jest.fn(() => pending);

      const p1 = cache.refresh(uri);
      const p2 = cache.refresh(uri);
      resolveFetch!(mockJwks());
      await Promise.all([p1, p2]);
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it('coalesces a scheduled (getKey TTL) refresh with a force refresh', async () => {
      let now = 1_000_000;
      let resolveFetch: (v: any) => void;
      const pending = new Promise<any>((resolve) => { resolveFetch = resolve; });
      const cache = new JwksCacheService({ now: () => now });
      global.fetch = jest.fn()
        .mockResolvedValueOnce(mockJwks())
        .mockImplementationOnce(() => pending);

      await cache.getKey(uri, 'k1', issuer); // populate + track
      now += 60 * 60 * 1000 + 1; // TTL expired

      const viaGetKey = cache.getKey(uri, 'k1', issuer); // scheduled refresh path
      const forced = cache.refresh(uri, issuer);          // force-refresh path

      resolveFetch!(mockJwks());
      await Promise.all([viaGetKey, forced]);
      expect(global.fetch).toHaveBeenCalledTimes(2); // initial + one shared refresh
      expect(cache.getCacheAgeSeconds(issuer)).toBe(0);
    });
  });
});
