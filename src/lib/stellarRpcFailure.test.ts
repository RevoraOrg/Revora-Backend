import {
  classifyStellarRPCFailure,
  createStellarErrorResponse,
  isStellarRPCRetryable,
  shouldRetryStellarRPCFailure,
  StellarRPCFailureClass,
} from "./stellarRpcFailure";

describe("classifyStellarRPCFailure", () => {
  const context = { operation: "submit_payment" };

  function expectRedactedMessage(result: ReturnType<typeof classifyStellarRPCFailure>) {
    expect(result.originalError).toEqual(
      expect.objectContaining({ message: "UPSTREAM_MESSAGE_REDACTED" }),
    );
    expect(JSON.stringify(result.originalError)).not.toContain("secret");
    expect(JSON.stringify(result.originalError)).not.toContain("tx_bad_seq");
    expect(JSON.stringify(result.originalError)).not.toContain("op_underfunded");
  }

  it("classifies Horizon transaction result codes as TX_RESULT_CODE", () => {
    const fixture = {
      status: 400,
      message: "secret upstream message tx_bad_seq",
      extras: {
        result_codes: {
          transaction: "tx_bad_seq",
        },
      },
    };

    const result = classifyStellarRPCFailure(fixture, context);

    expect(result.class).toBe(StellarRPCFailureClass.TX_RESULT_CODE);
    expect(result.shouldRetry).toBe(false);
    expect(result.originalError).toEqual({
      status: 400,
      message: "UPSTREAM_MESSAGE_REDACTED",
    });
  });

  it("classifies tx_insufficient_fee as non-retryable TX_RESULT_CODE", () => {
    const result = classifyStellarRPCFailure(
      {
        status: 400,
        message: "upstream says tx_insufficient_fee",
        extras: {
          result_codes: {
            transaction: "tx_insufficient_fee",
            operations: [],
          },
        },
      },
      context,
    );

    expect(result.class).toBe(StellarRPCFailureClass.TX_RESULT_CODE);
    expect(result.shouldRetry).toBe(false);
    expectRedactedMessage(result);
  });

  it("classifies Horizon operation result codes as OP_RESULT_CODE", () => {
    const result = classifyStellarRPCFailure(
      {
        status: 400,
        message: "upstream says op_no_destination",
        extras: {
          result_codes: {
            transaction: "tx_failed",
            operations: ["op_no_destination"],
          },
        },
      },
      context,
    );

    expect(result.class).toBe(StellarRPCFailureClass.OP_RESULT_CODE);
    expect(result.shouldRetry).toBe(false);
    expectRedactedMessage(result);
  });

  it("classifies op_underfunded as non-retryable OP_RESULT_CODE", () => {
    const result = classifyStellarRPCFailure(
      {
        status: 400,
        code: "HORIZON_PROTOCOL_ERROR",
        message: "upstream says op_underfunded",
        extras: {
          result_codes: {
            transaction: "tx_failed",
            operations: ["op_underfunded"],
          },
        },
      },
      context,
    );

    expect(result.class).toBe(StellarRPCFailureClass.OP_RESULT_CODE);
    expect(result.shouldRetry).toBe(false);
    expectRedactedMessage(result);
  });

  it("prefers operation result codes over transaction result codes when both are present", () => {
    const result = classifyStellarRPCFailure(
      {
        status: 400,
        extras: {
          result_codes: {
            transaction: "tx_bad_seq",
            operations: ["op_no_destination"],
          },
        },
      },
      context,
    );

    expect(result.class).toBe(StellarRPCFailureClass.OP_RESULT_CODE);
    expect(result.shouldRetry).toBe(false);
  });

  it("falls back to TX_RESULT_CODE when operations contains no known codes", () => {
    const result = classifyStellarRPCFailure(
      {
        status: 400,
        extras: {
          result_codes: {
            transaction: "tx_bad_seq",
            operations: ["op_success"],
          },
        },
      },
      context,
    );

    expect(result.class).toBe(StellarRPCFailureClass.TX_RESULT_CODE);
    expect(result.shouldRetry).toBe(false);
  });

  it("falls back to UNKNOWN for unrecognized result-code shapes", () => {
    const result = classifyStellarRPCFailure(
      {
        status: 400,
        message: "future horizon error",
        extras: {
          result_codes: {
            transaction: "tx_future_code",
            operations: ["op_future_code"],
          },
        },
      },
      context,
    );

    expect(result.class).toBe(StellarRPCFailureClass.UNKNOWN);
    expect(result.shouldRetry).toBe(true);
    expectRedactedMessage(result);
  });

  it("falls back to UNKNOWN when result codes are nested in an unsupported shape", () => {
    const result = classifyStellarRPCFailure(
      {
        response: {
          data: {
            extras: {
              result_codes: {
                transaction: "tx_bad_seq",
              },
            },
          },
        },
      },
      context,
    );

    expect(result.class).toBe(StellarRPCFailureClass.UNKNOWN);
    expect(result.shouldRetry).toBe(true);
  });

  it("handles missing extras, non-Error objects, null, and undefined safely", () => {
    expect(classifyStellarRPCFailure({ status: 400 }, context).class).toBe(
      StellarRPCFailureClass.UNKNOWN,
    );
    expect(classifyStellarRPCFailure({ foo: "bar" }, context).class).toBe(
      StellarRPCFailureClass.UNKNOWN,
    );
    expect(classifyStellarRPCFailure(null, context).class).toBe(
      StellarRPCFailureClass.UNKNOWN,
    );
    expect(classifyStellarRPCFailure(undefined, context).class).toBe(
      StellarRPCFailureClass.UNKNOWN,
    );
  });

  it("classifies timeout, network, http, malformed, and domain-specific branches", () => {
    expect(
      classifyStellarRPCFailure(new Error("upstream timeout while reading horizon"), context).class,
    ).toBe(StellarRPCFailureClass.TIMEOUT);
    expect(
      classifyStellarRPCFailure(new Error("network connection reset by peer"), context).class,
    ).toBe(StellarRPCFailureClass.NETWORK_ERROR);
    expect(classifyStellarRPCFailure({ status: 429 }, context).class).toBe(
      StellarRPCFailureClass.RATE_LIMIT,
    );
    expect(classifyStellarRPCFailure({ status: 401 }, context).class).toBe(
      StellarRPCFailureClass.UNAUTHORIZED,
    );
    expect(classifyStellarRPCFailure({ status: 503 }, context).class).toBe(
      StellarRPCFailureClass.UPSTREAM_ERROR,
    );
    expect(classifyStellarRPCFailure(new SyntaxError("bad json"), context).class).toBe(
      StellarRPCFailureClass.MALFORMED_RESPONSE,
    );
    expect(
      classifyStellarRPCFailure({ code: "CONTRACT_ERROR", message: "secret contract failure" }, context)
        .class,
    ).toBe(StellarRPCFailureClass.CONTRACT_ERROR);
    expect(
      classifyStellarRPCFailure({ code: "TRANSACTION_FAILED" }, context).class,
    ).toBe(StellarRPCFailureClass.TRANSACTION_FAILED);
    expect(
      classifyStellarRPCFailure({ code: "INSUFFICIENT_FUNDS" }, context).class,
    ).toBe(StellarRPCFailureClass.INSUFFICIENT_FUNDS);
    expect(classifyStellarRPCFailure({ code: "BAD_SEQUENCE" }, context).class).toBe(
      StellarRPCFailureClass.BAD_SEQUENCE,
    );
    expect(classifyStellarRPCFailure({ code: "SIGNING_ERROR" }, context).class).toBe(
      StellarRPCFailureClass.SIGNING_ERROR,
    );
  });

  it("redacts raw upstream messages for Error instances and primitive inputs", () => {
    const errorResult = classifyStellarRPCFailure(
      new Error("Sensitive data: password=secret123"),
      context,
    );
    const stringResult = classifyStellarRPCFailure("super secret upstream text", context);

    expect(errorResult.originalError).toEqual({
      name: "Error",
      message: "UPSTREAM_MESSAGE_REDACTED",
    });
    expect(stringResult.originalError).toEqual({
      message: "UPSTREAM_MESSAGE_REDACTED",
    });
  });

  it("increases retry delay with attempt count for timeouts", () => {
    const attemptOne = classifyStellarRPCFailure(new Error("timeout"), {
      ...context,
      attemptCount: 1,
    });
    const attemptTwo = classifyStellarRPCFailure(new Error("timeout"), {
      ...context,
      attemptCount: 2,
    });

    expect(attemptOne.suggestedRetryDelayMs).toBe(1000);
    expect(attemptTwo.suggestedRetryDelayMs).toBe(2000);
  });
});

describe("shouldRetryStellarRPCFailure", () => {
  const timestamp = new Date().toISOString();

  it("returns false for protocol and explicit non-retryable failures", () => {
    expect(
      shouldRetryStellarRPCFailure({
        class: StellarRPCFailureClass.TX_RESULT_CODE,
        context: { operation: "submit_payment", attemptCount: 1 },
        originalError: {},
        timestamp,
        shouldRetry: false,
      }),
    ).toBe(false);

    expect(
      shouldRetryStellarRPCFailure({
        class: StellarRPCFailureClass.OP_RESULT_CODE,
        context: { operation: "submit_payment", attemptCount: 1 },
        originalError: {},
        timestamp,
        shouldRetry: false,
      }),
    ).toBe(false);

    expect(
      shouldRetryStellarRPCFailure({
        class: StellarRPCFailureClass.SIGNING_ERROR,
        context: { operation: "submit_payment", attemptCount: 1 },
        originalError: {},
        timestamp,
        shouldRetry: false,
      }),
    ).toBe(false);
  });

  it("returns false when the max attempt budget is exhausted", () => {
    expect(
      shouldRetryStellarRPCFailure({
        class: StellarRPCFailureClass.TIMEOUT,
        context: { operation: "submit_payment", attemptCount: 5 },
        originalError: {},
        timestamp,
        shouldRetry: true,
      }, 3),
    ).toBe(false);
  });
});

describe("createStellarErrorResponse", () => {
  it("returns safe protocol messages for tx and op result-code failures", () => {
    expect(
      createStellarErrorResponse({
        class: StellarRPCFailureClass.TX_RESULT_CODE,
        context: { operation: "submit_payment" },
        originalError: {},
        timestamp: new Date().toISOString(),
        shouldRetry: false,
      }).message,
    ).toBe("Stellar transaction protocol error");

    expect(
      createStellarErrorResponse({
        class: StellarRPCFailureClass.OP_RESULT_CODE,
        context: { operation: "submit_payment" },
        originalError: {},
        timestamp: new Date().toISOString(),
        shouldRetry: false,
      }).message,
    ).toBe("Stellar operation protocol error");
  });
});

describe("isStellarRPCRetryable", () => {
  it("marks protocol result codes as non-retryable", () => {
    expect(isStellarRPCRetryable(StellarRPCFailureClass.TX_RESULT_CODE)).toBe(false);
    expect(isStellarRPCRetryable(StellarRPCFailureClass.OP_RESULT_CODE)).toBe(false);
  });
});
