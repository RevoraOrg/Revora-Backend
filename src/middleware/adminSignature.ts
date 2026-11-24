import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { Pool, QueryResult } from 'pg';
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
 * @title Admin Nonce Store
 * @notice Replay-protection store for admin signature nonces.
 *
 * Each signed admin request carries a single-use `nonce` (part of the signed
 * payload, so it cannot be tampered with). To reject replays the middleware
 * records every nonce it has already accepted and refuses duplicates within
 * the replay window.
 *
 * The in-memory fallback is process-local (development / single-instance
 * only): a restart clears history and other replicas never see the nonces.
 * The Postgres implementation is shared across instances and persists across
 * restarts, so a captured request replayed against a different replica — or
 * after a restart — is still rejected.
 */
export interface AdminNonceStore {
  /**
   * @notice Atomically record `kid` + `nonce` as seen within the replay window.
   * @param kid Admin key identifier that signed the request. Scoping records
   *            per key prevents a nonce from one admin key being interpreted
   *            as already consumed for another.
   * @param nonce Single-use value from the signed payload.
   * @param ttlMs How long the record must cause duplicate requests to be
   *              rejected, in milliseconds.
   * @returns `true` if the record was newly created (not a replay) and the
   *          request should proceed; `false` if a replay was detected (the
   *          record already existed and has not yet expired).
   * @throws  on infrastructure failure (e.g. database outage) or an invalid
   *          TTL. The caller is responsible for the fail-open vs. fail-closed
   *          decision.
   */
  consume(kid: string, nonce: string, ttlMs: number): Promise<boolean>;
}

/**
 * Default replay window for admin nonces, in milliseconds.
 *
 * The middleware rejects timestamps more than 30s from `now`, so a captured
 * request stays usable for at most ~60s from first sighting (clock-skew
 * bound). 120s doubles that worst case for skew margin.
 */
export const DEFAULT_ADMIN_NONCE_TTL_MS = 120_000;

/**
 * @notice Resolve the configured nonce TTL from the option or environment.
 * @dev Invalid values (non-numeric, zero, negative) fall back to the secure
 *      default with a warning. A short/missing TTL would silently weaken
 *      replay protection, so misconfiguration must never disable it.
 */
function resolveAdminNonceTtlMs(option?: number): number {
  if (option !== undefined) {
    if (Number.isFinite(option) && option > 0) {
      return Math.floor(option);
    }
    globalLogger.warn('Invalid admin nonce TTL option; using default', {
      value: option,
      defaultTtlMs: DEFAULT_ADMIN_NONCE_TTL_MS,
    });
    return DEFAULT_ADMIN_NONCE_TTL_MS;
  }

  const rawEnv = process.env.ADMIN_NONCE_TTL_MS;
  if (rawEnv !== undefined && rawEnv !== '') {
    const parsed = Number(rawEnv);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.floor(parsed);
    }
    globalLogger.warn('Invalid ADMIN_NONCE_TTL_MS; using default', {
      value: rawEnv,
      defaultTtlMs: DEFAULT_ADMIN_NONCE_TTL_MS,
    });
  }

  return DEFAULT_ADMIN_NONCE_TTL_MS;
}

export interface PostgresAdminNonceStoreOptions {
  /** Shared PostgreSQL connection pool. */
  pool: Pool;
}

/**
 * @title Postgres-Backed Admin Nonce Store
 * @notice Production-grade replay protection using PostgreSQL for
 *        multi-instance safety and persistence across restarts.
 * @dev Detecting a replay and recording a fresh nonce are a single atomic
 *      statement so concurrent duplicates across replicas are correctly
 *      rejected:
 *
 *  - `INSERT ... ON CONFLICT (kid, nonce) DO UPDATE ... WHERE expires_at <=
 *    NOW()` returns the inserted/refreshed row only when the record is new or
 *    its previous entry has already expired. A live, unexpired row produces no
 *    returned row, which the caller interprets as a replay.
 *  - PostgreSQL's unique-index insertion handles the concurrency race: the
 *    second concurrent insert for the same `(kid, nonce)` blocks until the
 *    first commits, then resolves to the conflict path and is reported as a
 *    replay.
 *  - Expired rows are filtered at query time, so stale data is never reused
 *    even before {@link PostgresAdminNonceStore.cleanupExpired} runs.
 *
 * Security assumptions:
 *  - Database connection is secure and properly configured
 *  - The single atomic statement serialises concurrent duplicates
 *  - TTL expiry is enforced at query time (and via periodic cleanup)
 *  - Infrastructure failures throw, letting the caller fail closed (default)
 *    to preserve replay safety, or fail open for availability
 */
export class PostgresAdminNonceStore implements AdminNonceStore {
  private readonly pool: Pool;

  constructor(options: PostgresAdminNonceStoreOptions) {
    this.pool = options.pool;
  }

  async consume(kid: string, nonce: string, ttlMs: number): Promise<boolean> {
    // Reject a nonsensical TTL rather than recording an immediately-expired
    // row, which would quietly disable replay protection.
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new RangeError('Admin nonce TTL must be a positive finite number of milliseconds');
    }

    const expiresAt = new Date(Date.now() + Math.floor(ttlMs));

    // Single atomic statement. ON CONFLICT (kid, nonce) DO UPDATE ... WHERE
    // expires_at <= NOW() only refreshes an *expired* row; a live row fails
    // the WHERE predicate, returns no row, and is a replay.
    const result: QueryResult = await this.pool.query(
      `INSERT INTO admin_nonces (kid, nonce, expires_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (kid, nonce) DO UPDATE
         SET expires_at = EXCLUDED.expires_at,
             created_at = NOW()
       WHERE admin_nonces.expires_at <= NOW()
       RETURNING 1`,
      [kid, nonce, expiresAt]
    );

    return (result.rowCount ?? 0) > 0;
  }

  /**
   * @notice Remove expired nonces to prevent table bloat.
   * @dev Should be run periodically (e.g. via a scheduled job). Correctness does
   *      not depend on cleanup — expired rows are filtered at query time —
   *      but unbounded growth degrades query planning over time.
   * @returns The number of rows deleted.
   */
  async cleanupExpired(): Promise<number> {
    const result: QueryResult = await this.pool.query(
      'DELETE FROM admin_nonces WHERE expires_at < NOW()'
    );
    return result.rowCount ?? 0;
  }
}

/**
 * Options for {@link verifyAdminSignature}.
 */
export interface VerifyAdminSignatureOptions {
  /**
   * Shared nonce store for cross-instance replay protection. When omitted,
   * the middleware falls back to a process-local in-memory `Set` stored on
   * `req.app` (single-instance / development use only).
   */
  store?: AdminNonceStore;
  /**
   * How long a consumed nonce must reject replays, in milliseconds.
   * @dev Overrides `ADMIN_NONCE_TTL_MS`. Must cover the full replay window
   *      (see {@link DEFAULT_ADMIN_NONCE_TTL_MS}); invalid values fall back to
   *      the secure default. Ignored by the in-memory fallback.
   */
  nonceTtlMs?: number;
  /**
   * Behaviour when the configured store throws (e.g. a database outage).
   * - `false` (default): **fail closed** — reject the request to preserve
   *   replay safety. A replayed admin action is a security failure, so the
   *   secure default is to refuse the request rather than risk accepting a
   *   replay.
   * - `true`: **fail open** — allow the request, trading replay safety for
   *   availability (admin actions remain reachable during a DB outage at the
   *   cost of a potential replay window).
   */
  failOpenOnStoreError?: boolean;
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
export function verifyAdminSignature(
  options: VerifyAdminSignatureOptions = {}
): (req: Request, res: Response, next: NextFunction) => void {
  const { store, failOpenOnStoreError = false } = options;
  const nonceTtlMs = store ? resolveAdminNonceTtlMs(options.nonceTtlMs) : undefined;
  return async (req, _res, next) => {
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

      // Replay protection: reject timestamps outside the ±30s freshness window.
      const now = Math.floor(Date.now() / 1000);
      if (Math.abs(now - Number(timestamp)) > 30) {
        globalLogger.warn('Stale timestamp in admin request', { timestamp, now });
        return next(Errors.unauthorized('Stale timestamp'));
      }

      if (store) {
        // Shared nonce store (e.g. PostgresAdminNonceStore) — rejects replays
        // across replicas and survives restarts.
        let isNew: boolean;
        try {
          isNew = await store.consume(kid, nonce, nonceTtlMs!);
        } catch (err) {
          globalLogger.critical('Admin nonce store error', {
            kid,
            nonce,
            error: err instanceof Error ? err.message : String(err),
          });
          if (failOpenOnStoreError) {
            // Fail open: accept the request despite the store failure.
            (req as AdminSignedRequest).adminKid = kid;
            return next();
          }
          // Fail closed (default): replay protection is a security control, so
          // a store outage must not silently allow a potential replay.
          return next(Errors.internal('Replay protection unavailable'));
        }
        if (!isNew) {
          globalLogger.warn('Replayed nonce detected', { nonce });
          return next(Errors.conflict('Replay detected'));
        }
      } else {
        // Process-local in-memory nonce cache (development / single-instance).
        // The shared store is the only cross-replica/persistent option; this
        // fallback remains the default for tests and dev.
        const nonceStore = (req.app.get('adminNonceStore') as Set<string>) ?? new Set<string>();
        if (nonceStore.has(nonce)) {
          globalLogger.warn('Replayed nonce detected', { nonce });
          return next(Errors.conflict('Replay detected'));
        }
        nonceStore.add(nonce);
        req.app.set('adminNonceStore', nonceStore);
      }

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
