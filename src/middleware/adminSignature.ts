import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { Errors } from '../lib/errors';
import { globalLogger } from '../lib/logger';

/**
 * Middleware to verify Ed25519 signature for privileged admin actions.
 * Expected headers:
 *  - x-admin-signature: base64url encoded signature
 *  - x-admin-kid: key identifier matching entry in ADMIN_PUBKEYS env
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
      pubKeyMap = JSON.parse(pubKeysEnv);
    } catch {
      globalLogger.critical('ADMIN_PUBKEYS env malformed');
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
