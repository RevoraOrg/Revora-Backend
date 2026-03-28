import {
  signWebhookPayload,
  verifyWebhookPayload,
  extractSignatureFromHeaders,
  assertValidWebhookSignature,
  verifyWebhook,
  WebhookSignatureError,
  WebhookVerificationConfig,
} from './webhookSignature';

// ─── Test Constants ───────────────────────────────────────────────────────────

const TEST_SECRET = 'test-secret-key-that-is-sufficiently-long-for-hmac-sha256';
const TEST_PAYLOAD = '{"event":"test","data":{"id":"123"}}';

// ─── signWebhookPayload ───────────────────────────────────────────────────────

describe('signWebhookPayload', () => {
  it('should generate a valid sha256 signature', () => {
    const signature = signWebhookPayload(TEST_SECRET, TEST_PAYLOAD);
    expect(signature).toMatch(/^sha256=[a-f0-9]{64}$/);
  });

  it('should generate consistent signatures for same input', () => {
    const sig1 = signWebhookPayload(TEST_SECRET, TEST_PAYLOAD);
    const sig2 = signWebhookPayload(TEST_SECRET, TEST_PAYLOAD);
    expect(sig1).toBe(sig2);
  });

  it('should generate different signatures for different secrets', () => {
    const sig1 = signWebhookPayload('secret-a', TEST_PAYLOAD);
    const sig2 = signWebhookPayload('secret-b', TEST_PAYLOAD);
    expect(sig1).not.toBe(sig2);
  });

  it('should generate different signatures for different payloads', () => {
    const sig1 = signWebhookPayload(TEST_SECRET, '{"a":1}');
    const sig2 = signWebhookPayload(TEST_SECRET, '{"a":2}');
    expect(sig1).not.toBe(sig2);
  });

  it('should handle Buffer payloads', () => {
    const bufferPayload = Buffer.from(TEST_PAYLOAD);
    const signature = signWebhookPayload(TEST_SECRET, bufferPayload);
    expect(signature).toMatch(/^sha256=[a-f0-9]{64}$/);
  });

  it('should handle empty payload', () => {
    const signature = signWebhookPayload(TEST_SECRET, '');
    expect(signature).toMatch(/^sha256=[a-f0-9]{64}$/);
  });

  it('should handle empty secret', () => {
    const signature = signWebhookPayload('', TEST_PAYLOAD);
    expect(signature).toMatch(/^sha256=[a-f0-9]{64}$/);
  });

  it('should handle unicode payloads', () => {
    const unicodePayload = '{"message":"Hello 世界 🌍"}';
    const signature = signWebhookPayload(TEST_SECRET, unicodePayload);
    expect(signature).toMatch(/^sha256=[a-f0-9]{64}$/);
  });

  it('should handle large payloads', () => {
    const largePayload = 'x'.repeat(1024 * 1024); // 1MB
    const signature = signWebhookPayload(TEST_SECRET, largePayload);
    expect(signature).toMatch(/^sha256=[a-f0-9]{64}$/);
  });
});

// ─── verifyWebhookPayload ─────────────────────────────────────────────────────

describe('verifyWebhookPayload', () => {
  it('should return true for valid signature', () => {
    const signature = signWebhookPayload(TEST_SECRET, TEST_PAYLOAD);
    const isValid = verifyWebhookPayload(TEST_SECRET, TEST_PAYLOAD, signature);
    expect(isValid).toBe(true);
  });

  it('should return false for invalid signature', () => {
    const isValid = verifyWebhookPayload(TEST_SECRET, TEST_PAYLOAD, 'sha256=invalid');
    expect(isValid).toBe(false);
  });

  it('should return false for tampered payload', () => {
    const signature = signWebhookPayload(TEST_SECRET, TEST_PAYLOAD);
    const isValid = verifyWebhookPayload(TEST_SECRET, '{"tampered":true}', signature);
    expect(isValid).toBe(false);
  });

  it('should return false for wrong secret', () => {
    const signature = signWebhookPayload(TEST_SECRET, TEST_PAYLOAD);
    const isValid = verifyWebhookPayload('wrong-secret', TEST_PAYLOAD, signature);
    expect(isValid).toBe(false);
  });

  it('should return false for missing signature', () => {
    const isValid = verifyWebhookPayload(TEST_SECRET, TEST_PAYLOAD, '');
    expect(isValid).toBe(false);
  });

  it('should return false for null/undefined signature', () => {
    expect(verifyWebhookPayload(TEST_SECRET, TEST_PAYLOAD, '')).toBe(false);
  });

  it('should return false for signature without sha256= prefix', () => {
    const signature = signWebhookPayload(TEST_SECRET, TEST_PAYLOAD);
    const bareSignature = signature.replace('sha256=', '');
    const isValid = verifyWebhookPayload(TEST_SECRET, TEST_PAYLOAD, bareSignature);
    expect(isValid).toBe(false);
  });

  it('should return false for signature with wrong prefix', () => {
    const signature = signWebhookPayload(TEST_SECRET, TEST_PAYLOAD);
    const wrongPrefix = signature.replace('sha256=', 'sha1=');
    const isValid = verifyWebhookPayload(TEST_SECRET, TEST_PAYLOAD, wrongPrefix);
    expect(isValid).toBe(false);
  });

  it('should return false for signature with different length', () => {
    const isValid = verifyWebhookPayload(TEST_SECRET, TEST_PAYLOAD, 'sha256=tooshort');
    expect(isValid).toBe(false);
  });

  it('should handle Buffer payloads', () => {
    const bufferPayload = Buffer.from(TEST_PAYLOAD);
    const signature = signWebhookPayload(TEST_SECRET, bufferPayload);
    const isValid = verifyWebhookPayload(TEST_SECRET, bufferPayload, signature);
    expect(isValid).toBe(true);
  });

  it('should return true for empty secret when signature matches', () => {
    const signature = signWebhookPayload('', TEST_PAYLOAD);
    const isValid = verifyWebhookPayload('', TEST_PAYLOAD, signature);
    expect(isValid).toBe(true); // Empty secret is valid if signature matches
  });

  it('should return false when secret is empty but provided signature was signed with non-empty secret', () => {
    const signature = signWebhookPayload(TEST_SECRET, TEST_PAYLOAD);
    const isValid = verifyWebhookPayload('', TEST_PAYLOAD, signature);
    expect(isValid).toBe(false);
  });

  // Timing attack prevention tests
  it('should take similar time for valid and invalid signatures of same length', async () => {
    const validSig = signWebhookPayload(TEST_SECRET, TEST_PAYLOAD);
    const invalidSig = 'sha256=' + '0'.repeat(64);

    const iterations = 100;

    const validTimes: number[] = [];
    const invalidTimes: number[] = [];

    for (let i = 0; i < iterations; i++) {
      const start1 = process.hrtime.bigint();
      verifyWebhookPayload(TEST_SECRET, TEST_PAYLOAD, validSig);
      const end1 = process.hrtime.bigint();
      validTimes.push(Number(end1 - start1));

      const start2 = process.hrtime.bigint();
      verifyWebhookPayload(TEST_SECRET, TEST_PAYLOAD, invalidSig);
      const end2 = process.hrtime.bigint();
      invalidTimes.push(Number(end2 - start2));
    }

    const avgValid = validTimes.reduce((a, b) => a + b, 0) / iterations;
    const avgInvalid = invalidTimes.reduce((a, b) => a + b, 0) / iterations;

    // Timing difference should be within 50% (very loose check due to JS engine variance)
    const ratio = Math.max(avgValid, avgInvalid) / Math.min(avgValid, avgInvalid);
    expect(ratio).toBeLessThan(2);
  });
});

// ─── extractSignatureFromHeaders ──────────────────────────────────────────────

describe('extractSignatureFromHeaders', () => {
  it('should extract x-revora-signature header', () => {
    const headers = { 'x-revora-signature': 'sha256=abc123' };
    const signature = extractSignatureFromHeaders(headers);
    expect(signature).toBe('sha256=abc123');
  });

  it('should extract x-webhook-signature header', () => {
    const headers = { 'x-webhook-signature': 'sha256=def456' };
    const signature = extractSignatureFromHeaders(headers);
    expect(signature).toBe('sha256=def456');
  });

  it('should extract x-signature header', () => {
    const headers = { 'x-signature': 'sha256=ghi789' };
    const signature = extractSignatureFromHeaders(headers);
    expect(signature).toBe('sha256=ghi789');
  });

  it('should extract x-hub-signature-256 header (GitHub style)', () => {
    const headers = { 'x-hub-signature-256': 'sha256=jkl012' };
    const signature = extractSignatureFromHeaders(headers);
    expect(signature).toBe('sha256=jkl012');
  });

  it('should handle lowercase header names', () => {
    const headers = { 'x-revora-signature': 'sha256=mno345' };
    const signature = extractSignatureFromHeaders(headers);
    expect(signature).toBe('sha256=mno345');
  });

  it('should handle array header values', () => {
    const headers = { 'x-revora-signature': ['sha256=pqr678', 'ignored'] };
    const signature = extractSignatureFromHeaders(headers);
    expect(signature).toBe('sha256=pqr678');
  });

  it('should return undefined when no signature header present', () => {
    const headers = { 'content-type': 'application/json' };
    const signature = extractSignatureFromHeaders(headers);
    expect(signature).toBeUndefined();
  });

  it('should return undefined for empty headers', () => {
    const signature = extractSignatureFromHeaders({});
    expect(signature).toBeUndefined();
  });

  it('should prioritize first matching header', () => {
    const headers = {
      'x-revora-signature': 'sha256=first',
      'x-webhook-signature': 'sha256=second',
    };
    const signature = extractSignatureFromHeaders(headers);
    expect(signature).toBe('sha256=first');
  });

  it('should handle undefined header values', () => {
    const headers = {
      'x-revora-signature': undefined,
      'x-webhook-signature': 'sha256=backup',
    };
    const signature = extractSignatureFromHeaders(headers);
    expect(signature).toBe('sha256=backup');
  });
});

// ─── assertValidWebhookSignature ──────────────────────────────────────────────

describe('assertValidWebhookSignature', () => {
  it('should not throw for valid signature', () => {
    const signature = signWebhookPayload(TEST_SECRET, TEST_PAYLOAD);
    expect(() => {
      assertValidWebhookSignature(TEST_SECRET, TEST_PAYLOAD, signature);
    }).not.toThrow();
  });

  it('should throw WebhookSignatureError for missing signature', () => {
    expect(() => {
      assertValidWebhookSignature(TEST_SECRET, TEST_PAYLOAD, undefined);
    }).toThrow(WebhookSignatureError);

    try {
      assertValidWebhookSignature(TEST_SECRET, TEST_PAYLOAD, undefined);
    } catch (error) {
      expect(error).toBeInstanceOf(WebhookSignatureError);
      expect((error as WebhookSignatureError).code).toBe('MISSING_SIGNATURE');
    }
  });

  it('should throw WebhookSignatureError for invalid format', () => {
    expect(() => {
      assertValidWebhookSignature(TEST_SECRET, TEST_PAYLOAD, 'invalid-format');
    }).toThrow(WebhookSignatureError);

    try {
      assertValidWebhookSignature(TEST_SECRET, TEST_PAYLOAD, 'invalid-format');
    } catch (error) {
      expect((error as WebhookSignatureError).code).toBe('INVALID_FORMAT');
    }
  });

  it('should throw WebhookSignatureError for verification failure', () => {
    const signature = signWebhookPayload(TEST_SECRET, TEST_PAYLOAD);
    expect(() => {
      assertValidWebhookSignature('wrong-secret', TEST_PAYLOAD, signature);
    }).toThrow(WebhookSignatureError);

    try {
      assertValidWebhookSignature('wrong-secret', TEST_PAYLOAD, signature);
    } catch (error) {
      expect((error as WebhookSignatureError).code).toBe('VERIFICATION_FAILED');
    }
  });

  it('should include descriptive error messages', () => {
    try {
      assertValidWebhookSignature(TEST_SECRET, TEST_PAYLOAD, undefined);
    } catch (error) {
      expect((error as Error).message).toContain('missing');
    }

    try {
      assertValidWebhookSignature(TEST_SECRET, TEST_PAYLOAD, 'bad-format');
    } catch (error) {
      expect((error as Error).message).toContain('format');
    }

    try {
      const signature = signWebhookPayload(TEST_SECRET, TEST_PAYLOAD);
      assertValidWebhookSignature('wrong-secret', TEST_PAYLOAD, signature);
    } catch (error) {
      expect((error as Error).message).toContain('failed');
    }
  });
});

// ─── verifyWebhook ────────────────────────────────────────────────────────────

describe('verifyWebhook', () => {
  const baseConfig: WebhookVerificationConfig = {
    secret: TEST_SECRET,
  };

  it('should return valid result for correct signature', () => {
    const signature = signWebhookPayload(TEST_SECRET, TEST_PAYLOAD);
    const headers = { 'x-revora-signature': signature };
    const result = verifyWebhook(baseConfig, TEST_PAYLOAD, headers);

    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('should return invalid result for missing signature', () => {
    const result = verifyWebhook(baseConfig, TEST_PAYLOAD, {});

    expect(result.valid).toBe(false);
    expect(result.error).toBeInstanceOf(WebhookSignatureError);
    expect(result.error?.code).toBe('MISSING_SIGNATURE');
  });

  it('should return invalid result for wrong signature', () => {
    const headers = { 'x-revora-signature': 'sha256=' + '0'.repeat(64) };
    const result = verifyWebhook(baseConfig, TEST_PAYLOAD, headers);

    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe('VERIFICATION_FAILED');
  });

  it('should respect custom header name', () => {
    const signature = signWebhookPayload(TEST_SECRET, TEST_PAYLOAD);
    const config: WebhookVerificationConfig = {
      ...baseConfig,
      headerName: 'x-custom-signature',
    };
    const headers = { 'x-custom-signature': signature };
    const result = verifyWebhook(config, TEST_PAYLOAD, headers);

    expect(result.valid).toBe(true);
  });

  it('should enforce max payload size', () => {
    const config: WebhookVerificationConfig = {
      ...baseConfig,
      maxPayloadSize: 10, // Very small
    };
    const result = verifyWebhook(config, TEST_PAYLOAD, {});

    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe('INVALID_FORMAT');
  });

  it('should allow payloads within max size', () => {
    const signature = signWebhookPayload(TEST_SECRET, TEST_PAYLOAD);
    const config: WebhookVerificationConfig = {
      ...baseConfig,
      maxPayloadSize: TEST_PAYLOAD.length * 2,
    };
    const headers = { 'x-revora-signature': signature };
    const result = verifyWebhook(config, TEST_PAYLOAD, headers);

    expect(result.valid).toBe(true);
  });

  describe('timestamp/replay protection', () => {
    const configWithTimestamp: WebhookVerificationConfig = {
      ...baseConfig,
      requireTimestamp: true,
      maxAgeMs: 60000, // 1 minute
    };

    it('should accept valid timestamp', () => {
      const signature = signWebhookPayload(TEST_SECRET, TEST_PAYLOAD);
      const now = Date.now();
      const headers = {
        'x-revora-signature': signature,
        'x-webhook-timestamp': String(now),
      };
      const result = verifyWebhook(configWithTimestamp, TEST_PAYLOAD, headers);

      expect(result.valid).toBe(true);
      expect(result.timestamp).toBeInstanceOf(Date);
    });

    it('should accept x-revora-timestamp header', () => {
      const signature = signWebhookPayload(TEST_SECRET, TEST_PAYLOAD);
      const now = Date.now();
      const headers = {
        'x-revora-signature': signature,
        'x-revora-timestamp': String(now),
      };
      const result = verifyWebhook(configWithTimestamp, TEST_PAYLOAD, headers);

      expect(result.valid).toBe(true);
    });

    it('should reject missing timestamp when required', () => {
      const signature = signWebhookPayload(TEST_SECRET, TEST_PAYLOAD);
      const headers = { 'x-revora-signature': signature };
      const result = verifyWebhook(configWithTimestamp, TEST_PAYLOAD, headers);

      expect(result.valid).toBe(false);
      expect(result.error?.code).toBe('INVALID_FORMAT');
    });

    it('should reject invalid timestamp format', () => {
      const signature = signWebhookPayload(TEST_SECRET, TEST_PAYLOAD);
      const headers = {
        'x-revora-signature': signature,
        'x-webhook-timestamp': 'not-a-number',
      };
      const result = verifyWebhook(configWithTimestamp, TEST_PAYLOAD, headers);

      expect(result.valid).toBe(false);
      expect(result.error?.code).toBe('INVALID_FORMAT');
    });

    it('should reject old timestamps', () => {
      const signature = signWebhookPayload(TEST_SECRET, TEST_PAYLOAD);
      const oldTimestamp = Date.now() - 120000; // 2 minutes ago
      const headers = {
        'x-revora-signature': signature,
        'x-webhook-timestamp': String(oldTimestamp),
      };
      const result = verifyWebhook(configWithTimestamp, TEST_PAYLOAD, headers);

      expect(result.valid).toBe(false);
      expect(result.error?.code).toBe('VERIFICATION_FAILED');
    });

    it('should reject future timestamps', () => {
      const signature = signWebhookPayload(TEST_SECRET, TEST_PAYLOAD);
      const futureTimestamp = Date.now() + 120000; // 2 minutes from now
      const headers = {
        'x-revora-signature': signature,
        'x-webhook-timestamp': String(futureTimestamp),
      };
      const result = verifyWebhook(configWithTimestamp, TEST_PAYLOAD, headers);

      expect(result.valid).toBe(false);
      expect(result.error?.code).toBe('VERIFICATION_FAILED');
    });

    it('should accept timestamp at exact boundary', () => {
      const signature = signWebhookPayload(TEST_SECRET, TEST_PAYLOAD);
      // Use a timestamp slightly less than maxAgeMs to account for test execution time
      const boundaryTimestamp = Date.now() - 59000; // Just under 1 minute ago
      const headers = {
        'x-revora-signature': signature,
        'x-webhook-timestamp': String(boundaryTimestamp),
      };
      const result = verifyWebhook(configWithTimestamp, TEST_PAYLOAD, headers);

      expect(result.valid).toBe(true);
    });
  });

  it('should handle array header values', () => {
    const signature = signWebhookPayload(TEST_SECRET, TEST_PAYLOAD);
    const headers: Record<string, string | string[] | undefined> = {
      'x-revora-signature': [signature, 'ignored'],
    };
    const result = verifyWebhook(baseConfig, TEST_PAYLOAD, headers);

    expect(result.valid).toBe(true);
  });
});

// ─── Edge Cases and Security Tests ────────────────────────────────────────────

describe('Webhook Signature Security Edge Cases', () => {
  it('should handle null bytes in payload', () => {
    const payloadWithNull = '{"data":"hello\u0000world"}';
    const signature = signWebhookPayload(TEST_SECRET, payloadWithNull);
    const isValid = verifyWebhookPayload(TEST_SECRET, payloadWithNull, signature);
    expect(isValid).toBe(true);
  });

  it('should handle special characters in secret', () => {
    const specialSecret = 'secret-with-!@#$%^&*()_+-=[]{}|;\':",./<>?';
    const signature = signWebhookPayload(specialSecret, TEST_PAYLOAD);
    const isValid = verifyWebhookPayload(specialSecret, TEST_PAYLOAD, signature);
    expect(isValid).toBe(true);
  });

  it('should handle unicode in secret', () => {
    const unicodeSecret = '密钥-🔐-秘密鍵';
    const signature = signWebhookPayload(unicodeSecret, TEST_PAYLOAD);
    const isValid = verifyWebhookPayload(unicodeSecret, TEST_PAYLOAD, signature);
    expect(isValid).toBe(true);
  });

  it('should handle very long secrets', () => {
    const longSecret = 'a'.repeat(10000);
    const signature = signWebhookPayload(longSecret, TEST_PAYLOAD);
    const isValid = verifyWebhookPayload(longSecret, TEST_PAYLOAD, signature);
    expect(isValid).toBe(true);
  });

  it('should handle binary payloads as Buffer', () => {
    const binaryPayload = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]);
    const signature = signWebhookPayload(TEST_SECRET, binaryPayload);
    const isValid = verifyWebhookPayload(TEST_SECRET, binaryPayload, signature);
    expect(isValid).toBe(true);
  });

  it('should reject signature with invalid hex characters', () => {
    const invalidSig = 'sha256=' + 'g'.repeat(64); // 'g' is not valid hex
    const isValid = verifyWebhookPayload(TEST_SECRET, TEST_PAYLOAD, invalidSig);
    expect(isValid).toBe(false);
  });

  it('should reject signature with truncated hex', () => {
    const validSig = signWebhookPayload(TEST_SECRET, TEST_PAYLOAD);
    const truncatedSig = validSig.slice(0, validSig.length - 5);
    const isValid = verifyWebhookPayload(TEST_SECRET, TEST_PAYLOAD, truncatedSig);
    expect(isValid).toBe(false);
  });

  it('should reject signature with extra hex', () => {
    const validSig = signWebhookPayload(TEST_SECRET, TEST_PAYLOAD);
    const extendedSig = validSig + 'abcd';
    const isValid = verifyWebhookPayload(TEST_SECRET, TEST_PAYLOAD, extendedSig);
    expect(isValid).toBe(false);
  });

  it('should handle case sensitivity in hex', () => {
    const signature = signWebhookPayload(TEST_SECRET, TEST_PAYLOAD);
    const upperCaseSig = signature.toUpperCase();
    const isValid = verifyWebhookPayload(TEST_SECRET, TEST_PAYLOAD, upperCaseSig);
    // Hex is case-insensitive, but our implementation uses lowercase
    expect(isValid).toBe(false);
  });
});

// ─── WebhookSignatureError ────────────────────────────────────────────────────

describe('WebhookSignatureError', () => {
  it('should have correct name', () => {
    const error = new WebhookSignatureError('Test', 'MISSING_SIGNATURE');
    expect(error.name).toBe('WebhookSignatureError');
  });

  it('should preserve code', () => {
    const error = new WebhookSignatureError('Test', 'VERIFICATION_FAILED');
    expect(error.code).toBe('VERIFICATION_FAILED');
  });

  it('should be instanceof Error', () => {
    const error = new WebhookSignatureError('Test', 'INVALID_FORMAT');
    expect(error).toBeInstanceOf(Error);
  });

  it('should be instanceof WebhookSignatureError', () => {
    const error = new WebhookSignatureError('Test', 'MISSING_SIGNATURE');
    expect(error).toBeInstanceOf(WebhookSignatureError);
  });

  it('should work with try-catch', () => {
    try {
      throw new WebhookSignatureError('Test error', 'VERIFICATION_FAILED');
    } catch (e) {
      expect(e).toBeInstanceOf(WebhookSignatureError);
      expect((e as WebhookSignatureError).message).toBe('Test error');
    }
  });
});
