import { Request, Response, NextFunction, RequestHandler } from 'express';
import {
  verifyWebhookPayload,
  extractSignatureFromHeaders,
  WebhookSignatureError,
  WebhookVerificationConfig,
  verifyWebhook,
} from '../lib/webhookSignature';

/**
 * @title Webhook Authentication Middleware
 * @notice Express middleware for verifying webhook signatures on incoming requests.
 * @dev Validates HMAC-SHA256 signatures to ensure webhooks are authentic.
 *
 * Security assumptions:
 * - Webhook secrets are securely stored and never exposed
 * - Requests contain the raw body (before JSON parsing) for signature verification
 * - Signatures follow the format: sha256=<hex>
 *
 * Abuse/failure paths handled:
 * - Missing or malformed signature headers
 * - Invalid signatures (tampered payloads)
 * - Replay attacks (via optional timestamp validation)
 * - Timing attacks (via constant-time comparison)
 */

/**
 * @notice Configuration options for webhook authentication middleware.
 */
export interface WebhookAuthOptions {
  /** The shared secret for signature verification */
  secret: string;
  /** Custom header name for signature (default: 'x-revora-signature') */
  headerName?: string;
  /** Whether to require timestamp header for replay protection (default: false) */
  requireTimestamp?: boolean;
  /** Maximum webhook age in milliseconds (default: 5 minutes) */
  maxAgeMs?: number;
  /** Maximum payload size in bytes (default: 1MB) */
  maxPayloadSize?: number;
  /** Custom error handler */
  onError?: (error: WebhookSignatureError, req: Request, res: Response) => void;
}

/**
 * @notice Extended request interface with webhook verification info.
 */
export interface WebhookAuthenticatedRequest extends Request {
  webhook?: {
    verified: boolean;
    timestamp?: Date;
  };
}

/**
 * @notice Default error response handler.
 */
function defaultErrorHandler(error: WebhookSignatureError, _req: Request, res: Response): void {
  const statusCode = error.code === 'MISSING_SIGNATURE' ? 401 : 403;
  res.status(statusCode).json({
    error: 'Webhook verification failed',
    code: error.code,
    message: error.message,
  });
}

/**
 * @notice Creates Express middleware for webhook signature verification.
 * @dev Verifies the HMAC-SHA256 signature of incoming webhook requests.
 *
 * @param options Configuration options for verification
 * @returns Express middleware function
 *
 * @example
 * ```typescript
 * // Basic usage
 * app.post('/webhooks', webhookAuth({ secret: 'my-secret' }), webhookHandler);
 *
 * // With replay protection
 * app.post('/webhooks', webhookAuth({
 *   secret: 'my-secret',
 *   requireTimestamp: true,
 *   maxAgeMs: 300000 // 5 minutes
 * }), webhookHandler);
 *
 * // With custom error handling
 * app.post('/webhooks', webhookAuth({
 *   secret: 'my-secret',
 *   onError: (err, req, res) => {
 *     logger.warn('Invalid webhook', err);
 *     res.status(401).json({ error: 'Invalid webhook' });
 *   }
 * }), webhookHandler);
 * ```
 */
export function webhookAuth(options: WebhookAuthOptions): RequestHandler {
  const {
    secret,
    headerName = 'x-revora-signature',
    requireTimestamp = false,
    maxAgeMs = 5 * 60 * 1000, // 5 minutes
    maxPayloadSize = 1024 * 1024, // 1MB
    onError = defaultErrorHandler,
  } = options;

  return (req: Request, res: Response, next: NextFunction): void => {
    // Get the raw body for signature verification
    // Note: This requires express.raw() or express.json() with verify option
    const payload = req.body;

    if (!payload) {
      onError(
        new WebhookSignatureError('Request body is required', 'MISSING_SIGNATURE'),
        req,
        res
      );
      return;
    }

    // Convert body to string if it's a Buffer, otherwise stringify
    let payloadString: string;
    if (Buffer.isBuffer(payload)) {
      payloadString = payload.toString('utf8');
    } else if (typeof payload === 'string') {
      payloadString = payload;
    } else {
      // If body was parsed as JSON, re-stringify for verification
      payloadString = JSON.stringify(payload);
    }

    // Check payload size
    const payloadSize = Buffer.byteLength(payloadString);
    if (payloadSize > maxPayloadSize) {
      onError(
        new WebhookSignatureError(
          `Payload exceeds maximum size of ${maxPayloadSize} bytes`,
          'INVALID_FORMAT'
        ),
        req,
        res
      );
      return;
    }

    // Extract signature from headers
    const rawSignature = req.headers[headerName.toLowerCase()] ?? extractSignatureFromHeaders(req.headers);
    const signature = Array.isArray(rawSignature) ? rawSignature[0] : rawSignature;

    if (!signature) {
      onError(
        new WebhookSignatureError(
          `Missing signature header: ${headerName}`,
          'MISSING_SIGNATURE'
        ),
        req,
        res
      );
      return;
    }

    // Verify signature
    if (!verifyWebhookPayload(secret, payloadString, signature)) {
      onError(
        new WebhookSignatureError('Signature verification failed', 'VERIFICATION_FAILED'),
        req,
        res
      );
      return;
    }

    // Optional timestamp/replay protection
    let timestamp: Date | undefined;
    if (requireTimestamp) {
      const timestampHeader = req.headers['x-webhook-timestamp'] ?? req.headers['x-revora-timestamp'];
      const timestampStr = Array.isArray(timestampHeader) ? timestampHeader[0] : timestampHeader;

      if (!timestampStr) {
        onError(
          new WebhookSignatureError('Missing required timestamp header', 'INVALID_FORMAT'),
          req,
          res
        );
        return;
      }

      const timestampNum = parseInt(timestampStr, 10);
      if (isNaN(timestampNum)) {
        onError(
          new WebhookSignatureError('Invalid timestamp format', 'INVALID_FORMAT'),
          req,
          res
        );
        return;
      }

      timestamp = new Date(timestampNum);
      const now = Date.now();
      const age = now - timestamp.getTime();

      if (age < 0 || age > maxAgeMs) {
        onError(
          new WebhookSignatureError(
            `Webhook timestamp outside acceptable window`,
            'VERIFICATION_FAILED'
          ),
          req,
          res
        );
        return;
      }
    }

    // Attach webhook verification info to request
    (req as WebhookAuthenticatedRequest).webhook = {
      verified: true,
      timestamp,
    };

    next();
  };
}

/**
 * @notice Creates a comprehensive webhook verification middleware using the full verification function.
 * @dev Provides more detailed configuration options than webhookAuth.
 *
 * @param config Webhook verification configuration
 * @returns Express middleware function
 *
 * @example
 * ```typescript
 * app.post('/webhooks', webhookVerify({
 *   secret: 'my-secret',
 *   headerName: 'x-custom-signature',
 *   requireTimestamp: true,
 *   maxAgeMs: 60000,
 *   maxPayloadSize: 512 * 1024 // 512KB
 * }), webhookHandler);
 * ```
 */
export function webhookVerify(config: WebhookVerificationConfig): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    // Get the raw body for signature verification
    const payload = req.body;

    if (!payload) {
      res.status(400).json({
        error: 'Bad Request',
        message: 'Request body is required',
      });
      return;
    }

    // Convert body to string/Buffer for verification
    let payloadData: string | Buffer;
    if (Buffer.isBuffer(payload)) {
      payloadData = payload;
    } else if (typeof payload === 'string') {
      payloadData = payload;
    } else {
      payloadData = JSON.stringify(payload);
    }

    // Perform verification
    const result = verifyWebhook(config, payloadData, req.headers);

    if (!result.valid) {
      const statusCode = result.error?.code === 'MISSING_SIGNATURE' ? 401 : 403;
      res.status(statusCode).json({
        error: 'Webhook verification failed',
        code: result.error?.code,
        message: result.error?.message,
      });
      return;
    }

    // Attach webhook verification info to request
    (req as WebhookAuthenticatedRequest).webhook = {
      verified: true,
      timestamp: result.timestamp,
    };

    next();
  };
}

/**
 * @notice Factory function to create a webhook auth middleware with a secret provider.
 * @dev Useful when secrets are stored in a database or external service.
 *
 * @param secretProvider Async function that returns the secret for a given webhook endpoint
 * @param options Additional middleware options
 * @returns Express middleware function
 *
 * @example
 * ```typescript
 * app.post('/webhooks/:endpointId', webhookAuthWithProvider(
 *   async (endpointId) => {
 *     const endpoint = await db.webhookEndpoints.findById(endpointId);
 *     return endpoint?.secret;
 *   },
 *   { requireTimestamp: true }
 * ), webhookHandler);
 * ```
 */
export interface WebhookAuthProviderOptions extends Omit<WebhookAuthOptions, 'secret'> {
  /** Extract endpoint identifier from request for secret lookup */
  endpointIdExtractor?: (req: Request) => string;
}

export function webhookAuthWithProvider(
  secretProvider: (endpointId: string) => Promise<string | null | undefined>,
  options: WebhookAuthProviderOptions = {}
): RequestHandler {
  const {
    endpointIdExtractor = (req: Request) => req.params.endpointId,
    headerName = 'x-revora-signature',
    requireTimestamp = false,
    maxAgeMs = 5 * 60 * 1000,
    maxPayloadSize = 1024 * 1024,
    onError = defaultErrorHandler,
  } = options;

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const endpointId = endpointIdExtractor(req);

    if (!endpointId) {
      onError(
        new WebhookSignatureError('Endpoint identifier is required', 'INVALID_FORMAT'),
        req,
        res
      );
      return;
    }

    // Fetch secret from provider
    let secret: string | null | undefined;
    try {
      secret = await secretProvider(endpointId);
    } catch (error) {
      onError(
        new WebhookSignatureError('Failed to retrieve webhook secret', 'VERIFICATION_FAILED'),
        req,
        res
      );
      return;
    }

    if (!secret) {
      onError(
        new WebhookSignatureError('Webhook endpoint not found or inactive', 'VERIFICATION_FAILED'),
        req,
        res
      );
      return;
    }

    // Get the raw body
    const payload = req.body;
    if (!payload) {
      onError(
        new WebhookSignatureError('Request body is required', 'MISSING_SIGNATURE'),
        req,
        res
      );
      return;
    }

    // Convert body to string
    let payloadString: string;
    if (Buffer.isBuffer(payload)) {
      payloadString = payload.toString('utf8');
    } else if (typeof payload === 'string') {
      payloadString = payload;
    } else {
      payloadString = JSON.stringify(payload);
    }

    // Check payload size
    const payloadSize = Buffer.byteLength(payloadString);
    if (payloadSize > maxPayloadSize) {
      onError(
        new WebhookSignatureError(
          `Payload exceeds maximum size of ${maxPayloadSize} bytes`,
          'INVALID_FORMAT'
        ),
        req,
        res
      );
      return;
    }

    // Extract signature
    const rawSignature = req.headers[headerName.toLowerCase()] ?? extractSignatureFromHeaders(req.headers);
    const signature = Array.isArray(rawSignature) ? rawSignature[0] : rawSignature;

    if (!signature) {
      onError(
        new WebhookSignatureError(
          `Missing signature header: ${headerName}`,
          'MISSING_SIGNATURE'
        ),
        req,
        res
      );
      return;
    }

    // Verify signature
    if (!verifyWebhookPayload(secret, payloadString, signature)) {
      onError(
        new WebhookSignatureError('Signature verification failed', 'VERIFICATION_FAILED'),
        req,
        res
      );
      return;
    }

    // Optional timestamp validation
    let timestamp: Date | undefined;
    if (requireTimestamp) {
      const timestampHeader = req.headers['x-webhook-timestamp'] ?? req.headers['x-revora-timestamp'];
      const timestampStr = Array.isArray(timestampHeader) ? timestampHeader[0] : timestampHeader;

      if (!timestampStr) {
        onError(
          new WebhookSignatureError('Missing required timestamp header', 'INVALID_FORMAT'),
          req,
          res
        );
        return;
      }

      const timestampNum = parseInt(timestampStr, 10);
      if (isNaN(timestampNum)) {
        onError(
          new WebhookSignatureError('Invalid timestamp format', 'INVALID_FORMAT'),
          req,
          res
        );
        return;
      }

      timestamp = new Date(timestampNum);
      const now = Date.now();
      const age = now - timestamp.getTime();

      if (age < 0 || age > maxAgeMs) {
        onError(
          new WebhookSignatureError(
            `Webhook timestamp outside acceptable window`,
            'VERIFICATION_FAILED'
          ),
          req,
          res
        );
        return;
      }
    }

    // Attach webhook verification info
    (req as WebhookAuthenticatedRequest).webhook = {
      verified: true,
      timestamp,
    };

    next();
  };
}
