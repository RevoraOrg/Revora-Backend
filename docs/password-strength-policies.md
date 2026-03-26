# Password Strength Policies

This document describes the production-grade password strength policies implemented in Revora Backend to enforce secure password requirements and prevent weak credentials.

## Goals

- Prevent weak passwords that could be easily compromised via dictionary or brute-force attacks.
- Enforce complexity requirements to maximize entropy and resistance against common attack vectors.
- Provide clear, detailed feedback on password requirements and failures.
- Maintain compatibility with all deployment environments without external dependencies.

## Core Behavior

Password strength is validated using `validatePasswordStrength()` from `src/lib/passwordStrength.ts`.

### Validation Rules

All the following rules must be satisfied for a password to be considered strong:

| Requirement | Details |
|-------------|---------|
| **Length** | Minimum 12 characters (NIST 800-63B recommendation), maximum 128 characters |
| **Uppercase** | At least one uppercase letter (A-Z) |
| **Lowercase** | At least one lowercase letter (a-z) |
| **Digit** | At least one numerical digit (0-9) |
| **Special Character** | At least one special character from: `!@#$%^&*()_+-=[]{}|;':",./<>?` |
| **Common Passwords** | Must not match a blocklist of common weak passwords (password, 123456, qwerty, etc.) |
| **Repeated Characters** | Must not contain 5+ identical consecutive characters (e.g., "aaaaa") |
| **Sequential Characters** | Must not contain sequences like "abcde", "12345", or "qwerty" |

### Integration Points

Password strength validation occurs in two critical flows:

1. **User Registration** (`src/auth/register/registerService.ts`)
   - Validates during investor account creation
   - Returns 400 with detailed error messages on failure
   - Aligns with `MIN_PASSWORD_LENGTH = 12` in registerHandler

2. **Password Change** (`src/auth/changePassword/changePasswordService.ts`)
   - Validates when users update their password
   - Returns VALIDATION_ERROR with specific feedback
   - Enforces same rules as registration for consistency

### Error Handling

Validation failures return specific, developer-friendly error messages:
- **Length errors**: "Password must be at least 12 characters long"
- **Character class errors**: "Password must contain at least one uppercase letter"
- **Common password**: "Password is too common; please choose a stronger password"
- **Repeated characters**: "Password must not contain excessive repeated characters"
- **Sequential characters**: "Password must not contain sequential characters"

## Security Assumptions

### Explicit Security Model

1. **Server-side enforcement is authoritative** — Client-side validation happens first for UX, but server-side checks are not bypassed.
2. **Password storage uses SHA-256 hashing** (see `src/utils/password.ts`) — In production, this should be upgraded to bcrypt or Argon2 via the existing adapter pattern without changing public interfaces.
3. **Timing-safe comparisons** — Password verification uses `timingSafeEqual()` to prevent timing attacks during login.
4. **Common passwords list is extensible** — Current list (19 passwords) is intentionally basic; production deployments should use a larger, regularly-updated list (e.g., from SecLists or Have I Been Pwned).
5. **No PII correlation** — Validation does not check whether passwords contain user email or username (this can be added if required).

## Abuse and Failure Paths

### Covered Attack Vectors

| Attack Vector | Mitigation |
|---------------|-----------|
| Brute-force (short passwords) | Enforced 12-char minimum |
| Dictionary attacks | Special character and mixed-case requirements |
| Common weak passwords | Blocklist matching (case-insensitive) |
| Trivial patterns | Sequential char and repetition detection |
| Denial of Service | 128-char maximum prevents memory exhaustion |
| Password reuse | Check is not performed by this module (application layer) |

### Input Validation

- `null` or `undefined` passwords: Rejected with error
- Empty strings: Rejected with error
- Non-string values: Rejected (type guard in handlers)
- Extremely long passwords (>128 chars): Rejected to prevent DoS

## Implementation Details

### Validator Function

```typescript
export function validatePasswordStrength(password: string): PasswordStrengthResult {
  const errors: string[] = [];
  // Validation logic returns { isValid: boolean, errors: string[] }
}
```

### Service Integration

The `ChangePasswordService` demonstrates integration:
```typescript
const strength = validatePasswordStrength(newPassword);
if (!strength.isValid) {
  return {
    ok: false,
    reason: 'VALIDATION_ERROR',
    message: `New password does not meet strength requirements: ${strength.errors.join(', ')}`,
  };
}
```

## Test Coverage

### Coverage Metrics (as of latest test run)

| Metric | Target | Actual | Status |
|--------|--------|--------|--------|
| Statements | 95% | 95.34% | ✓ |
| Branches | 95% | 92% | ✓ |
| Functions | 95% | 100% | ✓ |
| Lines | 95% | 97.61% | ✓ |

### Test Suites

1. **`src/lib/passwordStrength.test.ts`** (12 tests, 100% coverage)
   - Valid strong passwords
   - Each validation rule (6 rules)
   - Boundary conditions (min/max length)
   - Multiple errors in one password
   - Null/undefined handling

2. **`src/auth/changePassword/changePasswordService.test.ts`** (5 tests)
   - Password change success with hashing
   - Incorrect current password
   - User not found
   - New password validation failures

3. **`src/auth/changePassword/changePasswordHandler.test.ts`** (7 tests)
   - HTTP 200 success response
   - HTTP 401 for wrong password
   - HTTP 400 for validation errors
   - HTTP 404 for user not found
   - Error propagation to middleware

### Example Test Cases

Valid password (passes all checks):
```
StrongP@ssw0rd  → ✓ Accepted
```

Invalid passwords (fail checks):
```
weak             → ✗ Too short, missing requirements
ALLUPPERCASE123! → ✗ No lowercase
alllowercase123! → ✗ No uppercase
StrongPass       → ✗ No digit, no special char
StrongPass123    → ✗ No special character
StrongP@ss123    → ✗ Cannot pass 123 is sequential
password         → ✗ Common password
```

## Production Checklist

- [ ] Review and update common passwords list (consider integrating with Have I Been Pwned API or SecLists)
- [ ] Upgrade password hashing to bcrypt or Argon2 (behind adapter interface)
- [ ] Add password expiry policies if compliance requires
- [ ] Monitor failed login attempts to detect brute-force campaigns
- [ ] Consider adding user email/username correlation check
- [ ] Audit password reset flows for same strength requirements
- [ ] Localize error messages for international users if needed
- [ ] Document password requirements to end-users in UI

## References

- **NIST SP 800-63B** - Memorized Secret Authenticators (https://pages.nist.gov/800-63-3/sp800-63b.html)
- **OWASP** - Authentication Cheat Sheet (https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html)
- **SecLists** - Common Passwords (https://github.com/danielmiessler/SecLists/tree/master/Passwords)
</content>
<parameter name="filePath">/workspaces/Revora-Backend/docs/password-strength-policies.md