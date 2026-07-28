import { isValidTimezone, assertValidTimezone, normalizeTimezone, ALLOWED_TIMEZONES } from '../timezoneAllowlist';

describe('timezoneAllowlist', () => {
  describe('ALLOWED_TIMEZONES', () => {
    it('contains at least UTC', () => {
      expect(ALLOWED_TIMEZONES.has('UTC')).toBe(true);
    });

    it('contains common zones across major regions', () => {
      expect(ALLOWED_TIMEZONES.has('America/New_York')).toBe(true);
      expect(ALLOWED_TIMEZONES.has('America/Chicago')).toBe(true);
      expect(ALLOWED_TIMEZONES.has('Europe/London')).toBe(true);
      expect(ALLOWED_TIMEZONES.has('Europe/Paris')).toBe(true);
      expect(ALLOWED_TIMEZONES.has('Asia/Tokyo')).toBe(true);
      expect(ALLOWED_TIMEZONES.has('Asia/Shanghai')).toBe(true);
      expect(ALLOWED_TIMEZONES.has('Australia/Sydney')).toBe(true);
      expect(ALLOWED_TIMEZONES.has('Pacific/Auckland')).toBe(true);
    });
  });

  describe('isValidTimezone', () => {
    it('returns true for zones in the allowlist', () => {
      expect(isValidTimezone('America/New_York')).toBe(true);
      expect(isValidTimezone('Europe/Berlin')).toBe(true);
      expect(isValidTimezone('Asia/Kolkata')).toBe(true);
      expect(isValidTimezone('UTC')).toBe(true);
    });

    it('returns false for zones not in the allowlist', () => {
      expect(isValidTimezone('US/Eastern')).toBe(false);
      expect(isValidTimezone('')).toBe(false);
      expect(isValidTimezone('Foo/Bar')).toBe(false);
    });
  });

  describe('assertValidTimezone', () => {
    it('does not throw for valid zones', () => {
      expect(() => assertValidTimezone('America/New_York')).not.toThrow();
      expect(() => assertValidTimezone('Europe/London')).not.toThrow();
    });

    it('throws for invalid zones', () => {
      expect(() => assertValidTimezone('Bad/Zone')).toThrow('Invalid timezone');
      expect(() => assertValidTimezone('')).toThrow('Invalid timezone');
    });

    it('uses the provided label in the error message', () => {
      expect(() => assertValidTimezone('Bad/Zone', 'offering timezone'))
        .toThrow('offering timezone');
    });
  });

  describe('normalizeTimezone', () => {
    it('returns UTC for Etc/UTC', () => {
      expect(normalizeTimezone('Etc/UTC')).toBe('UTC');
    });

    it('returns UTC for Etc/GMT', () => {
      expect(normalizeTimezone('Etc/GMT')).toBe('UTC');
    });

    it('returns UTC for GMT', () => {
      expect(normalizeTimezone('GMT')).toBe('UTC');
    });

    it('returns UTC for Z', () => {
      expect(normalizeTimezone('Z')).toBe('UTC');
    });

    it('returns the input unchanged for other zones', () => {
      expect(normalizeTimezone('America/New_York')).toBe('America/New_York');
      expect(normalizeTimezone('Europe/Paris')).toBe('Europe/Paris');
    });
  });
});
