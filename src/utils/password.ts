import { scrypt, randomBytes, timingSafeEqual, createHash } from 'crypto';
import { promisify } from 'util';

const scryptAsync = promisify(scrypt);

const SALT_LENGTH = 16; // bytes → 32 hex chars
const KEY_LENGTH = 64;  // bytes → 128 hex chars

/**
 * Hash a plain-text password with scrypt + random salt.
 * Output: "<salt_hex>:<derived_key_hex>"
 */
export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH).toString('hex');
  const derivedKey = (await scryptAsync(plain, salt, KEY_LENGTH)) as Buffer;
  return `${salt}:${derivedKey.toString('hex')}`;
}

/**
 * Timing-safe comparison of a plain-text password against a stored hash.
 * 
 * Supports two formats for backward compatibility:
 * 1. Scrypt format: "<salt_hex>:<derived_key_hex>" (current standard)
 * 2. Legacy SHA-256 format: 64-character hex digest (unsalted, deprecated)
 * 
 * Legacy SHA-256 hashes are accepted for login but should be migrated to scrypt
 * on next password change via ChangePasswordService.
 */
export async function comparePassword(
  plain: string,
  stored: string
): Promise<boolean> {
  // Check if stored hash is in scrypt format (contains ':')
  if (stored.includes(':')) {
    const [salt, storedHash] = stored.split(':');
    if (!salt || !storedHash) return false;

    const derivedKey = (await scryptAsync(plain, salt, KEY_LENGTH)) as Buffer;
    const storedBuffer = Buffer.from(storedHash, 'hex');

    if (derivedKey.length !== storedBuffer.length) return false;
    return timingSafeEqual(derivedKey, storedBuffer);
  }

  // Legacy SHA-256 format (unsalted, 64 hex chars)
  // Used for backward compatibility with existing users
  const candidateHash = createHash('sha256').update(plain).digest('hex');

  const a = Buffer.from(candidateHash, 'utf-8');
  const b = Buffer.from(stored, 'utf-8');

  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}