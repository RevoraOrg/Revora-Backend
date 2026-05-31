import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { Errors } from '../lib/errors';
import { globalLogger } from '../lib/logger';

/**
 * Middleware to verify Ed25519 signature for privileged admin actions.
 * Expected headers:
 *  - x-admin-signature: base64url encoded signature
 *  - x-admin-kid: key identifier matching entry in ADMIN_PUBKEYS env
 * Request body must contain { action, offeringId, nonce, timestamp }.
 * The signature is over the canonical JSON string of the above fields with keys sorted.
 */
export function verifyAdminSignature(): (req: Request, res: Response, next: NextFunction) => void {
  return (req, _res, next) => {
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
    const canonical = JSON.stringify({ action, offeringId, nonce, timestamp }, Object.keys({ action, offeringId, nonce, timestamp }).sort());
    const signature = Buffer.from(signatureB64, 'base64');
    const pubKeyDer = Buffer.from(pubKeyBase64, 'base64');
    const keyObject = crypto.createPublicKey({ key: pubKeyDer, format: 'der', type: 'spki' });
    const verified = crypto.verify(null, Buffer.from(canonical), keyObject, signature);
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
    (req as any).adminKid = kid;
    next();
  };
}
