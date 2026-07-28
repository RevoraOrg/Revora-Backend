import jwt from 'jsonwebtoken';
import { getJwtSecret } from './jwt';

/**
 * @notice Signed cursor for offline-first delta sync.
 *
 * The cursor is a compact JWT carrying the server-assigned sync position.
 * Clients treat it as opaque; the server signs it to prevent tampering.
 *
 * Security assumptions:
 * - The JWT secret used for signing is the same application JWT_SECRET.
 * - Cursors are short-lived (default 24 h) and single-use from the client's
 *   perspective, though the server will accept any unexpired cursor.
 * - The `ts` field is the server-authoritative high-water mark; clients must
 *   never fabricate or modify it.
 *
 * Conflict resolution (server-authoritative):
 * - Holdings:   server `updated_at` always wins over client-local state.
 * - Distributions: server `updated_at` always wins; status transitions are
 *   validated server-side (pending → processed → completed/failed).
 */

export const CURSOR_DEFAULT_TTL_SECONDS = 86_400; // 24 hours
export const CURSOR_PAGE_SIZE = 20;

export interface SyncCursorPayload {
  /** Subject – investor user-id */
  sub: string;
  /** ISO-8601 high-water mark timestamp (server-assigned) */
  ts: string;
  /** Zero-based page index for the current sync window */
  page: number;
  /** Which resource types are included in this cursor */
  resources: string[];
  /** Expiry (unix seconds) */
  exp?: number;
  /** Issued-at (unix seconds) */
  iat?: number;
}

/**
 * Sign a sync cursor.
 *
 * @param payload – fields to embed (sub, ts, page, resources)
 * @param ttlSeconds – token lifetime (default 24 h)
 * @returns Compact JWT string
 */
export function signCursor(
  payload: Omit<SyncCursorPayload, 'exp' | 'iat'>,
  ttlSeconds = CURSOR_DEFAULT_TTL_SECONDS,
): string {
  const secret = getJwtSecret();
  return jwt.sign(
    { ...payload, ts: payload.ts },
    secret,
    {
      algorithm: 'HS256',
      expiresIn: ttlSeconds,
    },
  );
}

/**
 * Verify and decode a sync cursor.
 *
 * @param token – JWT string produced by {@link signCursor}
 * @returns Decoded payload
 * @throws On invalid signature, expiry, or missing required fields.
 */
export function verifyCursor(token: string): SyncCursorPayload {
  const secret = getJwtSecret();

  const decoded = jwt.verify(token, secret, {
    algorithms: ['HS256'],
  }) as SyncCursorPayload;

  if (!decoded.sub || typeof decoded.sub !== 'string') {
    throw new Error('Cursor missing subject (sub)');
  }
  if (!decoded.ts || typeof decoded.ts !== 'string') {
    throw new Error('Cursor missing timestamp (ts)');
  }
  if (typeof decoded.page !== 'number' || decoded.page < 0) {
    throw new Error('Cursor missing or invalid page index');
  }
  if (!Array.isArray(decoded.resources)) {
    throw new Error('Cursor missing resources array');
  }

  return decoded;
}

/**
 * Validate that a cursor timestamp is not in the future.
 *
 * @param cursorTs – ISO-8601 timestamp from the cursor
 * @param toleranceMs – allowed clock skew (default 30 s)
 * @returns true if valid; throws if cursor is from the future
 */
export function validateCursorTimestamp(
  cursorTs: string,
  toleranceMs = 30_000,
): boolean {
  const cursorTime = new Date(cursorTs).getTime();
  if (Number.isNaN(cursorTime)) {
    throw new Error('Cursor contains invalid timestamp');
  }

  const now = Date.now();
  if (cursorTime > now + toleranceMs) {
    throw new Error('Cursor timestamp is in the future');
  }

  return true;
}
