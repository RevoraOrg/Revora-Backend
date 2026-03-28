# Startup Auth Brute-Force Mitigation

This document describes the implementation of brute-force mitigation for the Startup Auth registration endpoint in the Revora Backend.

## Overview

The Startup Auth registration endpoint is a critical entry point for new startup users. To prevent brute-force attacks and ensure system availability, we have implemented rate limiting for this endpoint.

## Implementation Details

### Rate Limiting

We use a fixed-window rate-limiting algorithm to restrict the number of registration attempts from a single IP address.

- **Window**: 15 minutes
- **Limit**: 5 requests per IP address
- **Middleware**: `createRateLimitMiddleware`

When the limit is exceeded, the server returns a `429 Too Many Requests` status code with a standard JSON error response and a `Retry-After` header.

### Configuration

The rate limit is configured in `src/index.ts` and applied specifically to the `/startup/register` route.

```typescript
const startupAuthLimiter = createRateLimitMiddleware({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 5,
  message: 'Too many registration attempts, please try again after 15 minutes.',
});

apiRouter.use('/startup', startupAuthLimiter, createStartupAuthRouter(pool));
```

## Security Assumptions

1. **IP-Based Identification**: We assume that attackers will use a limited number of IP addresses. While this doesn't prevent sophisticated distributed attacks, it significantly increases the cost and difficulty of brute-forcing.
2. **Trust Proxy**: The backend is assumed to be running behind a trusted proxy (e.g., Nginx, Cloudflare) that sets the `X-Forwarded-For` header correctly.
3. **No User Enumeration**: The registration endpoint does not disclose whether an email already exists in a way that could be used for user enumeration beyond what is already available in the system.

## Testing and Verification

### Unit Tests

Comprehensive tests have been added to `src/routes/health.test.ts` to verify the following scenarios:
- Successful registration within the rate limit.
- Rejection of registration requests exceeding the rate limit.
- Reset of the rate limit after the window expires.

### Integration Tests

The rate limit has been verified using `supertest` in the automated test suite.

## Developer Notes

- The rate limit store is process-local (`InMemoryRateLimitStore`). In a multi-instance deployment, it should be replaced with a shared store (e.g., Redis).
- The rate limit can be adjusted in `src/index.ts` based on production requirements.
