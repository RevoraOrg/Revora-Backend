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
        error: 'Webhook verification failed',
        code: 'MISSING_SIGNATURE',
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
        error: 'Webhook verification failed',
        code: 'VERIFICATION_FAILED',
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
        code: 'INVALID_FORMAT',
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
          code: 'INVALID_FORMAT',
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
          code: 'VERIFICATION_FAILED',
        })
      );
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
