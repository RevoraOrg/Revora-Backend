import {
  classifyStellarRPCFailure,
  StellarRPCFailureClass,
} from "./stellarRpcFailure";

/**
 * Regression suite for the RATE_LIMIT retry-after branch of
 * `classifyStellarRPCFailure` (see `src/lib/stellarRpcFailure.ts`).
 *
 * The named branch evidence is the empty-result path at the end of the private
 * `extractRetryAfter` helper ("return undefined;"), which is consumed by the
 * `status === 429` classifier as `extractRetryAfter(error) || 10000`.
 *
 * The contract these tests pin down:
 *   - a usable `retry-after` header is converted to **milliseconds**
 *     (`string` seconds and raw `number` seconds are both accepted), and the
 *     nested `error.response.headers` shape takes precedence over `error.headers`;
 *   - anything unusable (absent, non-numeric, empty, `0`, boolean, `null`)
 *     degrades to the documented 10 s fallback instead of leaking `undefined`
 *     or `0` to a caller that schedules the retry;
 *   - the failure is always reported as retryable RATE_LIMIT with the upstream
 *     message redacted.
 */
describe("classifyStellarRPCFailure – RATE_LIMIT retry-after contract", () => {
  const context = { operation: "submit_payment" };
  const FALLBACK_DELAY_MS = 10_000;

  function classifyRateLimit(error: unknown) {
    return classifyStellarRPCFailure(error, context);
  }

  describe("empty-result path (no usable retry-after header)", () => {
    it("falls back to 10s when the error carries no headers at all", () => {
      const result = classifyRateLimit({ status: 429 });

      expect(result.class).toBe(StellarRPCFailureClass.RATE_LIMIT);
      expect(result.shouldRetry).toBe(true);
      expect(result.suggestedRetryDelayMs).toBe(FALLBACK_DELAY_MS);
    });

    it.each([
      ["non-numeric string", "soon"],
      ["empty string", ""],
      ["whitespace string", "   "],
      ["zero seconds", 0],
      ["zero seconds as string", "0"],
      ["boolean true", true],
      ["null", null],
    ])("falls back to 10s for %s", (_label, retryAfter) => {
      const result = classifyRateLimit({ status: 429, headers: { "retry-after": retryAfter } });

      expect(result.class).toBe(StellarRPCFailureClass.RATE_LIMIT);
      expect(result.suggestedRetryDelayMs).toBe(FALLBACK_DELAY_MS);
    });

    it("falls back to 10s when headers is an empty object", () => {
      expect(classifyRateLimit({ status: 429, headers: {} }).suggestedRetryDelayMs).toBe(
        FALLBACK_DELAY_MS,
      );
    });
  });

  describe("normal path (usable retry-after header)", () => {
    it("converts a numeric-string header value from seconds to milliseconds", () => {
      const result = classifyRateLimit({ status: 429, headers: { "retry-after": "5" } });

      expect(result.class).toBe(StellarRPCFailureClass.RATE_LIMIT);
      expect(result.suggestedRetryDelayMs).toBe(5_000);
    });

    it("converts a raw numeric header value from seconds to milliseconds", () => {
      const result = classifyRateLimit({ status: 429, headers: { "retry-after": 3 } });

      expect(result.suggestedRetryDelayMs).toBe(3_000);
    });

    it("reads the nested response.headers shape used by fetch/axios errors", () => {
      const result = classifyRateLimit({
        status: 429,
        response: { headers: { "retry-after": "12" } },
      });

      expect(result.suggestedRetryDelayMs).toBe(12_000);
    });

    it("prefers response.headers over top-level headers when both are present", () => {
      const result = classifyRateLimit({
        status: 429,
        headers: { "retry-after": "60" },
        response: { headers: { "retry-after": "2" } },
      });

      expect(result.suggestedRetryDelayMs).toBe(2_000);
    });

    it("truncates fractional header values to whole seconds", () => {
      const result = classifyRateLimit({ status: 429, headers: { "retry-after": "1.9" } });

      expect(result.suggestedRetryDelayMs).toBe(1_000);
    });

    it("ignores surrounding whitespace in the header value", () => {
      const result = classifyRateLimit({ status: 429, headers: { "retry-after": " 7 " } });

      expect(result.suggestedRetryDelayMs).toBe(7_000);
    });

    it("keeps the header-derived delay regardless of the attempt count", () => {
      const result = classifyStellarRPCFailure(
        { status: 429, headers: { "retry-after": "4" } },
        { ...context, attemptCount: 2 },
      );

      expect(result.suggestedRetryDelayMs).toBe(4_000);
    });
  });

  describe("neighbouring classification paths are unaffected", () => {
    it("ignores a retry-after header on non-429 failures", () => {
      const result = classifyStellarRPCFailure(
        { status: 503, headers: { "retry-after": "9" } },
        context,
      );

      expect(result.class).toBe(StellarRPCFailureClass.UPSTREAM_ERROR);
      expect(result.shouldRetry).toBe(true);
      expect(result.suggestedRetryDelayMs).toBe(5_000);
    });

    it("lets a Horizon result-code envelope win over the 429 status", () => {
      // Documents the existing precedence: the result-code branch is evaluated
      // before the HTTP status branch, so a 429 carrying a protocol error is
      // classified as a non-retryable protocol failure.
      const result = classifyStellarRPCFailure(
        {
          status: 429,
          extras: { result_codes: { transaction: "tx_bad_seq" } },
          headers: { "retry-after": "6" },
        },
        context,
      );

      expect(result.class).toBe(StellarRPCFailureClass.TX_RESULT_CODE);
      expect(result.shouldRetry).toBe(false);
      expect(result.suggestedRetryDelayMs).toBeUndefined();
    });

    it("still redacts the upstream message on the rate-limit path", () => {
      const result = classifyRateLimit({
        status: 429,
        message: "upstream says: slow down secret-value",
        headers: { "retry-after": "1" },
      });

      expect(result.originalError).toEqual(
        expect.objectContaining({ status: 429, message: "UPSTREAM_MESSAGE_REDACTED" }),
      );
      expect(JSON.stringify(result.originalError)).not.toContain("secret-value");
    });

    it("produces a deterministic ISO-8601 timestamp", () => {
      const result = classifyRateLimit({ status: 429 });

      expect(new Date(result.timestamp).toISOString()).toBe(result.timestamp);
    });
  });
});
