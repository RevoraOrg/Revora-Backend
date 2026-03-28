import { createHmac, timingSafeEqual } from 'crypto';

/**
 * @title Webhook Signature Verification
 * @notice Production-grade HMAC-SHA256 signature verification for incoming webhooks.
 * @dev Implements constant-time comparison to prevent timing attacks.
 *
 * Security assumptions:
 * - Secrets are cryptographically random and sufficiently long (>= 32 bytes recommended)
 * - Secrets are stored securely and never transmitted
 * - Signature format follows the standard: sha256=<hex>
 * - Payload bodies are not modified between signing and verification
 *
 * Abuse/failure paths handled:
 * - Missing or malformed signatures
 * - Signature length mismatches (preventing timing attack vectors)
 * - Invalid hex encoding in signatures
 * - Timing attacks via constant-time comparison
 * - Empty secrets or payloads
 */

/**
 * @notice Error thrown when signature verification fails.
 */
export class WebhookSignatureError extends Error {
  constructor(
    message: string,
    public readonly code: 'MISSING_SIGNATURE' | 'INVALID_FORMAT' | 'VERIFICATION_FAILED'
  ) {
    super(message);
    this.name = 'WebhookSignatureError';
    Object.setPrototypeOf(this, WebhookSignatureError.prototype);
  }
}

/**
 * @notice Generates an HMAC-SHA256 signature for a webhook payload.
 * @param secret The shared secret key
 * @param payload The raw request body (string or Buffer)
 * @returns A signature string in the format `sha256=<hex>`
 *
 * @example
 * ```typescript
 * const signature = signWebhookPayload('my-secret', '{"event":"test"}');
 * // Returns: "sha256=a1b2c3d4..."
 * ```
 */
export function signWebhookPayload(secret: string, payload: string | Buffer): string {
  const hmac = createHmac('sha256', secret);
  hmac.update(payload);
  return `sha256=${hmac.digest('hex')}`;
}

/**
 * @notice Verifies an HMAC-SHA256 signature against a webhook payload.
 * @dev Uses timing-safe comparison to prevent timing attacks.
 *
 * @param secret The shared secret key
 * @param payload The raw request body (string or Buffer)
 * @param signature The signature to verify (format: `sha256=<hex>`)
 * @returns `true` if the signature is valid, `false` otherwise
 *
 * @example
 * ```typescript
 * const isValid = verifyWebhookPayload('my-secret', body, 'sha256=a1b2c3d4...');
 * ```
 */
export function verifyWebhookPayload(
  secret: string,
  payload: string | Buffer,
  signature: string | string[]
): boolean {
  // Handle edge cases - allow empty string secret but not undefined/null
  if (secret === undefined || secret === null || !payload || !signature) {
    return false;
  }

  // Handle array signature (take first element)
  const signatureStr = Array.isArray(signature) ? signature[0] : signature;
  if (!signatureStr || typeof signatureStr !== 'string') {
    return false;
  }

  // Validate signature format
  if (!signatureStr.startsWith('sha256=')) {
    return false;
  }

  const expectedSignature = signWebhookPayload(secret, payload);

  // Ensure signatures are the same length before comparison
  if (signatureStr.length !== expectedSignature.length) {
    return false;
  }

  // Constant-time comparison to prevent timing attacks
  try {
    const signatureBuffer = Buffer.from(signatureStr, 'utf8');
    const expectedBuffer = Buffer.from(expectedSignature, 'utf8');
    return timingSafeEqual(signatureBuffer, expectedBuffer);
  } catch {
    // If buffers can't be compared, fall back to safe false
    return false;
  }
}

/**
 * @notice Extracts the signature from request headers.
 * @dev Supports both 'X-Revora-Signature' and standard 'X-Webhook-Signature' headers.
 *
 * @param headers The request headers object (case-insensitive lookup)
 * @returns The signature string or undefined if not found
 *
 * @example
 * ```typescript
 * const signature = extractSignatureFromHeaders(req.headers);
 * ```
 */
export function extractSignatureFromHeaders(
  headers: Record<string, string | string[] | undefined>
): string | undefined {
  // Common webhook signature header names
  const headerNames = [
    'x-revora-signature',
    'x-webhook-signature',
    'x-signature',
    'x-hub-signature-256', // GitHub-style
  ];

  for (const name of headerNames) {
    const value = headers[name] ?? headers[name.toLowerCase()];
    if (typeof value === 'string') {
      return value;
    }
    if (Array.isArray(value) && value.length > 0) {
      return value[0];
    }
  }

  return undefined;
}

/**
 * @notice Validates and verifies a webhook signature, throwing on failure.
 * @dev Use this when you want explicit error handling for different failure modes.
 *
 * @param secret The shared secret key
 * @param payload The raw request body
 * @param signature The signature to verify
 * @throws {WebhookSignatureError} When signature is missing, malformed, or invalid
 *
 * @example
 * ```typescript
 * try {
 *   assertValidWebhookSignature(secret, body, signature);
 *   // Process webhook...
 * } catch (error) {
 *   if (error instanceof WebhookSignatureError) {
 *     // Handle specific verification failure
 *   }
 * }
 * ```
 */
export function assertValidWebhookSignature(
  secret: string,
  payload: string | Buffer,
  signature: string | undefined
): void {
  if (!signature) {
    throw new WebhookSignatureError(
      'Webhook signature is missing',
      'MISSING_SIGNATURE'
    );
  }

  if (!signature.startsWith('sha256=')) {
    throw new WebhookSignatureError(
      'Invalid signature format. Expected: sha256=<hex>',
      'INVALID_FORMAT'
    );
  }

  if (!verifyWebhookPayload(secret, payload, signature)) {
    throw new WebhookSignatureError(
      'Webhook signature verification failed',
      'VERIFICATION_FAILED'
    );
  }
}

/**
 * @notice Configuration options for webhook signature verification.
 */
export interface WebhookVerificationConfig {
  /** The shared secret key */
  secret: string;
  /** Custom header name for the signature (default: 'x-revora-signature') */
  headerName?: string;
  /** Maximum payload size in bytes (default: 1MB) */
  maxPayloadSize?: number;
  /** Whether to require a timestamp header for replay protection */
  requireTimestamp?: boolean;
  /** Maximum age of webhook in milliseconds for replay protection (default: 5 minutes) */
  maxAgeMs?: number;
}

/**
 * @notice Result of a webhook verification operation.
 */
export interface WebhookVerificationResult {
  valid: boolean;
  error?: WebhookSignatureError;
  /** Parsed timestamp if present and valid */
  timestamp?: Date;
}

/**
 * @notice Comprehensive webhook verification with optional replay protection.
 * @dev Validates signature, payload size, and optionally timestamp for replay protection.
 *
 * @param config Verification configuration
 * @param payload The raw request body
 * @param headers The request headers
 * @returns Verification result with details
 *
 * @example
 * ```typescript
 * const result = verifyWebhook({
 *   secret: 'my-secret',
 *   requireTimestamp: true,
 *   maxAgeMs: 300000 // 5 minutes
 * }, body, headers);
 *
 * if (!result.valid) {
 *   // Handle verification failure
 * }
 * ```
 */
export function verifyWebhook(
  config: WebhookVerificationConfig,
  payload: string | Buffer,
  headers: Record<string, string | string[] | undefined>
): WebhookVerificationResult {
  const {
    secret,
    headerName = 'x-revora-signature',
    maxPayloadSize = 1024 * 1024, // 1MB default
    requireTimestamp = false,
    maxAgeMs = 5 * 60 * 1000, // 5 minutes default
  } = config;

  // Check payload size
  const payloadSize = Buffer.isBuffer(payload) ? payload.length : Buffer.byteLength(payload);
  if (payloadSize > maxPayloadSize) {
    return {
      valid: false,
      error: new WebhookSignatureError(
        `Payload exceeds maximum size of ${maxPayloadSize} bytes`,
        'INVALID_FORMAT'
      ),
    };
  }

  // Extract signature (handle both string and array header values)
  const rawSignature = headers[headerName.toLowerCase()] ?? extractSignatureFromHeaders(headers);
  const signature = Array.isArray(rawSignature) ? rawSignature[0] : rawSignature;

  if (!signature) {
    return {
      valid: false,
      error: new WebhookSignatureError(
        `Missing signature header: ${headerName}`,
        'MISSING_SIGNATURE'
      ),
    };
  }

  // Verify signature
  if (!verifyWebhookPayload(secret, payload, signature)) {
    return {
      valid: false,
      error: new WebhookSignatureError(
        'Signature verification failed',
        'VERIFICATION_FAILED'
      ),
    };
  }

  // Optional timestamp/replay protection
  let timestamp: Date | undefined;
  if (requireTimestamp) {
    const timestampHeader = headers['x-webhook-timestamp'] ?? headers['x-revora-timestamp'];
    const timestampStr = Array.isArray(timestampHeader) ? timestampHeader[0] : timestampHeader;

    if (!timestampStr) {
      return {
        valid: false,
        error: new WebhookSignatureError(
          'Missing required timestamp header',
          'INVALID_FORMAT'
        ),
      };
    }

    const timestampNum = parseInt(timestampStr, 10);
    if (isNaN(timestampNum)) {
      return {
        valid: false,
        error: new WebhookSignatureError(
          'Invalid timestamp format',
          'INVALID_FORMAT'
        ),
      };
    }

    timestamp = new Date(timestampNum);
    const now = Date.now();
    const age = now - timestamp.getTime();

    if (age < 0 || age > maxAgeMs) {
      return {
        valid: false,
        error: new WebhookSignatureError(
          `Webhook timestamp outside acceptable window (max age: ${maxAgeMs}ms)`,
          'VERIFICATION_FAILED'
        ),
      };
    }
  }

  return { valid: true, timestamp };
}
