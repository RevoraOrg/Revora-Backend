// Set up test JWT_SECRET before importing the cursor module (it reads the env
// lazily through getJwtSecret()).
process.env.JWT_SECRET = 'cursor-test-secret-key-that-is-at-least-32-chars';

import jwt from 'jsonwebtoken';
import {
  CURSOR_DEFAULT_TTL_SECONDS,
  CURSOR_PAGE_SIZE,
  signCursor,
  validateCursorTimestamp,
  verifyCursor,
} from './cursor';

const SECRET = process.env.JWT_SECRET as string;

/**
 * Regression coverage for the failure paths of the offline-first sync cursor
 * (issue: CURSOR_DEFAULT_TTL_SECONDS failure handling).
 *
 * verifyCursor is the trust boundary for client-supplied cursors, so each
 * missing/invalid field has an explicit, deterministic error contract.
 */
describe('sync cursor', () => {
  const basePayload = () => ({
    sub: 'investor-1',
    ts: new Date('2026-01-01T00:00:00.000Z').toISOString(),
    page: 0,
    resources: ['holdings', 'distributions'],
  });

  describe('constants', () => {
    it('defaults to a 24 hour TTL', () => {
      expect(CURSOR_DEFAULT_TTL_SECONDS).toBe(86_400);
    });

    it('defaults to a page size of 20', () => {
      expect(CURSOR_PAGE_SIZE).toBe(20);
    });
  });

  describe('signCursor / verifyCursor round trip', () => {
    it('signs and verifies a complete cursor', () => {
      const token = signCursor(basePayload());
      const decoded = verifyCursor(token);

      expect(decoded.sub).toBe('investor-1');
      expect(decoded.ts).toBe(basePayload().ts);
      expect(decoded.page).toBe(0);
      expect(decoded.resources).toEqual(['holdings', 'distributions']);
    });

    it('applies the default TTL when none is supplied', () => {
      const token = signCursor(basePayload());
      const decoded = verifyCursor(token);

      expect(decoded.exp! - decoded.iat!).toBe(CURSOR_DEFAULT_TTL_SECONDS);
    });

    it('applies an explicit TTL', () => {
      const token = signCursor(basePayload(), 120);
      const decoded = verifyCursor(token);

      expect(decoded.exp! - decoded.iat!).toBe(120);
    });
  });

  describe('verifyCursor rejection paths', () => {
    it('rejects a cursor without a subject', () => {
      const token = jwt.sign(
        { ts: basePayload().ts, page: 0, resources: [] },
        SECRET,
        { algorithm: 'HS256' },
      );

      expect(() => verifyCursor(token)).toThrow('Cursor missing subject (sub)');
    });

    it('rejects a cursor whose subject is not a string', () => {
      const token = jwt.sign({ sub: 42, ts: basePayload().ts, page: 0, resources: [] }, SECRET, {
        algorithm: 'HS256',
      });

      expect(() => verifyCursor(token)).toThrow('Cursor missing subject (sub)');
    });

    it('rejects a cursor without a timestamp', () => {
      const token = jwt.sign({ sub: 'investor-1', page: 0, resources: [] }, SECRET, {
        algorithm: 'HS256',
      });

      expect(() => verifyCursor(token)).toThrow('Cursor missing timestamp (ts)');
    });

    it('rejects a cursor whose page index is missing', () => {
      const token = jwt.sign(
        { sub: 'investor-1', ts: basePayload().ts, resources: [] },
        SECRET,
        { algorithm: 'HS256' },
      );

      expect(() => verifyCursor(token)).toThrow('Cursor missing or invalid page index');
    });

    it('rejects a cursor with a negative page index', () => {
      const token = jwt.sign(
        { sub: 'investor-1', ts: basePayload().ts, page: -1, resources: [] },
        SECRET,
        { algorithm: 'HS256' },
      );

      expect(() => verifyCursor(token)).toThrow('Cursor missing or invalid page index');
    });

    it('rejects a cursor whose resources field is not an array', () => {
      const token = jwt.sign(
        { sub: 'investor-1', ts: basePayload().ts, page: 0, resources: 'holdings' },
        SECRET,
        { algorithm: 'HS256' },
      );

      expect(() => verifyCursor(token)).toThrow('Cursor missing resources array');
    });

    it('rejects an expired cursor', () => {
      const token = jwt.sign(basePayload(), SECRET, { algorithm: 'HS256', expiresIn: -10 });

      expect(() => verifyCursor(token)).toThrow();
    });

    it('rejects a tampered cursor signature', () => {
      const token = signCursor(basePayload());
      const tampered = token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A');

      expect(() => verifyCursor(tampered)).toThrow();
    });

    it('rejects a cursor signed with a different secret', () => {
      const token = jwt.sign(basePayload(), 'a-different-secret-that-is-32-plus-chars', {
        algorithm: 'HS256',
      });

      expect(() => verifyCursor(token)).toThrow();
    });
  });

  describe('validateCursorTimestamp', () => {
    it('accepts a timestamp at the current time', () => {
      expect(validateCursorTimestamp(new Date().toISOString())).toBe(true);
    });

    it('accepts a small clock skew within the default tolerance', () => {
      const slightlyAhead = new Date(Date.now() + 5_000).toISOString();

      expect(validateCursorTimestamp(slightlyAhead)).toBe(true);
    });

    it('honours an explicit clock-skew tolerance', () => {
      const ahead = new Date(Date.now() + 45_000).toISOString();

      expect(validateCursorTimestamp(ahead, 60_000)).toBe(true);
    });

    it('rejects an unparseable timestamp', () => {
      expect(() => validateCursorTimestamp('not-a-date')).toThrow(
        'Cursor contains invalid timestamp',
      );
    });

    it('rejects a timestamp beyond the clock-skew tolerance', () => {
      const future = new Date(Date.now() + 120_000).toISOString();

      expect(() => validateCursorTimestamp(future)).toThrow('Cursor timestamp is in the future');
    });
  });
});
