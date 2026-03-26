# Backend Security Regression Suite

## Overview
The Backend Security Regression Suite is designed to ensure that `Revora-Backend` maintains production-grade security standards. It validates security assumptions, enforces auth boundaries, and prevents common information disclosure vulnerabilities.

## Security Assumptions
1.  **Strict Versioning**: All business logic must be scoped under the `API_VERSION_PREFIX` (default: `/api/v1`). Any business route exposed outside this prefix is considered a security leak.
2.  **Request Traceability**: Every request must be assigned a unique `X-Request-Id` for auditing and cross-service log correlation.
3.  **Information Hiding**: The server must not disclose its internal technology stack (e.g., `X-Powered-By` header must be disabled).
4.  **Resource Limits**: Every endpoint must be protected by rate limiting to prevent Denial of Service (DoS) attacks.
5.  **CORS Enforcement**: Cross-Origin Resource Sharing must be restricted to explicitly allowed origins.

## Security Controls

### 1. Hardened Headers
We use Express native settings and custom middlewares to control response headers:
- `app.disable('x-powered-by')`: Removes the Express signature.
- `requestIdMiddleware`: Injects traceability headers.

### 2. Rate Limiting
A global fixed-window rate limiter is implemented in `src/index.ts`:
- **Default Limit**: 100 requests per 60 seconds per IP.
- **Headers**:
    - `X-RateLimit-Limit`: Maximum requests allowed in the window.
    - `X-RateLimit-Remaining`: Requests left in the current window.
    - `X-RateLimit-Reset`: Time when the window resets.

### 3. Auditing
The `requestLogMiddleware` captures all incoming requests and audits sensitive actions (e.g., login, offering creation). Logs are output in JSON format for consumption by SIEM tools.

### 4. Authentication Boundaries
The `requireAuth` middleware enforces header-based authentication for all routes within the versioned prefix. It validates the presence of `x-user-id` and `x-user-role`.

## How to Run the Regression Suite
The suite is integrated into the Vitest/Jest test runner.

### Running Security Tests
```bash
npm test -- src/routes/health.test.ts
```

### Checking Coverage
To ensure deterministic coverage (target: >95%):
```bash
npm test -- --coverage
```

## Failure Path Examples
- **Unauthorized Access**: Attempting to hit `/api/v1/vaults/...` without headers returns `401 Unauthorized`.
- **CORS Violation**: Requests from unauthorized origins will lack the `Access-Control-Allow-Origin` header.
- **Rate Limit Breach**: Exceeding 100 requests/min returns `429 Too Many Requests`.
