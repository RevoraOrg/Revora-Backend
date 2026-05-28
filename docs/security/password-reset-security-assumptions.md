# Password Reset Security Assumptions

## Overview

The password reset flow allows users to recover access to their accounts by requesting a password reset link via email. This document outlines the security assumptions, threat model, and implementation details for the password reset functionality.

## Threat Model

### Attack Vectors Prevented

1. **Account Enumeration**
   - Uniform responses prevent attackers from determining if an email exists
   - Same response returned for valid and invalid email addresses
   - Invalid email formats return the same success message

2. **Token Leakage**
   - Reset tokens never appear in logs or error responses
   - Email service handles token delivery securely
   - Tokens are single-use and expire after a short time

3. **Rate Limiting Abuse**
   - Rate limiting prevents brute force attacks on password reset
   - Configurable limits on requests per email
   - Temporary blocking after excessive attempts

4. **Password Strength**
   - Minimum password length enforced (8 characters)
   - Prevents weak passwords from being set via reset

## Security Assumptions

### Email Delivery

- **Assumption**: EmailService delivers reset links securely
- **Risk**: Email interception could allow account takeover
- **Mitigation**: Tokens are single-use and expire quickly
- **Recommendation**: Use TLS for email delivery, consider additional verification

### Token Security

- **Assumption**: Reset tokens are cryptographically random
- **Risk**: Predictable tokens could be guessed
- **Mitigation**: Use secure random token generation in PasswordResetService
- **Coverage**: Tokens should be at least 32 bytes of entropy

### Rate Limiting

- **Assumption**: Rate limiting prevents abuse
- **Risk**: Distributed attacks could bypass rate limiting
- **Mitigation**: Rate limiting is per-email, not per-IP
- **Limitation**: Sophisticated attackers may use multiple emails

### Database Security

- **Assumption**: Database access is properly secured
- **Risk**: Database compromise could expose reset tokens
- **Mitigation**: Tokens should be hashed in database (if implemented)
- **Recommendation**: Consider hashing tokens before storage

## Implementation Details

### Module: `src/routes/passwordReset.ts`

#### Router Configuration

```typescript
export interface CreatePasswordResetRouterOptions {
  db: Pool;
  emailService: EmailService;
}

export function createPasswordResetRouter(options: CreatePasswordResetRouterOptions): Router
```

The router is configured with:
- Database pool for token storage and rate limiting
- EmailService for sending reset emails
- Rate limiter with configurable limits

#### Endpoints

**POST /api/auth/forgot-password**
- Input: `{ email: string }`
- Output: `{ message: "If the email exists, a password reset link has been sent" }`
- Security: Uniform response prevents account enumeration
- Rate limiting: 3 requests per hour, 15-minute block on violation

**POST /api/auth/reset-password**
- Input: `{ token: string, password: string }`
- Output: `{ message: "Password updated" }` or `{ error: "Invalid or expired token" }`
- Security: Token never appears in logs or error responses
- Validation: Password must be at least 8 characters

### Email Service Integration

The router uses EmailService instead of console.log:

```typescript
const service = new PasswordResetService(db, {
  emailSender: async (to, subject, body) => {
    await emailService.sendMail(to, subject, body);
  },
  rateLimiter,
});
```

**Security improvements**:
- No token leakage to console logs
- Proper email delivery via SendGrid or configured provider
- Error handling without exposing sensitive data

### Token Lifecycle

1. **Request**: User requests password reset with email
2. **Generation**: Service generates cryptographically random token
3. **Storage**: Token stored in database with expiry
4. **Delivery**: EmailService sends reset link via email
5. **Usage**: User clicks link and submits new password
6. **Validation**: Token validated and password updated
7. **Cleanup**: Token invalidated after use

## Usage

### Mounting the Router

```typescript
import { createPasswordResetRouter } from './routes/passwordReset';
import { emailService } from './services/emailService';
import { pool } from './db/pool';

app.use(createPasswordResetRouter({ db: pool, emailService }));
```

### Configuration

Environment variables:
- `SENDGRID_API_KEY`: API key for SendGrid email service
- `FROM_EMAIL`: Default sender email address

Rate limiting configuration (in `createPasswordResetRouter`):
- `maxRequests`: 3 requests per window
- `windowMinutes`: 60 minutes
- `blockMinutes`: 15 minutes

### Email Template

The reset email should include:
- Clear instructions for the user
- Reset link with token
- Expiration time warning
- Security notice about not sharing the link

## Abuse/Failure Paths Handled

### Invalid Email Format
- **Action**: Return uniform success message
- **Logging**: None
- **Impact**: No account enumeration
- **Recovery**: User can try with correct email

### Non-Existent Email
- **Action**: Return uniform success message
- **Logging**: None
- **Impact**: No account enumeration
- **Recovery**: User receives no email (expected behavior)

### Rate Limit Exceeded
- **Action**: Return 429 with retry-after header
- **Logging**: Rate limit event logged
- **Impact**: Temporary block on password reset
- **Recovery**: Wait for retry-after time

### Database Errors
- **Action**: Return uniform success message (fail open)
- **Logging**: Error logged without sensitive data
- **Impact**: Temporary service degradation
- **Recovery**: Automatic when database recovers

### Email Service Errors
- **Action**: Return uniform success message (fail open)
- **Logging**: Error logged without sensitive data
- **Impact**: User may not receive reset email
- **Recovery**: User can retry after waiting

### Invalid Token
- **Action**: Return 400 with generic error message
- **Logging**: Error logged without token
- **Impact**: User cannot reset password
- **Recovery**: User can request new reset link

### Expired Token
- **Action**: Return 400 with generic error message
- **Logging**: Error logged without token
- **Impact**: User cannot reset password
- **Recovery**: User can request new reset link

## Testing

Comprehensive test coverage is provided in `src/routes/passwordReset.test.ts`:

- **Forgot password tests**: Invalid email, valid email, rate limiting, error handling
- **Reset password tests**: Missing token, missing password, short password, valid reset
- **Security tests**: Token leakage prevention, account enumeration prevention
- **Email service integration**: EmailService.sendMail calls, error handling
- **Edge cases**: Email normalization, long passwords, database errors

## Recommendations

### Production Deployment

1. **Configure Email Service**
   - Set up SendGrid or alternative email provider
   - Configure FROM_EMAIL with appropriate domain
   - Test email delivery before going live

2. **Monitor Rate Limiting**
   - Track rate limit violations
   - Alert on unusual patterns (e.g., high volume from single IP)
   - Consider adjusting limits based on traffic patterns

3. **Secure Token Generation**
   - Ensure PasswordResetService uses cryptographically secure random
   - Token length should be at least 32 bytes
   - Consider adding additional entropy (user ID, timestamp)

4. **Token Expiry**
   - Set reasonable expiry time (e.g., 1 hour)
   - Implement cleanup job to remove expired tokens
   - Monitor token usage patterns

5. **Password Policy**
   - Consider additional password requirements (complexity, common passwords)
   - Implement password strength meter in UI
   - Enforce password history to prevent reuse

### Security Best Practices

1. **Email Security**
   - Use TLS for email delivery
   - Implement SPF, DKIM, and DMARC records
   - Monitor for email spoofing attempts

2. **Token Security**
   - Hash tokens before storing in database
   - Use HTTP-only cookies for additional verification
   - Consider adding CAPTCHA for reset requests

3. **Monitoring**
   - Track password reset request volume
   - Monitor for unusual patterns (e.g., bursts from single IP)
   - Alert on high failure rates

4. **User Communication**
   - Notify users of password reset attempts
   - Provide clear instructions in reset emails
   - Include security tips in email footer

## Migration from Console.log

The previous implementation used console.log for email sending:

```typescript
// Before
emailSender: async (to, subject, body) => {
  console.log(`[email] to=${to} subject="${subject}" body="${body}"`);
}
```

This leaked reset tokens into logs. The new implementation uses EmailService:

```typescript
// After
emailSender: async (to, subject, body) => {
  await emailService.sendMail(to, subject, body);
}
```

**Security improvements**:
- No token leakage to logs
- Proper email delivery
- Error handling without exposing sensitive data
- Production-ready email service integration

## References

- [OWASP Forgot Password Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html)
- [NIST Digital Identity Guidelines](https://pages.nist.gov/800-63-3/)
- [SendGrid API Documentation](https://docs.sendgrid.com/api-reference/)
