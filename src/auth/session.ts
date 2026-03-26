import { createHash } from 'node:crypto';

/**
 * Session lifetime for access tokens managed by login service.
 * 1 hour by default to match JWT token expiry in lib/jwt.
 */
export const SESSION_TTL_MS = 60 * 60 * 1000;

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
