import { scryptSync, randomBytes, timingSafeEqual } from 'crypto';

/**
 * @deprecated Use async `hashPassword` and `comparePassword` from `src/utils/password.ts` instead.
 * This module uses synchronous `scryptSync`, which blocks the Node.js event loop.
 */

/**
 * @deprecated Use async `hashPassword` from `src/utils/password.ts` instead.
 * Hash a password using scrypt
 * @param password The password to hash
 * @returns The hashed password in the format salt:hash
 */
export function hashPassword(password: string): string {
    const salt = randomBytes(16).toString('hex');
    const derivedKey = scryptSync(password, salt, 64);
    return `${salt}:${derivedKey.toString('hex')}`;
}

/**
 * @deprecated Use async `comparePassword` from `src/utils/password.ts` instead.
 * Verify a password against a hash
 * @param password The password to verify
 * @param hash The stored hash in the format salt:hash
 * @returns True if the password matches the hash
 */
export function verifyPassword(password: string, hash: string): boolean {
    const [salt, key] = hash.split(':');
    const keyBuffer = Buffer.from(key, 'hex');
    const derivedKey = scryptSync(password, salt, 64);
    return timingSafeEqual(keyBuffer, derivedKey);
}
