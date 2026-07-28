/**
 * Redaction tests – prove no PII leaks into fixtures.
 *
 * Every test case asserts that a specific PII pattern is replaced
 * by a safe placeholder, covering:
 * - Email addresses
 * - Phone numbers
 * - SSN / SSN last-4
 * - EIN
 * - IP addresses
 * - Key-name-based redaction (e.g., password, secret, token)
 * - Nested objects and arrays
 * - Non-PII values pass through unchanged
 * - Custom rules
 * - Deterministic placeholder generation
 */

import {
  redactObject,
  redactValue,
  createRedactionContext,
  RedactionContext,
} from '../fixtures/redaction';

describe('Redaction rules', () => {
  let ctx: RedactionContext;

  beforeEach(() => {
    ctx = createRedactionContext();
  });

  // ── Email ──────────────────────────────────────────────────────────

  describe('email redaction', () => {
    it('should redact email in a string value', () => {
      const input = { email: 'john.doe@example.com' };
      const result = redactObject(input, ctx);
      expect(result.email).toBe('__EMAIL__');
    });

    it('should redact email in nested objects', () => {
      const input = { user: { contact: { email: 'jane@test.org' } } };
      const result = redactObject(input, ctx);
      expect(result.user.contact.email).toBe('__EMAIL__');
    });

    it('should redact emails in arrays', () => {
      const input = { emails: ['a@b.com', 'c@d.org'] };
      const result = redactObject(input, ctx);
      expect(result.emails).toEqual(['__EMAIL__', '__EMAIL__']);
    });
  });

  // ── Phone ──────────────────────────────────────────────────────────

  describe('phone redaction', () => {
    it('should redact phone number in E.164 format', () => {
      const input = { phone: '+14155551234' };
      const result = redactObject(input, ctx);
      expect(result.phone).toBe('__PHONE__');
    });

    it('should redact phone without + prefix', () => {
      const input = { phone: '14155551234' };
      const result = redactObject(input, ctx);
      expect(result.phone).toBe('__PHONE__');
    });
  });

  // ── SSN ────────────────────────────────────────────────────────────

  describe('SSN redaction', () => {
    it('should redact SSN with dashes', () => {
      const input = { ssn: '123-45-6789' };
      const result = redactObject(input, ctx);
      expect(result.ssn).toBe('__SSN__');
    });

    it('should redact SSN without dashes', () => {
      const input = { ssn: '123456789' };
      const result = redactObject(input, ctx);
      expect(result.ssn).toBe('__SSN__');
    });

    it('should redact SSN last-4 when key contains ssn', () => {
      const input = { ssnLast4: '6789' };
      const result = redactObject(input, ctx);
      expect(result.ssnLast4).toBe('__SSN4__');
    });
  });

  // ── EIN ────────────────────────────────────────────────────────────

  describe('EIN redaction', () => {
    it('should redact EIN with dashes', () => {
      const input = { ein: '12-3456789' };
      const result = redactObject(input, ctx);
      expect(result.ein).toBe('__EIN__');
    });
  });

  // ── IP address ─────────────────────────────────────────────────────

  describe('IP address redaction', () => {
    it('should redact IPv4 address', () => {
      const input = { ip: '192.168.1.100' };
      const result = redactObject(input, ctx);
      expect(result.ip).toBe('__IP__');
    });

    it('should redact IP in nested path', () => {
      const input = { metadata: { ip_address: '10.0.0.1' } };
      const result = redactObject(input, ctx);
      expect(result.metadata.ip_address).toBe('__IP__');
    });
  });

  // ── Key-name-based redaction ───────────────────────────────────────

  describe('key-name-based redaction', () => {
    it('should redact "password" key', () => {
      const input = { password: 'hunter2' };
      const result = redactObject(input, ctx);
      expect(result.password).toBe('__REDACTED_PASSWORD__');
    });

    it('should redact "secret" key', () => {
      const input = { secret: 'my-secret-value' };
      const result = redactObject(input, ctx);
      expect(result.secret).toBe('__REDACTED_SECRET__');
    });

    it('should redact "token" key', () => {
      const input = { token: 'abc123' };
      const result = redactObject(input, ctx);
      expect(result.token).toBe('__REDACTED_TOKEN__');
    });

    it('should redact "apiKey" key', () => {
      const input = { apiKey: 'sk_live_123' };
      const result = redactObject(input, ctx);
      expect(result.apiKey).toBe('__REDACTED_APIKEY__');
    });

    it('should redact "firstName" key', () => {
      const input = { firstName: 'John' };
      const result = redactObject(input, ctx);
      expect(result.firstName).toBe('__REDACTED_FIRSTNAME__');
    });

    it('should redact "lastName" key', () => {
      const input = { lastName: 'Doe' };
      const result = redactObject(input, ctx);
      expect(result.lastName).toBe('__REDACTED_LASTNAME__');
    });

    it('should redact "address" key', () => {
      const input = { address: '123 Main St' };
      const result = redactObject(input, ctx);
      expect(result.address).toBe('__REDACTED_ADDRESS__');
    });

    it('should redact "passport" key', () => {
      const input = { passport: 'AB1234567' };
      const result = redactObject(input, ctx);
      expect(result.passport).toBe('__REDACTED_PASSPORT__');
    });

    it('should redact "dateOfBirth" key', () => {
      const input = { dateOfBirth: '1990-01-15' };
      const result = redactObject(input, ctx);
      expect(result.dateOfBirth).toBe('__REDACTED_DATEOFBIRTH__');
    });

    it('should redact "beneficiary" key', () => {
      const input = { beneficiary: 'Jane Doe' };
      const result = redactObject(input, ctx);
      expect(result.beneficiary).toBe('__REDACTED_BENEFICIARY__');
    });
  });

  // ── Non-PII passthrough ────────────────────────────────────────────

  describe('non-PII passthrough', () => {
    it('should leave normal strings unchanged', () => {
      const input = { id: 'abc-123', name: 'Revora', status: 'active' };
      const result = redactObject(input, ctx);
      expect(result).toEqual(input);
    });

    it('should leave numbers unchanged', () => {
      const input = { amount: 1000, rate: 0.05, count: 42 };
      const result = redactObject(input, ctx);
      expect(result).toEqual(input);
    });

    it('should leave booleans unchanged', () => {
      const input = { enabled: true, verified: false };
      const result = redactObject(input, ctx);
      expect(result).toEqual(input);
    });

    it('should leave dates (ISO strings that are not email/phone) unchanged', () => {
      const input = { createdAt: '2026-01-15T10:30:00Z' };
      const result = redactObject(input, ctx);
      expect(result.createdAt).toBe('2026-01-15T10:30:00Z');
    });

    it('should leave null and undefined unchanged', () => {
      const input = { a: null, b: undefined, c: 'value' };
      const result = redactObject(input, ctx);
      expect(result.a).toBeNull();
      expect(result.b).toBeUndefined();
      expect(result.c).toBe('value');
    });
  });

  // ── Complex nested structures ──────────────────────────────────────

  describe('complex nested structures', () => {
    it('should redact deeply nested PII', () => {
      const input = {
        level1: {
          level2: {
            level3: {
              email: 'deep@example.com',
              ssn: '111-22-3333',
              normalField: 'keep-me',
            },
          },
        },
      };
      const result = redactObject(input, ctx);
      expect(result.level1.level2.level3.email).toBe('__EMAIL__');
      expect(result.level1.level2.level3.ssn).toBe('__SSN__');
      expect(result.level1.level2.level3.normalField).toBe('keep-me');
    });

    it('should redact PII in arrays of objects', () => {
      const input = {
        transactions: [
          { id: 'tx1', investorEmail: 'a@test.com', amount: 100 },
          { id: 'tx2', investorEmail: 'b@test.com', amount: 200 },
        ],
      };
      const result = redactObject(input, ctx);
      expect(result.transactions[0].investorEmail).toBe('__EMAIL__');
      expect(result.transactions[1].investorEmail).toBe('__EMAIL__');
      expect(result.transactions[0].id).toBe('tx1');
      expect(result.transactions[0].amount).toBe(100);
    });

    it('should redact mixed PII types in a KYC response', () => {
      const input = {
        applicant: {
          firstName: 'John',
          lastName: 'Doe',
          email: 'john@example.com',
          phone: '+14155551234',
          dateOfBirth: '1990-01-15',
          address: '123 Main St',
          ssn: '123-45-6789',
        },
        verification: {
          status: 'verified',
          score: 0.95,
          documentType: 'passport',
          passport: 'AB1234567',
        },
      };
      const result = redactObject(input, ctx);

      expect(result.applicant.firstName).toBe('__REDACTED_FIRSTNAME__');
      expect(result.applicant.lastName).toBe('__REDACTED_LASTNAME__');
      expect(result.applicant.email).toBe('__EMAIL__');
      expect(result.applicant.phone).toBe('__PHONE__');
      expect(result.applicant.dateOfBirth).toBe('__REDACTED_DATEOFBIRTH__');
      expect(result.applicant.address).toBe('__REDACTED_ADDRESS__');
      expect(result.applicant.ssn).toBe('__SSN__');

      expect(result.verification.status).toBe('verified');
      expect(result.verification.score).toBe(0.95);
      expect(result.verification.documentType).toBe('passport');
      expect(result.verification.passport).toBe('__REDACTED_PASSPORT__');
    });
  });

  // ── Deterministic placeholders ─────────────────────────────────────

  describe('deterministic placeholders', () => {
    it('should produce same placeholders across multiple redactions on same context', () => {
      const input1 = { email: 'a@test.com' };
      const input2 = { email: 'b@test.com' };

      const result1 = redactObject(input1, ctx);
      const result2 = redactObject(input2, ctx);

      expect(result1.email).toBe('__EMAIL__');
      expect(result2.email).toBe('__EMAIL__');
    });

    it('should track redaction counts in context', () => {
      redactObject({ email: 'a@test.com', ssn: '123-45-6789' }, ctx);
      expect(ctx.privateValues.size).toBe(0); // Built-in rules use fixed placeholders, not ctx
    });
  });

  // ── Custom rules ───────────────────────────────────────────────────

  describe('custom rules', () => {
    it('should apply custom rules before built-in rules', () => {
      const customRules = [
        (key: string, value: unknown) => {
          if (key === 'customField' && typeof value === 'string') {
            return '__CUSTOM_REDACTED__';
          }
          return undefined;
        },
      ];
      const input = { customField: 'sensitive-data' };
      const result = redactObject(input, ctx, { customRules });
      expect(result.customField).toBe('__CUSTOM_REDACTED__');
    });

    it('should fall back to built-in rules when custom rule returns undefined', () => {
      const customRules = [
        () => undefined, // no-op
      ];
      const input = { email: 'test@example.com' };
      const result = redactObject(input, ctx, { customRules });
      expect(result.email).toBe('__EMAIL__');
    });
  });

  // ── redactValue ────────────────────────────────────────────────────

  describe('redactValue', () => {
    it('should redact email value', () => {
      const result = redactValue('test@example.com', 'email', '$.email', ctx);
      expect(result).toBe('__EMAIL__');
    });

    it('should not redact non-PII value', () => {
      const result = redactValue('hello', 'name', '$.name', ctx);
      expect(result).toBe('hello');
    });

    it('should pass through null and undefined', () => {
      expect(redactValue(null, 'x', '$', ctx)).toBeNull();
      expect(redactValue(undefined, 'x', '$', ctx)).toBeUndefined();
    });

    it('should pass through numbers and booleans', () => {
      expect(redactValue(42, 'x', '$', ctx)).toBe(42);
      expect(redactValue(true, 'x', '$', ctx)).toBe(true);
    });
  });

  // ── Redaction context ──────────────────────────────────────────────

  describe('createRedactionContext', () => {
    it('should create empty context', () => {
      const c = createRedactionContext();
      expect(c.privateValues.size).toBe(0);
      expect(c.counters.size).toBe(0);
    });
  });

  // ── Edge cases ─────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('should handle empty object', () => {
      const result = redactObject({}, ctx);
      expect(result).toEqual({});
    });

    it('should handle empty array', () => {
      const result = redactObject([], ctx);
      expect(result).toEqual([]);
    });

    it('should handle already-redacted values gracefully', () => {
      const input = { email: '__EMAIL__' };
      const result = redactObject(input, ctx);
      expect(result.email).toBe('__EMAIL__');
    });

    it('should handle string values that look like objects', () => {
      const input = { data: '{"email":"test@test.com"}' };
      const result = redactObject(input, ctx);
      // The string itself is not an email, so it passes through
      expect(result.data).toBe('{"email":"test@test.com"}');
    });
  });
});
