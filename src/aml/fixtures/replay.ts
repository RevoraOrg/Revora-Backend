/**
 * Fixture replay helpers for KYC/AML provider adapters.
 *
 * Complements `recorder.ts`: the recorder *captures* redacted traces during
 * a live run, this module *replays* those traces in CI and asserts the
 * replayed data is safe to commit.
 *
 * Test-only utility — must never be imported into production code paths.
 *
 * Security:
 * - `findPiiLeaks` scans serialized fixture content for values that look
 *   like live PII or credentials. Any hit is a build failure, not a warning.
 * - Detection is deliberately layered: format-based regexes catch values
 *   under innocuous keys, and key-name heuristics catch PII parked under
 *   unexpected keys. Either layer alone is insufficient.
 */

import * as path from 'path';
import { loadFixtures, FixtureFile, RecordedInteraction } from './recorder';

// ── Fixture discovery ─────────────────────────────────────────────────────────

/** Absolute path to the checked-in provider fixture directory. */
export const FIXTURE_DIR = path.join(__dirname, 'providers');

/** Provider identifiers with a checked-in fixture file. */
export const RECORDED_PROVIDERS: readonly string[] = [
  'example_kyc',
  'jumio',
  'sumsub',
] as const;

// ── Replay ────────────────────────────────────────────────────────────────────

/**
 * Load a provider's recorded fixture file for replay.
 *
 * Throws if no fixture exists, so a misconfigured provider name fails loudly
 * rather than silently skipping coverage.
 */
export async function replayProvider(
  provider: string,
  fixtureDir: string = FIXTURE_DIR,
): Promise<FixtureFile> {
  return loadFixtures(fixtureDir, provider);
}

/**
 * Replay a provider fixture as an ordered list of interactions.
 *
 * Order is preserved from the file: adapter tests frequently assert on
 * request sequencing (e.g. create-applicant then run-check).
 */
export function replayInteractions(
  fixture: FixtureFile,
): RecordedInteraction[] {
  return fixture.interactions;
}

/**
 * Look up a single interaction by its recorded label.
 */
export function interactionByLabel(
  fixture: FixtureFile,
  label: string,
): RecordedInteraction | undefined {
  return fixture.interactions.find((i) => i.label === label);
}

// ── PII leak detection ────────────────────────────────────────────────────────

/** Value shapes that indicate a raw (un-redacted) PII value. */
const LEAKY_VALUE_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: 'email', re: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/ },
  { name: 'ssn', re: /\b\d{3}-?\d{2}-?\d{4}\b/ },
  { name: 'ein', re: /\b\d{2}-?\d{7}\b/ },
  { name: 'ipv4', re: /\b(?:\d{1,3}\.){3}\d{1,3}\b/ },
  { name: 'e164-phone', re: /\+\d{9,15}\b/ },
  { name: 'bearer-token', re: /\bBearer\s+[A-Za-z0-9._-]{8,}/i },
  { name: 'pem-private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
];

/** Key names whose values must always be a redaction placeholder. */
const PII_KEY_PATTERNS: readonly RegExp[] = [
  /email/i,
  /phone/i,
  /address/i,
  /ssn/i,
  /social.?security/i,
  /passport/i,
  /driver.?license/i,
  /date.?of.?birth/i,
  /\bdob\b/i,
  /birth/i,
  /first.?name/i,
  /last.?name/i,
  /full.?name/i,
  /legal.?name/i,
  /national.?id/i,
  /tax.?id/i,
  /bank.?account/i,
  /routing.?number/i,
  /credit.?card/i,
  /card.?number/i,
  /\bcvv\b/i,
  /password/i,
  /secret/i,
  /\btoken\b/i,
  /api.?key/i,
  /auth/i,
  /private.?key/i,
  /ip.?address/i,
];

/** A value is safe if it is a placeholder the redactor emits, or inert data. */
const SAFE_PLACEHOLDER_PATTERNS: readonly RegExp[] = [
  /^__[A-Z0-9_]*__$/,
  /^\[REDACTED_[A-Z0-9_]*\]$/,
];

function isSafePlaceholder(value: string): boolean {
  return SAFE_PLACEHOLDER_PATTERNS.some((re) => re.test(value));
}

/** Inert values that are never PII regardless of the key they sit under. */
const INERT_VALUES: ReadonlySet<string> = new Set([
  '',
  'pass',
  'clear',
  'verified',
  'passed',
  'passport',
  'passport_front',
  'passport_back',
  'drivers_license',
  'on',
  'off',
  'in',
  'onfido',
  'sumsub',
  'jumio',
]);

/** Country codes / short enums used as non-identifying response data. */
const SHORT_ENUM_RE = /^[A-Z]{2,3}$/;

function isInert(value: string): boolean {
  return INERT_VALUES.has(value) || SHORT_ENUM_RE.test(value);
}

/**
 * Keys that name a status/enum rather than a data field.
 *
 * Without this, a response key like `address_verification` or `token_status`
 * trips the PII key heuristic on a value such as `"inconclusive"`. These
 * carry check outcomes, never the sensitive value itself.
 */
const METADATA_KEY_RE =
  /(?:_|-)(?:verification|check|checks|status|result|outcome|reason|category|type|attempt|attempts|flagged|matched|count|code|message)$/i;

function isMetadataKey(key: string): boolean {
  return METADATA_KEY_RE.test(key);
}

function scanString(value: string, where: string, out: string[]): void {
  for (const { name, re } of LEAKY_VALUE_PATTERNS) {
    if (re.test(value)) {
      out.push(`${where}: raw ${name} value survived redaction (${truncate(value)})`);
    }
  }
}

function truncate(value: string): string {
  return value.length > 24 ? `${value.slice(0, 24)}…` : value;
}

function walk(
  node: unknown,
  where: string,
  out: string[],
): void {
  if (node === null || node === undefined) return;

  if (typeof node === 'string') {
    scanString(node, where, out);
    return;
  }

  // Numbers/booleans cannot carry PII in a form we redact.
  if (typeof node === 'number' || typeof node === 'boolean') return;

  if (Array.isArray(node)) {
    node.forEach((item, i) => walk(item, `${where}[${i}]`, out));
    return;
  }

  if (typeof node !== 'object') return;

  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    const childWhere = `${where}.${key}`;

    // Key-name heuristic: sensitive key must hold a placeholder or inert value.
    if (PII_KEY_PATTERNS.some((re) => re.test(key)) && !isMetadataKey(key)) {
      if (typeof value === 'string' && !isInert(value) && !isSafePlaceholder(value)) {
        out.push(
          `${childWhere}: sensitive key holds a non-placeholder value (${truncate(value)})`,
        );
      }
    }

    walk(value, childWhere, out);
  }
}

/**
 * Scan a fixture file for PII or credentials that should have been redacted.
 *
 * Returns a list of human-readable leak descriptions. An empty array means the
 * fixture is safe to commit.
 */
export function findPiiLeaks(fixture: FixtureFile): string[] {
  const leaks: string[] = [];

  walk(
    {
      provider: fixture.provider,
      interactions: fixture.interactions,
    },
    '$.fixture',
    leaks,
  );

  return leaks;
}

/**
 * Throwing variant of {@link findPiiLeaks}, for use in test assertions.
 */
export function assertNoPiiLeaks(fixture: FixtureFile): void {
  const leaks = findPiiLeaks(fixture);
  if (leaks.length > 0) {
    throw new Error(
      `Fixture "${fixture.provider}" leaks PII:\n  - ${leaks.join('\n  - ')}`,
    );
  }
}
