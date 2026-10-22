/**
 * timezoneAllowlist.test.ts
 *
 * Regression suite for src/lib/timezoneAllowlist.ts (issue #1050).
 *
 * Covers:
 *   - ALLOWED_TIMEZONES: set membership, size, and immutability contract
 *   - isValidTimezone: true for every member, false for non-members, boundaries
 *   - assertValidTimezone: passes silently for valid TZs, throws for invalid ones
 *     with the exact error-message format (the branch cited in issue #1050)
 *   - normalizeTimezone: canonical alias folding + pass-through of unknown values
 *   - Boundary inputs: empty string, whitespace-padded, case-variant, numeric,
 *     undefined-ish coercion, very long strings
 */

import {
  ALLOWED_TIMEZONES,
  assertValidTimezone,
  isValidTimezone,
  normalizeTimezone,
} from './timezoneAllowlist';

// ─── ALLOWED_TIMEZONES ────────────────────────────────────────────────────────

describe('ALLOWED_TIMEZONES', () => {
  it('contains at least one entry', () => {
    expect(ALLOWED_TIMEZONES.size).toBeGreaterThan(0);
  });

  it('always contains UTC', () => {
    expect(ALLOWED_TIMEZONES.has('UTC')).toBe(true);
  });

  it('contains a representative sample of known IANA timezone IDs', () => {
    const knownMembers = [
      'America/New_York',
      'America/Los_Angeles',
      'America/Chicago',
      'America/Denver',
      'Europe/London',
      'Europe/Paris',
      'Asia/Tokyo',
      'Asia/Shanghai',
      'Australia/Sydney',
      'Pacific/Auckland',
      'America/Sao_Paulo',
      'Africa/Nairobi',
    ];
    for (const tz of knownMembers) {
      expect(ALLOWED_TIMEZONES.has(tz)).toBe(true);
    }
  });

  it('does NOT contain common non-allowlisted aliases', () => {
    // These are real IANA IDs that are intentionally excluded.
    const excluded = [
      'Etc/UTC',
      'Etc/GMT',
      'GMT',
      'Z',
      'America/Indiana/Indianapolis',
      'America/Anchorage',
    ];
    for (const tz of excluded) {
      expect(ALLOWED_TIMEZONES.has(tz)).toBe(false);
    }
  });

  it('is a ReadonlySet (has() and forEach() are present, no set/add/delete)', () => {
    expect(typeof ALLOWED_TIMEZONES.has).toBe('function');
    expect(typeof ALLOWED_TIMEZONES.forEach).toBe('function');
    // ReadonlySet does not expose add/delete/clear at the type level; verify
    // the runtime object is a plain Set (readonly at the type level only).
    expect(ALLOWED_TIMEZONES).toBeInstanceOf(Set);
  });
});

// ─── isValidTimezone ──────────────────────────────────────────────────────────

describe('isValidTimezone', () => {
  it('returns true for every member of ALLOWED_TIMEZONES', () => {
    for (const tz of ALLOWED_TIMEZONES) {
      expect(isValidTimezone(tz)).toBe(true);
    }
  });

  it('returns true for "UTC"', () => {
    expect(isValidTimezone('UTC')).toBe(true);
  });

  it('returns false for an empty string', () => {
    expect(isValidTimezone('')).toBe(false);
  });

  it('returns false for a whitespace-only string', () => {
    expect(isValidTimezone('   ')).toBe(false);
  });

  it('returns false for a valid IANA ID padded with whitespace', () => {
    // The allowlist performs exact matching; trimmed duplicates are rejected.
    expect(isValidTimezone(' UTC ')).toBe(false);
    expect(isValidTimezone('UTC ')).toBe(false);
    expect(isValidTimezone(' UTC')).toBe(false);
  });

  it('returns false for a case-variant of a valid ID', () => {
    expect(isValidTimezone('utc')).toBe(false);
    expect(isValidTimezone('america/new_york')).toBe(false);
    expect(isValidTimezone('EUROPE/LONDON')).toBe(false);
  });

  it('returns false for a forward-slash-only string', () => {
    expect(isValidTimezone('/')).toBe(false);
  });

  it('returns false for a numeric string', () => {
    expect(isValidTimezone('0')).toBe(false);
    expect(isValidTimezone('5')).toBe(false);
    expect(isValidTimezone('+05:30')).toBe(false);
  });

  it('returns false for a very long string', () => {
    expect(isValidTimezone('A'.repeat(500))).toBe(false);
  });

  it('returns false for common non-allowlisted aliases', () => {
    const aliases = ['Etc/UTC', 'Etc/GMT', 'GMT', 'Z', 'GMT+0', 'UTC+0'];
    for (const a of aliases) {
      expect(isValidTimezone(a)).toBe(false);
    }
  });

  it('returns false for completely arbitrary strings', () => {
    const invalid = [
      'Mars/Olympus_Mons',
      'Not/A/Timezone',
      'fake',
      '2025-01-01',
      '<script>alert(1)</script>',
      'null',
      'undefined',
    ];
    for (const tz of invalid) {
      expect(isValidTimezone(tz)).toBe(false);
    }
  });
});

// ─── assertValidTimezone — success paths ─────────────────────────────────────

describe('assertValidTimezone (success paths)', () => {
  it('does not throw for "UTC"', () => {
    expect(() => assertValidTimezone('UTC')).not.toThrow();
  });

  it('does not throw for any member of ALLOWED_TIMEZONES', () => {
    for (const tz of ALLOWED_TIMEZONES) {
      expect(() => assertValidTimezone(tz)).not.toThrow();
    }
  });

  it('does not throw when an explicit label is provided and the timezone is valid', () => {
    expect(() => assertValidTimezone('Europe/Paris', 'scheduleTimezone')).not.toThrow();
  });

  it('does not throw for "Asia/Kolkata" (representative non-US member)', () => {
    expect(() => assertValidTimezone('Asia/Kolkata')).not.toThrow();
  });
});

// ─── assertValidTimezone — failure paths (issue #1050 regression) ─────────────

describe('assertValidTimezone (failure paths — regression for issue #1050)', () => {
  // Exact error message format: `Invalid ${label}: "${tz}" is not in the allowed timezone list`

  it('throws for an empty string with the correct message format', () => {
    expect(() => assertValidTimezone('')).toThrow(
      'Invalid timezone: "" is not in the allowed timezone list',
    );
  });

  it('throws for an arbitrary invalid timezone with the correct message format', () => {
    expect(() => assertValidTimezone('Mars/Phobos')).toThrow(
      'Invalid timezone: "Mars/Phobos" is not in the allowed timezone list',
    );
  });

  it('throws an instance of Error (not a custom type)', () => {
    expect(() => assertValidTimezone('Bad/Tz')).toThrow(Error);
  });

  it('uses the default label "timezone" when no label is supplied', () => {
    let caught: unknown;
    try {
      assertValidTimezone('Fake/Zone');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe(
      'Invalid timezone: "Fake/Zone" is not in the allowed timezone list',
    );
  });

  it('interpolates a custom label into the error message', () => {
    let caught: unknown;
    try {
      assertValidTimezone('Bad/Zone', 'distributionTimezone');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe(
      'Invalid distributionTimezone: "Bad/Zone" is not in the allowed timezone list',
    );
  });

  it('interpolates a different custom label correctly', () => {
    expect(() => assertValidTimezone('Not/Real', 'offeringTimezone')).toThrow(
      'Invalid offeringTimezone: "Not/Real" is not in the allowed timezone list',
    );
  });

  it('throws for whitespace-padded valid ID (exact match required)', () => {
    expect(() => assertValidTimezone(' UTC ')).toThrow(
      'Invalid timezone: " UTC " is not in the allowed timezone list',
    );
  });

  it('throws for lowercase variant of a valid ID', () => {
    expect(() => assertValidTimezone('europe/london')).toThrow(
      'Invalid timezone: "europe/london" is not in the allowed timezone list',
    );
  });

  it('throws for "Etc/UTC" (a normalizable alias that is not allowlisted)', () => {
    expect(() => assertValidTimezone('Etc/UTC')).toThrow(
      'Invalid timezone: "Etc/UTC" is not in the allowed timezone list',
    );
  });

  it('throws for "GMT" (not in the allowlist)', () => {
    expect(() => assertValidTimezone('GMT')).toThrow(
      'Invalid timezone: "GMT" is not in the allowed timezone list',
    );
  });

  it('throws for a numeric string', () => {
    expect(() => assertValidTimezone('+05:30')).toThrow(
      'Invalid timezone: "+05:30" is not in the allowed timezone list',
    );
  });

  it('throws for a very long string and preserves the full value in the message', () => {
    const longTz = 'X'.repeat(200);
    expect(() => assertValidTimezone(longTz)).toThrow(
      `Invalid timezone: "${longTz}" is not in the allowed timezone list`,
    );
  });

  it('state is unchanged after a failed assertValidTimezone (pure function — no side effects)', () => {
    const sizeBefore = ALLOWED_TIMEZONES.size;
    try {
      assertValidTimezone('Injected/Fake');
    } catch {
      // expected
    }
    expect(ALLOWED_TIMEZONES.size).toBe(sizeBefore);
    expect(ALLOWED_TIMEZONES.has('Injected/Fake')).toBe(false);
  });
});

// ─── normalizeTimezone ────────────────────────────────────────────────────────

describe('normalizeTimezone', () => {
  it('normalizes "Etc/UTC" to "UTC"', () => {
    expect(normalizeTimezone('Etc/UTC')).toBe('UTC');
  });

  it('normalizes "Etc/GMT" to "UTC"', () => {
    expect(normalizeTimezone('Etc/GMT')).toBe('UTC');
  });

  it('normalizes "GMT" to "UTC"', () => {
    expect(normalizeTimezone('GMT')).toBe('UTC');
  });

  it('normalizes "Z" to "UTC"', () => {
    expect(normalizeTimezone('Z')).toBe('UTC');
  });

  it('returns the input unchanged for a valid allowlisted ID', () => {
    expect(normalizeTimezone('America/New_York')).toBe('America/New_York');
    expect(normalizeTimezone('Europe/Berlin')).toBe('Europe/Berlin');
    expect(normalizeTimezone('UTC')).toBe('UTC');
    expect(normalizeTimezone('Asia/Tokyo')).toBe('Asia/Tokyo');
  });

  it('returns the input unchanged for an arbitrary unknown string (no normalization defined)', () => {
    expect(normalizeTimezone('Unknown/Zone')).toBe('Unknown/Zone');
    expect(normalizeTimezone('')).toBe('');
    expect(normalizeTimezone('   ')).toBe('   ');
  });

  it('does NOT normalize "etc/utc" (case-sensitive)', () => {
    expect(normalizeTimezone('etc/utc')).toBe('etc/utc');
  });

  it('does NOT normalize "GMT+0" (not an explicit alias)', () => {
    expect(normalizeTimezone('GMT+0')).toBe('GMT+0');
  });

  it('normalizing all four aliases each returns a value accepted by isValidTimezone', () => {
    const aliases = ['Etc/UTC', 'Etc/GMT', 'GMT', 'Z'];
    for (const alias of aliases) {
      const normalized = normalizeTimezone(alias);
      expect(isValidTimezone(normalized)).toBe(true);
    }
  });
});

// ─── Integration: normalize → assert pipeline ─────────────────────────────────

describe('normalizeTimezone → assertValidTimezone pipeline', () => {
  it('Etc/UTC normalizes to UTC and then passes assertValidTimezone', () => {
    const normalized = normalizeTimezone('Etc/UTC');
    expect(() => assertValidTimezone(normalized)).not.toThrow();
  });

  it('GMT normalizes to UTC and then passes assertValidTimezone', () => {
    const normalized = normalizeTimezone('GMT');
    expect(() => assertValidTimezone(normalized)).not.toThrow();
  });

  it('Z normalizes to UTC and then passes assertValidTimezone', () => {
    const normalized = normalizeTimezone('Z');
    expect(() => assertValidTimezone(normalized)).not.toThrow();
  });

  it('an unknown alias does NOT become valid just by passing through normalizeTimezone', () => {
    const unchanged = normalizeTimezone('America/Indiana/Indianapolis');
    expect(isValidTimezone(unchanged)).toBe(false);
  });
});
