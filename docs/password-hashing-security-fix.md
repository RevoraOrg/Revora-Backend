# Password Hashing Security Fix

## Summary

Fixed critical password hashing inconsistency across authentication flows that locked users out after password changes and exposed passwords to trivial cracking attacks.

## Problem

### Inconsistent Hashing Algorithms

- **RegisterService**: Used unsalted SHA-256 (`createHash('sha256').update(password).digest('hex')`)
- **PasswordResetService**: Used unsalted SHA-256
- **LoginService**: Verified against SHA-256 only
- **ChangePasswordService**: Used salted scrypt from `src/utils/password.ts`

### Security Impact

1. **User Lockout**: After a user changed their password via ChangePasswordService, LoginService would compare a SHA-256 hex digest against a scrypt-formatted hash (`salt:key`), always failing. Users could no longer log in.

2. **Weak Cryptography**: Unsalted SHA-256 is:
   - Trivially crackable via rainbow tables if the users table leaks
   - Vulnerable to GPU/ASIC brute force attacks
   - Lacks computational hardness (designed for speed, not password hashing)

## Solution

### Standardized on Salted Scrypt

All password operations now use `src/utils/password.ts` which implements:

- **Algorithm**: scrypt (memory-hard, resistant to GPU/ASIC attacks)
- **Salt**: 16 random bytes (32 hex chars)
- **Key Length**: 64 bytes (128 hex chars)
- **Output Format**: `<salt_hex>:<derived_key_hex>`
- **Timing-Safe Comparison**: Uses `crypto.timingSafeEqual()` to prevent timing attacks

### Backward Compatibility

`comparePassword()` in `src/utils/password.ts` supports both formats:

1. **Scrypt format** (current standard): `<salt_hex>:<derived_key_hex>`
2. **Legacy SHA-256 format** (deprecated): 64-character hex digest

Legacy SHA-256 hashes are accepted during login but will be migrated to scrypt on the next password change via ChangePasswordService.

### Migration Strategy

- **Automatic**: Users with legacy SHA-256 hashes can still log in
- **On-Demand**: Password change (via ChangePasswordService or PasswordResetService) upgrades to scrypt
- **No Downtime**: No forced migration required; gradual upgrade as users change passwords

## Changes Made

### 1. RegisterService (`src/auth/register/registerService.ts`)

```typescript
// Before
const password_hash = createHash('sha256').update(password).digest('hex');

// After
const password_hash = await hashPassword(password);
```

### 2. PasswordResetService (`src/services/passwordResetService.ts`)

```typescript
// Before
private hashPassword(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}

// After
import { hashPassword } from '../utils/password';
const passwordHash = await hashPassword(newPassword);
```

### 3. LoginService (`src/auth/login/loginService.ts`)

```typescript
// Before
private verifyPassword(plaintext: string, storedHash: string): boolean {
  const candidateHash = createHash('sha256').update(plaintext).digest('hex');
  // ... timing-safe comparison
}

// After
import { comparePassword } from '../../utils/password';
const isMatch = await comparePassword(password, user.passwordHash);
```

### 4. password.ts (`src/utils/password.ts`)

Enhanced `comparePassword()` to detect and handle both formats:

```typescript
export async function comparePassword(plain: string, stored: string): Promise<boolean> {
  // Check if stored hash is in scrypt format (contains ':')
  if (stored.includes(':')) {
    const [salt, storedHash] = stored.split(':');
    // ... scrypt verification
  }

  // Legacy SHA-256 format (unsalted, 64 hex chars)
  const candidateHash = createHash('sha256').update(plain).digest('hex');
  // ... timing-safe comparison
}
```

## Security Assumptions

### Threat Model

- **Database Compromise**: Attacker gains read access to `users.password_hash` column
- **Offline Cracking**: Attacker attempts to crack password hashes using GPU/ASIC farms
- **Timing Attacks**: Attacker measures response times to infer password correctness

### Defenses

1. **Memory Hardness**: scrypt requires significant memory, making GPU/ASIC attacks expensive
2. **Random Salt**: Each password hash uses a unique salt, preventing rainbow table attacks
3. **Timing-Safe Comparison**: Prevents timing attacks on password verification
4. **Key Length**: 64-byte derived key provides 512 bits of security

### Residual Risks

- **Legacy SHA-256 Hashes**: Users who never change passwords remain vulnerable until they do
- **No Key Stretching Iteration Parameter**: Current implementation uses default scrypt parameters; consider adding configurable N/r/p parameters for future hardening

## Testing

### Unit Tests (`src/utils/password.test.ts`)

- Scrypt hash format validation
- Random salt uniqueness
- Correct password verification (scrypt)
- Incorrect password rejection (scrypt)
- Legacy SHA-256 backward compatibility
- Format detection by colon presence

### Integration Tests (`src/auth/login/loginService.test.ts`)

- Login with legacy SHA-256 hash
- Login with scrypt hash
- Failed login with wrong password
- Session creation on successful login

## Verification

Run tests to verify the fix:

```bash
npm test -- src/utils/password.test.ts
npm test -- src/auth/login/loginService.test.ts
```

## Deployment Notes

### Database Schema

No schema changes required. The `password_hash` column accepts both formats.

### Rollback Plan

If issues arise, revert to previous implementation. Legacy SHA-256 hashes will continue to work.

### Monitoring

Monitor for:
- Increased login failure rates (indicates migration issues)
- Slow login times (scrypt is slower than SHA-256, but should be acceptable)
- Support tickets related to password login

## References

- [scrypt RFC 7914](https://tools.ietf.org/html/rfc7914)
- [OWASP Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)
- [Why SHA-256 is Not Secure for Passwords](https://security.stackexchange.com/questions/21141/why-are-md5-and-sha-1-cryptographically-broken)
