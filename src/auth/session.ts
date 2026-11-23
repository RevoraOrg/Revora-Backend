import { createHash } from 'node:crypto';

/**
 * Session lifetime for access tokens managed by login service.
 * 1 hour by default to match JWT token expiry in lib/jwt.
 */
export const SESSION_TTL_MS = 60 * 60 * 1000;

/**
 * Absolute lifetime of a refresh-token family, measured from login.
 *
 * A refresh token may be rotated repeatedly, each rotation establishing a new
 * sliding 7-day window. `REFRESH_FAMILY_TTL_MS` caps that process: it is set
 * once when the family is created and inherited unchanged by every rotated
 * child, so a session cannot be kept alive indefinitely by refreshing.
 */
export const REFRESH_FAMILY_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Compute the absolute family deadline for a session created at `now`.
 */
export function computeFamilyExpiresAt(now: Date = new Date()): Date {
  return new Date(now.getTime() + REFRESH_FAMILY_TTL_MS);
}

/**
 * Creates deterministic token fingerprint for server-side session binding.
 * @param token plain JWT
 * @returns lower-case hex hash (sha256)
 */
export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Validate if Date is still in future.
 */
export function isSessionExpired(expiresAt: Date): boolean {
  return expiresAt.getTime() < Date.now();
}
