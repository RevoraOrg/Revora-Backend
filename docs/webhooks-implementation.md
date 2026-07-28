# Webhooks Implementation

## Overview

The Revora Backend webhooks system provides production-grade webhook delivery and reception capabilities with HMAC-SHA256 signature verification, structured logging, retry logic, and comprehensive error handling.

## Architecture

### Components

1. **Signature Verification** (`src/lib/webhookSignature.ts`)
   - HMAC-SHA256 signature generation and verification
   - Constant-time comparison to prevent timing attacks
   - Replay protection via timestamp validation
   - Payload size limits

2. **Authentication Middleware** (`src/middleware/webhookAuth.ts`)
   - Express middleware for webhook signature verification
   - Multi-tenant support with dynamic secret providers
   - Configurable replay protection
   - Structured error responses

3. **Webhook Routes** (`src/routes/webhooks.ts`)
   - Single-tenant and multi-tenant webhook receivers
   - Event validation and processing
   - Health check endpoints
   - Structured logging integration

4. **Webhook Service** (`src/services/webhookService.ts`)
   - Fire-and-forget webhook delivery
   - Exponential backoff retry logic
   - Configurable retry policies
   - Structured logging for delivery tracking

5. **Database Repository** (`src/db/repositories/webhookEndpointRepository.ts`)
   - CRUD operations for webhook endpoints
   - Event subscription management
   - Active/inactive endpoint filtering

## Security Features

### Signature Verification

All incoming webhooks must include a valid HMAC-SHA256 signature:

```
X-Revora-Signature: sha256=<hex-encoded-hmac>
```

The signature is computed over the raw request body using a shared secret:

```typescript
const signature = createHmac("sha256", secret)
  .update(requestBody)
  .digest("hex");
```

### Replay Protection

Optional timestamp-based replay protection prevents replay attacks:

```
X-Webhook-Timestamp: <unix-timestamp-ms>
```

Webhooks older than the configured `maxAgeMs` (default: 5 minutes) are rejected.

### Constant-Time Comparison

Signature verification uses `crypto.timingSafeEqual()` to prevent timing attacks that could leak information about the secret.

### Payload Size Limits

Configurable maximum payload size (default: 1MB) prevents DoS attacks via large payloads.

## Security Assumptions

1. **Secret Management**
   - Webhook secrets are cryptographically random (≥32 bytes recommended)
   - Secrets are stored securely (environment variables, secret managers)
   - Secrets are never logged or exposed in error messages
   - Secrets are rotated regularly

2. **Transport Security**
   - All webhook endpoints use HTTPS
   - TLS certificate validation is enforced
   - No sensitive data in URL parameters

3. **Access Control**
   - Webhook endpoints are authenticated via signatures
   - No IP-based filtering (signatures provide sufficient authentication)
   - Rate limiting applied at application level

4. **Data Handling**
   - Raw upstream errors never exposed to clients
   - All errors mapped to structured error codes
   - PII automatically redacted from logs

## Abuse/Failure Paths

### Handled Scenarios

1. **Missing Signature**
   - HTTP 401 Unauthorized
   - Error code: `MISSING_SIGNATURE`
   - Logged as warning with request ID

2. **Invalid Signature**
   - HTTP 403 Forbidden
   - Error code: `VERIFICATION_FAILED`
   - Logged as warning (potential attack)

3. **Expired Timestamp**
   - HTTP 403 Forbidden
   - Error code: `TIMESTAMP_EXPIRED`
   - Logged as warning (replay attempt)

4. **Payload Too Large**
   - HTTP 413 Payload Too Large (Express)
   - HTTP 403 Forbidden (middleware)
   - Error code: `INVALID_FORMAT`

5. **Invalid JSON**
   - HTTP 400 Bad Request
   - Logged as warning with error details

6. **Event Processing Failure**
   - HTTP 422 Unprocessable Entity
   - Custom error message from handler
   - Logged as warning with event details

7. **Internal Server Error**
   - HTTP 500 Internal Server Error
   - Generic error message (no details exposed)
   - Logged as error with full stack trace

### Delivery Retry Logic

Webhook delivery implements exponential backoff:

- **Attempt 1**: Immediate
- **Attempt 2**: After `initialDelayMs` (default: 1000ms)
- **Attempt 3**: After `initialDelayMs * 2` (default: 2000ms)

**Retryable Errors:**

- 5xx server errors
- 429 Too Many Requests
- Network errors (timeout, connection refused)

**Non-Retryable Errors:**

- 4xx client errors (except 429)
- Invalid endpoint configuration

## Usage

### Receiving Webhooks

#### Basic Setup

```typescript
import { createWebhookRouter } from "./routes/webhooks";

app.use(
  "/webhooks",
  createWebhookRouter({
    secret: process.env.WEBHOOK_SECRET!,
    requireTimestamp: true,
    maxAgeMs: 300000, // 5 minutes
  }),
);
```

#### Custom Event Handler

```typescript
app.use(
  "/webhooks",
  createWebhookRouter({
    secret: process.env.WEBHOOK_SECRET!,
    eventHandler: async (event) => {
      // Process the webhook event
      await processPaymentEvent(event.data);

      return {
        success: true,
        eventId: event.id,
        message: "Payment processed successfully",
      };
    },
  }),
);
```

#### Multi-Tenant Webhooks

```typescript
import { createMultiTenantWebhookRouter } from "./routes/webhooks";
import { WebhookEndpointRepository } from "./db/repositories/webhookEndpointRepository";

const webhookRepo = new WebhookEndpointRepository(pool);

app.use(
  "/webhooks/:endpointId",
  createMultiTenantWebhookRouter(
    async (endpointId) => {
      const endpoint = await webhookRepo.findById(endpointId);
      return endpoint?.secret;
    },
    {
      eventHandler: async (event, endpointId) => {
        // Process with tenant context
        await processTenantEvent(event, endpointId);
        return { success: true, message: "Processed" };
      },
    },
  ),
);
```

### Sending Webhooks

#### Setup Webhook Service

```typescript
import { WebhookService, WebhookEventType } from "./services/webhookService";
import { WebhookEndpointRepository } from "./db/repositories/webhookEndpointRepository";

const webhookRepo = new WebhookEndpointRepository(pool);
const webhookService = new WebhookService(webhookRepo, {
  maxRetries: 3,
  initialDelayMs: 1000,
  timeoutMs: 10000,
});
```

#### Emit Events

```typescript
// Emit offering created event
await webhookService.emit(WebhookEventType.OFFERING_CREATED, {
  offeringId: "offering-123",
  name: "New Offering",
  status: "active",
});

// Emit payout completed event
await webhookService.emit(WebhookEventType.PAYOUT_COMPLETED, {
  payoutId: "payout-456",
  amount: "1000.00",
  currency: "USD",
  recipientId: "user-789",
});
```

## Event Types

The system supports the following webhook event types:

| Event Type               | Description                    |
| ------------------------ | ------------------------------ |
| `offering.created`       | New offering created           |
| `offering.updated`       | Offering details updated       |
| `revenue.reported`       | Revenue report submitted       |
| `distribution.started`   | Distribution process started   |
| `distribution.completed` | Distribution process completed |
| `payout.completed`       | Payout successfully processed  |
| `payout.failed`          | Payout processing failed       |

## Structured Logging

All webhook operations use structured logging with the following fields:

### Webhook Reception

```json
{
  "timestamp": "2024-01-01T00:00:00.000Z",
  "level": "INFO",
  "message": "Processing webhook event",
  "requestId": "req-123",
  "eventId": "evt-456",
  "eventType": "offering.created"
}
```

### Webhook Delivery

```json
{
  "timestamp": "2024-01-01T00:00:00.000Z",
  "level": "INFO",
  "message": "Webhook delivered successfully",
  "endpointId": "webhook-789",
  "endpointUrl": "https://example.com/webhook",
  "event": "offering.created",
  "payloadId": "payload-123",
  "attempts": 1,
  "statusCode": 200
}
```

### Delivery Failures

```json
{
  "timestamp": "2024-01-01T00:00:00.000Z",
  "level": "ERROR",
  "message": "Webhook delivery failed after all retries",
  "endpointId": "webhook-789",
  "endpointUrl": "https://example.com/webhook",
  "event": "offering.created",
  "payloadId": "payload-123",
  "attempts": 3,
  "lastStatusCode": 500,
  "lastError": "HTTP 500"
}
```

## Error Handling

All errors follow the `lib/errors.ts` pattern with structured error codes:

```typescript
{
  "error": "Webhook verification failed",
  "code": "VERIFICATION_FAILED",
  "message": "Signature verification failed"
}
```

No raw database errors or upstream service errors are exposed to clients.

## Testing

### Unit Tests

```bash
# Test webhook signature verification
npm test -- src/lib/webhookSignature.test.ts

# Test webhook authentication middleware
npm test -- src/middleware/webhookAuth.test.ts

# Test webhook routes
npm test -- src/routes/webhooks.test.ts

# Test webhook service
npm test -- src/services/webhookService.test.ts

# Test webhook repository
npm test -- src/db/repositories/webhookEndpointRepository.test.ts
```

### Integration Tests

```bash
# Run all webhook tests
npm test -- --testPathPattern=webhook

# Run with coverage
npm test -- --coverage --testPathPattern=webhook
```

### Test Coverage Requirements

- Minimum 95% line coverage
- All error paths tested
- Edge cases covered (empty payloads, malformed JSON, etc.)
- Security scenarios tested (invalid signatures, replay attacks)

## Configuration

### Environment Variables

| Variable                   | Description                              | Default                      |
| -------------------------- | ---------------------------------------- | ---------------------------- |
| `WEBHOOK_SECRET`           | Shared secret for signature verification | `development-webhook-secret` |
| `WEBHOOK_MAX_RETRIES`      | Maximum delivery retry attempts          | `3`                          |
| `WEBHOOK_INITIAL_DELAY_MS` | Initial retry delay in milliseconds      | `1000`                       |
| `WEBHOOK_TIMEOUT_MS`       | Request timeout in milliseconds          | `10000`                      |
| `WEBHOOK_MAX_PAYLOAD_SIZE` | Maximum payload size in bytes            | `1048576` (1MB)              |

### Database Schema

```sql
CREATE TABLE webhook_endpoints (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id   UUID        NOT NULL,
  url        TEXT        NOT NULL,
  secret     TEXT        NOT NULL,
  events     TEXT[]      NOT NULL DEFAULT '{}',
  active     BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_webhook_endpoints_owner_id ON webhook_endpoints (owner_id);
CREATE INDEX idx_webhook_endpoints_active ON webhook_endpoints (active) WHERE active = TRUE;
CREATE INDEX idx_webhook_endpoints_events ON webhook_endpoints USING GIN (events);
```

## Performance Considerations

1. **Webhook Delivery**
   - Fire-and-forget pattern (non-blocking)
   - Parallel delivery to multiple endpoints
   - Configurable timeouts prevent hanging requests

2. **Database Queries**
   - GIN index on events array for efficient event filtering
   - Partial index on active endpoints
   - Owner ID index for tenant queries

3. **Signature Verification**
   - Constant-time comparison (no performance leak)
   - Raw body parsing (no JSON parsing overhead)
   - Minimal memory allocation

## Monitoring

### Key Metrics

1. **Webhook Reception**
   - Request rate
   - Signature verification failures
   - Event processing failures
   - Response time distribution

2. **Webhook Delivery**
   - Delivery success rate
   - Retry rate
   - Average delivery time
   - Endpoint availability

3. **Security**
   - Invalid signature attempts
   - Replay attack attempts
   - Payload size violations

### Alerting

Set up alerts for:

- High signature verification failure rate (>5%)
- High delivery failure rate (>10%)
- Unusual spike in webhook traffic
- Repeated failures to specific endpoints

## Best Practices

1. **Secret Management**
   - Use cryptographically random secrets (≥32 bytes)
   - Rotate secrets regularly (every 90 days)
   - Store secrets in secure secret managers
   - Never commit secrets to version control

2. **Endpoint Configuration**
   - Use HTTPS for all webhook endpoints
   - Implement idempotency in webhook handlers
   - Return 2xx status codes for successful processing
   - Return 4xx for permanent failures, 5xx for retryable errors

3. **Event Design**
   - Keep payloads small and focused
   - Include event ID for deduplication
   - Include timestamp for ordering
   - Version your event schemas

4. **Error Handling**
   - Log all webhook events with structured logging
   - Monitor delivery success rates
   - Set up alerts for repeated failures
   - Implement dead letter queues for failed deliveries

## Troubleshooting

### Signature Verification Failures

1. Check that the secret matches on both sides
2. Verify the signature is computed over the raw body (not parsed JSON)
3. Ensure the signature header format is correct (`sha256=<hex>`)
4. Check for character encoding issues

### Delivery Failures

1. Verify the endpoint URL is accessible
2. Check firewall rules and network connectivity
3. Ensure the endpoint returns appropriate status codes
4. Review endpoint logs for processing errors

### Performance Issues

1. Check database query performance (use EXPLAIN ANALYZE)
2. Monitor webhook delivery concurrency
3. Review timeout configurations
4. Consider implementing a webhook queue for high-volume scenarios

## Future Enhancements

1. **Webhook Queue**
   - Persistent queue for reliable delivery
   - Priority-based delivery
   - Batch delivery support

2. **Webhook Management API**
   - CRUD endpoints for webhook configuration
   - Webhook testing/validation endpoints
   - Delivery history and logs

3. **Advanced Retry Policies**
   - Configurable retry schedules
   - Circuit breaker pattern
   - Dead letter queue

4. **Webhook Analytics**
   - Delivery success metrics
   - Latency tracking
   - Event type distribution

## References

- [Webhook Signature Verification Documentation](./webhook-signature-verification.md)
- [Structured Logging Guide](../src/lib/logger.ts)
- [Error Handling Patterns](../src/lib/errors.ts)
- [Database Migration Guide](./transaction-boundaries-migration-guide.md)
