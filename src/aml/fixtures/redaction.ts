/**
 * Redaction rules for KYC/AML provider fixture recording.
 *
 * Ensures no PII (Personally Identifiable Information) leaks into test
 * fixtures. Every value traversed by `redactObject` is checked against
 * these rules and replaced with deterministic placeholders.
 *
 * Design principles:
 * - Rules are applied recursively to nested objects and arrays.
 * - A rule returning `undefined` means "leave unchanged".
 * - Redacted values are deterministic so fixtures remain stable across runs.
 * - The same PII key is always replaced with the same placeholder value
 *   (within a single `RedactionContext`).
 */

// ── Types ────────────────────────────────────────────────────────────────────

export type RedactionRule = (
  key: string,
  value: unknown,
  path: string,
) => unknown | undefined;

export interface RedactionContext {
  /** Map of original → redacted values for stable placeholders. */
  privateValues: Map<string, string>;
  /** Counter per placeholder prefix for deterministic suffixes. */
  counters: Map<string, number>;
}

export interface RedactionOptions {
  /** Additional custom rules applied before built-in rules. */
  customRules?: RedactionRule[];
}

// ── Built-in rules ───────────────────────────────────────────────────────────

const EMAIL_RE = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
const PHONE_RE = /^\+?[1-9]\d{1,14}$/;
const SSN_RE = /^\d{3}-?\d{2}-?\d{4}$/;
const EIN_RE = /^\d{2}-?\d{7}$/;
const IP_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
const SSN4_RE = /^\d{4}$/;

/**
 * Keys that are PII-sensitive by name, regardless of value format.
 */
const PII_KEY_PATTERNS = [
  /email/i,
  /phone/i,
  /address/i,
  /ssn/i,
  /social.?security/i,
  /passport/i,
  /driver.?license/i,
  /birth/i,
  /dob/i,
  /date.?of.?birth/i,
  /first.?name/i,
  /last.?name/i,
  /full.?name/i,
  /legal.?name/i,
  /ip.?address/i,
  /ip_addr/i,
  /national.?id/i,
  /tax.?id/i,
  /ein/i,
  /bank.?account/i,
  /routing.?number/i,
  /credit.?card/i,
  /card.?number/i,
  /cvv/i,
  /pin/i,
  /password/i,
  /secret/i,
  /token/i,
  /api.?key/i,
  /auth.?key/i,
  /private.?key/i,
  /beneficiary/i,
  /mother.?s?.?maiden/i,
];

function matchesPIIKey(key: string): boolean {
  return PII_KEY_PATTERNS.some((pattern) => pattern.test(key));
}

function generatePlaceholder(
  ctx: RedactionContext,
  prefix: string,
  original: string,
): string {
  const cached = ctx.privateValues.get(original);
  if (cached) return cached;

  const count = ctx.counters.get(prefix) ?? 0;
  ctx.counters.set(prefix, count + 1);
  const placeholder = `[REDACTED_${prefix}_${String(count).padStart(4, '0')}]`;
  ctx.privateValues.set(original, placeholder);
  return placeholder;
}

// ── Core redaction engine ────────────────────────────────────────────────────

const BUILTIN_RULES: RedactionRule[] = [
  // Email
  (_key, value) => {
    if (typeof value === 'string' && EMAIL_RE.test(value)) {
      return '__EMAIL__';
    }
    return undefined;
  },
  // Phone
  (_key, value) => {
    if (typeof value === 'string' && PHONE_RE.test(value)) {
      return '__PHONE__';
    }
    return undefined;
  },
  // SSN
  (_key, value) => {
    if (typeof value === 'string' && SSN_RE.test(value)) {
      return '__SSN__';
    }
    return undefined;
  },
  // SSN last-4
  (key, value) => {
    if (typeof value === 'string' && SSN4_RE.test(value) && /ssn|last.?4/i.test(key)) {
      return '__SSN4__';
    }
    return undefined;
  },
  // EIN
  (_key, value) => {
    if (typeof value === 'string' && EIN_RE.test(value)) {
      return '__EIN__';
    }
    return undefined;
  },
  // IP address
  (_key, value) => {
    if (typeof value === 'string' && IP_RE.test(value)) {
      return '__IP__';
    }
    return undefined;
  },
  // PII key pattern match
  (key, value) => {
    if (matchesPIIKey(key) && typeof value === 'string' && value.length > 0) {
      return `__REDACTED_${key.toUpperCase()}__`;
    }
    return undefined;
  },
];

/**
 * Create a fresh redaction context.
 */
export function createRedactionContext(): RedactionContext {
  return {
    privateValues: new Map(),
    counters: new Map(),
  };
}

/**
 * Redact a single value using the provided rules.
 *
 * Returns the redacted value, or the original if no rule matched.
 */
export function redactValue(
  value: unknown,
  key: string,
  path: string,
  ctx: RedactionContext,
  options: RedactionOptions = {},
): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;

  // Try custom rules first
  if (options.customRules) {
    for (const rule of options.customRules) {
      const result = rule(key, value, path);
      if (result !== undefined) return result;
    }
  }

  // Try built-in rules
  for (const rule of BUILTIN_RULES) {
    const result = rule(key, value, path);
    if (result !== undefined) return result;
  }

  return value;
}

/**
 * Deep-redact an object, traversing all nested structures.
 */
export function redactObject<T>(
  obj: T,
  ctx: RedactionContext,
  options: RedactionOptions = {},
  path = '$',
): T {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== 'object') {
    return redactValue(obj, '', path, ctx, options) as T;
  }

  if (Array.isArray(obj)) {
    return obj.map((item, i) =>
      redactObject(item, ctx, options, `${path}[${i}]`),
    ) as T;
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const currentPath = `${path}.${key}`;

    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      result[key] = redactObject(value, ctx, options, currentPath);
    } else if (Array.isArray(value)) {
      result[key] = redactObject(value, ctx, options, currentPath);
    } else {
      result[key] = redactValue(value, key, currentPath, ctx, options);
    }
  }

  return result as T;
}
