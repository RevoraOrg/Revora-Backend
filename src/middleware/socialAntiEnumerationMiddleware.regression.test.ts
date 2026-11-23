/**
 * @file socialAntiEnumerationMiddleware.regression.test.ts
 *
 * Regression suite for issue #1060 — pins the failure handling of
 * `getSocialAntiEnumerationMetrics()` and the extraction guards whose failures it
 * reports on.
 *
 * The issue names three explicit failure exits in
 * `src/middleware/socialAntiEnumerationMiddleware.ts`:
 *
 *   :90  `if (!VALID_PROVIDERS.has(provider as SocialAuthProvider)) return null;`
 *   :91  `if (typeof idToken !== 'string') return null;`
 *   :94  `if (parts.length !== 3) return null;`
 *
 * Each of them means "we could not identify the caller from the unverified token",
 * which routes the request to the **IP-fallback** guard instead of the
 * per-provider-sub guard.  That routing is what keeps the metrics honest:
 *
 *   - `attempts` must climb for *every* request, including malformed ones, so an
 *     enumeration spike cannot be hidden behind unparseable tokens.
 *   - `rejections` must climb exactly once per actual limiter refusal, and never
 *     for an Express control-flow signal (`next('route')` / `next('router')`).
 *
 * The suite is deliberately test-only: `socialAntiEnumerationMiddleware.ts` is not
 * modified, so the existing public contract is pinned rather than redefined.
 */

import { Request, Response, NextFunction } from 'express';
import {
  extractProviderSub,
  createSocialAntiEnumerationMiddleware,
  createSocialAntiEnumerationMiddlewareWithStore,
  getSocialAntiEnumerationMetrics,
  resetSocialAntiEnumerationMetrics,
} from './socialAntiEnumerationMiddleware';
import { InMemoryRateLimitStore } from './rateLimit';
import * as rateLimitModule from './rateLimit';
import { AppError, Errors } from '../lib/errors';

// ── Limiter factory interception ─────────────────────────────────────────────
//
// `createSocialAntiEnumerationMiddleware` builds its two guards through
// `createRateLimitMiddleware`. Replacing the factory lets the wiring suite below
// observe the exact options and drive the captured `wrappedNext` directly.
// Everything else keeps the real limiter: the default implementation delegates.
jest.mock('./rateLimit', () => {
  const actual = jest.requireActual('./rateLimit');
  return {
    ...actual,
    __esModule: true,
    createRateLimitMiddleware: jest.fn((options?: unknown) => actual.createRateLimitMiddleware(options)),
  };
});

const mockedLimiterFactory = rateLimitModule.createRateLimitMiddleware as unknown as jest.Mock;

/** Restores the default delegating implementation after a wired test. */
function delegateLimiterFactoryToReal(): void {
  const real = jest.requireActual('./rateLimit') as typeof rateLimitModule;
  mockedLimiterFactory.mockImplementation((options?: unknown) => real.createRateLimitMiddleware(options as never));
}


// ── Test helpers ─────────────────────────────────────────────────────────────

function b64url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

/** Builds an unverified compact JWT whose payload is `JSON.stringify(payload)`. */
function makeJwt(payload: Record<string, unknown>): string {
  const header = b64url(JSON.stringify({ alg: 'RS256', kid: 'k1' }));
  return `${header}.${b64url(JSON.stringify(payload))}.fakesig`;
}

/**
 * Builds a token from a *raw* JSON payload string, so cases that JavaScript object
 * literals cannot express (duplicate keys, `__proto__`, a top-level `null`) can be
 * exercised the way an attacker would send them.
 */
function makeRawJwt(payloadJson: string): string {
  return `${b64url(JSON.stringify({ alg: 'RS256' }))}.${b64url(payloadJson)}.fakesig`;
}

function makeReq(
  overrides: Partial<Request> & { body?: Record<string, unknown>; params?: Record<string, string> } = {},
): Request {
  return {
    ip: '127.0.0.1',
    socket: { remoteAddress: '127.0.0.1' },
    headers: {},
    body: {},
    params: {},
    ...overrides,
  } as unknown as Request;
}

function makeRes(): Response & { headers: Record<string, string> } {
  const headers: Record<string, string> = {};
  const res = {
    setHeader: jest.fn((k: string, v: string) => {
      headers[k.toLowerCase()] = v;
    }),
    getHeader: jest.fn((k: string) => headers[k.toLowerCase()]),
    get headers() {
      return headers;
    },
  };
  return res as unknown as Response & { headers: Record<string, string> };
}

/** Snapshot helper — the public read path under test. */
function metrics(): { attempts: number; rejections: number } {
  return getSocialAntiEnumerationMetrics();
}

/** A request that will always fall back to the IP guard (unsupported provider). */
function makeUnidentifiableReq(ip = '127.0.0.1'): Request {
  return makeReq({ params: { provider: 'github' }, body: { idToken: makeJwt({ sub: 'ignored' }) }, ip });
}

// Every test starts from a zeroed counter pair so the exact numbers are meaningful.
beforeEach(() => {
  resetSocialAntiEnumerationMetrics();
});


// ── Line 90: provider gate ────────────────────────────────────────────────────

describe('extractProviderSub — provider gate (line 90)', () => {
  it('returns "<provider>:<sub>" for the supported provider "google"', () => {
    expect(extractProviderSub('google', makeJwt({ sub: 'sub-1' }))).toBe('google:sub-1');
  });

  it('returns "<provider>:<sub>" for the supported provider "apple"', () => {
    expect(extractProviderSub('apple', makeJwt({ sub: 'sub-1' }))).toBe('apple:sub-1');
  });

  it('returns null for an unsupported provider (github)', () => {
    expect(extractProviderSub('github', makeJwt({ sub: 'sub-1' }))).toBeNull();
  });

  it('returns null for case variants — the gate does not case-fold', () => {
    const token = makeJwt({ sub: 'sub-1' });
    for (const provider of ['Google', 'GOOGLE', 'gOoGlE', 'APPLE', 'Apple']) {
      expect(extractProviderSub(provider, token)).toBeNull();
    }
  });

  it('returns null for a provider carrying whitespace or padding — the gate does not trim', () => {
    const token = makeJwt({ sub: 'sub-1' });
    for (const provider of [' google', 'google ', 'google\t', ' google ']) {
      expect(extractProviderSub(provider, token)).toBeNull();
    }
  });

  it('returns null for the empty provider (missing :provider route param)', () => {
    expect(extractProviderSub('', makeJwt({ sub: 'sub-1' }))).toBeNull();
  });

  it('returns null instead of throwing for non-string providers at runtime', () => {
    const token = makeJwt({ sub: 'sub-1' });
    const hostile: unknown[] = [null, undefined, 123, 0, false, {}, [], ['google'], Symbol('google')];
    for (const provider of hostile) {
      expect(() => extractProviderSub(provider as string, token)).not.toThrow();
      expect(extractProviderSub(provider as string, token)).toBeNull();
    }
  });

  it('never invents a fallback key for an invalid provider (no "unknown:<sub>")', () => {
    const result = extractProviderSub('github', makeJwt({ sub: 'victim-sub' }));
    expect(result).toBeNull();
    expect(String(result)).not.toContain('victim-sub');
  });
});

// ── Line 91: idToken type gate ────────────────────────────────────────────────

describe('extractProviderSub — idToken type gate (line 91)', () => {
  it('returns null for null and undefined idTokens', () => {
    expect(extractProviderSub('google', null as unknown as string)).toBeNull();
    expect(extractProviderSub('google', undefined as unknown as string)).toBeNull();
  });

  it('returns null for numeric and boolean idTokens', () => {
    expect(extractProviderSub('google', 123 as unknown as string)).toBeNull();
    expect(extractProviderSub('google', 0 as unknown as string)).toBeNull();
    expect(extractProviderSub('google', false as unknown as string)).toBeNull();
    expect(extractProviderSub('google', true as unknown as string)).toBeNull();
  });

  it('returns null for object and array idTokens', () => {
    expect(extractProviderSub('google', {} as unknown as string)).toBeNull();
    expect(extractProviderSub('google', { sub: 'x' } as unknown as string)).toBeNull();
    expect(extractProviderSub('google', ['h', 'p', 's'] as unknown as string)).toBeNull();
  });

  it('returns null for Buffer / typed-array idTokens', () => {
    expect(extractProviderSub('google', Buffer.from('h.p.s') as unknown as string)).toBeNull();
    expect(extractProviderSub('google', new Uint8Array([1, 2, 3]) as unknown as string)).toBeNull();
  });

  it('returns null for symbol and function idTokens without throwing', () => {
    expect(() => extractProviderSub('google', Symbol('token') as unknown as string)).not.toThrow();
    expect(extractProviderSub('google', Symbol('token') as unknown as string)).toBeNull();
    expect(extractProviderSub('google', (() => 'h.p.s') as unknown as string)).toBeNull();
  });

  it('rejects a truthy non-string before any parsing happens (type gate precedes split)', () => {
    // If line 91 were removed or softened, `idToken.split` would be reached and the
    // probe below would throw instead of returning null.
    const probe = {
      split: () => {
        throw new Error('split() must never be reached for a non-string idToken');
      },
    };
    expect(() => extractProviderSub('google', probe as unknown as string)).not.toThrow();
    expect(extractProviderSub('google', probe as unknown as string)).toBeNull();
  });

  it('lets the empty string through the type gate so the structure gate rejects it', () => {
    expect(extractProviderSub('google', '')).toBeNull();
  });
});


// ── Line 94: compact-JWT structure gate ───────────────────────────────────────

describe('extractProviderSub — structure gate (line 94)', () => {
  const cases: Array<[string, string]> = [
    ['empty string (1 segment)', ''],
    ['a bare string (1 segment)', 'header-only'],
    ['two segments', 'header.payload'],
    ['four segments', 'a.b.c.d'],
    ['five segments', 'a.b.c.d.e'],
    ['four empty segments', '...'],
    ['trailing-dot token (4 segments, empty signature)', 'a.b.c.'],
    ['three segments with an empty payload', 'a..c'],
    ['three segments with a 1-char payload (incomplete base64 group)', 'a.a.c'],
    ['three segments with non-base64 payload content', 'a.!!!.c'],
  ];

  it.each(cases)('returns null for %s', (_label, token) => {
    expect(() => extractProviderSub('google', token)).not.toThrow();
    expect(extractProviderSub('google', token)).toBeNull();
  });

  it('accepts a padded base64url payload (3 segments)', () => {
    const padded = `${b64url('{"alg":"RS256"}')}.${b64url('{"sub":"pad"}')}==.sig`;
    expect(padded.split('.')).toHaveLength(3);
    expect(extractProviderSub('google', padded)).toBe('google:pad');
  });

  it('returns null when the payload is valid base64 but not JSON', () => {
    expect(extractProviderSub('google', `${b64url('h')}.${b64url('not-json')}.sig`)).toBeNull();
  });

  it('returns null when the payload JSON decodes to null (TypeError is contained)', () => {
    expect(extractProviderSub('google', makeRawJwt('null'))).toBeNull();
  });

  it('returns null for a top-level JSON string payload (String.prototype.sub is not a token sub)', () => {
    // `JSON.parse('"abc"')['sub']` resolves to the legacy String.prototype.sub
    // helper (a function), which the `typeof sub !== 'string'` check rejects.
    expect(extractProviderSub('google', makeRawJwt('"abc"'))).toBeNull();
  });

  it('returns null for JSON payloads that are numbers or arrays', () => {
    expect(extractProviderSub('google', makeRawJwt('42'))).toBeNull();
    expect(extractProviderSub('google', makeRawJwt('[1,2,3]'))).toBeNull();
    expect(extractProviderSub('google', makeRawJwt('[]'))).toBeNull();
  });

  it('rejects a 2-segment token even when the second segment is a valid payload', () => {
    const token = `${b64url('{"alg":"RS256"}')}.${b64url('{"sub":"two-segment"}')}`;
    expect(token.split('.')).toHaveLength(2);
    expect(extractProviderSub('google', token)).toBeNull();
  });

  it('rejects a 4-segment token carrying a valid payload at index 1', () => {
    const token = `${b64url('{"alg":"RS256"}')}.${b64url('{"sub":"four-segment"}')}.sig.extra`;
    expect(token.split('.')).toHaveLength(4);
    expect(extractProviderSub('google', token)).toBeNull();
  });

  it('rejects a 5-segment token carrying a valid payload at index 1', () => {
    const token = `${b64url('{"alg":"RS256"}')}.${b64url('{"sub":"five-segment"}')}.sig.extra.more`;
    expect(token.split('.')).toHaveLength(5);
    expect(extractProviderSub('google', token)).toBeNull();
  });

  it('rejects a token with a trailing dot (empty 4th segment) even when the payload parses', () => {
    const token = `${b64url('{"alg":"RS256"}')}.${b64url('{"sub":"trailing-dot"}')}.sig.`;
    expect(token.split('.')).toHaveLength(4);
    expect(extractProviderSub('google', token)).toBeNull();
  });
});

// ── sub boundaries and hostile payloads ──────────────────────────────────────

describe('extractProviderSub — sub boundaries and hostile payloads', () => {
  it('returns null when the payload has no sub field', () => {
    expect(extractProviderSub('google', makeJwt({ email: 'no-sub@example.com' }))).toBeNull();
  });

  it('returns null when sub is an empty string', () => {
    expect(extractProviderSub('google', makeJwt({ sub: '' }))).toBeNull();
  });

  it('returns null when sub is not a string', () => {
    expect(extractProviderSub('google', makeJwt({ sub: 12345 }))).toBeNull();
    expect(extractProviderSub('google', makeJwt({ sub: null }))).toBeNull();
    expect(extractProviderSub('google', makeJwt({ sub: { nested: 'x' } }))).toBeNull();
    expect(extractProviderSub('google', makeJwt({ sub: ['a'] }))).toBeNull();
    expect(extractProviderSub('google', makeJwt({ sub: true }))).toBeNull();
  });

  it('keeps the falsy-but-valid sub "0" (boundary is length, not truthiness)', () => {
    expect(extractProviderSub('google', makeJwt({ sub: '0' }))).toBe('google:0');
  });

  it('does not trim or normalise the sub value', () => {
    expect(extractProviderSub('google', makeJwt({ sub: '  padded  ' }))).toBe('google:  padded  ');
  });

  it('preserves unicode and emoji subs', () => {
    expect(extractProviderSub('google', makeJwt({ sub: 'ü-😀-日本' }))).toBe('google:ü-😀-日本');
  });

  it('preserves a very long sub without truncation', () => {
    const long = 'x'.repeat(5000);
    expect(extractProviderSub('google', makeJwt({ sub: long }))).toBe(`google:${long}`);
  });

  it('preserves dots and colons inside sub (only the two JWT dots delimit segments)', () => {
    expect(extractProviderSub('google', makeJwt({ sub: 'a.b:c' }))).toBe('google:a.b:c');
  });

  it('takes the last duplicate sub field (JSON.parse semantics)', () => {
    expect(extractProviderSub('google', makeRawJwt('{"sub":"first","sub":"second"}'))).toBe('google:second');
  });

  it('rejects a __proto__ payload without polluting prototypes and still returns the real sub', () => {
    const token = makeRawJwt('{"__proto__":{"polluted":true},"sub":"safe-sub"}');
    expect(extractProviderSub('google', token)).toBe('google:safe-sub');
    expect((Object.prototype as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(Object.keys(Object.prototype)).toHaveLength(0);
  });

  it('is deterministic across repeated calls (pure, no retained state)', () => {
    const token = makeJwt({ sub: 'stable-sub' });
    const first = extractProviderSub('google', token);
    const second = extractProviderSub('google', token);
    const third = extractProviderSub('google', token);
    expect(first).toBe('google:stable-sub');
    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(metrics()).toEqual({ attempts: 0, rejections: 0 });
  });
});

// ── getSocialAntiEnumerationMetrics — snapshot contract ──────────────────────

describe('getSocialAntiEnumerationMetrics — snapshot contract', () => {
  it('starts from a zeroed { attempts, rejections } pair', () => {
    expect(metrics()).toEqual({ attempts: 0, rejections: 0 });
  });

  it('returns exactly { attempts, rejections } as integers', () => {
    const m = metrics();
    expect(Object.keys(m).sort()).toEqual(['attempts', 'rejections']);
    expect(Number.isInteger(m.attempts)).toBe(true);
    expect(Number.isInteger(m.rejections)).toBe(true);
  });

  it('returns a fresh snapshot, not a live reference to module state', () => {
    const snapshot = metrics();
    snapshot.attempts = 999;
    snapshot.rejections = 999;
    expect(metrics()).toEqual({ attempts: 0, rejections: 0 });
  });

  it('is independent of the rate-limit store contents', () => {
    const store = new InMemoryRateLimitStore();
    store.increment('provider-sub:google:pre-filled', 60_000);
    store.increment('ip:203.0.113.9', 60_000);
    expect(metrics()).toEqual({ attempts: 0, rejections: 0 });
  });

  it('is shared process-wide: two instances with different stores feed one counter pair', () => {
    const mwA = createSocialAntiEnumerationMiddlewareWithStore(new InMemoryRateLimitStore(), { limit: 5 });
    const mwB = createSocialAntiEnumerationMiddlewareWithStore(new InMemoryRateLimitStore(), { limit: 5 });
    const next: NextFunction = jest.fn();

    mwA(makeUnidentifiableReq('198.51.100.1'), makeRes(), next);
    mwB(makeUnidentifiableReq('198.51.100.2'), makeRes(), next);

    expect(metrics()).toEqual({ attempts: 2, rejections: 0 });
  });

  it('never reports more rejections than attempts', () => {
    const store = new InMemoryRateLimitStore();
    const mw = createSocialAntiEnumerationMiddlewareWithStore(store, { limit: 1, ipFallbackLimit: 1 });
    const next: NextFunction = jest.fn();
    const token = makeJwt({ sub: 'invariant-sub' });
    const subReq = () => makeReq({ params: { provider: 'google' }, body: { idToken: token }, ip: '203.0.113.1' });

    mw(subReq(), makeRes(), next); // allowed
    mw(subReq(), makeRes(), next); // blocked (per-sub)
    mw(makeUnidentifiableReq('203.0.113.1'), makeRes(), next); // allowed (IP bucket, count 1)
    mw(makeUnidentifiableReq('203.0.113.1'), makeRes(), next); // blocked (IP bucket, count 2)

    const m = metrics();
    expect(m.attempts).toBe(4);
    expect(m.rejections).toBe(2);
    expect(m.rejections).toBeLessThanOrEqual(m.attempts);
  });
});

// ── attempts/rejections accounting when extraction fails (lines 90, 91, 94) ──

describe('metrics — accounting when provider/sub extraction fails', () => {
  /** One request per unresolvable-input class, all from the same client IP. */
  const unidentifiableRequests = (): Request[] => [
    makeUnidentifiableReq('203.0.113.10'), // line 90 — unsupported provider
    makeReq({ params: { provider: 'google' }, body: {}, ip: '203.0.113.10' }), // missing idToken
    makeReq({ params: { provider: 'google' }, body: { idToken: 42 }, ip: '203.0.113.10' }), // line 91 — non-string
    makeReq({ params: { provider: 'google' }, body: { idToken: 'header.payload' }, ip: '203.0.113.10' }), // line 94
    makeReq({
      params: { provider: 'google' },
      body: { idToken: makeJwt({ email: 'no-sub@example.com' }) },
      ip: '203.0.113.10',
    }), // payload without sub
  ];

  it('climbs attempts for every unidentifiable request without inventing rejections', () => {
    const mw = createSocialAntiEnumerationMiddlewareWithStore(new InMemoryRateLimitStore(), {
      limit: 5,
      ipFallbackLimit: 20,
    });
    const next: NextFunction = jest.fn();

    for (const req of unidentifiableRequests()) mw(req, makeRes(), next);

    expect(next).toHaveBeenCalledTimes(5);
    expect((next as jest.Mock).mock.calls.every((call) => call[0] === undefined)).toBe(true);
    expect(metrics()).toEqual({ attempts: 5, rejections: 0 });
  });

  it('increments rejections exactly once per per-sub rejection', () => {
    const store = new InMemoryRateLimitStore();
    const mw = createSocialAntiEnumerationMiddlewareWithStore(store, { limit: 1 });
    const next: NextFunction = jest.fn();
    const token = makeJwt({ sub: 'per-sub-reject' });
    const req = () => makeReq({ params: { provider: 'google' }, body: { idToken: token }, ip: '203.0.113.11' });

    mw(req(), makeRes(), next); // allowed
    mw(req(), makeRes(), next); // blocked
    mw(req(), makeRes(), next); // blocked again

    expect(metrics()).toEqual({ attempts: 3, rejections: 2 });
    expect((next as jest.Mock).mock.calls[1][0]).toBeInstanceOf(AppError);
    expect((next as jest.Mock).mock.calls[2][0]).toBeInstanceOf(AppError);
  });

  it('increments rejections exactly once per IP-fallback rejection', () => {
    const store = new InMemoryRateLimitStore();
    const mw = createSocialAntiEnumerationMiddlewareWithStore(store, { ipFallbackLimit: 1 });
    const next: NextFunction = jest.fn();

    mw(makeUnidentifiableReq('203.0.113.12'), makeRes(), next); // allowed
    mw(makeUnidentifiableReq('203.0.113.12'), makeRes(), next); // blocked by the fallback guard

    expect(metrics()).toEqual({ attempts: 2, rejections: 1 });
    expect((next as jest.Mock).mock.calls[1][0]).toBeInstanceOf(AppError);
  });

  it('keeps attempts and rejections exactly aligned across a mixed sequence', () => {
    const store = new InMemoryRateLimitStore();
    const mw = createSocialAntiEnumerationMiddlewareWithStore(store, { limit: 1 });
    const next: NextFunction = jest.fn();
    const tokenA = makeJwt({ sub: 'mixed-a' });
    const tokenB = makeJwt({ sub: 'mixed-b' });
    const reqFor = (token: string) =>
      makeReq({ params: { provider: 'google' }, body: { idToken: token }, ip: '203.0.113.13' });

    mw(reqFor(tokenA), makeRes(), next); // allowed
    mw(reqFor(tokenA), makeRes(), next); // blocked
    mw(reqFor(tokenB), makeRes(), next); // allowed (independent bucket)
    mw(reqFor(tokenB), makeRes(), next); // blocked

    expect(metrics()).toEqual({ attempts: 4, rejections: 2 });
  });

  it('rejects every request when the limit is 0, so rejections track attempts 1:1', () => {
    const store = new InMemoryRateLimitStore();
    const mw = createSocialAntiEnumerationMiddlewareWithStore(store, { limit: 0 });
    const next: NextFunction = jest.fn();
    const token = makeJwt({ sub: 'zero-limit' });

    mw(makeReq({ params: { provider: 'google' }, body: { idToken: token }, ip: '203.0.113.14' }), makeRes(), next);
    mw(makeReq({ params: { provider: 'google' }, body: { idToken: token }, ip: '203.0.113.14' }), makeRes(), next);

    expect(metrics()).toEqual({ attempts: 2, rejections: 2 });
    expect((next as jest.Mock).mock.calls[0][0]).toBeInstanceOf(AppError);
  });

  it('zeroes both counters on reset while the limiter store keeps its counts', () => {
    const store = new InMemoryRateLimitStore();
    const mw = createSocialAntiEnumerationMiddlewareWithStore(store, { limit: 1 });
    const next: NextFunction = jest.fn();
    const token = makeJwt({ sub: 'reset-after-reject' });
    const req = () => makeReq({ params: { provider: 'google' }, body: { idToken: token }, ip: '203.0.113.15' });

    mw(req(), makeRes(), next); // allowed
    mw(req(), makeRes(), next); // blocked
    expect(metrics()).toEqual({ attempts: 2, rejections: 1 });

    resetSocialAntiEnumerationMetrics();
    expect(metrics()).toEqual({ attempts: 0, rejections: 0 });

    // The window counter is untouched by the metrics reset, so the next request is
    // still refused — proving the two states are independent.
    mw(req(), makeRes(), next);
    expect(metrics()).toEqual({ attempts: 1, rejections: 1 });
    expect((next as jest.Mock).mock.calls[2][0]).toBeInstanceOf(AppError);
  });

  it('a failing store surfaces the error and counts the attempt but never a rejection', () => {
    // An infrastructure failure (e.g. a Redis-backed store going away) is not a
    // limiter refusal: the request errors out, so no 429 response was produced.
    const failingStore = {
      increment: (): { count: number; resetAt: number } => {
        throw new Error('rate-limit store unavailable');
      },
      reset: (): void => undefined,
    };
    const mw = createSocialAntiEnumerationMiddlewareWithStore(failingStore, { limit: 5 });
    const token = makeJwt({ sub: 'store-down' });
    const req = makeReq({ params: { provider: 'google' }, body: { idToken: token }, ip: '203.0.113.16' });

    expect(() => mw(req, makeRes(), jest.fn())).toThrow('rate-limit store unavailable');
    expect(metrics()).toEqual({ attempts: 1, rejections: 0 });
  });
});

// ── failure routing / abuse paths around the three guards ────────────────────

describe('extraction failure — routing, rate limiting and leakage', () => {
  it('a provider-gate failure never attaches socialProviderSub to the request', () => {
    const mw = createSocialAntiEnumerationMiddlewareWithStore(new InMemoryRateLimitStore(), { limit: 5 });
    const req = makeUnidentifiableReq('203.0.113.20');
    const next: NextFunction = jest.fn();

    mw(req, makeRes(), next);

    expect((req as { socialProviderSub?: string }).socialProviderSub).toBeUndefined();
    expect((req as { socialProviderSub?: string }).socialProviderSub).not.toBe('github:ignored');
    expect(metrics()).toEqual({ attempts: 1, rejections: 0 });
  });

  it('coerces a non-string idToken to "" so the extractor is never handed one', () => {
    const mw = createSocialAntiEnumerationMiddlewareWithStore(new InMemoryRateLimitStore(), {
      limit: 5,
      ipFallbackLimit: 20,
    });
    const next: NextFunction = jest.fn();

    for (const idToken of [42, true, { sub: 'x' }, ['h', 'p', 's'], null]) {
      const req = makeReq({ params: { provider: 'google' }, body: { idToken }, ip: '203.0.113.21' });
      expect(() => mw(req, makeRes(), next)).not.toThrow();
      expect((req as { socialProviderSub?: string }).socialProviderSub).toBeUndefined();
    }

    expect(next).toHaveBeenCalledTimes(5);
    expect(metrics()).toEqual({ attempts: 5, rejections: 0 });
  });

  it('survives a request with no body and no params, still counting the attempt', () => {
    const mw = createSocialAntiEnumerationMiddlewareWithStore(new InMemoryRateLimitStore(), { ipFallbackLimit: 5 });
    const req = makeReq({ params: undefined as never, body: undefined as never, ip: '203.0.113.22' });
    const next: NextFunction = jest.fn();

    expect(() => mw(req, makeRes(), next)).not.toThrow();
    expect(next).toHaveBeenCalledWith(undefined);
    expect(metrics()).toEqual({ attempts: 1, rejections: 0 });
  });

  it('an unidentifiable request is still rate-limited by the IP fallback (no bypass)', () => {
    const mw = createSocialAntiEnumerationMiddlewareWithStore(new InMemoryRateLimitStore(), { ipFallbackLimit: 2 });
    const next: NextFunction = jest.fn();
    const res3 = makeRes();

    mw(makeUnidentifiableReq('203.0.113.23'), makeRes(), next);
    mw(makeUnidentifiableReq('203.0.113.23'), makeRes(), next);
    mw(makeUnidentifiableReq('203.0.113.23'), res3, next);

    const err = (next as jest.Mock).mock.calls[2][0] as AppError;
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe('TOO_MANY_REQUESTS');
    expect(err.statusCode).toBe(429);
    expect(res3.headers['x-ratelimit-remaining']).toBe('0');
    expect(res3.headers['retry-after']).toBeDefined();
    expect(metrics()).toEqual({ attempts: 3, rejections: 1 });
  });

  it('the rejection message is generic and leaks no token or subject material', () => {
    const mw = createSocialAntiEnumerationMiddlewareWithStore(new InMemoryRateLimitStore(), { limit: 1 });
    const next: NextFunction = jest.fn();
    const token = makeJwt({ sub: 'leak-canary-sub' });
    const req = () => makeReq({ params: { provider: 'google' }, body: { idToken: token }, ip: '203.0.113.24' });

    mw(req(), makeRes(), next);
    mw(req(), makeRes(), next);

    const err = (next as jest.Mock).mock.calls[1][0] as AppError;
    expect(err.message).toBe('Too many requests, please try again later.');
    expect(err.message).not.toContain('leak-canary-sub');
    expect(err.message).not.toContain(token);
    expect(err.message.toLowerCase()).not.toContain('google');
  });

  it('per-sub and IP buckets stay separate when the token cannot be parsed', () => {
    const store = new InMemoryRateLimitStore();
    const mw = createSocialAntiEnumerationMiddlewareWithStore(store, { limit: 1, ipFallbackLimit: 1 });
    const nextSub: NextFunction = jest.fn();
    const nextIp: NextFunction = jest.fn();
    const token = makeJwt({ sub: 'separate-buckets' });
    const subReq = () => makeReq({ params: { provider: 'google' }, body: { idToken: token }, ip: '203.0.113.25' });

    mw(subReq(), makeRes(), nextSub); // allowed
    mw(subReq(), makeRes(), nextSub); // blocked (per-sub bucket)
    mw(makeUnidentifiableReq('203.0.113.25'), makeRes(), nextIp); // allowed — IP bucket untouched

    expect((nextSub as jest.Mock).mock.calls[1][0]).toBeInstanceOf(AppError);
    expect((nextIp as jest.Mock).mock.calls[0][0]).toBeUndefined();
    expect(metrics()).toEqual({ attempts: 3, rejections: 1 });
  });

  it('counts each unidentifiable request per client IP independently', () => {
    const mw = createSocialAntiEnumerationMiddlewareWithStore(new InMemoryRateLimitStore(), { ipFallbackLimit: 1 });
    const nextA: NextFunction = jest.fn();
    const nextB: NextFunction = jest.fn();

    mw(makeUnidentifiableReq('203.0.113.26'), makeRes(), nextA);
    mw(makeUnidentifiableReq('203.0.113.26'), makeRes(), nextA); // blocked
    mw(makeUnidentifiableReq('203.0.113.27'), makeRes(), nextB); // different IP — allowed

    expect((nextA as jest.Mock).mock.calls[1][0]).toBeInstanceOf(AppError);
    expect((nextB as jest.Mock).mock.calls[0][0]).toBeUndefined();
    expect(metrics()).toEqual({ attempts: 3, rejections: 1 });
  });
});

// ── limiter wiring + next() rejection accounting (contract pins) ─────────────

describe('middleware wiring — limiter options and next() accounting', () => {
  let created: Array<Record<string, unknown>>;
  /** The `next` the middleware handed to the most recently created limiter. */
  let wrappedNexts: NextFunction[];

  beforeEach(() => {
    created = [];
    wrappedNexts = [];
    // Replaces the delegating default for the duration of this suite only.
    mockedLimiterFactory.mockImplementation((options: Record<string, unknown>) => {
      created.push(options);
      return (_req: Request, _res: Response, next: NextFunction): void => {
        wrappedNexts.push(next);
      };
    });
  });

  afterEach(() => {
    delegateLimiterFactoryToReal();
  });

  /** Runs one request through a fresh instance and returns the captured next. */
  function drive(req: Request, options: Record<string, unknown> = {}) {
    const mw = createSocialAntiEnumerationMiddlewareWithStore(new InMemoryRateLimitStore(), options);
    const outerNext = jest.fn();
    wrappedNexts = [];
    mw(req, makeRes(), outerNext);
    return { outerNext, wrappedNext: wrappedNexts[0] };
  }

  const subRequest = () => makeReq({ params: { provider: 'google' }, body: { idToken: makeJwt({ sub: 'wired' }) } });

  it('wires the per-sub limiter with perProviderSub and the sub key prefix', () => {
    createSocialAntiEnumerationMiddleware({ limit: 7, windowMs: 1000, ipFallbackLimit: 9 });

    expect(created).toHaveLength(2);
    expect(created[0]).toMatchObject({
      perProviderSub: true,
      limit: 7,
      windowMs: 1000,
      keyPrefix: 'social-anti-enum:sub',
    });
    expect(created[1]).toMatchObject({ limit: 9, windowMs: 1000, keyPrefix: 'social-anti-enum:ip' });
    expect(created[1].perProviderSub).toBeUndefined();
  });

  it('forwards the custom message and the injected store to both limiters', () => {
    const store = new InMemoryRateLimitStore();
    createSocialAntiEnumerationMiddlewareWithStore(store, { message: 'slow down' });

    expect(created[0].message).toBe('slow down');
    expect(created[1].message).toBe('slow down');
    expect(created[0].store).toBe(store);
    expect(created[1].store).toBe(store);
  });

  it('defaults to 10 attempts per 15 minutes per sub and 20 per IP per 15 minutes', () => {
    createSocialAntiEnumerationMiddleware();

    expect(created[0].limit).toBe(10);
    expect(created[0].windowMs).toBe(15 * 60 * 1000);
    expect(created[1].limit).toBe(20);
    expect(created[1].windowMs).toBe(15 * 60 * 1000);
  });

  it('uses the per-sub limiter once a subject is parsed and the IP limiter otherwise', () => {
    drive(subRequest());
    expect(created[0].perProviderSub).toBe(true);
    expect(created[1].perProviderSub).toBeUndefined();
    expect(wrappedNexts).toHaveLength(1);

    // A second, separately-configured instance: the fallback guard is the 4th
    // limiter created overall (2 per instance) and carries ipFallbackLimit.
    drive(makeUnidentifiableReq(), { ipFallbackLimit: 3 });
    expect(created[2].perProviderSub).toBe(true);
    expect(created[3].perProviderSub).toBeUndefined();
    expect(created[3].limit).toBe(3);
    expect(wrappedNexts).toHaveLength(1);
  });

  it('counts exactly one rejection when the limiter reports an Error, and forwards it', () => {
    const err = Errors.tooManyRequests('Too many requests, please try again later.', { retryAfter: 60 });
    const { outerNext, wrappedNext } = drive(subRequest());

    wrappedNext(err);

    expect(metrics()).toEqual({ attempts: 1, rejections: 1 });
    expect(outerNext).toHaveBeenCalledTimes(1);
    expect(outerNext.mock.calls[0][0]).toBe(err);
  });

  it('counts a rejection on the IP-fallback branch as well', () => {
    const err = Errors.tooManyRequests('Too many requests, please try again later.');
    const { outerNext, wrappedNext } = drive(makeUnidentifiableReq());

    wrappedNext(err);

    expect(metrics()).toEqual({ attempts: 1, rejections: 1 });
    expect(outerNext.mock.calls[0][0]).toBe(err);
  });

  it('never counts next(), next(undefined) or next(null) as a rejection', () => {
    const { outerNext, wrappedNext } = drive(subRequest());

    wrappedNext();
    wrappedNext(undefined);
    wrappedNext(null);

    expect(metrics()).toEqual({ attempts: 1, rejections: 0 });
    expect(outerNext).toHaveBeenCalledTimes(3);
  });

  it('never counts Express control-flow signals (next("route") / next("router"))', () => {
    const { outerNext, wrappedNext } = drive(subRequest());

    wrappedNext('route');
    wrappedNext('router');

    expect(metrics()).toEqual({ attempts: 1, rejections: 0 });
    expect(outerNext).toHaveBeenCalledTimes(2);
  });

  it('counts any other non-nullish, non-route argument as one rejection (defensive branch)', () => {
    const { outerNext, wrappedNext } = drive(subRequest());

    wrappedNext('rate-limit-rejected');
    wrappedNext({ retryAfter: 30 });

    // Express never passes these, but if a future limiter changed its signal the
    // rejection would still be instrumented rather than silently dropped.
    expect(metrics()).toEqual({ attempts: 1, rejections: 2 });
    expect(outerNext).toHaveBeenCalledTimes(2);
  });

  it('applies the same next() accounting matrix on the IP-fallback branch', () => {
    const matrix: Array<{ arg: unknown; counted: boolean }> = [
      { arg: new Error('boom'), counted: true },
      { arg: undefined, counted: false },
      { arg: null, counted: false },
      { arg: 'router', counted: false },
      { arg: 'route', counted: false },
      { arg: 'other-signal', counted: true },
    ];
    let expectedRejections = 0;

    matrix.forEach(({ arg, counted }, index) => {
      const { outerNext, wrappedNext } = drive(makeUnidentifiableReq(`198.51.100.${10 + index}`));
      wrappedNext(arg);
      if (counted) expectedRejections += 1;
      expect(outerNext).toHaveBeenCalledTimes(1);
      expect(outerNext.mock.calls[0][0]).toBe(arg);
    });

    expect(metrics()).toEqual({ attempts: matrix.length, rejections: expectedRejections });
  });

  it('accepts an omitted options object and applies the documented defaults', () => {
    const store = new InMemoryRateLimitStore();
    createSocialAntiEnumerationMiddlewareWithStore(store);

    expect(created[0]).toMatchObject({ perProviderSub: true, limit: 10, keyPrefix: 'social-anti-enum:sub' });
    expect(created[0].ipFallbackLimit).toBeUndefined();
    expect(created[1]).toMatchObject({ limit: 20, keyPrefix: 'social-anti-enum:ip' });
    expect(created[1].store).toBe(store);
  });

  it('delegates to the real limiter factory by default (the guard is not disabled)', () => {
    delegateLimiterFactoryToReal();
    const mw = createSocialAntiEnumerationMiddlewareWithStore(new InMemoryRateLimitStore(), { limit: 1 });
    const next: NextFunction = jest.fn();
    const token = makeJwt({ sub: 'delegation-check' });
    const req = () => makeReq({ params: { provider: 'google' }, body: { idToken: token }, ip: '198.51.100.99' });

    mw(req(), makeRes(), next); // allowed
    mw(req(), makeRes(), next); // blocked by the real limiter

    expect((next as jest.Mock).mock.calls[1][0]).toBeInstanceOf(AppError);
    expect(metrics()).toEqual({ attempts: 2, rejections: 1 });
  });
});
