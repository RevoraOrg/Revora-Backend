# CORS Production Origin Allowlist

## Overview

This document describes the CORS (Cross-Origin Resource Sharing) middleware implementation for Revora-Backend, providing production-grade origin allowlisting with environment-driven configuration.

## Security Assumptions

### Core Security Model
- **Explicit Allowlist**: Only origins explicitly listed in `ALLOWED_ORIGINS` are permitted
- **Default Deny**: Any origin not in the allowlist is denied
- **Production Enforcement**: `ALLOWED_ORIGINS` must be configured in production environments
- **No Wildcards with Credentials**: Wildcard origin `*` is strictly forbidden when `credentials: true` is enabled (which is our default)
- **No Origin Handling**: Requests without Origin header (e.g., curl, health checks) can be optionally allowed via `CORS_ALLOW_NO_ORIGIN`

### Threat Mitigation
- **Origin Spoofing**: CORS does not prevent origin header spoofing; this is a client-side enforcement mechanism
- **CSRF Protection**: CORS is not a substitute for CSRF tokens; it complements other security measures
- **Information Disclosure**: Denied origins are logged for security monitoring but not exposed to clients
- **Preflight Hardening**: Preflight responses are capped with a bounded `max-age` and restricted methods/headers to minimize attack surface

### Abuse and Failure Paths
- **Configuration Errors**: Missing `ALLOWED_ORIGINS` in production, or including `*` in the allowlist while credentials are enabled, throws a startup error.
- **Malformed Origins**: Invalid origin headers are safely rejected.
- **Allowlist Integrity**: Mixing `*` with explicit origins in `ALLOWED_ORIGINS` is rejected during environment parsing.
- **Logging Overhead**: Security events are logged at appropriate levels (WARN for denials, ERROR for config issues).

## Configuration

### Environment Variables

```bash
# Required in production: Comma-separated list of allowed origins
ALLOWED_ORIGINS="https://app.revora.com,https://admin.revora.com"

# Optional: Allow requests without Origin header (default: false)
CORS_ALLOW_NO_ORIGIN="true"
```

### Development Defaults
- `ALLOWED_ORIGINS`: `["http://localhost:3000"]`
- `CORS_ALLOW_NO_ORIGIN`: `false`

## Implementation Details

### Middleware Flow
1. **Configuration Validation**: Validates `ALLOWED_ORIGINS` in production
2. **Origin Validation**: Checks request Origin against allowlist
3. **Logging**: Structured logging of security events
4. **Header Injection**: Sets appropriate CORS headers for allowed requests

### CORS Headers Configured
- `Access-Control-Allow-Origin`: Mirrors request origin if allowed (never `*` with credentials)
- `Access-Control-Allow-Credentials`: `true`
- `Access-Control-Allow-Methods`: `GET, POST, PUT, PATCH, DELETE, OPTIONS`
- `Access-Control-Allow-Headers`: `Content-Type, Authorization, X-Request-Id, X-User-Id, X-User-Role`
- `Access-Control-Expose-Headers`: `X-Request-Id`
- `Access-Control-Max-Age`: `86400` (24 hours - bounded preflight cache)

### Error Handling
- **Configuration Errors**: Throws `Error` on startup if production config invalid
- **Origin Validation**: Returns `false` from origin callback (CORS library handles response)
- **Logging Failures**: Gracefully continues if logging fails (non-blocking)

## Testing Coverage

### Unit Tests (`src/middleware/cors.test.ts`)
- ✅ Configuration validation (production requirements)
- ✅ Origin allowlist validation
- ✅ No-origin request handling
- ✅ CORS header injection
- ✅ Security edge cases (malformed origins, empty allowlists)
- ✅ Environment variable parsing

### Integration Tests
- ✅ End-to-end CORS behavior with actual HTTP requests
- ✅ Preflight request handling
- ✅ Credential handling

### Coverage Requirements
- **Target**: ≥95% line and branch coverage
- **Critical Paths**: All origin validation logic, configuration parsing
- **Edge Cases**: Malformed inputs, environment variations

## Usage Examples

### Basic Setup
```typescript
import { createCorsMiddleware } from './middleware/cors';

const app = express();
app.use(createCorsMiddleware());
```

### Testing Origin Validation
```bash
# Allowed origin
curl -H "Origin: https://app.revora.com" -X OPTIONS https://api.revora.com/health

# Denied origin (logged as security event)
curl -H "Origin: https://evil.com" -X OPTIONS https://api.revora.com/health
```

## Monitoring and Alerting

### Log Events
- **INFO**: Middleware initialization with configuration summary
- **WARN**: Denied origins (security monitoring)
- **ERROR**: Configuration validation failures

### Recommended Alerts
- Configuration errors in production
- High volume of denied origin attempts (potential scanning)
- Unexpected middleware failures

## Migration Notes

### From Default CORS
Replace `app.use(cors())` with `app.use(createCorsMiddleware())` for:
- Environment-driven configuration
- Structured security logging
- Production safety validations

### Breaking Changes
- Requires explicit `ALLOWED_ORIGINS` in production
- More restrictive default behavior
- Additional logging output

## Related Components

- **Request ID Middleware**: Provides correlation IDs for security event tracing
- **Error Handler**: Sanitizes error responses (no CORS errors exposed to clients)
- **Logger**: Structured logging with PII redaction
- **Environment Config**: Centralized configuration management