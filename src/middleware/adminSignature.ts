import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { Errors } from '../lib/errors';
import { globalLogger } from '../lib/logger';

/** Express request augmented with the verified admin key id for audit logging. */
interface AdminSignedRequest extends Request {
  adminKid?: string;
}

/**
 * @dev Ed25519 signatures are always 64 raw bytes. Enforcing the decoded length
 * before calling `crypto.verify` keeps attacker-controlled header input from
 * reaching Node's crypto layer in an unexpected shape.
 */
const ED25519_SIGNATURE_BYTES = 64;

/**
 * @dev Strict base64 / base64url alphabet. `Buffer.from(str, 'base64')` is
 * intentionally lenient (it silently drops invalid characters), so we validate
 * the raw header ourselves before decoding. Padding is only allowed at the end.
 */
const BASE64_PATTERN = /^[A-Za-z0-9+/_-]+={0,2}$/;

/**
 * @dev Decode an admin signature header without ever throwing.
 *
 * Accepts both standard base64 and base64url encodings (the header is
 * documented as base64url, but existing callers may send standard base64).
 *
 * @param raw Raw `x-admin-signature` header value.
 * @returns The decoded signature, or `null` if the value is not valid
 *          base64/base64url or does not decode to exactly 64 bytes.
 */
function decodeSignature(raw: string): Buffer | null {
  if (!BASE64_PATTERN.test(raw)) {
    return null;
  }
  // Reject stray '=' anywhere except the trailing padding matched above.
  const payload = raw.replace(/=+$/, '');
  const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
  // Buffer.from is lenient, so re-validate that decoding yields whole bytes.
  const decoded = Buffer.from(normalized, 'base64');
  if (decoded.length !== ED25519_SIGNATURE_BYTES) {
    return null;
  }
  return decoded;
}

/**
 * Middleware to verify Ed25519 signature for privileged admin actions.
 * Expected headers:
 *  - x-admin-signature: base64url encoded signature
 *  - x-admin-kid: key identifier matching entry in ADMIN_PUBKEYS env
 * Request body must contain { action, offeringId, nonce, timestamp }.
 * The signature is over the canonical JSON string of the above fields with keys sorted.
 *
 * @dev Failure modes are explicit and never throw synchronously out of the
 * Express middleware:
 *  - Missing/invalid client credentials, malformed signatures and replay/stale
 *    requests are forwarded as operational errors (401/409).
 *  - Malformed *server* configuration (missing/unparseable ADMIN_PUBKEYS or an
 *    unusable SPKI key) is logged at CRITICAL level and forwarded as a generic
 *    500 without leaking configuration details to the client.
 */
export function verifyAdminSignature(): (req: Request, res: Response, next: NextFunction) => void {
  return (req, _res, next) => {
 *  - x-admin-signature-version: optional version ("1" or "2"; defaults to "1")
 * Version 1 signs { action, offeringId, nonce, timestamp }; version 2 additionally
 * signs { method, path }. Both versions use canonical JSON with sorted keys.
 */
export function verifyAdminSignature(): (req: Request, res: Response, next: NextFunction) => void {
  return (req, _res, next) => {
    const signatureB64 = req.header('x-admin-signature');
    const kid = req.header('x-admin-kid');
    if (!signatureB64 || !kid) {
      globalLogger.warn('Missing admin signature or kid', { path: req.path });
      return next(Errors.unauthorized('Missing admin signature'));
    }
    const versionHeader = req.header('x-admin-signature-version');
    const version = versionHeader ?? '1';
    if (version !== '1' && version !== '2') {
      globalLogger.warn('Unsupported admin signature version', { version });
      return next(Errors.badRequest('Unsupported admin signature version'));
    }

    if (version === '1') {
      let legacyEnabled: boolean;
      try {
        legacyEnabled = isLegacySignatureEnabled();
      } catch {
        globalLogger.critical('ADMIN_SIGNATURE_V1_ENABLED env malformed');
        return next(Errors.internal('Server configuration error'));
      }
      if (!legacyEnabled) {
        globalLogger.warn('Legacy admin signature version is disabled', { kid });
        return next(Errors.unauthorized('Admin signature version is disabled'));
      }
    }

    const pubKeysEnv = process.env.ADMIN_PUBKEYS;
    if (!pubKeysEnv) {
      globalLogger.critical('ADMIN_PUBKEYS env not set');
      return next(Errors.internal('Server configuration error'));
    }
    let pubKeyMap: Record<string, string>;
    try {
      const signatureB64 = req.header('x-admin-signature');
      const kid = req.header('x-admin-kid');
      if (!signatureB64 || !kid) {
        globalLogger.warn('Missing admin signature or kid', { path: req.path });
        return next(Errors.unauthorized('Missing admin signature'));
      }

      const pubKeysEnv = process.env.ADMIN_PUBKEYS;
      if (!pubKeysEnv) {
        globalLogger.critical('ADMIN_PUBKEYS env not set');
        return next(Errors.internal('Server configuration error'));
      }

      let pubKeyMap: Record<string, string>;
      try {
        const parsed: unknown = JSON.parse(pubKeysEnv);
        if (
          parsed === null ||
          typeof parsed !== 'object' ||
          Array.isArray(parsed)
        ) {
          throw new TypeError('ADMIN_PUBKEYS must be a JSON object');
        }
        pubKeyMap = parsed as Record<string, string>;
      } catch {
        globalLogger.critical('ADMIN_PUBKEYS env malformed');
        return next(Errors.internal('Server configuration error'));
      }

      const pubKeyBase64 = pubKeyMap[kid];
      if (!pubKeyBase64 || typeof pubKeyBase64 !== 'string') {
        globalLogger.warn('Unknown admin key identifier', { kid });
        return next(Errors.unauthorized('Invalid admin key'));
      }

      // Prepare canonical JSON payload
      const { action, offeringId, nonce, timestamp } = req.body ?? {};
      if (!action || !offeringId || !nonce || !timestamp) {
        globalLogger.warn('Missing required signed fields', { path: req.path });
        return next(Errors.badRequest('Missing signed fields'));
      }
      const canonical = JSON.stringify({ action, offeringId, nonce, timestamp }, Object.keys({ action, offeringId, nonce, timestamp }).sort());

      // Reject malformed/incorrect-length signatures before touching crypto.verify.
      const signature = decodeSignature(signatureB64);
      if (!signature) {
        globalLogger.warn('Malformed admin signature encoding', { kid });
        return next(Errors.unauthorized('Invalid admin signature'));
      }

      // ── Key import ──────────────────────────────────────────────────────
      // A malformed SPKI key is a server-side misconfiguration. Never let it
      // escape as an unhandled synchronous throw -> generic 500/stack trace.
      let keyObject: crypto.KeyObject;
      try {
        const pubKeyDer = Buffer.from(pubKeyBase64, 'base64');
        keyObject = crypto.createPublicKey({ key: pubKeyDer, format: 'der', type: 'spki' });
      } catch (err) {
        globalLogger.critical('ADMIN_PUBKEYS contains an invalid public key', {
          kid,
          error: err instanceof Error ? err.message : String(err),
        });
        return next(Errors.internal('Server configuration error'));
      }

      // ── Signature verification ──────────────────────────────────────────
      // `crypto.verify` can throw for malformed key/signature combinations.
      // Treat any such failure as an invalid client signature (401).
      let verified: boolean;
      try {
        verified = crypto.verify(null, Buffer.from(canonical), keyObject, signature);
      } catch (err) {
        globalLogger.warn('Admin signature verification threw', {
          kid,
          error: err instanceof Error ? err.message : String(err),
        });
        return next(Errors.unauthorized('Invalid admin signature'));
      }

      if (!verified) {
        globalLogger.warn('Invalid admin signature', { kid });
        return next(Errors.unauthorized('Invalid admin signature'));
      }

      // Replay protection: simple in‑memory nonce cache (could be replaced by Redis)
      const now = Math.floor(Date.now() / 1000);
      if (Math.abs(now - Number(timestamp)) > 30) {
        globalLogger.warn('Stale timestamp in admin request', { timestamp, now });
        return next(Errors.unauthorized('Stale timestamp'));
      }
      // Simple nonce store on request object to detect duplicates later (for demo purposes)
      const nonceStore = (req.app.get('adminNonceStore') as Set<string>) ?? new Set<string>();
      if (nonceStore.has(nonce)) {
        globalLogger.warn('Replayed nonce detected', { nonce });
        return next(Errors.conflict('Replay detected'));
      }
      nonceStore.add(nonce);
      req.app.set('adminNonceStore', nonceStore);
      // Attach verified kid for audit logging
      (req as AdminSignedRequest).adminKid = kid;
      next();
    } catch (err) {
      // Defence in depth: no unexpected error (e.g. a throwing req.app) should
      // escape the middleware as an unhandled synchronous throw.
      globalLogger.critical('Unexpected error in admin signature middleware', {
        path: req.path,
        error: err instanceof Error ? err.message : String(err),
      });
      return next(Errors.internal('Server configuration error'));
    }
    const pubKeyBase64 = pubKeyMap[kid];
    if (!pubKeyBase64) {
      globalLogger.warn('Unknown admin key identifier', { kid });
      return next(Errors.unauthorized('Invalid admin key'));
    }
    // Prepare canonical JSON payload
    const { action, offeringId, nonce, timestamp } = req.body ?? {};
    if (!action || !offeringId || !nonce || !timestamp) {
      globalLogger.warn('Missing required signed fields', { path: req.path });
      return next(Errors.badRequest('Missing signed fields'));
    }
    const signedFields: Record<string, unknown> = { action, offeringId, nonce, timestamp };
    if (version === '2') {
      const { method, path } = req.body ?? {};
      if (typeof method !== 'string' || typeof path !== 'string') {
        globalLogger.warn('Missing method or path in v2 admin signature', { path: req.path });
        return next(Errors.badRequest('Missing signed fields'));
      }
      const requestPath = req.originalUrl.split('?')[0];
      if (method !== req.method || path !== requestPath) {
        globalLogger.warn('Admin signature route binding mismatch', {
          methodMatches: method === req.method,
          pathMatches: path === requestPath,
        });
        return next(Errors.unauthorized('Invalid admin signature'));
      }
      signedFields.method = method;
      signedFields.path = path;
    }
    const canonical = JSON.stringify(signedFields, Object.keys(signedFields).sort());
    const signature = Buffer.from(signatureB64, 'base64');
    const pubKeyDer = Buffer.from(pubKeyBase64, 'base64');
    const keyObject = crypto.createPublicKey({ key: pubKeyDer, format: 'der', type: 'spki' });
    const verified = crypto.verify(null, Buffer.from(canonical), keyObject, signature);
    if (!verified) {
      globalLogger.warn('Invalid admin signature', { kid });
      return next(Errors.unauthorized('Invalid admin signature'));
    }
    if (version === '1') {
      globalLogger.warn('Legacy admin signature version is deprecated', { kid, path: req.path });
    }
    // Replay protection: simple in‑memory nonce cache (could be replaced by Redis)
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - Number(timestamp)) > 30) {
      globalLogger.warn('Stale timestamp in admin request', { timestamp, now });
      return next(Errors.unauthorized('Stale timestamp'));
    }
    // Simple nonce store on request object to detect duplicates later (for demo purposes)
    const nonceStore = (req.app.get('adminNonceStore') as Set<string>) ?? new Set<string>();
    if (nonceStore.has(nonce)) {
      globalLogger.warn('Replayed nonce detected', { nonce });
      return next(Errors.conflict('Replay detected'));
    }
    nonceStore.add(nonce);
    req.app.set('adminNonceStore', nonceStore);
    // Attach verified kid for audit logging
    (req as any).adminKid = kid;
    next();
  };
}

function isLegacySignatureEnabled(): boolean {
  const value = process.env.ADMIN_SIGNATURE_V1_ENABLED?.trim().toLowerCase();
  if (value === undefined) return true;
  if (['true', '1', 'yes', 'on'].includes(value)) return true;
  if (['false', '0', 'no', 'off'].includes(value)) return false;
  throw new Error('ADMIN_SIGNATURE_V1_ENABLED must be a boolean');
}
