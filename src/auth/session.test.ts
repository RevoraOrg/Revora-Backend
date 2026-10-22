/**
 * Focused behavior coverage for `src/auth/session.ts` (issue #983).
 *
 * These tests pin the current public contract of the module:
 *  - `SESSION_TTL_MS` constant value (1 hour) and its documented relationship
 *    to the JWT access-token expiry (`TOKEN_EXPIRY = "1h"` in src/lib/jwt.ts).
 *  - `hashSessionToken` deterministic SHA-256 lowercase-hex fingerprinting.
 *  - `isSessionExpired` half-open expiry window (`expiresAt < now`).
 *
 * All time-dependent behavior uses Jest fake timers so the suite is fully
 * deterministic — no real waiting or sleeps.
 */

import { createHash } from 'node:crypto';
import {
  SESSION_TTL_MS,
  hashSessionToken,
  isSessionExpired,
} from './session';

describe('SESSION_TTL_MS', () => {
  it('equals 1 hour (3,600,000 ms), matching the JWT access-token expiry', () => {
    // Documented value: src/docs/session-expiry-cleanup.md pins 3600000.
    // Contract rationale: src/lib/jwt.ts uses TOKEN_EXPIRY = "1h" for access
    // tokens, so the session TTL must match.
    expect(SESSION_TTL_MS).toBe(3_600_000);
  });

  it('is exactly 60 * 60 * 1000 expressed as a numeric ms value', () => {
    expect(SESSION_TTL_MS).toBe(60 * 60 * 1000);
  });

  it('is a finite positive integer usable as a timestamp offset', () => {
    expect(Number.isInteger(SESSION_TTL_MS)).toBe(true);
    expect(Number.isFinite(SESSION_TTL_MS)).toBe(true);
    expect(SESSION_TTL_MS).toBeGreaterThan(0);
  });
});

describe('hashSessionToken', () => {
  it('produces the known SHA-256 vector for a representative token', () => {
    const hash = hashSessionToken('test-session-token');
    expect(hash).toBe(
      '7a16f44e82f892c5db994ff1fe2c468656ad31af77ebe04b1d02be3bf8d4cc8e',
    );
  });

  it('matches the SHA-256 digest of the raw token bytes', () => {
    const token = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig';
    expect(hashSessionToken(token)).toBe(
      createHash('sha256').update(token).digest('hex'),
    );
  });

  it('is deterministic: same input yields the same hash across calls', () => {
    const token = 'deterministic-token';
    expect(hashSessionToken(token)).toBe(hashSessionToken(token));
    expect(hashSessionToken(token)).toBe(hashSessionToken(token));
  });

  it('produces different hashes for different inputs', () => {
    expect(hashSessionToken('token-a')).not.toBe(hashSessionToken('token-b'));
    // Case change and trailing whitespace are different byte inputs.
    expect(hashSessionToken('token-a')).not.toBe(hashSessionToken('token-A'));
    expect(hashSessionToken('token-a')).not.toBe(hashSessionToken('token-a '));
  });

  it('always returns 64-char lowercase hex (output shape/type)', () => {
    for (const input of ['a', 'token-a', '\n', 'x'.repeat(10_000)]) {
      const hash = hashSessionToken(input);
      expect(typeof hash).toBe('string');
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('returns the empty-string SHA-256 digest for an empty token', () => {
    // Contract keeps working for the degenerate input; the empty digest is
    // the well-known SHA-256("") value.
    expect(hashSessionToken('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('hashes multi-byte UTF-8 input by bytes, not JS string length', () => {
    expect(hashSessionToken('héllo-token')).toBe(
      createHash('sha256').update('héllo-token').digest('hex'),
    );
    expect(hashSessionToken('héllo-token')).not.toBe(
      hashSessionToken('hello-token'),
    );
  });

  it('stays within the lowercase-hex shape for very long tokens', () => {
    const long = 'a'.repeat(100_000);
    expect(hashSessionToken(long).length).toBe(64);
    expect(hashSessionToken(long)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('isSessionExpired', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('returns false for a clearly non-expired session', () => {
    jest.setSystemTime(1_700_000_000_000);
    expect(isSessionExpired(new Date(1_700_000_000_000 + 60_000))).toBe(false);
  });

  it('returns false exactly at the expiration boundary (expiresAt === now is NOT expired)', () => {
    jest.setSystemTime(1_700_000_000_000);
    expect(isSessionExpired(new Date(1_700_000_000_000))).toBe(false);
  });

  it('returns true immediately after the boundary (expiresAt === now - 1ms)', () => {
    jest.setSystemTime(1_000_000_000_000);
    expect(isSessionExpired(new Date(1_000_000_000_000 - 1))).toBe(true);
  });

  it('returns true for a clearly expired session (a full TTL in the past)', () => {
    jest.setSystemTime(2_000_000_000_000);
    expect(
      isSessionExpired(new Date(2_000_000_000_000 - SESSION_TTL_MS)),
    ).toBe(true);
  });

  it('re-evaluates against Date.now() at call time, not a captured clock', () => {
    jest.setSystemTime(1_000_000_000_000);
    const expiresAt = new Date(1_000_000_000_000 + 5_000);
    expect(isSessionExpired(expiresAt)).toBe(false);

    jest.advanceTimersByTime(6_000);
    // Same Date object — result flips once the live clock passes it.
    expect(isSessionExpired(expiresAt)).toBe(true);
  });
});

describe('session state transitions around the TTL (fresh → boundary → expired)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('fresh session (just issued, expiresAt = issuedAt + SESSION_TTL_MS) is not expired', () => {
    jest.setSystemTime(1_700_000_000_000);
    const issuedAt = Date.now();
    const expiresAt = new Date(issuedAt + SESSION_TTL_MS);
    expect(isSessionExpired(expiresAt)).toBe(false);
  });

  it('session exactly at the TTL boundary (1h after issue) is still valid', () => {
    jest.setSystemTime(1_700_000_000_000);
    const issuedAt = Date.now();
    const expiresAt = new Date(issuedAt + SESSION_TTL_MS);

    jest.setSystemTime(issuedAt + SESSION_TTL_MS);
    expect(isSessionExpired(expiresAt)).toBe(false);
  });

  it('session 1ms past the TTL boundary is expired', () => {
    jest.setSystemTime(1_700_000_000_000);
    const issuedAt = Date.now();
    const expiresAt = new Date(issuedAt + SESSION_TTL_MS);

    jest.setSystemTime(issuedAt + SESSION_TTL_MS + 1);
    expect(isSessionExpired(expiresAt)).toBe(true);
  });

  it('session far beyond the TTL (e.g. one extra TTL) is expired', () => {
    jest.setSystemTime(1_700_000_000_000);
    const issuedAt = Date.now();
    const expiresAt = new Date(issuedAt + SESSION_TTL_MS);

    jest.setSystemTime(issuedAt + SESSION_TTL_MS + SESSION_TTL_MS);
    expect(isSessionExpired(expiresAt)).toBe(true);
  });
});

describe('cross-module consistency: hashing is stable across clock changes', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(1_700_000_000_000);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('sha256 token fingerprint does not depend on the current time', () => {
    const token = 'login-flow-token';
    const before = hashSessionToken(token);

    jest.advanceTimersByTime(SESSION_TTL_MS);
    const after = hashSessionToken(token);

    expect(after).toBe(before);
    expect(after).toBe(createHash('sha256').update(token).digest('hex'));
  });
});
