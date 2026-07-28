import crypto from 'crypto';
import { Request, Response, NextFunction, RequestHandler } from 'express';
import { Errors } from '../lib/errors';
import { globalMetrics } from '../lib/metrics';
import { globalLogger } from '../lib/logger';

/**
 * Ed25519 device-signature verification middleware for the mobile companion API.
 *
 * Security model
 * ──────────────
 * 1. At install time the client generates an Ed25519 keypair and sends the
 *    **public** key to the server via POST /mobile/devices/enroll.
 * 2. The server stores the public key keyed by `install_id` (opaque UUID the
 *    client generates once per install and never rotates).
 * 3. Every subsequent request MUST include four headers:
 *
 *    X-Device-Install-Id   – the install identifier
 *    X-Device-Timestamp    – ISO-8601 UTC timestamp of the request
 *    X-Device-Nonce        – random nonce (UUID v4 recommended) unique per request
 *    X-Device-Signature    – base64url-encoded Ed25519 signature over the
 *                            canonical message:
 *                            `<METHOD>\n<path>\n<sha256-of-body>\n<timestamp>\n<nonce>`
 *
 * 4. The middleware verifies:
 *    a. All four headers are present.
 *    b. Timestamp is within ±90 seconds of server time (clock-skew tolerance).
 *    c. The (timestamp, nonce) pair has not been seen before (replay cache).
 *    d. The Ed25519 signature is valid against the stored public key.
 *
 * On success the middleware attaches `{ installId, publicKey }` to
 * `req.deviceAuth` and increments the `mobile.sig.verified` counter.
 *
 * The device public-key store is abstracted behind `DeviceKeyStore` so callers
 * can swap in a persistent implementation (Postgres, Redis, etc.).
 */

// ── Types ────────────────────────────────────────────────────────────────────

export interface DeviceAuthContext {
  installId: string;
  publicKey: string;
}

export interface AuthenticatedDeviceRequest extends Request {
  deviceAuth?: DeviceAuthContext;
}

/**
 * Pluggable store for device public keys. The default implementation is
 * in-memory and suitable for single-instance deployments.
 */
export interface DeviceKeyStore {
  /** Return the public key (PEM) for the given install, or null if unknown. */
  getPublicKey(installId: string): Promise<string | null>;
  /** Persist a new device's public key. */
  setPublicKey(installId: string, publicKey: string): Promise<void>;
}

/**
 * In-memory device key store – acceptable for dev/test; production should
 * back this with a persistent store.
 */
export class InMemoryDeviceKeyStore implements DeviceKeyStore {
  private keys = new Map<string, string>();

  async getPublicKey(installId: string): Promise<string | null> {
    return this.keys.get(installId) ?? null;
  }

  async setPublicKey(installId: string, publicKey: string): Promise<void> {
    this.keys.set(installId, publicKey);
  }

  clear(): void {
    this.keys.clear();
  }
}

// ── Replay cache (timestamp + nonce) ─────────────────────────────────────────

/**
 * Sliding-window replay cache. Entries are evicted automatically after
 * `maxAgeMs`. The default window is 180 s (3× the clock-skew tolerance).
 */
export interface ReplayCache {
  /** Returns `true` if the pair is new (and marks it as seen). */
  seen(key: string, maxAgeMs?: number): boolean;
}

export class InMemoryReplayCache implements ReplayCache {
  private seen = new Map<string, number>();

  seen(key: string, maxAgeMs = 180_000): boolean {
    const now = Date.now();

    // Evict stale entries opportunistically (amortised O(1)).
    if (this.seen.size > 10_000) {
      for (const [k, ts] of this.seen) {
        if (now - ts > maxAgeMs) this.seen.delete(k);
      }
    }

    if (this.seen.has(key)) return true;
    this.seen.set(key, now);
    return false;
  }

  clear(): void {
    this.seen.clear();
  }
}

// ── Ed25519 helpers ──────────────────────────────────────────────────────────

const CLOCK_SKEW_MS = 90_000; // 90 seconds

/**
 * Build the canonical signing payload.
 * Format: METHOD\nPATH\nBODY_SHA256\nTIMESTAMP\nNONCE
 */
export function buildSignaturePayload(
  method: string,
  path: string,
  bodyHash: string,
  timestamp: string,
  nonce: string,
): string {
  return `${method.toUpperCase()}\n${path}\n${bodyHash}\n${timestamp}\n${nonce}`;
}

/**
 * Compute SHA-256 hex digest of a request body.
 * Returns the empty-body sentinel for undefined / null.
 */
export function hashBody(body: unknown): string {
  if (body === undefined || body === null || body === '') {
    return crypto.createHash('sha256').update('').digest('hex');
  }
  const serialised =
    typeof body === 'string' ? body : JSON.stringify(body);
  return crypto.createHash('sha256').update(serialised).digest('hex');
}

/**
 * Verify an Ed25519 signature.
 *
 * @param publicKeyPem - PEM-encoded Ed25519 public key
 * @param payload     - the canonical string that was signed
 * @param signatureB64 - base64url-encoded signature from the client
 */
export function verifyEd25519(
  publicKeyPem: string,
  payload: string,
  signatureB64: string,
): boolean {
  try {
    const sigBuffer = Buffer.from(signatureB64, 'base64url');
    const verifier = crypto.createVerify(null as any);
    // Ed25519 verify via the low-level key object
    const keyObj = crypto.createPublicKey(publicKeyPem);
    return crypto.verify(null as any, Buffer.from(payload), keyObj as any, sigBuffer as any);
  } catch {
    return false;
  }
}

/**
 * Generate an Ed25519 keypair and return it as PEM strings.
 */
export function generateEd25519Keypair(): {
  publicKey: string;
  privateKey: string;
} {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }) as string,
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
  };
}

// ── Middleware factory ────────────────────────────────────────────────────────

export interface DeviceSignatureMiddlewareOptions {
  keyStore: DeviceKeyStore;
  replayCache?: ReplayCache;
  /** Maximum allowed clock skew in ms. Default: 90 000 (90 s). */
  clockSkewMs?: number;
}

/**
 * Creates Express middleware that enforces per-device Ed25519 request
 * signatures on mobile companion API routes.
 */
export function createDeviceSignatureMiddleware(
  options: DeviceSignatureMiddlewareOptions,
): RequestHandler {
  const {
    keyStore,
    replayCache = new InMemoryReplayCache(),
    clockSkewMs = CLOCK_SKEW_MS,
  } = options;

  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      const installId = req.header('x-device-install-id');
      const timestamp = req.header('x-device-timestamp');
      const nonce = req.header('x-device-nonce');
      const signature = req.header('x-device-signature');

      if (!installId || !timestamp || !nonce || !signature) {
        next(
          Errors.badRequest(
            'Missing required device signature headers: X-Device-Install-Id, X-Device-Timestamp, X-Device-Nonce, X-Device-Signature',
          ),
        );
        return;
      }

      // ── Clock-skew check ────────────────────────────────────────────
      const requestTime = new Date(timestamp).getTime();
      if (Number.isNaN(requestTime)) {
        next(Errors.badRequest('X-Device-Timestamp must be a valid ISO-8601 date'));
        return;
      }
      const skew = Math.abs(Date.now() - requestTime);
      if (skew > clockSkewMs) {
        next(Errors.badRequest('Request timestamp outside allowed clock-skew window'));
        return;
      }

      // ── Replay check ────────────────────────────────────────────────
      const replayKey = `${installId}:${timestamp}:${nonce}`;
      if (replayCache.seen(replayKey)) {
        globalLogger.warn('[DeviceSignature] Replayed signature rejected', {
          installId,
          nonce,
        });
        next(Errors.badRequest('Replay detected: nonce already used within the allowed window'));
        return;
      }

      // ── Key lookup ──────────────────────────────────────────────────
      const publicKey = await keyStore.getPublicKey(installId);
      if (!publicKey) {
        next(Errors.unauthorized('Unknown device install ID'));
        return;
      }

      // ── Signature verification ──────────────────────────────────────
      const bodyHash = hashBody(req.body);
      const payload = buildSignaturePayload(
        req.method,
        req.path,
        bodyHash,
        timestamp,
        nonce,
      );

      if (!verifyEd25519(publicKey, payload, signature)) {
        globalLogger.warn('[DeviceSignature] Signature mismatch', { installId });
        next(Errors.unauthorized('Invalid device signature'));
        return;
      }

      // ── Success ─────────────────────────────────────────────────────
      (req as AuthenticatedDeviceRequest).deviceAuth = { installId, publicKey };

      globalMetrics.incrementCounter(
        'mobile.sig.verified',
        { installId },
        1,
        'Number of successfully verified mobile device signatures',
      );

      next();
    } catch (err) {
      next(
        Errors.internal(
          err instanceof Error ? err.message : 'Device signature verification failed',
        ),
      );
    }
  };
}

export const __test = {
  buildSignaturePayload,
  hashBody,
  verifyEd25519,
  generateEd25519Keypair,
};
