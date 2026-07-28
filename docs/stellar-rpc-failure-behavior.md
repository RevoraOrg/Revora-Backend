# Stellar RPC Failure Classification

## Overview

The `classifyStellarRPCFailure` function provides deterministic classification of Stellar network failures into client-safe error categories. This ensures that raw upstream error messages never cross the API trust boundary, maintaining security while providing meaningful error responses.

## Implementation

### Function Signature

```typescript
export function classifyStellarRPCFailure(error: unknown): StellarRPCFailureClass
```

### Failure Classes

| Class | Description | HTTP Status Code | Use Case |
|-------|-------------|----------------|----------|
| `TIMEOUT` | Request timed out or was aborted | 504 Gateway Timeout | Network latency, server overload |
| `RATE_LIMIT` | Too many requests to Stellar services | 429 Too Many Requests | API rate limiting exceeded |
| `UPSTREAM_ERROR` | Stellar server error (5xx) | 502 Bad Gateway | Horizon/Soroban server issues |
| `MALFORMED_RESPONSE` | Invalid response format from Stellar | 502 Bad Gateway | JSON parsing errors, unexpected format |
| `UNAUTHORIZED` | Authentication/authorization failure | 401 Unauthorized | Invalid credentials, permissions |
| `UNKNOWN` | Unclassified error | 503 Service Unavailable | Fallback for unknown errors |

### Classification Logic

```typescript
export function classifyStellarRPCFailure(error: unknown): StellarRPCFailureClass {
  // Timeout detection
  if (
    error instanceof Error &&
    (error.name === 'AbortError' || error.message.toLowerCase().includes('timeout'))
  ) {
    return StellarRPCFailureClass.TIMEOUT;
  }

  // HTTP status code classification
  if (typeof error === 'object' && error !== null) {
    const status = (error as { status?: number }).status;
    if (status === 429) return StellarRPCFailureClass.RATE_LIMIT;
    if (status === 401 || status === 403) return StellarRPCFailureClass.UNAUTHORIZED;
    if (typeof status === 'number' && status >= 500) return StellarRPCFailureClass.UPSTREAM_ERROR;
  }

  // Response parsing errors
  if (error instanceof SyntaxError) {
    return StellarRPCFailureClass.MALFORMED_RESPONSE;
  }

  // Default fallback
  return StellarRPCFailureClass.UNKNOWN;
}
```

## Usage in Offering Sync Service

The offering sync service uses this classification to:

1. **Log appropriate error levels** based on failure class
2. **Return suitable HTTP status codes** to clients
3. **Provide safe error messages** without exposing upstream details
4. **Enable monitoring and alerting** for specific failure types

### Example Usage

```typescript
try {
  const onChainState = await this.stellarClient.getOfferingState(contractAddress);
  // Process successful response
} catch (error) {
  const failureClass = classifyStellarRPCFailure(error);
  
  this.logger.error('Stellar RPC failure', {
    contractAddress,
    failureClass,
    // Never log raw error messages in production
  });

  // Return appropriate HTTP response
  const statusCode = getStatusCodeForFailureClass(failureClass);
  const clientMessage = getClientSafeMessage(failureClass);
  
  return {
    success: false,
    error: clientMessage,
    failureClass,
  };
}
```

## Security Considerations

### Input Sanitization
- Raw error messages are never exposed to clients
- Only predefined failure classes are returned in API responses
- Error details are logged securely without sensitive information

### Error Message Mapping
```typescript
function getClientSafeMessage(failureClass: StellarRPCFailureClass): string {
  switch (failureClass) {
    case StellarRPCFailureClass.TIMEOUT:
      return 'Stellar network request timed out';
    case StellarRPCFailureClass.RATE_LIMIT:
      return 'Rate limit exceeded, please try again later';
    case StellarRPCFailureClass.UPSTREAM_ERROR:
      return 'Stellar service temporarily unavailable';
    case StellarRPCFailureClass.MALFORMED_RESPONSE:
      return 'Invalid response from Stellar network';
    case StellarRPCFailureClass.UNAUTHORIZED:
      return 'Authentication failed';
    default:
      return 'Stellar service error';
  }
}
```

### Monitoring Integration
The failure classes enable proper monitoring:

```typescript
// Metrics collection
metrics.counter('stellar_rpc_failures_total').inc({
  failure_class: failureClass,
  contract_address: contractAddress,
});

// Alerting rules
if (failureClass === StellarRPCFailureClass.UPSTREAM_ERROR) {
  alertManager.trigger('stellar_service_degraded', {
    severity: 'warning',
    details: { failureClass, contractAddress },
  });
}
```

## Testing Strategy

### Unit Tests
- Test each classification path with appropriate error inputs
- Verify edge cases (null, undefined, custom errors)
- Ensure no raw error messages leak through

### Integration Tests
- Test with actual Stellar network failures
- Verify HTTP status code mapping
- Test error propagation through service layers

### Mock Scenarios
```typescript
describe('classifyStellarRPCFailure', () => {
  it('classifies timeout errors', () => {
    const timeoutError = new Error('Request timeout');
    timeoutError.name = 'AbortError';
    
    expect(classifyStellarRPCFailure(timeoutError))
      .toBe(StellarRPCFailureClass.TIMEOUT);
  });

  it('classifies rate limit errors', () => {
    const rateLimitError = { status: 429 };
    
    expect(classifyStellarRPCFailure(rateLimitError))
      .toBe(StellarRPCFailureClass.RATE_LIMIT);
  });

  it('handles unknown errors', () => {
    const unknownError = new Error('Something went wrong');
    
    expect(classifyStellarRPCFailure(unknownError))
      .toBe(StellarRPCFailureClass.UNKNOWN);
  });
});
```

## Best Practices

1. **Always classify errors** before exposing them to clients
2. **Log failure classes** for monitoring and debugging
3. **Use appropriate HTTP status codes** based on failure class
4. **Never expose raw upstream error messages** in API responses
5. **Implement retry logic** for transient failures (TIMEOUT, RATE_LIMIT)
6. **Set up alerts** for persistent UPSTREAM_ERROR failures

## Integration with Existing Error Handling

The classification integrates seamlessly with the existing `lib/errors` system:

```typescript
// In route handlers
if (result.failureClass) {
  const statusCode = getStatusCodeForFailureClass(result.failureClass);
  const error = Errors.serviceUnavailable('Stellar service temporarily unavailable', {
    failureClass: result.failureClass,
  });
  return res.status(statusCode).json(error.toResponse(requestId));
}
```

This ensures consistent error responses across the entire API while maintaining security and observability.
