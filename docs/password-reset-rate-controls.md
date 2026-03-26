# Password Reset Rate Controls

## Overview
This document details the implementation of production-grade Password Reset Rate Controls for the Revora Backend. The system prevents abuse of the password reset functionality through rate limiting while maintaining a secure and user-friendly experience.

## Implementation Details

### Components
1. **PasswordResetRateLimiter** (`src/services/passwordResetRateLimiter.ts`)
   - In-memory rate limiting with database persistence
   - Configurable request limits and time windows
   - Automatic blocking after threshold exceeded

2. **PasswordResetService** (`src/services/passwordResetService.ts`)
   - Extended with rate limiting integration
   - Custom error type `PasswordResetRateLimitedError` for rate limit events

3. **Password Reset Routes** (`src/routes/passwordReset.ts`)
   - Integrated rate limiting on `/api/auth/forgot-password` endpoint
   - Returns 429 status with `retryAfter` header when rate limited

### Configuration
| Parameter | Default | Description |
|-----------|---------|-------------|
| maxRequests | 3 | Maximum reset requests per window |
| windowMinutes | 60 | Time window in minutes |
| blockMinutes | 15 | Block duration after threshold exceeded |

### Database Schema
The `password_reset_rate_limits` table stores rate limiting state:
```sql
CREATE TABLE IF NOT EXISTS password_reset_rate_limits (
  identifier VARCHAR(255) PRIMARY KEY,
  request_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  blocked_until TIMESTAMPTZ
);
```

## Security Assumptions & Abuse/Failure Paths

### Rate Limiting Behavior
1. **Email Normalization**: All identifiers are normalized to lowercase and trimmed to prevent bypass attempts through case variations.
2. **Timing Attack Prevention**: Generic error messages returned for both existent and non-existent users to prevent email enumeration.
3. **Automatic Blocking**: When the request threshold is exceeded, the identifier is blocked for 15 minutes.
4. **Graceful Degradation**: If the rate limiter fails, the password reset request proceeds (fail-open for user experience, but logged).

### Attack Vectors Mitigated
1. **Brute Force Email Discovery**: Rate limits prevent systematic probing for valid email addresses.
2. **Denial of Service**: Limits prevent attackers from overwhelming the email service with reset requests.
3. **Token Spraying**: Combined with token expiry (60 minutes) and single-use constraints, rate limiting adds another layer of defense.

### Failure Paths
- **Database Unavailable**: If the rate limit check fails, the request proceeds with a warning logged.
- **Expired Block**: Blocks automatically expire; no manual intervention required.
- **Invalid Inputs**: Malformed emails are rejected before rate limiting is checked.

## Testing Strategy

### Unit Tests
- `src/services/passwordResetRateLimiter.test.ts` - Comprehensive tests for rate limiter logic
  - Rate limit allowance tests
  - Blocking behavior tests
  - Configuration tests
  - Security edge cases (SQL injection, whitespace handling)

### Integration Tests
- `src/routes/health.test.ts` - Password Reset Rate Controls section
  - Valid request handling
  - Security through generic responses
  - Invalid input validation
  - Rate limit response (429)
  - Route prefix consistency

### Test Coverage
The test suite covers:
- Normal request flow
- Rate limit exceeded scenarios
- Invalid email formats
- Missing parameters
- Security through obscurity (generic messages)
- Route boundary consistency

## API Usage

### Request Password Reset
```http
POST /api/v1/api/auth/forgot-password
Content-Type: application/json

{
  "email": "user@example.com"
}
```

**Success Response (200):**
```json
{
  "message": "If the email exists, a password reset link has been sent"
}
```

**Rate Limited Response (429):**
```json
{
  "error": "Too many password reset requests. Please try again later.",
  "retryAfter": 900
}
```

### Reset Password
```http
POST /api/v1/api/auth/reset-password
Content-Type: application/json

{
  "token": "reset-token-here",
  "password": "new-secure-password"
}
```

## Migration
Run the migration to create the rate limits table:
```bash
npm run migrate
```

This executes `src/db/migrations/011_create_password_reset_rate_limits.sql`.
