# Webhooks and Stellar RPC Integration

## Overview

This document describes how the webhook system integrates with Stellar Horizon API and Soroban smart contracts, including error classification and failure handling.

## Stellar RPC Failure Classification

When webhooks are triggered by Stellar/Soroban operations (e.g., payment submissions, contract invocations), failures from the Stellar network must be classified and sanitized before being exposed to webhook consumers.

### classifyStellarRPCFailure Usage

The `classifyStellarRPCFailure` function from `src/lib/stellarRpcFailure.ts` is used to map arbitrary Stellar Horizon/RPC failures into deterministic, client-safe error categories.

```typescript
import {
  classifyStellarRPCFailure,
  StellarRPCFailureClass,
} from "../lib/stellarRpcFailure";

// In webhook event handler
try {
  await stellarSubmissionService.submitPayment(destination, amount);

  // Emit success webhook
  await webhookService.emit(WebhookEventType.PAYOUT_COMPLETED, {
    payoutId,
    destination,
    amount,
    status: "completed",
  });
} catch (error) {
  // Classify the Stellar failure
  const failureClass = classifyStellarRPCFailure(error);

  // Emit failure webhook with classified error
  await webhookService.emit(WebhookEventType.PAYOUT_FAILED, {
    payoutId,
    destination,
    amount,
    status: "failed",
    errorClass: failureClass,
    // Never include raw error message
  });
}
```

### Failure Classification Categories

The following failure classes are used in webhook payloads:

| Failure Class        | Description                       | Webhook Behavior                    |
| -------------------- | --------------------------------- | ----------------------------------- |
| `TIMEOUT`            | Stellar Horizon request timed out | Retry webhook delivery              |
| `RATE_LIMIT`         | Stellar Horizon rate limit (429)  | Retry with backoff                  |
| `UPSTREAM_ERROR`     | Stellar Horizon 5xx error         | Retry webhook delivery              |
| `MALFORMED_RESPONSE` | Invalid JSON from Horizon         | Log error, send webhook             |
| `UNAUTHORIZED`       | Stellar auth failure (401/403)    | Send webhook immediately            |
| `UNKNOWN`            | Unclassified error                | Log for investigation, send webhook |

### Security Assumptions

1. **No Raw Upstream Errors**
   - Raw Stellar Horizon error messages are NEVER included in webhook payloads
   - Only the classified error category is exposed
   - Detailed errors are logged server-side only

2. **Deterministic Classification**
   - All Stellar failures map to one of the defined categories
   - Classification is consistent across retries
   - No information leakage through error messages

3. **Webhook Payload Sanitization**
   - Webhook payloads contain only:
     - Event type
     - Entity IDs
     - Status
     - Classified error category (if failed)
   - No stack traces, internal paths, or sensitive data

## Integration Points

### 1. Payout Processing

When processing payouts via Stellar:

```typescript
// src/services/payoutService.ts
import { WebhookService, WebhookEventType } from "./webhookService";
import { StellarSubmissionService } from "./stellarSubmissionService";
import { classifyStellarRPCFailure } from "../lib/stellarRpcFailure";
import { Logger } from "../lib/logger";

export class PayoutService {
  constructor(
    private readonly stellarService: StellarSubmissionService,
    private readonly webhookService: WebhookService,
    private readonly logger: Logger,
  ) {}

  async processPayout(payoutId: string, destination: string, amount: string) {
    try {
      // Submit to Stellar network
      const result = await this.stellarService.submitPayment(
        destination,
        amount,
      );

      this.logger.info("Payout submitted to Stellar", {
        payoutId,
        destination,
        amount,
        txHash: result.hash,
      });

      // Emit success webhook
      await this.webhookService.emit(WebhookEventType.PAYOUT_COMPLETED, {
        payoutId,
        destination,
        amount,
        transactionHash: result.hash,
        status: "completed",
        completedAt: new Date().toISOString(),
      });

      return { success: true, transactionHash: result.hash };
    } catch (error) {
      // Classify Stellar failure
      const failureClass = classifyStellarRPCFailure(error);

      this.logger.error("Payout failed", {
        payoutId,
        destination,
        amount,
        failureClass,
        error, // Full error logged server-side only
      });

      // Emit failure webhook with classified error
      await this.webhookService.emit(WebhookEventType.PAYOUT_FAILED, {
        payoutId,
        destination,
        amount,
        errorClass: failureClass, // Only classified error exposed
        status: "failed",
        failedAt: new Date().toISOString(),
      });

      return { success: false, errorClass: failureClass };
    }
  }
}
```

### 2. Distribution Processing

When distributing revenue via Stellar:

```typescript
// src/services/distributionEngine.ts
import { classifyStellarRPCFailure } from '../lib/stellarRpcFailure';

async processDistribution(distributionId: string) {
  // Emit start webhook
  await this.webhookService.emit(WebhookEventType.DISTRIBUTION_STARTED, {
    distributionId,
    startedAt: new Date().toISOString(),
  });

  try {
    // Process Stellar transactions
    const results = await this.processPayments(distributionId);

    // Emit completion webhook
    await this.webhookService.emit(WebhookEventType.DISTRIBUTION_COMPLETED, {
      distributionId,
      totalPayments: results.length,
      successfulPayments: results.filter(r => r.success).length,
      failedPayments: results.filter(r => !r.success).length,
      completedAt: new Date().toISOString(),
    });
  } catch (error) {
    const failureClass = classifyStellarRPCFailure(error);

    this.logger.error('Distribution failed', {
      distributionId,
      failureClass,
      error,
    });

    // Note: Distribution failures may not emit a webhook if the failure
    // occurs before any payments are processed
  }
}
```

### 3. Soroban Contract Events

When invoking Soroban contracts:

```typescript
// Future implementation for Soroban contract webhooks
async invokeContractWithWebhook(
  contractId: string,
  functionName: string,
  args: any[]
) {
  try {
    const result = await this.stellarService.invokeContract(
      contractId,
      functionName,
      args
    );

    // Emit contract invocation webhook
    await this.webhookService.emit('contract.invoked', {
      contractId,
      functionName,
      result,
      status: 'success',
    });
  } catch (error) {
    const failureClass = classifyStellarRPCFailure(error);

    await this.webhookService.emit('contract.failed', {
      contractId,
      functionName,
      errorClass: failureClass,
      status: 'failed',
    });
  }
}
```

## Webhook Event Payloads

### Successful Payout

```json
{
  "id": "evt-123",
  "event": "payout.completed",
  "payload": {
    "payoutId": "payout-456",
    "destination": "GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    "amount": "100.0000000",
    "transactionHash": "abc123...",
    "status": "completed",
    "completedAt": "2024-01-01T00:00:00.000Z"
  },
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

### Failed Payout (Classified Error)

```json
{
  "id": "evt-124",
  "event": "payout.failed",
  "payload": {
    "payoutId": "payout-457",
    "destination": "GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    "amount": "100.0000000",
    "errorClass": "TIMEOUT",
    "status": "failed",
    "failedAt": "2024-01-01T00:00:00.000Z"
  },
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

**Note:** The `errorClass` field contains only the classified error category, never raw error messages from Stellar Horizon.

## Error Handling Flow

```
Stellar Operation
       ↓
   Try/Catch
       ↓
   Error Occurs
       ↓
classifyStellarRPCFailure()
       ↓
Classified Error Category
       ↓
   Log Full Error (server-side)
       ↓
Emit Webhook (classified error only)
       ↓
Webhook Delivery (with retry)
```

## Testing

### Unit Tests

Tests for Stellar RPC failure classification are in `src/lib/stellar.test.ts`:

```bash
npm test -- src/lib/stellar.test.ts
```

### Integration Tests

Webhook integration with Stellar operations:

```bash
npm test -- src/services/webhookService.test.ts
npm test -- src/services/stellarSubmissionService.test.ts
```

### Test Coverage

The following scenarios are tested:

1. ✅ Successful Stellar payment → webhook emitted
2. ✅ Stellar timeout → classified as TIMEOUT → webhook emitted
3. ✅ Stellar rate limit (429) → classified as RATE_LIMIT → webhook emitted
4. ✅ Stellar 5xx error → classified as UPSTREAM_ERROR → webhook emitted
5. ✅ Stellar auth error → classified as UNAUTHORIZED → webhook emitted
6. ✅ Malformed response → classified as MALFORMED_RESPONSE → webhook emitted
7. ✅ Unknown error → classified as UNKNOWN → webhook emitted
8. ✅ No raw error messages in webhook payloads

## Security Considerations

### 1. Information Disclosure Prevention

**Risk:** Raw Stellar Horizon errors may contain sensitive information (account balances, internal IPs, etc.)

**Mitigation:**

- All errors classified before webhook emission
- Only error category exposed in webhooks
- Full errors logged server-side only
- Webhook consumers never see raw upstream errors

### 2. Retry Behavior

**Risk:** Transient Stellar failures could cause webhook spam

**Mitigation:**

- Webhook delivery has its own retry logic (separate from Stellar retries)
- Classified errors help consumers decide whether to retry
- TIMEOUT and RATE_LIMIT errors indicate retryable conditions
- UNAUTHORIZED errors indicate permanent failures

### 3. Event Ordering

**Risk:** Stellar operations may complete out of order, causing webhook confusion

**Mitigation:**

- Webhooks include sequence numbers for ordering
- EventOrderingTracker handles out-of-order delivery
- Consumers can buffer and reorder events client-side

## Monitoring

### Key Metrics

1. **Stellar Operation Success Rate**
   - Track successful vs failed Stellar operations
   - Alert on high failure rates

2. **Failure Classification Distribution**
   - Monitor which error classes are most common
   - TIMEOUT spikes may indicate network issues
   - RATE_LIMIT spikes may require throttling

3. **Webhook Delivery for Stellar Events**
   - Track webhook delivery success for Stellar-triggered events
   - Monitor retry rates for different error classes

### Logging

All Stellar-related webhook events are logged with structured context:

```json
{
  "timestamp": "2024-01-01T00:00:00.000Z",
  "level": "ERROR",
  "message": "Payout failed",
  "payoutId": "payout-456",
  "destination": "GXXX...XXX",
  "amount": "100.0000000",
  "failureClass": "TIMEOUT",
  "context": {
    "error": {
      "name": "Error",
      "message": "Request timeout"
    }
  }
}
```

## References

- [Stellar RPC Failure Classification](../src/lib/stellarRpcFailure.ts)
- [Stellar Tests](../src/lib/stellar.test.ts)
- [Webhook Service](../src/services/webhookService.ts)
- [Stellar Submission Service](../src/services/stellarSubmissionService.ts)
- [Webhook Implementation Guide](./webhooks-implementation.md)
