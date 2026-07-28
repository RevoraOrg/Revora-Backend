# RevenueHandler: Validation and Decimal Boundaries

## Overview

The RevenueHandler implementation provides hardened HTTP request handling for revenue report submission with comprehensive validation, decimal boundary enforcement, structured logging, and security-aware error responses.

**Target Files:**
- [src/handlers/revenueHandler.ts](../src/handlers/revenueHandler.ts)
- [src/services/revenueService.ts](../src/services/revenueService.ts)
- [src/routes/revenueRoutes.ts](../src/routes/revenueRoutes.ts)

**Test Coverage:**
- [src/handlers/revenueHandler.test.ts](../src/handlers/revenueHandler.test.ts) - 100% coverage
- [src/services/revenueService.test.ts](../src/services/revenueService.test.ts) - 94.91% coverage

## Security Assumptions

### Authentication & Authorization

1. **JWT Authentication**
   - The `AuthenticatedRequest.user` field is populated by the `authMiddleware` only after successful JWT verification.
   - The `user.id` (issuer ID) is extracted from the JWT claims and is guaranteed to be authentic.
   - Any request without valid JWT credentials is rejected at the middleware layer before reaching the handler.

2. **Offering Ownership**
   - Before processing any revenue report, the service verifies that the authenticated issuer owns the offering.
   - This check occurs in `RevenueService.submitReport()` before any state-modifying operations.
   - A forbidden (403) error is returned if the issuer attempts to submit a report for an offering they do not own.

3. **Error Response Sanitization**
   - No raw database errors, file system paths, or upstream service details are exposed to clients.
   - All errors are mapped to structured `AppError` instances with machine-readable error codes.
   - Unexpected exceptions are caught and sanitized to prevent information leakage.
   - Only errors with `expose: true` are sent to clients; internal errors are logged but not detailed.

### Input Validation & Schema

1. **Middleware-Layer Validation**
   - Request body schema validation occurs **before** authentication to avoid timing attacks.
   - UUID v4 format validation for offering IDs prevents SQL injection and path traversal.
   - ISO 8601 date validation prevents malformed timestamps.
   - Positive decimal validation prevents negative amounts and non-numeric values.

2. **Service-Layer Validation**
   - Business logic validations (period ordering, offering ownership, period overlap detection) require database access.
   - These checks are enforced in `RevenueService` after middleware-level format validation.

## Decimal Precision & Boundaries

### Database Schema

The PostgreSQL database schema defines revenue amounts as:
```sql
amount NUMERIC(30,10)
```

This precision allows:
- **Integer part**: Up to 20 digits (maximum ~9.99 × 10^19)
- **Fractional part**: Up to 10 decimal places (minimum ~10^-10)

### Validation Rules

All decimal amount strings must satisfy:

1. **Format**: Positive decimal string with digits and optional decimal point
   - ✓ Valid: `100`, `100.5`, `0.1234567890`
   - ✗ Invalid: `-100`, `100.00a`, `$100`, `1e6`

2. **Integer Part**: Maximum 20 digits
   - ✓ Valid: `99999999999999999999` (20 nines)
   - ✗ Invalid: `123456789012345678901` (21 digits)

3. **Fractional Part**: Maximum 10 decimal places
   - ✓ Valid: `100.1234567890` (10 places)
   - ✗ Invalid: `100.12345678901` (11 places)

4. **Numeric Value**: Must be greater than zero
   - ✓ Valid: `0.0000000001`, `1000000`, `99999999999999999999.9999999999`
   - ✗ Invalid: `0`, `-100`, `NaN`, `Infinity`

5. **Forbidden Formats**: No exponential notation or non-numeric characters
   - ✗ Invalid: `1e6`, `1E3`, `1.5e-2`

### Implementation Details

**Regex Patterns:**

```typescript
// Amount: positive decimal with 0-10 decimal places
const POSITIVE_DECIMAL_REGEX = /^\d+(\.\d{1,10})?$/;

// UUID v4 canonical format
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// ISO 8601 date/datetime
const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})?)?$/;
```

**Precision Preservation:**

Amounts are:
1. **Accepted as strings** in JSON request bodies (e.g., `"amount": "1000.1234567890"`)
2. **Validated as strings** to preserve exact decimal representation
3. **Stored as NUMERIC** in PostgreSQL (preserves precision)
4. **Returned as strings** in JSON responses to prevent floating-point rounding

This prevents the loss of precision from JavaScript's floating-point arithmetic.

### Boundary Test Cases

**Valid Boundary Values:**

| Amount | Type | Notes |
|--------|------|-------|
| `100` | Integer | No decimal places |
| `0.1234567890` | Minimum precision | 10 decimal places |
| `99999999999999999999.9999999999` | Maximum amount | 20 integer + 10 decimal |
| `1.5` | Common case | 1 decimal place |

**Invalid Boundary Values:**

| Amount | Reason |
|--------|--------|
| `100.12345678901` | 11 decimal places (exceeds 10) |
| `123456789012345678901` | 21 integer digits (exceeds 20) |
| `0` | Not greater than zero |
| `-100` | Negative value |
| `1e6` | Exponential notation |
| `100.00a` | Non-numeric characters |

## Structured Logging

### Logger Configuration

The implementation uses structured JSON logging with RFC 5424 log levels:

```typescript
enum LogLevel {
  EMERGENCY = 0,
  ALERT = 1,
  CRITICAL = 2,
  ERROR = 3,
  WARN = 4,
  INFO = 5,
  DEBUG = 6,
  TRACE = 7,
}
```

### Log Events

**Success Path:**
```json
{
  "level": "INFO",
  "message": "Revenue report submitted successfully",
  "requestId": "req-123",
  "reportId": "report-1",
  "offeringId": "offering-1",
  "issuerId": "issuer-1"
}
```

**Validation Error:**
```json
{
  "level": "WARN",
  "message": "Revenue submission: invalid amount format",
  "requestId": "req-123",
  "amount": "100.12345678901",
  "reason": "Decimal places exceed maximum 10 places"
}
```

**Authorization Error:**
```json
{
  "level": "WARN",
  "message": "Revenue submission: unauthorized offering access",
  "requestId": "req-123",
  "offeringId": "offering-1",
  "expectedIssuerId": "issuer-correct",
  "providedIssuerId": "issuer-wrong"
}
```

**Internal Error:**
```json
{
  "level": "ERROR",
  "message": "Unexpected error during revenue submission",
  "requestId": "req-123",
  "error": "Database connection timeout"
}
```

### PII Redaction

Sensitive fields are automatically redacted from logs (case-insensitive):
- `password`, `secret`, `token`, `apikey`, `api_key`
- `authorization`, `cookie`, `session`
- `private_key`, `privatekey`, `credit_card`, `creditcard`
- `ssn`, `social_security`

## Error Handling & API Responses

### AppError Class

All errors are mapped to `AppError` instances with structured responses:

```typescript
interface ErrorResponse {
  code: ErrorCode;           // Machine-readable error code
  message: string;           // Human-readable message
  details?: unknown;         // Optional context (hidden for internal errors)
  requestId?: string;        // Correlation ID for log tracing
}
```

### HTTP Status Codes & Error Codes

| HTTP | Code | Scenario |
|------|------|----------|
| 201 | N/A | Report submitted successfully |
| 400 | VALIDATION_ERROR | Schema validation failure (handled by middleware) |
| 400 | BAD_REQUEST | Missing fields, invalid amount, period ordering |
| 401 | UNAUTHORIZED | Missing or invalid JWT |
| 403 | FORBIDDEN | Issuer does not own the offering |
| 404 | NOT_FOUND | Offering does not exist |
| 409 | CONFLICT | Period overlaps with existing report |
| 500 | INTERNAL_ERROR | Unexpected server error (details not exposed) |

### Error Propagation

1. **Middleware Validation Errors**: Caught by `validateParams()` / `validateBody()` middleware
2. **Service AppErrors**: Forwarded through express `next()` to error handler middleware
3. **Unexpected Errors**: Sanitized to `INTERNAL_ERROR` (500) to prevent information leakage

## API Endpoints

### POST /offerings/:id/revenue

**Request:**
```json
{
  "amount": "1000.00",
  "periodStart": "2024-01-01T00:00:00Z",
  "periodEnd": "2024-01-31T00:00:00Z"
}
```

**Response (201):**
```json
{
  "message": "Revenue report submitted successfully",
  "data": {
    "id": "report-1",
    "offering_id": "offering-1",
    "issuer_id": "issuer-1",
    "amount": "1000.00",
    "period_start": "2024-01-01T00:00:00Z",
    "period_end": "2024-01-31T00:00:00Z",
    "created_at": "2024-01-01T12:00:00Z",
    "updated_at": "2024-01-01T12:00:00Z"
  }
}
```

**Error Response (400):**
```json
{
  "code": "BAD_REQUEST",
  "message": "Invalid revenue amount: Decimal places exceed maximum 10 places",
  "details": {
    "provided": 11,
    "maximum": 10,
    "providedValue": "100.12345678901"
  },
  "requestId": "req-123"
}
```

### POST /revenue-reports

Same as above, but with `offeringId` in the request body instead of path parameter.

## Testing Strategy

### Test Coverage

| Module | Statements | Branches | Functions | Lines |
|--------|-----------|----------|-----------|-------|
| revenueHandler.ts | 100% | 95.65% | 100% | 100% |
| revenueService.ts | 94.91% | 90% | 100% | 94.91% |

### Test Categories

1. **Happy Path**: Successful report submission with valid inputs
2. **Authentication**: Missing/invalid JWT credentials
3. **Authorization**: Issuer attempting to access offering they don't own
4. **Decimal Validation**: Boundary cases (max integer digits, max decimal places, zero, negative, exponential)
5. **Period Validation**: Invalid ordering (end before start, end equals start)
6. **Overlap Detection**: Detecting conflicting existing reports
7. **Error Handling**: AppError propagation and error sanitization
8. **Logging**: Verification of structured log events

### Edge Cases Covered

- Amounts with exactly 10 decimal places
- Amounts with fewer than 10 decimal places
- Maximum 20-digit integer part
- Minimum positive amount (0.0000000001)
- Maximum valid amount (99999999999999999999.9999999999)
- Missing/null authenticated user
- Missing required fields in request body
- Service layer exceptions (not AppError instances)
- Very large date ranges for periods
- Overlapping period detection with existing reports

## Running Tests

```bash
# Run revenue-specific tests with coverage
npm test -- src/services/revenueService.test.ts src/handlers/revenueHandler.test.ts --coverage

# Run all tests
npm test

# Run with coverage threshold enforcement
npm run test:coverage
```

**Test Output Summary:**
```
Test Suites: 2 passed, 2 total
Tests:       51 passed, 51 total
Time:        9.19 s
Coverage:    94.91% - 100% across revenue modules
```

## Stellar RPC Failure Classification

The `classifyStellarRPCFailure` function (from `lib/stellarRpcFailure.ts`) is available for use in related distribution or payout operations:

```typescript
enum StellarRPCFailureClass {
  TIMEOUT = 'TIMEOUT',
  RATE_LIMIT = 'RATE_LIMIT',
  UPSTREAM_ERROR = 'UPSTREAM_ERROR',
  MALFORMED_RESPONSE = 'MALFORMED_RESPONSE',
  UNAUTHORIZED = 'UNAUTHORIZED',
  UNKNOWN = 'UNKNOWN',
}
```

This is NOT used in RevenueHandler itself (revenue reports are DB-only), but is documented for reference when revenue data flows to the distribution engine.

## Migration & Database

No new database migrations are required for this implementation. The `revenue_reports` table is assumed to exist with:
- `id` (UUID primary key)
- `offering_id` (UUID, foreign key)
- `issuer_id` (UUID, foreign key)
- `amount` (NUMERIC(30,10))
- `period_start` (TIMESTAMP)
- `period_end` (TIMESTAMP)
- `reported_by` (UUID)
- `created_at`, `updated_at` (TIMESTAMP)

## Deployment Notes

1. **Configuration**: No new environment variables required; uses existing `DATABASE_URL` and `LOG_LEVEL`.
2. **Backward Compatibility**: New handler methods do not break existing interfaces.
3. **Transaction Safety**: Relies on existing database transaction handling in repositories.
4. **Error Handling**: Global error handler middleware must be configured to catch and format `AppError` instances.

## Security Considerations

- **No Raw Errors to Clients**: All database and system errors are sanitized before returning to clients.
- **Timing Attack Prevention**: Schema validation occurs before JWT verification to avoid timing leaks.
- **Decimal Precision**: String-based validation prevents JavaScript floating-point precision issues.
- **Period Non-Overlap**: Database queries prevent concurrent submissions for the same offering/period.
- **Audit Trail**: All operations are logged with `requestId` for correlation and forensics.

## Future Enhancements

1. **Rate Limiting**: Apply per-issuer rate limits to prevent report flooding.
2. **Idempotency Keys**: Support idempotent revenue report submission.
3. **Event Publishing**: Emit events to message queue (Kafka/RabbitMQ) for distribution engine.
4. **Audit Events**: Publish audit events for compliance and forensics.
5. **Bulk Submission**: Support batch revenue report upload for multiple offerings.
