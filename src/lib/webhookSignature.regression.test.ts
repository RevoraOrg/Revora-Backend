/**
 * @file Focused regression suite for `WEBHOOK_SIGNATURE_HEADER` failure handling.
 *
 * @notice Pins the explicit empty-result / failure branches of
 *   `src/lib/webhookSignature.ts` so that a silent behaviour change is caught in
 *   CI instead of shipping to webhook receivers (issue #1051):
 *
 *   | Evidence                                              | Branch                                     |
 *   | ----------------------------------------------------- | ------------------------------------------ |
 *   | `src/lib/webhookSignature.ts:156`                     | `extractSignatureFromHeaders` → undefined  |
 *   | `src/lib/webhookSignature.ts:214`                     | `parseExpiryTimestamp` → undefined (unset) |
 *   | `src/lib/webhookSignature.ts:221`                     | `parseExpiryTimestamp` → undefined (NaN)   |
 *   | `src/lib/webhookSignature.ts:234`                     | `parseExpiryTimestamp` → undefined (type)  |
 *
 * @dev Contract rules exercised here (all pre-existing, unchanged by this suite):
 *   - Header lookups are case-sensitive map reads. Node/Express lower-case
 *     inbound header names, so a mixed-case key in the map is an intentional
 *     miss, never a partial match.
 *   - "No header found" is `undefined`; an empty string is returned verbatim and
 *     it is the *caller* (`verifyWebhook` / `webhookAuth`) that turns falsy
 *     values into `MISSING_SIGNATURE`.
 *   - `parseExpiryTimestamp` returns `undefined` for unset, `NaN`, invalid-Date
 *     and out-of-contract inputs — and a *valid* `0`, so "epoch" and "unset"
 *     stay distinguishable.
 *   - An unparseable `nextSecretExpiry` fails **open** (the next key is treated
 *     as never-expiring). This is the current public contract and is pinned
 *     deliberately; the security impact is documented in
 *     `docs/webhook-signature-header-regression.md`.
 */

import {
  assertValidWebhookSignature,
  extractSignatureFromHeaders,
  parseExpiryTimestamp,
  signWebhookPayload,
  verifyWebhook,
  verifyWebhookPayload,
  verifyWebhookPayloadDualKey,
  WebhookSignatureError,
  WebhookVerificationConfig,
  WEBHOOK_EVENT_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
} from './webhookSignature';

// ─── Test Constants ───────────────────────────────────────────────────────────

const TEST_SECRET = 'regression-secret-key-that-is-long-enough-for-hmac-sha256';
const TEST_PAYLOAD = '{"event":"webhook.signature.regression","data":{"id":"1051"}}';

/** Header map keyed by the exported constant — mirrors what senders transmit. */
const signedHeaders = (signature: string): Record<string, string | string[] | undefined> => ({
  [WEBHOOK_SIGNATURE_HEADER]: signature,
  [WEBHOOK_TIMESTAMP_HEADER]: String(Date.now()),
  [WEBHOOK_EVENT_HEADER]: 'webhook.signature.regression',
});

// ─── WEBHOOK_SIGNATURE_HEADER wire contract ───────────────────────────────────

describe('WEBHOOK_SIGNATURE_HEADER wire contract', () => {
  it('keeps the wire header name stable and lower-case', () => {
    expect(WEBHOOK_SIGNATURE_HEADER).toBe('x-revora-signature');
    // Outbound signing (src/services/webhookService.ts) and inbound extraction
    // share this constant, and extraction performs an exact map lookup — a
    // rename or a casing change would break every receiver at once.
    expect(WEBHOOK_SIGNATURE_HEADER).toBe(WEBHOOK_SIGNATURE_HEADER.toLowerCase());
  });

  it('round-trips a signature issued under the exported header name', () => {
    const signature = signWebhookPayload(TEST_SECRET, TEST_PAYLOAD);
    const result = verifyWebhook({ secret: TEST_SECRET }, TEST_PAYLOAD, signedHeaders(signature));

    expect(result.valid).toBe(true);
    expect(result.verifiedByKey).toBe('current');
    expect(result.error).toBeUndefined();
  });
});

// ─── extractSignatureFromHeaders — empty-result path (line 156) ───────────────

describe('extractSignatureFromHeaders — empty-result path (line 156)', () => {
  it('returns undefined when no candidate header is present at all', () => {
    expect(extractSignatureFromHeaders({})).toBeUndefined();
    expect(
      extractSignatureFromHeaders({
        'content-type': 'application/json',
        'user-agent': 'revora-webhook/1.0',
      })
    ).toBeUndefined();
  });

  it('returns undefined when every candidate header is present but explicitly unset', () => {
    expect(
      extractSignatureFromHeaders({
        'x-revora-signature': undefined,
        'x-webhook-signature': undefined,
        'x-signature': undefined,
        'x-hub-signature-256': undefined,
      })
    ).toBeUndefined();
  });

  it('returns undefined for an empty array header value (boundary)', () => {
    expect(extractSignatureFromHeaders({ 'x-revora-signature': [] })).toBeUndefined();
  });

  it('returns undefined for non-string, non-array header values (boundary)', () => {
    expect(
      extractSignatureFromHeaders({ 'x-revora-signature': 12345 as unknown as string })
    ).toBeUndefined();
    expect(
      extractSignatureFromHeaders({ 'x-revora-signature': { value: 'sha256=abc' } as unknown as string })
    ).toBeUndefined();
  });

  it('returns undefined for a null header value (nullish fallback boundary)', () => {
    // `headers[name] ?? headers[name.toLowerCase()]` collapses to the same
    // nullish entry, so the candidate is skipped rather than coerced.
    expect(extractSignatureFromHeaders({ 'x-revora-signature': null as unknown as string })).toBeUndefined();
  });

  it('returns undefined for a mixed-case header key (case-sensitive lookup contract)', () => {
    // Node lower-cases inbound header names before Express exposes them, so a
    // mixed-case key documents an intentional miss (defence against mis-wired
    // callers that build header maps from raw wire input).
    expect(
      extractSignatureFromHeaders({ 'X-Revora-Signature': 'sha256=abc' } as unknown as Record<string, string>)
    ).toBeUndefined();
  });

  // ── neighbouring normal paths ──────────────────────────────────────────────

  it('returns the first non-empty candidate in priority order (normal path)', () => {
    expect(
      extractSignatureFromHeaders({
        'x-revora-signature': undefined,
        'x-webhook-signature': ['sha256=first', 'sha256=second'],
        'x-signature': 'sha256=third',
      })
    ).toBe('sha256=first');
  });

  it('returns the individual candidate correctly for every supported header name', () => {
    expect(extractSignatureFromHeaders({ 'x-revora-signature': 'sha256=a' })).toBe('sha256=a');
    expect(extractSignatureFromHeaders({ 'x-webhook-signature': 'sha256=b' })).toBe('sha256=b');
    expect(extractSignatureFromHeaders({ 'x-signature': 'sha256=c' })).toBe('sha256=c');
    expect(extractSignatureFromHeaders({ 'x-hub-signature-256': 'sha256=d' })).toBe('sha256=d');
  });

  it('returns an empty string verbatim so callers own the emptiness check', () => {
    // Boundary coupling: the helper only guarantees "a string was found".
    // `verifyWebhook` / `webhookAuth` are the layers that translate a falsy
    // value into MISSING_SIGNATURE — never this function.
    expect(extractSignatureFromHeaders({ 'x-revora-signature': '' })).toBe('');
    expect(extractSignatureFromHeaders({ 'x-revora-signature': [''] })).toBe('');
  });
});

// ─── verifyWebhook — missing WEBHOOK_SIGNATURE_HEADER contract ────────────────

describe('verifyWebhook — missing WEBHOOK_SIGNATURE_HEADER failure contract', () => {
  const baseConfig: WebhookVerificationConfig = { secret: TEST_SECRET };

  const expectMissingSignature = (
    result: ReturnType<typeof verifyWebhook>,
    expectedHeaderName: string = WEBHOOK_SIGNATURE_HEADER
  ): void => {
    expect(result.valid).toBe(false);
    expect(result.error).toBeInstanceOf(WebhookSignatureError);
    expect(result.error?.name).toBe('WebhookSignatureError');
    expect(result.error?.code).toBe('MISSING_SIGNATURE');
    expect(result.error?.message).toBe(`Missing signature header: ${expectedHeaderName}`);
    expect(result.verifiedByKey).toBeUndefined();
    expect(result.timestamp).toBeUndefined();
  };

  it('emits MISSING_SIGNATURE for empty headers', () => {
    expectMissingSignature(verifyWebhook(baseConfig, TEST_PAYLOAD, {}));
  });

  it('emits MISSING_SIGNATURE when unrelated headers are present', () => {
    expectMissingSignature(
      verifyWebhook(baseConfig, TEST_PAYLOAD, { 'content-type': 'application/json' })
    );
  });

  it('emits MISSING_SIGNATURE for an empty array header value', () => {
    expectMissingSignature(verifyWebhook(baseConfig, TEST_PAYLOAD, { 'x-revora-signature': [] }));
  });

  it('emits MISSING_SIGNATURE for an empty string header value', () => {
    expectMissingSignature(verifyWebhook(baseConfig, TEST_PAYLOAD, { 'x-revora-signature': '' }));
  });

  it('emits MISSING_SIGNATURE when the first array entry is unset', () => {
    const signature = signWebhookPayload(TEST_SECRET, TEST_PAYLOAD);
    // Only the first duplicate header value is considered — a later duplicate
    // never rescues an unusable first entry.
    expectMissingSignature(
      verifyWebhook(baseConfig, TEST_PAYLOAD, {
        'x-revora-signature': [undefined, signature] as unknown as string[],
      })
    );
  });

  it('emits MISSING_SIGNATURE when the configured header name is absent', () => {
    expectMissingSignature(
      verifyWebhook({ ...baseConfig, headerName: 'x-custom-signature' }, TEST_PAYLOAD, {}),
      'x-custom-signature'
    );
  });

  it('does not leak the shared secret in the failure payload', () => {
    const result = verifyWebhook(baseConfig, TEST_PAYLOAD, {});
    expect(result.error?.message).not.toContain(TEST_SECRET);
    expect(JSON.stringify(result.error)).not.toContain(TEST_SECRET);
  });

  // ── neighbouring normal paths ──────────────────────────────────────────────

  it('verifies when the constant header name is present (success path)', () => {
    const signature = signWebhookPayload(TEST_SECRET, TEST_PAYLOAD);
    const result = verifyWebhook(baseConfig, TEST_PAYLOAD, {
      [WEBHOOK_SIGNATURE_HEADER]: signature,
    });

    expect(result.valid).toBe(true);
    expect(result.verifiedByKey).toBe('current');
    expect(result.error).toBeUndefined();
  });

  it('falls back to the standard header when a custom header name is missing', () => {
    const signature = signWebhookPayload(TEST_SECRET, TEST_PAYLOAD);
    const result = verifyWebhook(
      { ...baseConfig, headerName: 'x-custom-signature' },
      TEST_PAYLOAD,
      { 'x-revora-signature': signature }
    );

    expect(result.valid).toBe(true);
  });

  it('accepts a mixed-case headerName config because lookup is lower-cased', () => {
    const signature = signWebhookPayload(TEST_SECRET, TEST_PAYLOAD);
    const result = verifyWebhook(
      { ...baseConfig, headerName: 'X-Revora-Signature' },
      TEST_PAYLOAD,
      { 'x-revora-signature': signature }
    );

    expect(result.valid).toBe(true);
  });

  // ── failure ordering (deterministic, pre-header checks win) ────────────────

  it('reports the oversized payload before the missing signature', () => {
    const result = verifyWebhook({ ...baseConfig, maxPayloadSize: 1 }, TEST_PAYLOAD, {});

    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe('INVALID_FORMAT');
    expect(result.error?.message).toContain('Payload exceeds maximum size');
  });

  it('reports the missing signature before the missing timestamp', () => {
    const result = verifyWebhook(
      { ...baseConfig, requireTimestamp: true },
      TEST_PAYLOAD,
      {}
    );

    expect(result.error?.code).toBe('MISSING_SIGNATURE');
  });

  it('reports the missing signature even when the payload itself is falsy', () => {
    expectMissingSignature(verifyWebhook(baseConfig, '', {}));
  });

  it('throws MISSING_SIGNATURE through assertValidWebhookSignature for undefined headers', () => {
    const extracted = extractSignatureFromHeaders({});
    expect(extracted).toBeUndefined();

    expect(() => assertValidWebhookSignature(TEST_SECRET, TEST_PAYLOAD, extracted)).toThrow(
      WebhookSignatureError
    );
    try {
      assertValidWebhookSignature(TEST_SECRET, TEST_PAYLOAD, extracted);
    } catch (error) {
      expect((error as WebhookSignatureError).code).toBe('MISSING_SIGNATURE');
    }
  });
});


// ─── parseExpiryTimestamp — explicit empty-result branches ────────────────────

describe('parseExpiryTimestamp — empty-result branches (lines 214, 218, 221, 234)', () => {
  it('returns undefined for unset expiry values (line 214)', () => {
    expect(parseExpiryTimestamp(undefined)).toBeUndefined();
    expect(parseExpiryTimestamp(null as unknown as undefined)).toBeUndefined();
    expect(parseExpiryTimestamp('')).toBeUndefined();
  });

  it('returns undefined for an invalid Date instance (line 218)', () => {
    const invalid = new Date('not-a-date');
    expect(Number.isNaN(invalid.getTime())).toBe(true);
    expect(parseExpiryTimestamp(invalid)).toBeUndefined();
  });

  it('returns undefined for a numeric NaN expiry (line 221)', () => {
    expect(parseExpiryTimestamp(NaN)).toBeUndefined();
    // Mirrors `Number(process.env.NEXT_SECRET_EXPIRY)` on a malformed config.
    expect(parseExpiryTimestamp(Number('not-a-number'))).toBeUndefined();
  });

  it('returns undefined for out-of-contract runtime types (line 234)', () => {
    expect(parseExpiryTimestamp(true as unknown as number)).toBeUndefined();
    expect(parseExpiryTimestamp({} as unknown as string)).toBeUndefined();
    expect(parseExpiryTimestamp([] as unknown as string)).toBeUndefined();
    expect(parseExpiryTimestamp((() => 1) as unknown as string)).toBeUndefined();
  });

  it('returns undefined for whitespace-only or unparseable date strings', () => {
    expect(parseExpiryTimestamp('   ')).toBeUndefined();
    expect(parseExpiryTimestamp('\n\t')).toBeUndefined();
    expect(parseExpiryTimestamp('definitely-not-a-date')).toBeUndefined();
  });

  it('preserves the non-finite number contract relied on by rotation configs', () => {
    // `isNaN(Infinity)` is false, so non-finite numbers are returned unchanged
    // (they are NOT treated as "unset"). In the dual-key flow this means an
    // infinite expiry never elapses — pinned deliberately so any future change
    // is a reviewed decision (see docs/webhook-signature-header-regression.md).
    expect(parseExpiryTimestamp(Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY);
    expect(parseExpiryTimestamp(Number.NEGATIVE_INFINITY)).toBe(Number.NEGATIVE_INFINITY);
  });
});

// ─── parseExpiryTimestamp — seconds/milliseconds boundary values ──────────────

describe('parseExpiryTimestamp — seconds/milliseconds boundary values', () => {
  /** Values strictly below this cut-off are epoch seconds, otherwise epoch ms. */
  const SECONDS_CUTOFF = 1e11;

  it('treats values strictly below the cut-off as epoch seconds', () => {
    expect(parseExpiryTimestamp(SECONDS_CUTOFF - 1)).toBe((SECONDS_CUTOFF - 1) * 1000);
    expect(parseExpiryTimestamp(String(SECONDS_CUTOFF - 1))).toBe((SECONDS_CUTOFF - 1) * 1000);
  });

  it('treats the exact cut-off as epoch milliseconds (inclusive upper branch)', () => {
    expect(parseExpiryTimestamp(SECONDS_CUTOFF)).toBe(SECONDS_CUTOFF);
    expect(parseExpiryTimestamp(String(SECONDS_CUTOFF))).toBe(SECONDS_CUTOFF);
  });

  it('keeps epoch zero distinct from "unset"', () => {
    // `0` is a valid, already-elapsed deadline — not an absent configuration.
    expect(parseExpiryTimestamp(0)).toBe(0);
    expect(parseExpiryTimestamp('0')).toBe(0);
    expect(parseExpiryTimestamp(0)).not.toBeUndefined();
  });

  it('treats negative numeric deadlines as long since expired', () => {
    // Negative values still take the epoch-seconds branch (they are < 1e11),
    // so their magnitude is scaled — they remain far in the past either way.
    expect(parseExpiryTimestamp(-1)).toBe(-1000);
    expect(parseExpiryTimestamp(-1e12)).toBe(-1e12 * 1000);
  });

  it('trims surrounding whitespace before parsing numeric strings', () => {
    expect(parseExpiryTimestamp('  1700000000000  ')).toBe(1700000000000);
    expect(parseExpiryTimestamp('\t1700000000\n')).toBe(1700000000 * 1000);
  });

  it('keeps numeric strings with trailing garbage unparseable', () => {
    // The digit-only regex is anchored, so partially numeric input must not be
    // silently truncated to a plausible-looking deadline.
    expect(parseExpiryTimestamp('1700000000seconds')).toBeUndefined();
    expect(parseExpiryTimestamp('1700000000.5')).toBeUndefined();
  });

  it('parses Date instances and ISO-8601 strings to the same epoch ms', () => {
    const iso = '2026-12-31T23:59:59.000Z';
    const expected = Date.parse(iso);
    expect(Number.isNaN(expected)).toBe(false);
    expect(parseExpiryTimestamp(iso)).toBe(expected);
    expect(parseExpiryTimestamp(new Date(iso))).toBe(expected);
  });

  it('returns the largest safe-integer millisecond timestamp unchanged', () => {
    expect(parseExpiryTimestamp(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
  });
});


// ─── verifyWebhookPayloadDualKey — malformed nextSecretExpiry coupling ────────

describe('verifyWebhookPayloadDualKey — nextSecretExpiry branch coupling', () => {
  const CURRENT_SECRET = 'rotation-current-secret';
  const NEXT_SECRET = 'rotation-next-secret';
  const PAYLOAD = '{"event":"kyc.updated","id":"1051"}';
  const nextKeySignature = (): string => signWebhookPayload(NEXT_SECRET, PAYLOAD);

  it('accepts a next-key signature when the expiry is unparseable (fail-open contract)', () => {
    // `parseExpiryTimestamp` returns undefined here, so `isExpired` stays false
    // and the rotated key keeps working. Pinned as the current contract —
    // operators must remove a retired secret explicitly.
    const result = verifyWebhookPayloadDualKey(
      { secret: CURRENT_SECRET, nextSecret: NEXT_SECRET, nextSecretExpiry: 'not-a-date' },
      PAYLOAD,
      nextKeySignature()
    );

    expect(result).toEqual({ valid: true, verifiedByKey: 'next' });
  });

  it('accepts a next-key signature when the expiry is a numeric NaN (line 221 coupling)', () => {
    const result = verifyWebhookPayloadDualKey(
      { secret: CURRENT_SECRET, nextSecret: NEXT_SECRET, nextSecretExpiry: NaN },
      PAYLOAD,
      nextKeySignature()
    );

    expect(result).toEqual({ valid: true, verifiedByKey: 'next' });
  });

  it('flags the next key as expired once the parsed deadline has passed', () => {
    const result = verifyWebhookPayloadDualKey(
      { secret: CURRENT_SECRET, nextSecret: NEXT_SECRET, nextSecretExpiry: Date.now() - 1 },
      PAYLOAD,
      nextKeySignature()
    );

    expect(result).toEqual({ valid: false, expired: true });
  });

  it('accepts a next-key signature whose deadline is in the future', () => {
    const result = verifyWebhookPayloadDualKey(
      { secret: CURRENT_SECRET, nextSecret: NEXT_SECRET, nextSecretExpiry: Date.now() + 60_000 },
      PAYLOAD,
      nextKeySignature()
    );

    expect(result).toEqual({ valid: true, verifiedByKey: 'next' });
  });

  it('returns a plain mismatch (no expired flag) when neither key matches', () => {
    const result = verifyWebhookPayloadDualKey(
      { secret: CURRENT_SECRET, nextSecret: NEXT_SECRET, nextSecretExpiry: 'not-a-date' },
      PAYLOAD,
      signWebhookPayload('unrelated-secret', PAYLOAD)
    );

    expect(result).toEqual({ valid: false });
    expect(result.expired).toBeUndefined();
  });

  it('still verifies with the current key when the next key has expired', () => {
    const result = verifyWebhookPayloadDualKey(
      { secret: CURRENT_SECRET, nextSecret: NEXT_SECRET, nextSecretExpiry: Date.now() - 1 },
      PAYLOAD,
      signWebhookPayload(CURRENT_SECRET, PAYLOAD)
    );

    expect(result).toEqual({ valid: true, verifiedByKey: 'current' });
  });

  it('treats an infinite next-key expiry as never-expiring (documented boundary)', () => {
    const result = verifyWebhookPayloadDualKey(
      {
        secret: CURRENT_SECRET,
        nextSecret: NEXT_SECRET,
        nextSecretExpiry: Number.POSITIVE_INFINITY,
      },
      PAYLOAD,
      nextKeySignature()
    );

    expect(result).toEqual({ valid: true, verifiedByKey: 'next' });
  });

  it('ignores nextSecret entirely when it is not configured', () => {
    const result = verifyWebhookPayloadDualKey(
      { secret: CURRENT_SECRET, nextSecretExpiry: 'not-a-date' },
      PAYLOAD,
      nextKeySignature()
    );

    expect(result).toEqual({ valid: false });
    expect(result.expired).toBeUndefined();
  });
});


// ─── verifyWebhookPayload — malformed signature-container boundaries ──────────

describe('verifyWebhookPayload — malformed signature-container boundaries', () => {
  it('returns false when the first array entry is not a string (line 97)', () => {
    expect(
      verifyWebhookPayload(TEST_SECRET, TEST_PAYLOAD, [12345 as unknown as string])
    ).toBe(false);
    expect(
      verifyWebhookPayload(TEST_SECRET, TEST_PAYLOAD, [] as unknown as string[])
    ).toBe(false);
  });

  it('returns false for a non-string signature value', () => {
    expect(verifyWebhookPayload(TEST_SECRET, TEST_PAYLOAD, {} as unknown as string)).toBe(false);
    expect(verifyWebhookPayload(TEST_SECRET, TEST_PAYLOAD, null as unknown as string)).toBe(false);
  });

  it('fails closed for a same-length signature with multi-byte characters (line 119)', () => {
    // `signatureStr.length` matches the expected signature, but the UTF-8 byte
    // lengths differ, so `crypto.timingSafeEqual` throws
    // ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH. The defensive catch must convert that
    // into `false` instead of surfacing an unhandled error to the caller.
    const expected = signWebhookPayload(TEST_SECRET, TEST_PAYLOAD);
    const multibyteSameLength = expected.slice(0, -1) + '\u00e9';

    expect(multibyteSameLength).toHaveLength(expected.length);
    expect(Buffer.byteLength(multibyteSameLength)).not.toBe(Buffer.byteLength(expected));
    expect(verifyWebhookPayload(TEST_SECRET, TEST_PAYLOAD, multibyteSameLength)).toBe(false);
  });
});

