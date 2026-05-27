import { Logger } from "./logger";

/**
 * @dev Stable classification for failures returned by Stellar-facing dependencies.
 * Raw upstream messages must never cross the API trust boundary.
 * 
 * **Security Assumptions:**
 * - **Error Masking**: This utility is the primary defense against internal information leakage via error messages.
 * - **Deterministic Mapping**: Every error, even if unknown, is mapped to a `StellarRPCFailureClass` to prevent raw stacks or messages from being returned to the user.
 * - **Retry Safety**: Only failures explicitly marked as `shouldRetry` (like TIMEOUT or RATE_LIMIT) should trigger automated retries.
 */
export enum StellarRPCFailureClass {
  TIMEOUT = 'TIMEOUT',
  RATE_LIMIT = 'RATE_LIMIT',
  UPSTREAM_ERROR = 'UPSTREAM_ERROR',
  MALFORMED_RESPONSE = 'MALFORMED_RESPONSE',
  UNAUTHORIZED = 'UNAUTHORIZED',
  NETWORK_ERROR = 'NETWORK_ERROR',
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  INSUFFICIENT_FUNDS = 'INSUFFICIENT_FUNDS',
  TRANSACTION_FAILED = 'TRANSACTION_FAILED',
  CONTRACT_ERROR = 'CONTRACT_ERROR',
  BAD_SEQUENCE = 'BAD_SEQUENCE',
  SIGNING_ERROR = 'SIGNING_ERROR',
  /** Transaction-level result code from Horizon (e.g. tx_bad_seq, tx_insufficient_fee). */
  TX_RESULT_CODE = "TX_RESULT_CODE",
  /** Operation-level result code from Horizon (e.g. op_no_destination, op_underfunded). */
  OP_RESULT_CODE = "OP_RESULT_CODE",
  UNKNOWN = "UNKNOWN",
}

/**
 * @dev Context information for Stellar RPC failures.
 */
export interface StellarRPCFailureContext {
  operation: string;
  attemptCount?: number;
  accountId?: string;
  transactionId?: string;
  offeringId?: string;
  periodId?: string;
  requestId?: string;
  [key: string]: unknown;
}

/**
 * @dev Structured representation of a Stellar RPC failure.
 */
export interface StellarRPCFailure {
  class: StellarRPCFailureClass;
  context: StellarRPCFailureContext;
  originalError: unknown;
  timestamp: string;
  shouldRetry: boolean;
  suggestedRetryDelayMs?: number;
}

/**
 * @dev Horizon transaction-level result codes that indicate a non-retryable
 * protocol error.  Keeping these as a const set avoids string-matching on
 * arbitrary upstream messages.
 *
 * Reference: https://developers.stellar.org/docs/data/horizon/api-reference/errors/result-codes/transactions
 */
export const STELLAR_TX_RESULT_CODES = new Set([
  "tx_failed",
  "tx_too_early",
  "tx_too_late",
  "tx_missing_operation",
  "tx_bad_seq",
  "tx_bad_auth",
  "tx_insufficient_balance",
  "tx_no_source_account",
  "tx_insufficient_fee",
  "tx_bad_auth_extra",
  "tx_internal_error",
]);

/**
 * @dev Horizon operation-level result codes.
 *
 * Reference: https://developers.stellar.org/docs/data/horizon/api-reference/errors/result-codes/operations
 */
export const STELLAR_OP_RESULT_CODES = new Set([
  "op_inner",
  "op_bad_auth",
  "op_no_account",
  "op_not_supported",
  "op_too_many_subentries",
  "op_exceeded_work_limit",
  "op_too_many_sponsoring",
  // payment-specific
  "op_no_destination",
  "op_no_trust",
  "op_not_authorized",
  "op_underfunded",
  "op_src_no_trust",
  "op_src_not_authorized",
  "op_line_full",
  "op_no_issuer",
]);

/**
 * @dev Maps arbitrary dependency failures into deterministic, client-safe buckets.
 *
 * Stellar Horizon 400 responses carry a `extras.result_codes` object with
 * `transaction` and `operations` arrays.  These are classified into
 * TX_RESULT_CODE / OP_RESULT_CODE so callers can decide retry eligibility
 * without inspecting raw upstream strings.
 */
export function classifyStellarRPCFailure(
  error: unknown,
  context: StellarRPCFailureContext = { operation: 'unknown' }
): StellarRPCFailure {
  const timestamp = new Date().toISOString();
  const logger = new Logger().child({
    component: "StellarRPCFailure",
    operation: context.operation,
  });

  logger.info("Classifying Stellar RPC failure", {
    operation: context.operation,
    attemptCount: context.attemptCount,
    errorType: error instanceof Error ? error.name : typeof error,
  });
  if (
    error instanceof Error &&
    (error.name === "AbortError" ||
      error.message.toLowerCase().includes("timeout") ||
      error.message.toLowerCase().includes("aborted"))
  ) {
    return {
      class: StellarRPCFailureClass.TIMEOUT,
      context,
      originalError: sanitizeError(error),
      timestamp,
      shouldRetry: true,
      suggestedRetryDelayMs: Math.min(
        1000 * Math.pow(2, (context.attemptCount || 1) - 1),
        30000,
      ),
    };
  }

  // Network connectivity errors
  if (
    error instanceof Error &&
    (error.name === "NetworkError" ||
      error.name === "FetchError" ||
      error.message.toLowerCase().includes("network") ||
      error.message.toLowerCase().includes("connection") ||
      error.message.toLowerCase().includes("enotfound") ||
      error.message.toLowerCase().includes("econnrefused"))
  ) {
    return {
      class: StellarRPCFailureClass.NETWORK_ERROR,
      context,
      originalError: sanitizeError(error),
      timestamp,
      shouldRetry: true,
      suggestedRetryDelayMs: Math.min(
        2000 * Math.pow(2, (context.attemptCount || 1) - 1),
        60000,
      ),
    };
  }

  // HTTP status code based classification
  if (typeof error === "object" && error !== null) {
    const err = error as Record<string, unknown>;
    const status = (err['status'] || err['statusCode'] || err['httpCode']) as number | undefined;

    // ── Stellar Horizon result-code envelope ────────────────────────────────
    // Horizon wraps protocol errors in { extras: { result_codes: { transaction, operations } } }
    const extras = err["extras"] as Record<string, unknown> | undefined;
    const resultCodes = extras?.["result_codes"] as
      | Record<string, unknown>
      | undefined;

    if (resultCodes) {
      const txCode = resultCodes["transaction"] as string | undefined;
      const opCodes = resultCodes["operations"] as string[] | undefined;

      // Operation-level codes take precedence for actionability
      if (Array.isArray(opCodes) && opCodes.some((c) => STELLAR_OP_RESULT_CODES.has(c))) {
        return {
          class: StellarRPCFailureClass.OP_RESULT_CODE,
          context,
          originalError: sanitizeError(error),
          timestamp,
          shouldRetry: false, // Protocol errors usually shouldn't be retried
        };
      }
      if (typeof txCode === 'string' && STELLAR_TX_RESULT_CODES.has(txCode)) {
        return {
          class: StellarRPCFailureClass.TX_RESULT_CODE,
          context,
          originalError: sanitizeError(error),
          timestamp,
          shouldRetry: false, // Protocol errors usually shouldn't be retried
        };
      }
    }

    // ── HTTP status codes ───────────────────────────────────────────────────
    if (status === 429) {
      return {
        class: StellarRPCFailureClass.RATE_LIMIT,
        context,
        originalError: sanitizeError(error),
        timestamp,
        shouldRetry: true,
        suggestedRetryDelayMs: extractRetryAfter(error) || 10000,
      };
    }
    if (status === 401 || status === 403) {
      return {
        class: StellarRPCFailureClass.UNAUTHORIZED,
        context,
        originalError: sanitizeError(error),
        timestamp,
        shouldRetry: false,
      };
    }
    if (typeof status === 'number' && status >= 500) {
      return {
        class: StellarRPCFailureClass.UPSTREAM_ERROR,
        context,
        originalError: sanitizeError(error),
        timestamp,
        shouldRetry: true,
        suggestedRetryDelayMs: 5000,
      };
    }
  }

  // Stellar-specific transaction errors with enhanced detection
  if (typeof error === "object" && error !== null) {
    const errObj = error as any;

    // Soroban contract errors with better detection
    if (
      errObj.code === "CONTRACT_ERROR" ||
      errObj.message?.toLowerCase().includes("contract") ||
      errObj.result_xdr?.includes("contract") ||
      errObj.error?.includes("contract") ||
      errObj.details?.includes("contract")
    ) {
      return {
        class: StellarRPCFailureClass.CONTRACT_ERROR,
        context,
        originalError: sanitizeError(error),
        timestamp,
        shouldRetry: false,
      };
    }

    // Transaction failure codes with comprehensive detection
    if (
      errObj.code === "TRANSACTION_FAILED" ||
      errObj.result_xdr?.includes("tx_failed") ||
      errObj.message?.toLowerCase().includes("transaction failed") ||
      errObj.message?.toLowerCase().includes("tx_failed") ||
      errObj.status === "ERROR" ||
      errObj.result?.operation_results?.some(
        (result: any) => result.tr?.type === "tx_failed",
      )
    ) {
      return {
        class: StellarRPCFailureClass.TRANSACTION_FAILED,
        context,
        originalError: sanitizeError(error),
        timestamp,
        shouldRetry: false,
      };
    }

    // Insufficient funds with enhanced detection
    if (
      errObj.code === "INSUFFICIENT_FUNDS" ||
      errObj.message?.toLowerCase().includes("insufficient") ||
      errObj.result_xdr?.includes("insufficient") ||
      errObj.message?.toLowerCase().includes("no trustline") ||
      errObj.message?.toLowerCase().includes("underfunded")
    ) {
      return {
        class: StellarRPCFailureClass.INSUFFICIENT_FUNDS,
        context,
        originalError: sanitizeError(error),
        timestamp,
        shouldRetry: false,
      };
    }

    // Bad sequence number with enhanced detection
    if (
      errObj.code === "BAD_SEQUENCE" ||
      errObj.message?.toLowerCase().includes("sequence") ||
      errObj.result_xdr?.includes("bad_seq") ||
      errObj.message?.toLowerCase().includes("bad sequence") ||
      errObj.message?.toLowerCase().includes("sequence number")
    ) {
      return {
        class: StellarRPCFailureClass.BAD_SEQUENCE,
        context,
        originalError: sanitizeError(error),
        timestamp,
        shouldRetry: true,
        suggestedRetryDelayMs: 1000,
      };
    }

    // Signing errors with enhanced detection
    if (
      errObj.code === "SIGNING_ERROR" ||
      errObj.message?.toLowerCase().includes("signature") ||
      errObj.message?.toLowerCase().includes("signing") ||
      errObj.message?.toLowerCase().includes("invalid signature") ||
      errObj.message?.toLowerCase().includes("signature verification failed")
    ) {
      return {
        class: StellarRPCFailureClass.SIGNING_ERROR,
        context,
        originalError: sanitizeError(error),
        timestamp,
        shouldRetry: false,
      };
    }
  }

  // JSON parsing errors
  if (error instanceof SyntaxError) {
    return {
      class: StellarRPCFailureClass.MALFORMED_RESPONSE,
      context,
      originalError: sanitizeError(error),
      timestamp,
      shouldRetry: true,
      suggestedRetryDelayMs: 1000,
    };
  }

  // Default unknown error with enhanced retry logic
  const isRetryable =
    context.attemptCount === undefined || context.attemptCount < 3;
  return {
    class: StellarRPCFailureClass.UNKNOWN,
    context,
    originalError: sanitizeError(error),
    timestamp,
    shouldRetry: isRetryable,
    suggestedRetryDelayMs: Math.min(
      5000 * Math.pow(2, (context.attemptCount || 1) - 1),
      30000,
    ),
  };
}

/**
 * @dev Sanitizes error objects to prevent sensitive data leakage.
 */
function sanitizeError(error: unknown): unknown {
  const redactedMessage = "UPSTREAM_MESSAGE_REDACTED";

  if (error instanceof Error) {
    return {
      name: error.name,
      message: redactedMessage,
    };
  }

  if (typeof error === "object" && error !== null) {
    const sanitized: Record<string, unknown> = {};
    const allowedKeys = [
      "status",
      "statusText",
      "code",
      "result_xdr",
    ];

    for (const key of allowedKeys) {
      if (key in error) {
        sanitized[key] = (error as Record<string, unknown>)[key];
      }
    }

    if ("message" in error) {
      // Preserve shape for diagnostics without disclosing upstream text.
      sanitized.message = redactedMessage;
    }

    return sanitized;
  }

  return { message: redactedMessage };
}

/**
 * @dev Extracts retry-after header value from error response.
 */
function extractRetryAfter(error: any): number | undefined {
  const retryAfter =
    error?.response?.headers?.["retry-after"] ||
    error?.headers?.["retry-after"];

  if (typeof retryAfter === "string") {
    const parsed = parseInt(retryAfter, 10);
    return isNaN(parsed) ? undefined : parsed * 1000; // Convert to milliseconds
  }

  if (typeof retryAfter === "number") {
    return retryAfter * 1000;
  }

  return undefined;
}

/**
 * @dev Determines if a Stellar RPC failure should be retried based on classification and attempt count.
 * Enhanced with better logic for different failure types and edge cases.
 */
export function shouldRetryStellarRPCFailure(
  failure: StellarRPCFailure,
  maxAttempts: number = 3,
): boolean {
  const currentAttempt = failure.context.attemptCount || 1;

  // Don't retry if we've exceeded max attempts
  if (currentAttempt >= maxAttempts) {
    return false;
  }

  // Don't retry certain failure classes that are inherently non-retryable
  const nonRetryableClasses = new Set([
    StellarRPCFailureClass.VALIDATION_ERROR,
    StellarRPCFailureClass.UNAUTHORIZED,
    StellarRPCFailureClass.INSUFFICIENT_FUNDS,
    StellarRPCFailureClass.TRANSACTION_FAILED,
    StellarRPCFailureClass.CONTRACT_ERROR,
    StellarRPCFailureClass.SIGNING_ERROR,
  ]);

  if (nonRetryableClasses.has(failure.class)) {
    return false;
  }

  // Use the failure's shouldRetry flag as the primary indicator
  return failure.shouldRetry;
}

/**
 * @dev Creates a standardized error response for Stellar RPC failures.
 */
export function createStellarErrorResponse(
  failure: StellarRPCFailure,
  requestId?: string,
): {
  code: string;
  message: string;
  details: {
    operation: string;
    retryable: boolean;
    retryDelayMs?: number;
    failureClass: string;
  };
  requestId?: string;
} {
  const messages: Record<string, string> = {
    [StellarRPCFailureClass.TIMEOUT]: "Stellar network request timed out",
    [StellarRPCFailureClass.RATE_LIMIT]: "Stellar network rate limit exceeded",
    [StellarRPCFailureClass.UPSTREAM_ERROR]:
      "Stellar network temporarily unavailable",
    [StellarRPCFailureClass.MALFORMED_RESPONSE]:
      "Invalid response from Stellar network",
    [StellarRPCFailureClass.UNAUTHORIZED]:
      "Authentication with Stellar network failed",
    [StellarRPCFailureClass.NETWORK_ERROR]:
      "Network connection to Stellar failed",
    [StellarRPCFailureClass.VALIDATION_ERROR]:
      "Invalid Stellar transaction data",
    [StellarRPCFailureClass.INSUFFICIENT_FUNDS]:
      "Insufficient funds for Stellar transaction",
    [StellarRPCFailureClass.TRANSACTION_FAILED]: "Stellar transaction failed",
    [StellarRPCFailureClass.CONTRACT_ERROR]:
      "Soroban contract execution failed",
    [StellarRPCFailureClass.BAD_SEQUENCE]: "Stellar sequence number invalid",
    [StellarRPCFailureClass.SIGNING_ERROR]:
      "Stellar transaction signing failed",
    [StellarRPCFailureClass.TX_RESULT_CODE]:
      "Stellar transaction protocol error",
    [StellarRPCFailureClass.OP_RESULT_CODE]: "Stellar operation protocol error",
    [StellarRPCFailureClass.UNKNOWN]: "Unknown Stellar network error",
  };

  return {
    code: `STELLAR_${failure.class}`,
    message:
      messages[failure.class] || messages[StellarRPCFailureClass.UNKNOWN],
    details: {
      operation: failure.context.operation,
      retryable: failure.shouldRetry,
      retryDelayMs: failure.suggestedRetryDelayMs,
      failureClass: failure.class,
    },
    requestId,
  };
}

/**
 * @dev Returns true for failure classes that are safe to retry (transient).
 * TX_RESULT_CODE and OP_RESULT_CODE are protocol errors — retrying them
 * without fixing the transaction will always fail.
 */
export function isStellarRPCRetryable(cls: StellarRPCFailureClass): boolean {
  return (
    cls === StellarRPCFailureClass.TIMEOUT ||
    cls === StellarRPCFailureClass.UPSTREAM_ERROR
  );
}
