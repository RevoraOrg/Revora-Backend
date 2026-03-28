/**
 * Password Strength Policies
 *
 * Enforces production-grade password requirements to prevent weak passwords
 * that could be easily cracked via dictionary attacks, brute force, or rainbow tables.
 *
 * Security assumptions:
 * - Minimum length prevents short passwords vulnerable to brute force.
 * - Character class requirements ensure complexity against dictionary attacks.
 * - No common passwords list blocks well-known weak passwords.
 * - All checks are performed client-side first, but enforced server-side.
 *
 * Abuse/failure paths:
 * - Short passwords: rejected with clear message.
 * - Missing character classes: rejected with specific feedback.
 * - Common passwords: rejected without revealing the list.
 * - Empty/null passwords: rejected.
 */

export interface PasswordStrengthResult {
  isValid: boolean;
  errors: string[];
}

/**
 * Validates password strength against security policies.
 *
 * @param password - Plain text password to validate
 * @returns Validation result with boolean and error messages
 */
export function validatePasswordStrength(password: string): PasswordStrengthResult {
  const errors: string[] = [];

  if (!password || typeof password !== 'string') {
    errors.push('Password is required');
    return { isValid: false, errors };
  }

  // Minimum length: 12 characters (NIST recommends 8+, but 12 for better security)
  if (password.length < 12) {
    errors.push('Password must be at least 12 characters long');
  }

  // Maximum length: prevent DoS via extremely long passwords
  if (password.length > 128) {
    errors.push('Password must be no more than 128 characters long');
  }

  // Require at least one uppercase letter
  if (!/[A-Z]/.test(password)) {
    errors.push('Password must contain at least one uppercase letter');
  }

  // Require at least one lowercase letter
  if (!/[a-z]/.test(password)) {
    errors.push('Password must contain at least one lowercase letter');
  }

  // Require at least one digit
  if (!/\d/.test(password)) {
    errors.push('Password must contain at least one number');
  }

  // Require at least one special character
  if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(password)) {
    errors.push('Password must contain at least one special character');
  }

  // Check against common passwords (basic list; in production, use a larger dataset)
  const commonPasswords = [
    'password', '123456', '123456789', 'qwerty', 'abc123', 'password123',
    'admin', 'letmein', 'welcome', 'monkey', '1234567890', 'iloveyou',
    'princess', 'rockyou', '1234567', '12345678', 'password1', '123123',
    'football', 'baseball', 'welcome1', 'admin123', 'root', 'user'
  ];

  if (commonPasswords.includes(password.toLowerCase())) {
    errors.push('Password is too common; please choose a stronger password');
  }

  // Check for repeated characters (e.g., 'aaaaa')
  if (/(.)\1{4,}/.test(password)) {
    errors.push('Password must not contain excessive repeated characters');
  }

  // Check for sequential characters (e.g., 'abcde' or '12345')
  if (/(.)\1{4,}|(?:012|123|234|345|456|567|678|789|890|abc|bcd|cde|def|efg|fgh|ghi|hij|ijk|jkl|klm|lmn|mno|nop|opq|pqr|qrs|rst|stu|tuv|uvw|vwx|wxy|xyz)/i.test(password)) {
    errors.push('Password must not contain sequential characters');
  }

  return {
    isValid: errors.length === 0,
    errors
  };
}