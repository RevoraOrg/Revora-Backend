/**
 * Regression coverage for `RedactionRule` failure handling.
 *
 * Scope (issue #958):
 * - The three explicit `return undefined` branches in `src/aml/fixtures/redaction.ts`
 *   (lines 111, 118, 126):
 *     - Line 111 — idempotency rule declines a value that is not an
 *       already-redacted marker.
 *     - Line 118 — email rule declines a value that is not an email address.
 *     - Line 126 — SSN rule declines a value that is not an SSN.
 * - The neighboring normal paths: each rule's successful replacement.
 * - Meaningful boundary inputs around each decline condition.
 *
 * Contract being protected: a rule returning `undefined` means
 * "decline" — `redactValue`/`redactObject` then leave the value unchanged
 * (or fall through to a later rule). A `RedactionRule` must never silently
 * mutate or drop values on its failure path.
 *
 * Production behavior is intentionally unchanged: these tests pin the
 * existing public contract only.
 */

import {
  redactObject,
  redactValue,
  createRedactionContext,
  RedactionContext,
  RedactionRule,
} from '../fixtures/redaction';

describe('RedactionRule failure handling (issue #958 regression)', () => {
  let ctx: RedactionContext;

  beforeEach(() => {
    ctx = createRedactionContext();
  });

  // ── Branch at line 111: idempotency rule declines non-marker values ──────

  describe('failure branch 1: idempotency rule declines non-marker values', () => {
    it('returns the value unchanged when it is not an already-redacted marker', () => {
      // Plain non-PII string does not match /^(?:__.*__|\[REDACTED_.*\])$/,
      // so the rule returns `undefined` and redactValue falls through to the
      // remaining rules, none of which match either.
      const result = redactValue('plain-value', 'note', '$.note', ctx);
      expect(result).toBe('plain-value');
    });

    it('returns object values unchanged when no rule matches them', () => {
      const input = { note: 'plain-value', count: 7, flag: true };
      const result = redactObject(input, ctx);
      expect(result).toEqual({ note: 'plain-value', count: 7, flag: true });
    });

    it('treats near-marker strings as non-markers and leaves them unchanged', () => {
      // Boundary: strings that resemble but do not satisfy the marker
      // pattern `^(?:__.*__|\[REDACTED_.*\])$` must not be treated as
      // already redacted, and must still pass through unchanged.
      const nearMarkers = [
        '__',                 // too short: no inner content
        '__ EMAIL __',        // spaces are not covered by the pattern
        '[REDACTED_',         // unclosed bracket form
        'REDACTED_EMAIL]',    // missing opening bracket
        'x__EMAIL__x',        // marker embedded in surrounding text
      ];
      for (const value of nearMarkers) {
        expect(redactValue(value, 'note', '$.note', ctx)).toBe(value);
      }
    });

    it('does not decline-then-respan already-redacted markers: idempotency holds', () => {
      // Already-redacted markers match the idempotency rule's success branch
      // and are returned verbatim — the flip side of the line-111 decline.
      const input = {
        email: '__EMAIL__',
        token: '[REDACTED_TOKEN_0001]',
      };
      const result = redactObject(input, ctx);
      expect(result.email).toBe('__EMAIL__');
      expect(result.token).toBe('[REDACTED_TOKEN_0001]');
    });
  });

  // ── Branch at line 118: email rule declines non-email values ─────────────

  describe('failure branch 2: email rule declines non-email values', () => {
    it('returns undefined for values that are not email addresses', () => {
      // Driven through a custom-rule slot would bypass built-ins, so assert
      // the built-in rule's decline directly via redactValue: a non-email
      // string with a non-PII key ends up returned unchanged.
      const result = redactValue('not-an-email', 'note', '$.note', ctx);
      expect(result).toBe('not-an-email');
    });

    it('declines non-string values of every other type', () => {
      // typeof checks make the rule decline non-strings; redactValue passes
      // primitives through before rules even run.
      expect(redactValue(null, 'x', '$.x', ctx)).toBeNull();
      expect(redactValue(undefined, 'x', '$.x', ctx)).toBeUndefined();
      expect(redactValue(42, 'x', '$.x', ctx)).toBe(42);
      expect(redactValue(false, 'x', '$.x', ctx)).toBe(false);
      expect(redactValue({ nested: true }, 'x', '$.x', ctx)).toEqual({ nested: true });
      expect(redactValue(['a'], 'x', '$.x', ctx)).toEqual(['a']);
    });

    it('still redacts emails when an earlier rule declines (fall-through success)', () => {
      // A declining custom rule must not prevent the built-in email rule
      // from matching on its success path.
      const customRules: RedactionRule[] = [() => undefined];
      const result = redactObject(
        { contact: 'user@example.com' },
        ctx,
        { customRules },
      );
      expect(result.contact).toBe('__EMAIL__');
    });
  });

  // ── Branch at line 126: SSN rule declines non-SSN values ─────────────────

  describe('failure branch 3: SSN rule declines non-SSN values', () => {
    it('returns the value unchanged for digit strings that no rule owns', () => {
      // SSN_RE is ^\d{3}-?\d{2}-?\d{4}$; these strings do not satisfy it and
      // are also not matched by any later rule, so they pass through intact.
      const nonSsns = [
        '123-456-789',   // wrong dash grouping (3-3-3)
        'a23456789',     // non-digit character
        '-123456789',    // leading dash
      ];
      for (const value of nonSsns) {
        expect(redactValue(value, 'note', '$.note', ctx)).toBe(value);
      }
    });

    it('hands digit strings that decline as SSN to the phone rule', () => {
      // Fall-through contract: declining SSN candidates with 8/10 digits are
      // redacted by the generic phone rule, never dropped or left raw.
      expect(redactValue('12345678', 'note', '$.note', ctx)).toBe('__PHONE__');
      expect(redactValue('1234567890', 'note', '$.note', ctx)).toBe('__PHONE__');
    });

    it('hands EIN-shaped strings that decline as SSN to the EIN rule', () => {
      expect(redactValue('12-3456789', 'note', '$.note', ctx)).toBe('__EIN__');
    });

    it('keeps phone-shaped digit strings on the phone rule, not the SSN rule', () => {
      // SSN must decline first (line 126) so the generic phone rule can own
      // digit strings — regression-proofs the documented rule ordering.
      expect(redactValue('14155551234', 'phone', '$.phone', ctx)).toBe('__PHONE__');
      expect(redactValue('+14155551234', 'phone', '$.phone', ctx)).toBe('__PHONE__');
    });

    it('redacts SSNs on the neighboring success path after declining non-SSNs', () => {
      const input = { ssn: '123-45-6789', compact: '123456789' };
      const result = redactObject(input, ctx);
      expect(result.ssn).toBe('__SSN__');
      expect(result.compact).toBe('__SSN__');
    });

    it('redacts SSN last-4 only when the key matches, declining otherwise', () => {
      // Key-specific rule boundary: SSN4_RE matches 4-digit strings, but the
      // key gate /ssn|last.?4/i decides the outcome.
      expect(redactValue('6789', 'ssnLast4', '$.ssnLast4', ctx)).toBe('__SSN4__');
      expect(redactValue('6789', 'last4', '$.last4', ctx)).toBe('__SSN4__');
      // With a non-SSN key the SSN4 rule declines; the phone rule then owns
      // the 4-digit string — pinning that fall-through, not data loss.
      expect(redactValue('6789', 'note', '$.note', ctx)).toBe('__PHONE__');
      // A single digit matches neither SSN4 nor phone: no rule claims it.
      expect(redactValue('6', 'note', '$.note', ctx)).toBe('6');
    });
  });

  // ── Neighboring normal (success) paths ───────────────────────────────────

  describe('neighboring success paths', () => {
    it('redacts email values on the success path adjacent to line 118', () => {
      expect(redactValue('john.doe@example.com', 'email', '$.email', ctx)).toBe('__EMAIL__');
    });

    it('redacts mixed PII and leaves non-PII together in one object', () => {
      const input = {
        email: 'jane@test.org',
        ssn: '987-65-4321',
        note: 'plain-value',
        amount: 1500,
        active: true,
      };
      const result = redactObject(input, ctx);
      expect(result.email).toBe('__EMAIL__');
      expect(result.ssn).toBe('__SSN__');
      expect(result.note).toBe('plain-value');
      expect(result.amount).toBe(1500);
      expect(result.active).toBe(true);
    });
  });

  // ── Boundary inputs around the decline conditions ────────────────────────

  describe('boundary behavior', () => {
    it('declines empty strings on every string-matching rule', () => {
      // Empty string matches none of EMAIL_RE/SSN_RE/marker regex and fails
      // the PII-key rule's value.length > 0 gate.
      expect(redactValue('', 'email', '$.email', ctx)).toBe('');
      expect(redactValue('', 'ssn', '$.ssn', ctx)).toBe('');
      expect(redactValue('', 'password', '$.password', ctx)).toBe('');
    });

    it('declines PII keys whose values are empty or non-string', () => {
      // Boundary of the PII-key rule: key matches but the value gate fails.
      expect(redactValue('', 'token', '$.token', ctx)).toBe('');
      expect(redactValue(0, 'token', '$.token', ctx)).toBe(0);
      expect(redactValue(false, 'token', '$.token', ctx)).toBe(false);
    });

    it('redacts the shortest valid email and declines a one-letter TLD', () => {
      // EMAIL_RE requires a 2+ letter TLD, so 'a@b.c' declines the email rule;
      // with a non-PII key no later rule claims it and it passes through.
      expect(redactValue('a@b.co', 'note', '$.note', ctx)).toBe('__EMAIL__');
      expect(redactValue('a@b.c', 'note', '$.note', ctx)).toBe('a@b.c');
      // With a PII key, the same declined value is claimed by the key rule.
      expect(redactValue('a@b.c', 'email', '$.email', ctx)).toBe('__REDACTED_EMAIL__');
    });

    it('keeps the first matching rule authoritative when earlier rules decline', () => {
      // Boundary of rule ordering: a value can match at most one built-in
      // replacement; declining rules must not clobber the winning one.
      const input = { phone: '1234567890' }; // 10 digits: not SSN (9), is phone
      const result = redactObject(input, ctx);
      expect(result.phone).toBe('__PHONE__');
    });
  });
});
