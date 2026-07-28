# Requirements Document

## Introduction

The Rate Limiter Tier Policies feature provides production-grade, multi-tier rate limiting for the Revora backend API. This capability enables different rate limit policies based on client tier classification (standard, trusted, internal), with explicit security controls to prevent tier escalation attacks. The system must be deterministic, testable, and efficient for high-throughput production environments.

This feature addresses the need to:
- Protect backend resources from abuse while allowing legitimate high-volume clients
- Provide differentiated service levels based on client trust and authorization
- Maintain security by requiring explicit authorization for elevated tiers
- Enable observability through standard rate limit headers and tier identification

## Glossary

- **Rate_Limiter**: The middleware component that enforces request limits within time windows
- **Tier**: A classification level (standard, trusted, internal) that determines rate limit policies
- **Tier_Policy**: A configuration defining limit, window duration, and error message for a specific tier
- **Tier_Secret**: A shared secret required to authorize elevated tier access (trusted or internal)
- **Fixed_Window**: A rate limiting algorithm that counts requests within fixed time intervals
- **Rate_Limit_Store**: The backing storage mechanism for request counters (in-memory or distributed)
- **Client_IP**: The originating IP address of the request, used for keying standard tier limits
- **Tier_Header**: The HTTP header `x-revora-rate-tier` used by clients to request a specific tier
- **Secret_Header**: The HTTP header `x-revora-tier-secret` used to authorize elevated tier access
- **Rate_Limit_Headers**: Standard HTTP headers (X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset)
- **Tier_Downgrade**: The security mechanism that demotes unauthorized elevated tier requests to standard tier
- **Counter_Isolation**: The use of tier-specific key prefixes to prevent counter collision across tiers

## Requirements

### Requirement 1: Tier Policy Configuration

**User Story:** As a backend administrator, I want to configure distinct rate limit policies for each tier, so that I can provide differentiated service levels based on client trust.

#### Acceptance Criteria

1. THE Rate_Limiter SHALL support three tiers: standard, trusted, and internal
2. THE standard tier policy SHALL enforce 5 requests per 15-minute window
3. THE trusted tier policy SHALL enforce 10 requests per 15-minute window
4. THE internal tier policy SHALL enforce 25 requests per 15-minute window
5. FOR ALL tiers, THE Rate_Limiter SHALL use a fixed-window algorithm with deterministic counter behavior
6. THE Rate_Limiter SHALL use tier-specific key prefixes to ensure Counter_Isolation between tiers

### Requirement 2: Tier Resolution and Security

**User Story:** As a security engineer, I want elevated tiers to require explicit authorization, so that clients cannot escalate their rate limits through header spoofing.

#### Acceptance Criteria

1. WHEN a request includes no Tier_Header, THE Rate_Limiter SHALL assign the standard tier
2. WHEN a request includes Tier_Header with value "trusted" or "internal" AND includes a valid Tier_Secret, THE Rate_Limiter SHALL assign the requested tier
3. WHEN a request includes Tier_Header with value "trusted" or "internal" AND the Tier_Secret is missing, THE Rate_Limiter SHALL perform Tier_Downgrade to standard
4. WHEN a request includes Tier_Header with value "trusted" or "internal" AND the Tier_Secret is invalid, THE Rate_Limiter SHALL perform Tier_Downgrade to standard
5. WHEN a request includes Tier_Header with an unknown value, THE Rate_Limiter SHALL assign the standard tier
6. THE Rate_Limiter SHALL read the Tier_Secret from the environment variable STARTUP_AUTH_TIER_SECRET
7. THE Rate_Limiter SHALL compare the Secret_Header value against the configured Tier_Secret using exact string matching

### Requirement 3: Rate Limit Enforcement

**User Story:** As a backend developer, I want the rate limiter to block requests that exceed tier limits, so that backend resources are protected from abuse.

#### Acceptance Criteria

1. WHEN a request count exceeds the tier's limit within the current window, THE Rate_Limiter SHALL return HTTP status 429 Too Many Requests
2. WHEN returning 429, THE Rate_Limiter SHALL include a JSON error body with a tier-specific message
3. WHEN returning 429, THE Rate_Limiter SHALL include a Retry-After header indicating seconds until window reset
4. WHEN a request is within the tier's limit, THE Rate_Limiter SHALL increment the counter and pass the request to the next middleware
5. WHEN a time window expires, THE Rate_Limiter SHALL reset the counter for that key and start a new window

### Requirement 4: Rate Limit Headers

**User Story:** As a client developer, I want to receive standard rate limit headers, so that I can implement intelligent retry logic and avoid hitting limits.

#### Acceptance Criteria

1. FOR ALL requests, THE Rate_Limiter SHALL set the X-RateLimit-Limit header to the tier's maximum request count
2. FOR ALL requests, THE Rate_Limiter SHALL set the X-RateLimit-Remaining header to the number of requests remaining in the current window
3. FOR ALL requests, THE Rate_Limiter SHALL set the X-RateLimit-Reset header to the UTC epoch seconds when the window resets
4. FOR ALL requests, THE Rate_Limiter SHALL set the X-RateLimit-Tier header to the resolved tier name for observability
5. THE Rate_Limiter SHALL calculate X-RateLimit-Remaining as max(0, limit - count) to prevent negative values

### Requirement 5: Request Keying Strategy

**User Story:** As a backend engineer, I want rate limits keyed by client IP for public routes, so that individual clients cannot exhaust shared resources.

#### Acceptance Criteria

1. THE Rate_Limiter SHALL derive the rate limit key from the Client_IP for public routes
2. WHEN the application is deployed behind a trusted proxy, THE Rate_Limiter SHALL use the de-proxied IP from req.ip
3. WHEN req.ip is unavailable, THE Rate_Limiter SHALL fall back to req.socket.remoteAddress
4. WHEN no IP address can be determined, THE Rate_Limiter SHALL use the key "unknown"
5. THE Rate_Limiter SHALL prefix IP-based keys with "ip:" for namespace clarity
6. THE Rate_Limiter SHALL combine the tier-specific keyPrefix with the IP key to ensure Counter_Isolation

### Requirement 6: In-Memory Store Implementation

**User Story:** As a backend developer, I want an in-memory rate limit store for single-instance deployments, so that I can enforce limits without external dependencies.

#### Acceptance Criteria

1. THE Rate_Limit_Store SHALL maintain a map of keys to window entries containing count and resetAt timestamp
2. WHEN incrementing a counter for a key with no existing window, THE Rate_Limit_Store SHALL create a new window with count 1 and resetAt set to now + windowMs
3. WHEN incrementing a counter for a key with an expired window, THE Rate_Limit_Store SHALL create a new window with count 1
4. WHEN incrementing a counter for a key with an active window, THE Rate_Limit_Store SHALL increment the count and return the existing resetAt
5. THE Rate_Limit_Store SHALL provide a reset method to clear a specific key's counter for testing
6. THE Rate_Limit_Store SHALL provide a clear method to remove all counters for testing

### Requirement 7: Middleware Integration

**User Story:** As a backend developer, I want to apply tier-based rate limiting to specific routes, so that I can protect sensitive endpoints without affecting all routes.

#### Acceptance Criteria

1. THE Rate_Limiter SHALL be implemented as Express middleware compatible with the RequestHandler interface
2. THE Rate_Limiter SHALL accept req, res, and next parameters following Express conventions
3. WHEN the rate limit is not exceeded, THE Rate_Limiter SHALL call next() without arguments to continue the middleware chain
4. WHEN the rate limit is exceeded, THE Rate_Limiter SHALL call next(error) with a structured error object
5. THE Rate_Limiter SHALL be mountable on specific routes without affecting other routes (e.g., /health endpoint isolation)

### Requirement 8: Error Response Format

**User Story:** As a client developer, I want structured error responses when rate limited, so that I can programmatically handle rate limit errors.

#### Acceptance Criteria

1. WHEN returning 429, THE Rate_Limiter SHALL include a JSON body with an error message field
2. THE error message for standard tier SHALL be "Too many registration attempts, please try again after 15 minutes."
3. THE error message for trusted tier SHALL be "Too many trusted-tier registration attempts, please try again after 15 minutes."
4. THE error message for internal tier SHALL be "Too many internal registration attempts, please try again after 15 minutes."
5. THE Rate_Limiter SHALL use the application's standard error format compatible with the global error handler

### Requirement 9: Testing and Observability

**User Story:** As a QA engineer, I want comprehensive test coverage for rate limiting behavior, so that I can verify correctness and prevent regressions.

#### Acceptance Criteria

1. THE Rate_Limiter SHALL achieve minimum 95% test coverage across statements, branches, functions, and lines
2. THE test suite SHALL verify that standard tier blocks the 6th request within a 15-minute window
3. THE test suite SHALL verify that trusted tier allows 10 requests and blocks the 11th when properly authorized
4. THE test suite SHALL verify that spoofed trusted tier requests without valid Tier_Secret are downgraded to standard limits
5. THE test suite SHALL verify that internal tier allows 25 requests and blocks the 26th when properly authorized
6. THE test suite SHALL verify that rate limit headers are correctly set on all responses
7. THE test suite SHALL verify that the /health endpoint remains available when startup auth routes are rate limited
8. THE test suite SHALL verify that tier-specific counters are isolated and do not interfere with each other

### Requirement 10: Security Assumptions Documentation

**User Story:** As a security auditor, I want explicit documentation of security assumptions, so that I can assess the threat model and deployment requirements.

#### Acceptance Criteria

1. THE documentation SHALL state that Tier_Header is treated as untrusted client input
2. THE documentation SHALL state that elevated tiers require valid Tier_Secret authorization
3. THE documentation SHALL state that missing or invalid Tier_Secret results in Tier_Downgrade to standard
4. THE documentation SHALL state that the application must be deployed behind a trusted proxy with `app.set('trust proxy', 1)` for stable IP-based keying
5. THE documentation SHALL state that the in-memory store is process-local and requires replacement with a shared store for distributed deployments
6. THE documentation SHALL document abuse scenarios including header spoofing, invalid tier names, and counter isolation
7. THE documentation SHALL document failure paths including rate limiter store failures and fallback strategies

### Requirement 11: Distributed Store Compatibility

**User Story:** As a DevOps engineer, I want the rate limiter to support pluggable storage backends, so that I can use Redis or other shared stores in multi-instance deployments.

#### Acceptance Criteria

1. THE Rate_Limiter SHALL accept an optional store parameter implementing the RateLimitStore interface
2. THE RateLimitStore interface SHALL define an increment method accepting key and windowMs parameters
3. THE RateLimitStore interface SHALL define a reset method accepting a key parameter
4. THE RateLimitStore interface SHALL define an optional clear method for test support
5. WHEN no store is provided, THE Rate_Limiter SHALL use a module-level default InMemoryRateLimitStore instance
6. THE Rate_Limiter SHALL not make assumptions about store implementation details beyond the interface contract

### Requirement 12: Configuration Flexibility

**User Story:** As a backend developer, I want to configure tier secret environment variable names, so that I can adapt the rate limiter to different deployment contexts.

#### Acceptance Criteria

1. THE Rate_Limiter SHALL accept an optional tierSecretEnvName parameter for configuring the environment variable name
2. WHEN tierSecretEnvName is not provided, THE Rate_Limiter SHALL default to "STARTUP_AUTH_TIER_SECRET"
3. WHEN tierSecretEnvName is provided, THE Rate_Limiter SHALL read the Tier_Secret from the specified environment variable
4. THE Rate_Limiter SHALL trim whitespace from the configured Tier_Secret value
5. THE Rate_Limiter SHALL trim whitespace from the Secret_Header value before comparison
