# Webhook Signature Verification

This document describes the webhook signature verification system implemented in Revora Backend.

## Overview

The webhook signature verification system provides production-grade HMAC-SHA256 signature verification for incoming webhooks. It ensures that webhooks are authentic and haven't been tampered with during transmission.

## Security Features

- **HMAC-SHA256 Signatures**: Cryptographically secure signature generation and verification
- **Constant-Time Comparison**: Prevents timing attacks during signature verification
- **Replay Protection**: Optional timestamp validation to prevent replay attacks
- **Payload Size Limits**: Configurable maximum payload size to prevent abuse
- **Multiple Header Support**: Supports various webhook signature header formats

## Architecture

### Core Components

1. **`src/lib/webhookSignature.ts`** - Core signature utilities
   - `signWebhookPayload()` - Generate HMAC-SHA256 signatures
   - `verifyWebhookPayload()` - Verify signatures with constant-time comparison
   - `verifyWebhook()` - Comprehensive verification with replay protection
   - `WebhookSignatureError` - Structured error handling

2. **`src/middleware/webhookAuth.ts`** - Express middleware
   - `webhookAuth()` - Basic webhook authentication middleware
   - `webhookVerify()` - Full verification middleware
   - `webhookAuthWithProvider()` - Multi-tenant support with dynamic secrets

3. **`src/routes/webhooks.ts`** - Webhook receiver routes
   - `createWebhookRouter()` - Single-tenant webhook receiver
   - `createMultiTenantWebhookRouter()` - Multi-tenant webhook receiver

## Usage

### Basic Webhook Receiver

```typescript
import { createWebhookRouter } from './routes/webhooks';

// Add to your Express app
app.use('/webhooks', createWebhookRouter({
  secret: process.env.WEBHOOK_SECRET!,
  requireTimestamp: true,
  maxAgeMs: 300000, // 5 minutes
}));
```

### Custom Event Handler

```typescript
app.use('/webhooks', createWebhookRouter({
  secret: process.env.WEBHOOK_SECRET!,
  eventHandler: async (event) => {
    // Process the webhook event
    await processPayment(event.data);
    
    return {
      success: true,
      message: 'Payment processed successfully',
    };
  },
}));
```

### Multi-Tenant Webhooks

```typescript
import { createMultiTenantWebhookRouter } from './routes/webhooks';

app.use('/webhooks/:endpointId', createMultiTenantWebhookRouter(
  async (endpointId) => {
    // Fetch secret from database
    const endpoint = await db.webhookEndpoints.findById(endpointId);
    return endpoint?.secret;
  },
  {
    eventHandler: async (event, endpointId) => {
      // Process with tenant context
      await processForTenant(event.data, endpointId);
      return { success: true, message: 'Processed' };
    },
  }
));
```

### Using Middleware Directly

```typescript
import { webhookAuth } from './middleware/webhookAuth';

app.post('/custom-webhook',
  webhookAuth({
    secret: process.env.WEBHOOK_SECRET!,
    requireTimestamp: true,
  }),
  (req, res) => {
    // Webhook is verified, process the event
    res.json({ success: true });
  }
);
```

## Signature Format

Signatures follow the standard format:

```
sha256=<hex-encoded-hmac-sha256>
```

Example:
```
sha256=a1b2c3d4e5f6... (64 hex characters)
```

## Generating Signatures

### Node.js

```typescript
import { createHmac } from 'crypto';

function signWebhookPayload(secret: string, payload: string): string {
  const hmac = createHmac('sha256', secret);
  hmac.update(payload);
  return `sha256=${hmac.digest('hex')}`;
}

// Usage
const signature = signWebhookPayload('your-secret', JSON.stringify(payload));
```

### Python

```python
import hmac
import hashlib

def sign_webhook_payload(secret: str, payload: str) -> str:
    signature = hmac.new(
        secret.encode('utf-8'),
        payload.encode('utf-8'),
        hashlib.sha256
    ).hexdigest()
    return f'sha256={signature}'
```

### cURL Example

```bash
#!/bin/bash

SECRET="your-webhook-secret"
PAYLOAD='{"event":"test","data":{"id":"123"}}'
SIGNATURE=$(echo -n "$PAYLOAD" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/^.* //')

curl -X POST https://api.example.com/webhooks \
  -H "Content-Type: application/json" \
  -H "X-Revora-Signature: sha256=$SIGNATURE" \
  -d "$PAYLOAD"
```

## Headers

The system supports multiple signature header formats:

- `X-Revora-Signature` (default)
- `X-Webhook-Signature`
- `X-Signature`
- `X-Hub-Signature-256` (GitHub-style)

## Configuration Options

### WebhookRouterConfig

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `secret` | `string` | Required | Shared secret for signature verification |
| `eventHandler` | `WebhookEventHandler` | Logging handler | Custom event processing function |
| `requireTimestamp` | `boolean` | `true` | Require timestamp header for replay protection |
| `maxAgeMs` | `number` | `300000` (5 min) | Maximum webhook age in milliseconds |
| `maxPayloadSize` | `number` | `1048576` (1MB) | Maximum payload size in bytes |

### WebhookAuthOptions

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `secret` | `string` | Required | Shared secret for signature verification |
| `headerName` | `string` | `'x-revora-signature'` | Custom signature header name |
| `requireTimestamp` | `boolean` | `false` | Require timestamp header |
| `maxAgeMs` | `number` | `300000` | Maximum webhook age |
| `maxPayloadSize` | `number` | `1048576` | Maximum payload size |
| `onError` | `function` | Default handler | Custom error handler |

## Error Handling

### Error Codes

| Code | HTTP Status | Description |
|------|-------------|-------------|
| `MISSING_SIGNATURE` | 401 | Signature header is missing |
| `INVALID_FORMAT` | 403 | Signature format is invalid |
| `VERIFICATION_FAILED` | 403 | Signature verification failed |
| `TIMESTAMP_EXPIRED` | 403 | Webhook timestamp is outside acceptable window |

### WebhookSignatureError

```typescript
import { WebhookSignatureError } from './lib/webhookSignature';

try {
  assertValidWebhookSignature(secret, payload, signature);
} catch (error) {
  if (error instanceof WebhookSignatureError) {
    console.log(error.code); // 'MISSING_SIGNATURE' | 'INVALID_FORMAT' | 'VERIFICATION_FAILED'
    console.log(error.message);
  }
}
```

## Security Considerations

### Secret Management

1. **Use strong secrets**: Generate cryptographically random secrets of at least 32 bytes
2. **Rotate secrets regularly**: Implement a secret rotation strategy
3. **Store secrets securely**: Use environment variables or secret management services
4. **Never log secrets**: Ensure secrets are not included in logs

### Replay Protection

Enable `requireTimestamp` in production to prevent replay attacks:

```typescript
webhookAuth({
  secret: process.env.WEBHOOK_SECRET!,
  requireTimestamp: true,
  maxAgeMs: 60000, // 1 minute - adjust based on your needs
})
```

### Payload Size Limits

Set appropriate payload size limits to prevent DoS attacks:

```typescript
createWebhookRouter({
  secret: process.env.WEBHOOK_SECRET!,
  maxPayloadSize: 512 * 1024, // 512KB
})
```

## Testing

Run the webhook signature verification tests:

```bash
# Run all webhook tests
npm test -- src/lib/webhookSignature.test.ts
npm test -- src/middleware/webhookAuth.test.ts
npm test -- src/routes/webhooks.test.ts

# Run with coverage
npm test -- --coverage --testPathPattern=webhook
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `WEBHOOK_SECRET` | Shared secret for webhook signature verification | `development-webhook-secret` |
| `NODE_ENV` | Environment mode - enables timestamp validation in production | - |

## API Endpoints

### POST /webhooks

Receive webhooks with signature verification.

**Headers:**
- `Content-Type: application/json`
- `X-Revora-Signature: sha256=<signature>` (required)
- `X-Webhook-Timestamp: <unix-timestamp>` (optional, required if `requireTimestamp: true`)

**Request Body:**
```json
{
  "id": "evt-123",
  "event": "payment.completed",
  "data": { ... },
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

**Responses:**
- `200 OK` - Webhook processed successfully
- `400 Bad Request` - Invalid event structure
- `401 Unauthorized` - Missing signature
- `403 Forbidden` - Invalid signature or expired timestamp
- `422 Unprocessable Entity` - Event handler returned failure
- `500 Internal Server Error` - Server error

### GET /webhooks/health

Health check endpoint for the webhook receiver.

**Response:**
```json
{
  "status": "ok",
  "service": "webhook-receiver",
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

## Contributing

When modifying webhook signature verification:

1. Maintain constant-time comparison for security
2. Add tests for new functionality
3. Update this documentation
4. Ensure minimum 95% test coverage
5. Validate security assumptions and abuse/failure paths
