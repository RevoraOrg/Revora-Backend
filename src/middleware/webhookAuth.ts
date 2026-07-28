import { Request, Response, NextFunction, RequestHandler } from 'express';
import {
  verifyWebhookPayload,
  extractSignatureFromHeaders,
  WebhookSignatureError,
  WebhookVerificationConfig,
  verifyWebhook,
  verifyWebhookPayloadDualKey,
} from '../lib/webhookSignature';
import { Errors } from '../lib/errors';
import { globalLogger } from '../lib/logger';
import { globalMetrics } from '../lib/metrics';

/**
 * @title Webhook Authentication Middleware
 * @notice Express middleware for verifying webhook signatures on incoming requests.
 * @dev Validates HMAC-SHA256 signatures to ensure webhooks are authentic. Supports dual-key
 * rotation windows with expiry deadlines for zero-downtime key rollover.
 *
 * Security assumptions:
 * - Webhook secrets are securely stored and never exposed
 * - Requests contain the raw body (before JSON parsing) for signature verification
 * - Signatures follow the format: sha256=<hex>
 * - Secondary/Next key window expires on a strict hard deadline
 *
 * Abuse/failure paths handled:
 * - Missing or malformed signature headers
 * - Invalid signatures (tampered payloads)
 * - Expired secondary key signatures during rotation
 * - Replay attacks (via optional timestamp validation)
 * - Timing attacks (via constant-time comparison)
 */

/**
 * @notice Configuration options for webhook authentication middleware.
 */
export interface WebhookAuthOptions {
  /** The shared primary secret for signature verification */
  secret: string;
  /** Secondary next secret key for dual-key acceptance window during key rotation */
  nextSecret?: string;
  /** Expiry deadline for secondary key acceptance window (Date, ISO string, or timestamp ms) */
  nextSecretExpiry?: Date | string | number;
  /** Metric counter name for verification tracking (e.g. 'kyc.webhook.verified_by_key') */
  metricName?: string;
  /** Custom header name for signature (default: 'x-revora-signature') */
  headerName?: string;
  /** Whether to require timestamp header for replay protection (default: false) */
  requireTimestamp?: boolean;
  /** Maximum webhook age in milliseconds (default: 5 minutes) */
  maxAgeMs?: number;
  /** Maximum payload size in bytes (default: 1MB) */
  maxPayloadSize?: number;
  /**
   * Allowed clock drift for future-dated timestamps in milliseconds (default: 30 seconds).
   * Accommodates minor clock differences between the webhook sender and this server.
   */
  clockSkewMs?: number;
  /** Custom error handler */
  onError?: (error: WebhookSignatureError, req: Request, res: Response) => void;
}

/**
 * @notice Extended request interface with webhook verification info.
 */
export interface WebhookAuthenticatedRequest extends Request {
  webhook?: {
    verified: boolean;
    verifiedByKey?: 'current' | 'next';
    timestamp?: Date;
  };
}

/**
 * @notice Default error response handler.
 * @dev Uses lib/errors factories so the response shape is consistent with the
 * rest of the API and no internal error strings leak to clients.
 */
function defaultErrorHandler(error: WebhookSignatureError, _req: Request, res: Response): void {
  const appErr =
    error.code === 'MISSING_SIGNATURE'
      ? Errors.unauthorized('Webhook authentication required')
      : Errors.forbidden('Webhook verification failed');
  res.status(appErr.statusCode).json(appErr.toResponse());
}

/**
 * @notice Creates Express middleware for webhook signature verification.
 * @dev Verifies the HMAC-SHA256 signature of incoming webhook requests with dual-key support.
 *
 * @param options Configuration options for verification
 * @returns Express middleware function
 */
export function webhookAuth(options: WebhookAuthOptions): RequestHandler {
  const {
    secret,
    nextSecret,
    nextSecretExpiry,
    metricName,
    headerName = 'x-revora-signature',
    requireTimestamp = false,
    maxAgeMs = 5 * 60 * 1000, // 5 minutes
    maxPayloadSize = 1024 * 1024, // 1MB
    clockSkewMs = 30 * 1000, // 30 seconds clock drift tolerance
    onError = defaultErrorHandler,
  } = options;

  return (req: Request, res: Response, next: NextFunction): void => {
    // Get the raw body for signature verification
    const payload = req.body;

    if (!payload) {
      globalLogger.warn('Webhook rejected: missing request body', { path: req.path, method: req.method });
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
      payloadString = JSON.stringify(payload);
    }

    // Check payload size
    const payloadSize = Buffer.byteLength(payloadString);
    if (payloadSize > maxPayloadSize) {
      globalLogger.warn('Webhook rejected: payload too large', {
        path: req.path,
        payloadSize,
        maxPayloadSize,
      });
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
      globalLogger.warn('Webhook rejected: missing signature header', {
        path: req.path,
        header: headerName,
      });
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

    // Perform dual-key signature verification
    const dualKeyResult = verifyWebhookPayloadDualKey(
      { secret, nextSecret, nextSecretExpiry },
      payloadString,
      signature
    );

    if (!dualKeyResult.valid) {
      if (dualKeyResult.expired) {
        globalLogger.warn('Webhook rejected: secondary signature key has expired', { path: req.path });
      } else {
        globalLogger.warn('Webhook rejected: signature mismatch', { path: req.path });
      }
      onError(
        new WebhookSignatureError('Signature verification failed', 'VERIFICATION_FAILED'),
        req,
        res
      );
      return;
    }

    const verifiedByKey = dualKeyResult.verifiedByKey ?? 'current';

    // Emit metric if metricName is specified
    if (metricName) {
      try {
        globalMetrics.incrementCounter(metricName, { key: verifiedByKey });
      } catch {
        // Silently swallow metric collection errors
      }
    }

    // Optional timestamp/replay protection
    let timestamp: Date | undefined;
    if (requireTimestamp) {
      const timestampHeader = req.headers['x-webhook-timestamp'] ?? req.headers['x-revora-timestamp'];
      const timestampStr = Array.isArray(timestampHeader) ? timestampHeader[0] : timestampHeader;

      if (!timestampStr) {
        globalLogger.warn('Webhook rejected: missing timestamp header', { path: req.path });
        onError(
          new WebhookSignatureError('Missing required timestamp header', 'INVALID_FORMAT'),
          req,
          res
        );
        return;
      }

      const timestampNum = parseInt(timestampStr, 10);
      if (isNaN(timestampNum)) {
        globalLogger.warn('Webhook rejected: invalid timestamp format', { path: req.path });
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

      if (age < -clockSkewMs || age > maxAgeMs) {
        globalLogger.warn('Webhook rejected: timestamp outside acceptable window', {
          path: req.path,
          age,
          maxAgeMs,
          clockSkewMs,
        });
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

    globalLogger.debug('Webhook signature verified', { path: req.path, verifiedByKey });

    // Attach webhook verification info to request
    (req as WebhookAuthenticatedRequest).webhook = {
      verified: true,
      verifiedByKey,
      timestamp,
    };

    next();
  };
}

/**
 * @notice Express middleware for KYC provider webhook signature verification with dual-key support.
 * @dev Inspects process.env for KYC_WEBHOOK_SECRET / KYC_WEBHOOK_KEY, KYC_WEBHOOK_KEY_NEXT,
 * and KYC_WEBHOOK_KEY_NEXT_EXPIRY, and emits `kyc.webhook.verified_by_key` metric labeled by key slot.
 *
 * @param options Optional override options for KYC webhook authentication
 * @returns Express middleware function
 */
export function kycWebhookAuth(options: Partial<WebhookAuthOptions> = {}): RequestHandler {
  const secret =
    options.secret ??
    process.env.KYC_WEBHOOK_SECRET ??
    process.env.KYC_WEBHOOK_KEY ??
    '';
  const nextSecret = options.nextSecret ?? process.env.KYC_WEBHOOK_KEY_NEXT;
  const nextSecretExpiry = options.nextSecretExpiry ?? process.env.KYC_WEBHOOK_KEY_NEXT_EXPIRY;
  const metricName = options.metricName ?? 'kyc.webhook.verified_by_key';

  return webhookAuth({
    secret,
    nextSecret,
    nextSecretExpiry,
    metricName,
    ...options,
  });
}

/**
 * @notice Creates a comprehensive webhook verification middleware using the full verification function.
 * @dev Provides more detailed configuration options than webhookAuth.
 *
 * @param config Webhook verification configuration
 * @returns Express middleware function
 */
export function webhookVerify(config: WebhookVerificationConfig): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    // Get the raw body for signature verification
    const payload = req.body;

    if (!payload) {
      globalLogger.warn('Webhook rejected: missing request body', { path: req.path });
      const appErr = Errors.badRequest('Request body is required');
      res.status(appErr.statusCode).json(appErr.toResponse());
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

    // Perform verification (clockSkewMs and dual-key parameters are honoured)
    const result = verifyWebhook(config, payloadData, req.headers);

    if (!result.valid) {
      const appErr =
        result.error?.code === 'MISSING_SIGNATURE'
          ? Errors.unauthorized('Webhook authentication required')
          : Errors.forbidden('Webhook verification failed');
      globalLogger.warn('Webhook rejected via webhookVerify', {
        path: req.path,
        internalCode: result.error?.code,
      });
      res.status(appErr.statusCode).json(appErr.toResponse());
      return;
    }

    globalLogger.debug('Webhook verified via webhookVerify', { path: req.path });

    // Attach webhook verification info to request
    (req as WebhookAuthenticatedRequest).webhook = {
      verified: true,
      verifiedByKey: result.verifiedByKey,
      timestamp: result.timestamp,
    };

    next();
  };
}

/**
 * @notice Type for secret provider return value supporting dual-key configuration.
 */
export type WebhookSecretProviderResult =
  | string
  | null
  | undefined
  | {
      secret: string;
      nextSecret?: string;
      nextSecretExpiry?: Date | string | number;
    };

/**
 * @notice Factory function to create a webhook auth middleware with a secret provider.
 * @dev Useful when secrets are stored in a database or external service.
 *
 * @param secretProvider Async function that returns the secret or dual-key config for a given webhook endpoint
 * @param options Additional middleware options
 * @returns Express middleware function
 */
export interface WebhookAuthProviderOptions extends Omit<WebhookAuthOptions, 'secret'> {
  /** Extract endpoint identifier from request for secret lookup */
  endpointIdExtractor?: (req: Request) => string;
}

export function webhookAuthWithProvider(
  secretProvider: (endpointId: string) => Promise<WebhookSecretProviderResult>,
  options: WebhookAuthProviderOptions = {}
): RequestHandler {
  const {
    endpointIdExtractor = (req: Request) => req.params.endpointId,
    metricName = options.metricName,
    headerName = 'x-revora-signature',
    requireTimestamp = false,
    maxAgeMs = 5 * 60 * 1000,
    maxPayloadSize = 1024 * 1024,
    clockSkewMs = 30 * 1000,
    onError = defaultErrorHandler,
  } = options;

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const endpointId = endpointIdExtractor(req);

    if (!endpointId) {
      globalLogger.warn('Webhook rejected: missing endpoint identifier', { path: req.path });
      onError(
        new WebhookSignatureError('Endpoint identifier is required', 'INVALID_FORMAT'),
        req,
        res
      );
      return;
    }

    // Fetch secret from provider
    let secretResult: WebhookSecretProviderResult;
    try {
      secretResult = await secretProvider(endpointId);
    } catch (error) {
      globalLogger.warn('Webhook rejected: secret provider error', {
        path: req.path,
        endpointId,
      });
      onError(
        new WebhookSignatureError('Failed to retrieve webhook secret', 'VERIFICATION_FAILED'),
        req,
        res
      );
      return;
    }

    if (!secretResult) {
      globalLogger.warn('Webhook rejected: endpoint not found', { path: req.path, endpointId });
      onError(
        new WebhookSignatureError('Webhook endpoint not found or inactive', 'VERIFICATION_FAILED'),
        req,
        res
      );
      return;
    }

    let secret: string;
    let nextSecret: string | undefined = options.nextSecret;
    let nextSecretExpiry: Date | string | number | undefined = options.nextSecretExpiry;

    if (typeof secretResult === 'string') {
      secret = secretResult;
    } else {
      secret = secretResult.secret;
      if (secretResult.nextSecret !== undefined) nextSecret = secretResult.nextSecret;
      if (secretResult.nextSecretExpiry !== undefined) nextSecretExpiry = secretResult.nextSecretExpiry;
    }

    // Get the raw body
    const payload = req.body;
    if (!payload) {
      globalLogger.warn('Webhook rejected: missing request body', { path: req.path });
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
      globalLogger.warn('Webhook rejected: payload too large', {
        path: req.path,
        payloadSize,
        maxPayloadSize,
      });
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
      globalLogger.warn('Webhook rejected: missing signature header', {
        path: req.path,
        header: headerName,
        endpointId,
      });
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

    // Perform dual-key signature verification
    const dualKeyResult = verifyWebhookPayloadDualKey(
      { secret, nextSecret, nextSecretExpiry },
      payloadString,
      signature
    );

    if (!dualKeyResult.valid) {
      globalLogger.warn('Webhook rejected: signature mismatch', { path: req.path, endpointId });
      onError(
        new WebhookSignatureError('Signature verification failed', 'VERIFICATION_FAILED'),
        req,
        res
      );
      return;
    }

    const verifiedByKey = dualKeyResult.verifiedByKey ?? 'current';

    if (metricName) {
      try {
        globalMetrics.incrementCounter(metricName, { key: verifiedByKey });
      } catch {
        // Silently swallow metric errors
      }
    }

    // Optional timestamp validation with clock skew tolerance
    let timestamp: Date | undefined;
    if (requireTimestamp) {
      const timestampHeader = req.headers['x-webhook-timestamp'] ?? req.headers['x-revora-timestamp'];
      const timestampStr = Array.isArray(timestampHeader) ? timestampHeader[0] : timestampHeader;

      if (!timestampStr) {
        globalLogger.warn('Webhook rejected: missing timestamp header', { path: req.path });
        onError(
          new WebhookSignatureError('Missing required timestamp header', 'INVALID_FORMAT'),
          req,
          res
        );
        return;
      }

      const timestampNum = parseInt(timestampStr, 10);
      if (isNaN(timestampNum)) {
        globalLogger.warn('Webhook rejected: invalid timestamp format', { path: req.path });
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

      if (age < -clockSkewMs || age > maxAgeMs) {
        globalLogger.warn('Webhook rejected: timestamp outside acceptable window', {
          path: req.path,
          age,
          maxAgeMs,
          clockSkewMs,
        });
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

    globalLogger.debug('Webhook signature verified (provider)', { path: req.path, endpointId, verifiedByKey });

    // Attach webhook verification info
    (req as WebhookAuthenticatedRequest).webhook = {
      verified: true,
      verifiedByKey,
      timestamp,
    };

    next();
  };
}
