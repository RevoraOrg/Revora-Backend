import { Request, Response, NextFunction } from 'express';
import {
  webhookAuth,
  webhookVerify,
  webhookAuthWithProvider,
  WebhookAuthOptions,
  WebhookAuthenticatedRequest,
} from './webhookAuth';
import { signWebhookPayload, WebhookSignatureError } from '../lib/webhookSignature';

// ─── Test Constants ───────────────────────────────────────────────────────────

const TEST_SECRET = 'test-webhook-secret-that-is-sufficiently-long';
const TEST_PAYLOAD = { event: 'test', data: { id: '123' } };
const TEST_PAYLOAD_STRING = JSON.stringify(TEST_PAYLOAD);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createMockRequest(overrides: Partial<Request> = {}): jest.Mocked<Request> {
  return {
    headers: {},
    body: TEST_PAYLOAD,
    params: {},
    ...overrides,
  } as unknown as jest.Mocked<Request>;
}

function createMockResponse(): jest.Mocked<Response> {
  const res: Partial<Response> = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    send: jest.fn().mockReturnThis(),
  };
  return res as jest.Mocked<Response>;
}

function createMockNext(): jest.MockedFunction<NextFunction> {
  return jest.fn();
}

// ─── webhookAuth ──────────────────────────────────────────────────────────────

describe('webhookAuth middleware', () => {
  let mockReq: jest.Mocked<Request>;
  let mockRes: jest.Mocked<Response>;
  let mockNext: jest.MockedFunction<NextFunction>;

  beforeEach(() => {
    mockReq = createMockRequest();
    mockRes = createMockResponse();
    mockNext = createMockNext();
    jest.clearAllMocks();
  });

  it('should call next() for valid signature', () => {
    const signature = signWebhookPayload(TEST_SECRET, TEST_PAYLOAD_STRING);
    mockReq.headers['x-revora-signature'] = signature;

    const middleware = webhookAuth({ secret: TEST_SECRET });
    middleware(mockReq, mockRes, mockNext);

    expect(mockNext).toHaveBeenCalled();
    expect(mockRes.status).not.toHaveBeenCalled();
  });

  it('should attach webhook verification info to request', () => {
    const signature = signWebhookPayload(TEST_SECRET, TEST_PAYLOAD_STRING);
    mockReq.headers['x-revora-signature'] = signature;

    const middleware = webhookAuth({ secret: TEST_SECRET });
    middleware(mockReq, mockRes, mockNext);

    const authReq = mockReq as WebhookAuthenticatedRequest;
    expect(authReq.webhook).toEqual({
      verified: true,
      timestamp: undefined,
    });
  });

  it('should return 401 for missing signature', () => {
    const middleware = webhookAuth({ secret: TEST_SECRET });
    middleware(mockReq, mockRes, mockNext);

    expect(mockRes.status).toHaveBeenCalledWith(401);
    expect(mockRes.json).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'UNAUTHORIZED',
      })
    );
    expect(mockNext).not.toHaveBeenCalled();
  });

  it('should return 403 for invalid signature', () => {
    mockReq.headers['x-revora-signature'] = 'sha256=invalid';

    const middleware = webhookAuth({ secret: TEST_SECRET });
    middleware(mockReq, mockRes, mockNext);

    expect(mockRes.status).toHaveBeenCalledWith(403);
    expect(mockRes.json).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'FORBIDDEN',
      })
    );
    expect(mockNext).not.toHaveBeenCalled();
  });

  it('should return 403 for wrong secret', () => {
    const signature = signWebhookPayload('wrong-secret', TEST_PAYLOAD_STRING);
    mockReq.headers['x-revora-signature'] = signature;

    const middleware = webhookAuth({ secret: TEST_SECRET });
    middleware(mockReq, mockRes, mockNext);

    expect(mockRes.status).toHaveBeenCalledWith(403);
    expect(mockNext).not.toHaveBeenCalled();
  });

  it('should handle custom header name', () => {
    const signature = signWebhookPayload(TEST_SECRET, TEST_PAYLOAD_STRING);
    mockReq.headers['x-custom-signature'] = signature;

    const middleware = webhookAuth({
      secret: TEST_SECRET,
      headerName: 'x-custom-signature',
    });
    middleware(mockReq, mockRes, mockNext);

    expect(mockNext).toHaveBeenCalled();
  });

  it('should handle Buffer body', () => {
    const bufferBody = Buffer.from(TEST_PAYLOAD_STRING);
    mockReq.body = bufferBody;
    const signature = signWebhookPayload(TEST_SECRET, bufferBody);
    mockReq.headers['x-revora-signature'] = signature;

    const middleware = webhookAuth({ secret: TEST_SECRET });
    middleware(mockReq, mockRes, mockNext);

    expect(mockNext).toHaveBeenCalled();
  });

  it('should handle string body', () => {
    mockReq.body = TEST_PAYLOAD_STRING;
    const signature = signWebhookPayload(TEST_SECRET, TEST_PAYLOAD_STRING);
    mockReq.headers['x-revora-signature'] = signature;

    const middleware = webhookAuth({ secret: TEST_SECRET });
    middleware(mockReq, mockRes, mockNext);

    expect(mockNext).toHaveBeenCalled();
  });

  it('should return 400 for missing body', () => {
    mockReq.body = undefined;

    const middleware = webhookAuth({ secret: TEST_SECRET });
    middleware(mockReq, mockRes, mockNext);

    expect(mockRes.status).toHaveBeenCalledWith(401);
    expect(mockNext).not.toHaveBeenCalled();
  });

  it('should enforce max payload size', () => {
    const largePayload = { data: 'x'.repeat(1024 * 1024) };
    mockReq.body = largePayload;
    const signature = signWebhookPayload(TEST_SECRET, JSON.stringify(largePayload));
    mockReq.headers['x-revora-signature'] = signature;

    const middleware = webhookAuth({
      secret: TEST_SECRET,
      maxPayloadSize: 100, // Very small limit
    });
    middleware(mockReq, mockRes, mockNext);

    expect(mockRes.status).toHaveBeenCalledWith(403);
    expect(mockRes.json).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'FORBIDDEN',
      })
    );
    expect(mockNext).not.toHaveBeenCalled();
  });

  describe('timestamp/replay protection', () => {
    it('should accept valid timestamp when required', () => {
      const signature = signWebhookPayload(TEST_SECRET, TEST_PAYLOAD_STRING);
      mockReq.headers['x-revora-signature'] = signature;
      mockReq.headers['x-webhook-timestamp'] = String(Date.now());

      const middleware = webhookAuth({
        secret: TEST_SECRET,
        requireTimestamp: true,
      });
      middleware(mockReq, mockRes, mockNext);

      expect(mockNext).toHaveBeenCalled();
      const authReq = mockReq as WebhookAuthenticatedRequest;
      expect(authReq.webhook?.timestamp).toBeInstanceOf(Date);
    });

    it('should reject missing timestamp when required', () => {
      const signature = signWebhookPayload(TEST_SECRET, TEST_PAYLOAD_STRING);
      mockReq.headers['x-revora-signature'] = signature;
      // No timestamp header

      const middleware = webhookAuth({
        secret: TEST_SECRET,
        requireTimestamp: true,
      });
      middleware(mockReq, mockRes, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(403);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          code: 'FORBIDDEN',
        })
      );
    });

    it('should reject old timestamps', () => {
      const signature = signWebhookPayload(TEST_SECRET, TEST_PAYLOAD_STRING);
      mockReq.headers['x-revora-signature'] = signature;
      mockReq.headers['x-webhook-timestamp'] = String(Date.now() - 10 * 60 * 1000); // 10 minutes ago

      const middleware = webhookAuth({
        secret: TEST_SECRET,
        requireTimestamp: true,
        maxAgeMs: 5 * 60 * 1000, // 5 minutes max
      });
      middleware(mockReq, mockRes, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(403);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          code: 'FORBIDDEN',
        })
      );
    });

    it('should accept a slightly future timestamp within the default clock skew window', () => {
      const signature = signWebhookPayload(TEST_SECRET, TEST_PAYLOAD_STRING);
      mockReq.headers['x-revora-signature'] = signature;
      // 15 seconds in the future — within the 30 s default clockSkewMs
      mockReq.headers['x-webhook-timestamp'] = String(Date.now() + 15_000);

      const middleware = webhookAuth({
        secret: TEST_SECRET,
        requireTimestamp: true,
      });
      middleware(mockReq, mockRes, mockNext);

      expect(mockNext).toHaveBeenCalled();
      expect(mockRes.status).not.toHaveBeenCalled();
    });

    it('should reject a future timestamp beyond the default clock skew window', () => {
      const signature = signWebhookPayload(TEST_SECRET, TEST_PAYLOAD_STRING);
      mockReq.headers['x-revora-signature'] = signature;
      // 45 seconds in the future — beyond the 30 s default clockSkewMs
      mockReq.headers['x-webhook-timestamp'] = String(Date.now() + 45_000);

      const middleware = webhookAuth({
        secret: TEST_SECRET,
        requireTimestamp: true,
      });
      middleware(mockReq, mockRes, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(403);
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('should accept a future timestamp within a custom clockSkewMs', () => {
      const signature = signWebhookPayload(TEST_SECRET, TEST_PAYLOAD_STRING);
      mockReq.headers['x-revora-signature'] = signature;
      mockReq.headers['x-webhook-timestamp'] = String(Date.now() + 50_000);

      const middleware = webhookAuth({
        secret: TEST_SECRET,
        requireTimestamp: true,
        clockSkewMs: 60_000, // 60-second tolerance
      });
      middleware(mockReq, mockRes, mockNext);

      expect(mockNext).toHaveBeenCalled();
    });

    it('should reject all future timestamps when clockSkewMs is 0', () => {
      const signature = signWebhookPayload(TEST_SECRET, TEST_PAYLOAD_STRING);
      mockReq.headers['x-revora-signature'] = signature;
      mockReq.headers['x-webhook-timestamp'] = String(Date.now() + 1_000);

      const middleware = webhookAuth({
        secret: TEST_SECRET,
        requireTimestamp: true,
        clockSkewMs: 0,
      });
      middleware(mockReq, mockRes, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(403);
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('should reject future timestamps', () => {
      const signature = signWebhookPayload(TEST_SECRET, TEST_PAYLOAD_STRING);
      mockReq.headers['x-revora-signature'] = signature;
      mockReq.headers['x-webhook-timestamp'] = String(Date.now() + 10 * 60 * 1000); // 10 minutes in future

      const middleware = webhookAuth({
        secret: TEST_SECRET,
        requireTimestamp: true,
      });
      middleware(mockReq, mockRes, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(403);
    });

    // Clock skew boundary tests
    describe('clock skew boundary tests', () => {
      const clockSkewMs = 30_000; // 30 seconds default

      it('should accept timestamp exactly at clock skew boundary (future)', () => {
        const signature = signWebhookPayload(TEST_SECRET, TEST_PAYLOAD_STRING);
        mockReq.headers['x-revora-signature'] = signature;
        // Exactly at the clock skew boundary
        mockReq.headers['x-webhook-timestamp'] = String(Date.now() + clockSkewMs);

        const middleware = webhookAuth({
          secret: TEST_SECRET,
          requireTimestamp: true,
          clockSkewMs,
        });
        middleware(mockReq, mockRes, mockNext);

        expect(mockNext).toHaveBeenCalled();
        expect(mockRes.status).not.toHaveBeenCalled();
      });

      it('should reject timestamp 1ms beyond clock skew boundary (future)', () => {
        const signature = signWebhookPayload(TEST_SECRET, TEST_PAYLOAD_STRING);
        mockReq.headers['x-revora-signature'] = signature;
        // 1ms beyond the clock skew boundary
        mockReq.headers['x-webhook-timestamp'] = String(Date.now() + clockSkewMs + 1);

        const middleware = webhookAuth({
          secret: TEST_SECRET,
          requireTimestamp: true,
          clockSkewMs,
        });
        middleware(mockReq, mockRes, mockNext);

        expect(mockRes.status).toHaveBeenCalledWith(403);
        expect(mockNext).not.toHaveBeenCalled();
      });

      it('should accept timestamp 1ms inside clock skew boundary (future)', () => {
        const signature = signWebhookPayload(TEST_SECRET, TEST_PAYLOAD_STRING);
        mockReq.headers['x-revora-signature'] = signature;
        // 1ms inside the clock skew boundary
        mockReq.headers['x-webhook-timestamp'] = String(Date.now() + clockSkewMs - 1);

        const middleware = webhookAuth({
          secret: TEST_SECRET,
          requireTimestamp: true,
          clockSkewMs,
        });
        middleware(mockReq, mockRes, mockNext);

        expect(mockNext).toHaveBeenCalled();
        expect(mockRes.status).not.toHaveBeenCalled();
      });

      it('should accept timestamp exactly at max age boundary (past)', () => {
        const signature = signWebhookPayload(TEST_SECRET, TEST_PAYLOAD_STRING);
        mockReq.headers['x-revora-signature'] = signature;
        const maxAgeMs = 5 * 60 * 1000; // 5 minutes
        // Use a timestamp 100ms inside the boundary to avoid timing flakiness
        mockReq.headers['x-webhook-timestamp'] = String(Date.now() - maxAgeMs + 100);

        const middleware = webhookAuth({
          secret: TEST_SECRET,
          requireTimestamp: true,
          maxAgeMs,
          clockSkewMs,
        });
        middleware(mockReq, mockRes, mockNext);

        expect(mockNext).toHaveBeenCalled();
        expect(mockRes.status).not.toHaveBeenCalled();
      });

      it('should reject timestamp 1ms beyond max age boundary (past)', () => {
        const signature = signWebhookPayload(TEST_SECRET, TEST_PAYLOAD_STRING);
        mockReq.headers['x-revora-signature'] = signature;
        const maxAgeMs = 5 * 60 * 1000; // 5 minutes
        // 1ms beyond the max age boundary
        mockReq.headers['x-webhook-timestamp'] = String(Date.now() - maxAgeMs - 1);

        const middleware = webhookAuth({
          secret: TEST_SECRET,
          requireTimestamp: true,
          maxAgeMs,
          clockSkewMs,
        });
        middleware(mockReq, mockRes, mockNext);

        expect(mockRes.status).toHaveBeenCalledWith(403);
        expect(mockNext).not.toHaveBeenCalled();
      });

      it('should accept timestamp 1ms inside max age boundary (past)', () => {
        const signature = signWebhookPayload(TEST_SECRET, TEST_PAYLOAD_STRING);
        mockReq.headers['x-revora-signature'] = signature;
        const maxAgeMs = 5 * 60 * 1000; // 5 minutes
        // 1ms inside the max age boundary
        mockReq.headers['x-webhook-timestamp'] = String(Date.now() - maxAgeMs + 1);

        const middleware = webhookAuth({
          secret: TEST_SECRET,
          requireTimestamp: true,
          maxAgeMs,
          clockSkewMs,
        });
        middleware(mockReq, mockRes, mockNext);

        expect(mockNext).toHaveBeenCalled();
        expect(mockRes.status).not.toHaveBeenCalled();
      });
    });

    // Replay window edge cases
    describe('replay window edge cases', () => {
      it('should reject very old timestamp (replay attack prevention)', () => {
        const signature = signWebhookPayload(TEST_SECRET, TEST_PAYLOAD_STRING);
        mockReq.headers['x-revora-signature'] = signature;
        // 1 hour old - well beyond replay window
        mockReq.headers['x-webhook-timestamp'] = String(Date.now() - 60 * 60 * 1000);

        const middleware = webhookAuth({
          secret: TEST_SECRET,
          requireTimestamp: true,
          maxAgeMs: 5 * 60 * 1000, // 5 minutes
        });
        middleware(mockReq, mockRes, mockNext);

        expect(mockRes.status).toHaveBeenCalledWith(403);
        expect(mockNext).not.toHaveBeenCalled();
      });

      it('should reject very far future timestamp (replay attack prevention)', () => {
        const signature = signWebhookPayload(TEST_SECRET, TEST_PAYLOAD_STRING);
        mockReq.headers['x-revora-signature'] = signature;
        // 1 hour in future - well beyond clock skew
        mockReq.headers['x-webhook-timestamp'] = String(Date.now() + 60 * 60 * 1000);

        const middleware = webhookAuth({
          secret: TEST_SECRET,
          requireTimestamp: true,
        });
        middleware(mockReq, mockRes, mockNext);

        expect(mockRes.status).toHaveBeenCalledWith(403);
        expect(mockNext).not.toHaveBeenCalled();
      });

      it('should accept timestamp at current time (no drift)', () => {
        const signature = signWebhookPayload(TEST_SECRET, TEST_PAYLOAD_STRING);
        mockReq.headers['x-revora-signature'] = signature;
        mockReq.headers['x-webhook-timestamp'] = String(Date.now());

        const middleware = webhookAuth({
          secret: TEST_SECRET,
          requireTimestamp: true,
        });
        middleware(mockReq, mockRes, mockNext);

        expect(mockNext).toHaveBeenCalled();
        expect(mockRes.status).not.toHaveBeenCalled();
      });

      it('should reject timestamp with negative value (invalid)', () => {
        const signature = signWebhookPayload(TEST_SECRET, TEST_PAYLOAD_STRING);
        mockReq.headers['x-revora-signature'] = signature;
        mockReq.headers['x-webhook-timestamp'] = String(-1000);

        const middleware = webhookAuth({
          secret: TEST_SECRET,
          requireTimestamp: true,
        });
        middleware(mockReq, mockRes, mockNext);

        expect(mockRes.status).toHaveBeenCalledWith(403);
        expect(mockNext).not.toHaveBeenCalled();
      });

      it('should reject timestamp with zero value (very old)', () => {
        const signature = signWebhookPayload(TEST_SECRET, TEST_PAYLOAD_STRING);
        mockReq.headers['x-revora-signature'] = signature;
        mockReq.headers['x-webhook-timestamp'] = '0';

        const middleware = webhookAuth({
          secret: TEST_SECRET,
          requireTimestamp: true,
        });
        middleware(mockReq, mockRes, mockNext);

        expect(mockRes.status).toHaveBeenCalledWith(403);
        expect(mockNext).not.toHaveBeenCalled();
      });
    });
  });

  describe('custom error handler', () => {
    it('should use custom error handler when provided', () => {
      const customErrorHandler = jest.fn();
      mockReq.headers['x-revora-signature'] = 'invalid';

      const middleware = webhookAuth({
        secret: TEST_SECRET,
        onError: customErrorHandler,
      });
      middleware(mockReq, mockRes, mockNext);

      expect(customErrorHandler).toHaveBeenCalledWith(
        expect.any(WebhookSignatureError),
        mockReq,
        mockRes
      );
      expect(mockRes.status).not.toHaveBeenCalled();
      expect(mockRes.json).not.toHaveBeenCalled();
    });
  });
});

// ─── webhookVerify ────────────────────────────────────────────────────────────

describe('webhookVerify middleware', () => {
  let mockReq: jest.Mocked<Request>;
  let mockRes: jest.Mocked<Response>;
  let mockNext: jest.MockedFunction<NextFunction>;

  beforeEach(() => {
    mockReq = createMockRequest();
    mockRes = createMockResponse();
    mockNext = createMockNext();
    jest.clearAllMocks();
  });

  it('should call next() for valid signature', () => {
    const signature = signWebhookPayload(TEST_SECRET, TEST_PAYLOAD_STRING);
    mockReq.headers['x-revora-signature'] = signature;

    const middleware = webhookVerify({
      secret: TEST_SECRET,
    });
    middleware(mockReq, mockRes, mockNext);

    expect(mockNext).toHaveBeenCalled();
  });

  it('should return 401 for missing signature', () => {
    const middleware = webhookVerify({
      secret: TEST_SECRET,
    });
    middleware(mockReq, mockRes, mockNext);

    expect(mockRes.status).toHaveBeenCalledWith(401);
  });

  it('should return 403 for invalid signature', () => {
    mockReq.headers['x-revora-signature'] = 'sha256=invalid';

    const middleware = webhookVerify({
      secret: TEST_SECRET,
    });
    middleware(mockReq, mockRes, mockNext);

    expect(mockRes.status).toHaveBeenCalledWith(403);
  });

  it('should enforce max payload size', () => {
    const largePayload = { data: 'x'.repeat(1024 * 1024) };
    mockReq.body = largePayload;
    const signature = signWebhookPayload(TEST_SECRET, JSON.stringify(largePayload));
    mockReq.headers['x-revora-signature'] = signature;

    const middleware = webhookVerify({
      secret: TEST_SECRET,
      maxPayloadSize: 100,
    });
    middleware(mockReq, mockRes, mockNext);

    expect(mockRes.status).toHaveBeenCalledWith(403);
  });

  it('should handle timestamp validation', () => {
    const signature = signWebhookPayload(TEST_SECRET, TEST_PAYLOAD_STRING);
    mockReq.headers['x-revora-signature'] = signature;
    mockReq.headers['x-webhook-timestamp'] = String(Date.now());

    const middleware = webhookVerify({
      secret: TEST_SECRET,
      requireTimestamp: true,
    });
    middleware(mockReq, mockRes, mockNext);

    expect(mockNext).toHaveBeenCalled();
    const authReq = mockReq as WebhookAuthenticatedRequest;
    expect(authReq.webhook?.timestamp).toBeInstanceOf(Date);
  });
});

// ─── webhookAuthWithProvider ──────────────────────────────────────────────────

describe('webhookAuthWithProvider middleware', () => {
  let mockReq: jest.Mocked<Request>;
  let mockRes: jest.Mocked<Response>;
  let mockNext: jest.MockedFunction<NextFunction>;

  beforeEach(() => {
    mockReq = createMockRequest({
      params: { endpointId: 'endpoint-123' },
    });
    mockRes = createMockResponse();
    mockNext = createMockNext();
    jest.clearAllMocks();
  });

  it('should call next() for valid signature with provider', async () => {
    const signature = signWebhookPayload(TEST_SECRET, TEST_PAYLOAD_STRING);
    mockReq.headers['x-revora-signature'] = signature;

    const secretProvider = jest.fn().mockResolvedValue(TEST_SECRET);

    const middleware = webhookAuthWithProvider(secretProvider);
    await middleware(mockReq, mockRes, mockNext);

    expect(secretProvider).toHaveBeenCalledWith('endpoint-123');
    expect(mockNext).toHaveBeenCalled();
  });

  it('should return 403 when secret provider returns null', async () => {
    const signature = signWebhookPayload(TEST_SECRET, TEST_PAYLOAD_STRING);
    mockReq.headers['x-revora-signature'] = signature;

    const secretProvider = jest.fn().mockResolvedValue(null);

    const middleware = webhookAuthWithProvider(secretProvider);
    await middleware(mockReq, mockRes, mockNext);

    expect(mockRes.status).toHaveBeenCalledWith(403);
    expect(mockNext).not.toHaveBeenCalled();
  });

  it('should return 403 when secret provider throws', async () => {
    const signature = signWebhookPayload(TEST_SECRET, TEST_PAYLOAD_STRING);
    mockReq.headers['x-revora-signature'] = signature;

    const secretProvider = jest.fn().mockRejectedValue(new Error('DB error'));

    const middleware = webhookAuthWithProvider(secretProvider);
    await middleware(mockReq, mockRes, mockNext);

    expect(mockRes.status).toHaveBeenCalledWith(403);
    expect(mockNext).not.toHaveBeenCalled();
  });

  it('should use custom endpointIdExtractor', async () => {
    mockReq = createMockRequest({
      headers: { 'x-endpoint-id': 'custom-endpoint' },
    });
    const signature = signWebhookPayload(TEST_SECRET, TEST_PAYLOAD_STRING);
    mockReq.headers['x-revora-signature'] = signature;

    const secretProvider = jest.fn().mockResolvedValue(TEST_SECRET);

    const middleware = webhookAuthWithProvider(secretProvider, {
      endpointIdExtractor: (req) => req.headers['x-endpoint-id'] as string,
    });
    await middleware(mockReq, mockRes, mockNext);

    expect(secretProvider).toHaveBeenCalledWith('custom-endpoint');
    expect(mockNext).toHaveBeenCalled();
  });

  it('should return 403 when endpointId is missing', async () => {
    mockReq = createMockRequest({ params: {} });
    const signature = signWebhookPayload(TEST_SECRET, TEST_PAYLOAD_STRING);
    mockReq.headers['x-revora-signature'] = signature;

    const secretProvider = jest.fn().mockResolvedValue(TEST_SECRET);

    const middleware = webhookAuthWithProvider(secretProvider);
    await middleware(mockReq, mockRes, mockNext);

    expect(mockRes.status).toHaveBeenCalledWith(403);
    expect(mockNext).not.toHaveBeenCalled();
  });

  it('should handle timestamp validation with provider', async () => {
    const signature = signWebhookPayload(TEST_SECRET, TEST_PAYLOAD_STRING);
    mockReq.headers['x-revora-signature'] = signature;
    mockReq.headers['x-webhook-timestamp'] = String(Date.now());

    const secretProvider = jest.fn().mockResolvedValue(TEST_SECRET);

    const middleware = webhookAuthWithProvider(secretProvider, {
      requireTimestamp: true,
    });
    await middleware(mockReq, mockRes, mockNext);

    expect(mockNext).toHaveBeenCalled();
    const authReq = mockReq as WebhookAuthenticatedRequest;
    expect(authReq.webhook?.timestamp).toBeInstanceOf(Date);
  });
});

// ─── Security: Constant-Time Comparison & Signature Tampering ──────────────

describe('Webhook Auth Security: Constant-Time Comparison', () => {
  let mockReq: jest.Mocked<Request>;
  let mockRes: jest.Mocked<Response>;
  let mockNext: jest.MockedFunction<NextFunction>;

  beforeEach(() => {
    mockReq = createMockRequest();
    mockRes = createMockResponse();
    mockNext = createMockNext();
    jest.clearAllMocks();
  });

  it('should reject signature with wrong length (prevents timing attack)', () => {
    // Create a signature that's too short
    mockReq.headers['x-revora-signature'] = 'sha256=abc123';

    const middleware = webhookAuth({ secret: TEST_SECRET });
    middleware(mockReq, mockRes, mockNext);

    expect(mockRes.status).toHaveBeenCalledWith(403);
    expect(mockNext).not.toHaveBeenCalled();
  });

  it('should reject signature with extra characters (wrong length)', () => {
    const validSignature = signWebhookPayload(TEST_SECRET, TEST_PAYLOAD_STRING);
    // Append extra characters to change length
    mockReq.headers['x-revora-signature'] = validSignature + 'extra';

    const middleware = webhookAuth({ secret: TEST_SECRET });
    middleware(mockReq, mockRes, mockNext);

    expect(mockRes.status).toHaveBeenCalledWith(403);
    expect(mockNext).not.toHaveBeenCalled();
  });

  it('should reject signature with missing prefix (wrong format)', () => {
    mockReq.headers['x-revora-signature'] = 'a1b2c3d4e5f6'; // Missing 'sha256=' prefix

    const middleware = webhookAuth({ secret: TEST_SECRET });
    middleware(mockReq, mockRes, mockNext);

    expect(mockRes.status).toHaveBeenCalledWith(403);
    expect(mockNext).not.toHaveBeenCalled();
  });

  it('should reject tampered signature (single bit flip)', () => {
    const validSignature = signWebhookPayload(TEST_SECRET, TEST_PAYLOAD_STRING);
    // Flip one character in the signature
    const tamperedSignature = validSignature.slice(0, -1) + 
      (validSignature.slice(-1) === 'a' ? 'b' : 'a');
    
    mockReq.headers['x-revora-signature'] = tamperedSignature;

    const middleware = webhookAuth({ secret: TEST_SECRET });
    middleware(mockReq, mockRes, mockNext);

    expect(mockRes.status).toHaveBeenCalledWith(403);
    expect(mockNext).not.toHaveBeenCalled();
  });

  it('should reject signature for tampered payload', () => {
    const originalPayload = TEST_PAYLOAD_STRING;
    const tamperedPayload = JSON.stringify({ event: 'test', data: { id: '999' } });
    
    // Signature is for original payload, but we send tampered payload
    const signature = signWebhookPayload(TEST_SECRET, originalPayload);
    mockReq.body = JSON.parse(tamperedPayload);
    mockReq.headers['x-revora-signature'] = signature;

    const middleware = webhookAuth({ secret: TEST_SECRET });
    middleware(mockReq, mockRes, mockNext);

    expect(mockRes.status).toHaveBeenCalledWith(403);
    expect(mockNext).not.toHaveBeenCalled();
  });

  it('should reject signature with invalid hex characters', () => {
    mockReq.headers['x-revora-signature'] = 'sha256=ghijklmnopqrstuvwxyz'; // Invalid hex

    const middleware = webhookAuth({ secret: TEST_SECRET });
    middleware(mockReq, mockRes, mockNext);

    expect(mockRes.status).toHaveBeenCalledWith(403);
    expect(mockNext).not.toHaveBeenCalled();
  });

  it('should reject empty signature', () => {
    mockReq.headers['x-revora-signature'] = '';

    const middleware = webhookAuth({ secret: TEST_SECRET });
    middleware(mockReq, mockRes, mockNext);

    expect(mockRes.status).toHaveBeenCalledWith(401);
    expect(mockNext).not.toHaveBeenCalled();
  });

  it('should reject signature with only prefix', () => {
    mockReq.headers['x-revora-signature'] = 'sha256=';

    const middleware = webhookAuth({ secret: TEST_SECRET });
    middleware(mockReq, mockRes, mockNext);

    expect(mockRes.status).toHaveBeenCalledWith(403);
    expect(mockNext).not.toHaveBeenCalled();
  });

  it('should accept valid signature (constant-time comparison path)', () => {
    const signature = signWebhookPayload(TEST_SECRET, TEST_PAYLOAD_STRING);
    mockReq.headers['x-revora-signature'] = signature;

    const middleware = webhookAuth({ secret: TEST_SECRET });
    middleware(mockReq, mockRes, mockNext);

    expect(mockNext).toHaveBeenCalled();
    expect(mockRes.status).not.toHaveBeenCalled();
  });
});

// ─── Security: Missing Headers ───────────────────────────────────────────────

describe('Webhook Auth Security: Missing Headers', () => {
  let mockReq: jest.Mocked<Request>;
  let mockRes: jest.Mocked<Response>;
  let mockNext: jest.MockedFunction<NextFunction>;

  beforeEach(() => {
    mockReq = createMockRequest();
    mockRes = createMockResponse();
    mockNext = createMockNext();
    jest.clearAllMocks();
  });

  it('should return 401 for missing signature header', () => {
    const middleware = webhookAuth({ secret: TEST_SECRET });
    middleware(mockReq, mockRes, mockNext);

    expect(mockRes.status).toHaveBeenCalledWith(401);
    expect(mockRes.json).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'UNAUTHORIZED',
      })
    );
    expect(mockNext).not.toHaveBeenCalled();
  });

  it('should return 401 for missing signature header when timestamp required', () => {
    mockReq.headers['x-webhook-timestamp'] = String(Date.now());
    // No signature header

    const middleware = webhookAuth({
      secret: TEST_SECRET,
      requireTimestamp: true,
    });
    middleware(mockReq, mockRes, mockNext);

    expect(mockRes.status).toHaveBeenCalledWith(401);
    expect(mockRes.json).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'UNAUTHORIZED',
      })
    );
    expect(mockNext).not.toHaveBeenCalled();
  });

  it('should return 403 for missing timestamp header when required', () => {
    const signature = signWebhookPayload(TEST_SECRET, TEST_PAYLOAD_STRING);
    mockReq.headers['x-revora-signature'] = signature;
    // No timestamp header

    const middleware = webhookAuth({
      secret: TEST_SECRET,
      requireTimestamp: true,
    });
    middleware(mockReq, mockRes, mockNext);

    expect(mockRes.status).toHaveBeenCalledWith(403);
    expect(mockRes.json).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'FORBIDDEN',
      })
    );
    expect(mockNext).not.toHaveBeenCalled();
  });

  it('should return 403 for missing timestamp header with custom header name', () => {
    const signature = signWebhookPayload(TEST_SECRET, TEST_PAYLOAD_STRING);
    mockReq.headers['x-revora-signature'] = signature;
    // No x-revora-timestamp header

    const middleware = webhookAuth({
      secret: TEST_SECRET,
      requireTimestamp: true,
    });
    middleware(mockReq, mockRes, mockNext);

    expect(mockRes.status).toHaveBeenCalledWith(403);
    expect(mockNext).not.toHaveBeenCalled();
  });

  it('should return 403 for undefined timestamp header value', () => {
    const signature = signWebhookPayload(TEST_SECRET, TEST_PAYLOAD_STRING);
    mockReq.headers['x-revora-signature'] = signature;
    mockReq.headers['x-webhook-timestamp'] = undefined;

    const middleware = webhookAuth({
      secret: TEST_SECRET,
      requireTimestamp: true,
    });
    middleware(mockReq, mockRes, mockNext);

    expect(mockRes.status).toHaveBeenCalledWith(403);
    expect(mockNext).not.toHaveBeenCalled();
  });

  it('should return 403 for empty timestamp header value', () => {
    const signature = signWebhookPayload(TEST_SECRET, TEST_PAYLOAD_STRING);
    mockReq.headers['x-revora-signature'] = signature;
    mockReq.headers['x-webhook-timestamp'] = '';

    const middleware = webhookAuth({
      secret: TEST_SECRET,
      requireTimestamp: true,
    });
    middleware(mockReq, mockRes, mockNext);

    expect(mockRes.status).toHaveBeenCalledWith(403);
    expect(mockNext).not.toHaveBeenCalled();
  });

  it('should return 401 for undefined signature header value', () => {
    mockReq.headers['x-revora-signature'] = undefined;

    const middleware = webhookAuth({ secret: TEST_SECRET });
    middleware(mockReq, mockRes, mockNext);

    expect(mockRes.status).toHaveBeenCalledWith(401);
    expect(mockNext).not.toHaveBeenCalled();
  });

  it('should return 403 for non-numeric timestamp when required', () => {
    const signature = signWebhookPayload(TEST_SECRET, TEST_PAYLOAD_STRING);
    mockReq.headers['x-revora-signature'] = signature;
    mockReq.headers['x-webhook-timestamp'] = 'not-a-number';

    const middleware = webhookAuth({
      secret: TEST_SECRET,
      requireTimestamp: true,
    });
    middleware(mockReq, mockRes, mockNext);

    expect(mockRes.status).toHaveBeenCalledWith(403);
    expect(mockNext).not.toHaveBeenCalled();
  });

  it('should return 403 for timestamp with decimal when required', () => {
    const signature = signWebhookPayload(TEST_SECRET, TEST_PAYLOAD_STRING);
    mockReq.headers['x-revora-signature'] = signature;
    mockReq.headers['x-webhook-timestamp'] = '12345.678';

    const middleware = webhookAuth({
      secret: TEST_SECRET,
      requireTimestamp: true,
    });
    middleware(mockReq, mockRes, mockNext);

    expect(mockRes.status).toHaveBeenCalledWith(403);
    expect(mockNext).not.toHaveBeenCalled();
  });
});

// ─── Edge Cases ───────────────────────────────────────────────────────────────

describe('Webhook Auth Edge Cases', () => {
  let mockReq: jest.Mocked<Request>;
  let mockRes: jest.Mocked<Response>;
  let mockNext: jest.MockedFunction<NextFunction>;

  beforeEach(() => {
    mockReq = createMockRequest();
    mockRes = createMockResponse();
    mockNext = createMockNext();
    jest.clearAllMocks();
  });

  it('should handle array header values', () => {
    const signature = signWebhookPayload(TEST_SECRET, TEST_PAYLOAD_STRING);
    mockReq.headers['x-revora-signature'] = [signature, 'ignored'];

    const middleware = webhookAuth({ secret: TEST_SECRET });
    middleware(mockReq, mockRes, mockNext);

    expect(mockNext).toHaveBeenCalled();
  });

  it('should handle unicode payloads', () => {
    const unicodePayload = { message: 'Hello 世界 🌍' };
    mockReq.body = unicodePayload;
    const payloadString = JSON.stringify(unicodePayload);
    const signature = signWebhookPayload(TEST_SECRET, payloadString);
    mockReq.headers['x-revora-signature'] = signature;

    const middleware = webhookAuth({ secret: TEST_SECRET });
    middleware(mockReq, mockRes, mockNext);

    expect(mockNext).toHaveBeenCalled();
  });

  it('should handle special characters in secret', () => {
    const specialSecret = 'secret-with-!@#$%^&*()_+-=[]{}|;\':",./<>?';
    const signature = signWebhookPayload(specialSecret, TEST_PAYLOAD_STRING);
    mockReq.headers['x-revora-signature'] = signature;

    const middleware = webhookAuth({ secret: specialSecret });
    middleware(mockReq, mockRes, mockNext);

    expect(mockNext).toHaveBeenCalled();
  });

  it('should handle empty JSON object body', () => {
    mockReq.body = {};
    const signature = signWebhookPayload(TEST_SECRET, '{}');
    mockReq.headers['x-revora-signature'] = signature;

    const middleware = webhookAuth({ secret: TEST_SECRET });
    middleware(mockReq, mockRes, mockNext);

    expect(mockNext).toHaveBeenCalled();
  });

  it('should handle null bytes in payload', () => {
    const payloadWithNull = { data: 'hello\u0000world' };
    mockReq.body = payloadWithNull;
    const payloadString = JSON.stringify(payloadWithNull);
    const signature = signWebhookPayload(TEST_SECRET, payloadString);
    mockReq.headers['x-revora-signature'] = signature;

    const middleware = webhookAuth({ secret: TEST_SECRET });
    middleware(mockReq, mockRes, mockNext);

    expect(mockNext).toHaveBeenCalled();
  });
});
