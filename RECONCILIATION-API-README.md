# Reconciliation API

## Overview

The Reconciliation API provides comprehensive revenue distribution reconciliation capabilities for the Revora platform. It ensures audit log consistency with chain events, validates Stellar/Horizon transactions, and maintains structured logging for security and compliance.

## Features

- **Revenue Reconciliation**: Comprehensive reconciliation between reported revenue and actual payouts
- **Chain Event Validation**: Optional validation of Stellar transactions for consistency
- **Audit Logging**: Complete audit trail for all reconciliation operations
- **Structured Logging**: Production-grade logging with correlation IDs
- **Error Handling**: Graceful handling of Stellar RPC failures with classification
- **Role-based Access**: Secure authorization based on user roles
- **High Test Coverage**: 95%+ test coverage with comprehensive edge case handling

## API Endpoints

### POST `/api/reconciliation/reconcile`
Perform comprehensive reconciliation check for an offering.

**Request Body:**
```json
{
  "offeringId": "string",
  "periodStart": "ISO 8601 datetime",
  "periodEnd": "ISO 8601 datetime",
  "options": {
    "tolerance": 0.01,
    "checkRoundingAdjustments": true,
    "checkInvestorAllocations": true,
    "validateChainEvents": true
  }
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "offeringId": "string",
    "periodStart": "ISO 8601 datetime",
    "periodEnd": "ISO 8601 datetime",
    "isBalanced": true,
    "discrepancies": [],
    "summary": {
      "totalRevenueReported": "1000.00",
      "totalPayouts": "1000.00",
      "discrepancyAmount": "0.00",
      "investorCount": 5,
      "payoutsProcessed": 5,
      "payoutsFailed": 0
    },
    "checkedAt": "ISO 8601 datetime"
  }
}
```

### GET `/api/reconciliation/balance-check/:offeringId`
Perform quick balance check without detailed discrepancy analysis.

**Query Parameters:**
- `periodStart`: ISO 8601 datetime
- `periodEnd`: ISO 8601 datetime

**Response:**
```json
{
  "success": true,
  "data": {
    "isBalanced": true,
    "difference": "0.00"
  }
}
```

### POST `/api/reconciliation/verify-distribution/:runId`
Verify integrity of a distribution run (admin only).

**Response:**
```json
{
  "success": true,
  "data": {
    "isValid": true,
    "errors": []
  }
}
```

### POST `/api/reconciliation/validate-report`
Validate a revenue report before submission.

**Request Body:**
```json
{
  "offeringId": "string",
  "amount": "1000.00",
  "periodStart": "ISO 8601 datetime",
  "periodEnd": "ISO 8601 datetime"
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "isValid": true,
    "errors": []
  }
}
```

## Discrepancy Types

The reconciliation API can detect the following discrepancy types:

- `REVENUE_MISMATCH`: Reported revenue doesn't match total payouts
- `PAYOUT_SUM_MISMATCH`: Sum of individual payouts doesn't match total
- `INVESTOR_ALLOCATION_ERROR`: Incorrect investor allocation calculations
- `ROUNDING_LOSS_UNACCOUNTED`: Unaccounted rounding losses
- `MISSING_PAYOUT`: Expected payout not found
- `DUPLICATE_PAYOUT`: Duplicate payout detected
- `OVERPAYMENT`: Payout exceeds expected amount
- `UNDERPAYMENT`: Payout is less than expected amount
- `DISTRIBUTION_STATUS_INVALID`: Invalid distribution status
- `CHAIN_EVENT_VALIDATION_FAILED`: Chain event validation failed
- `CHAIN_EVENT_MISMATCH`: Chain event doesn't match expected data
- `STELLAR_TX_NOT_FOUND`: Stellar transaction not found
- `STELLAR_TX_FAILED`: Stellar transaction validation failed

## Discrepancy Severity Levels

- **critical**: Immediate attention required (e.g., transaction failures)
- **error**: Investigation required (e.g., data inconsistencies)
- **warning**: Review recommended (e.g., timing mismatches)

## Authentication & Authorization

All endpoints require authentication. Role-based access control:

- **admin**: Full access to all reconciliation operations
- **startup**: Can reconcile offerings they own
- **compliance**: Read access to reconciliation data
- **investor**: Limited access based on investments

## Audit Logging

All reconciliation operations create comprehensive audit logs including:

- User ID and action performed
- Resource identifiers (offering ID, distribution run ID)
- Operation details (periods, amounts, results)
- IP address and user agent
- Request correlation ID
- Timestamp

## Stellar Integration

### Chain Event Validation
When enabled, the API validates Stellar transactions:

- Verifies transaction existence on-chain
- Validates transaction amounts match expected payouts
- Checks transaction timestamps are within reconciliation periods
- Handles Stellar RPC failures gracefully

### Stellar RPC Failure Classification
The API classifies Stellar RPC failures to prevent upstream error leakage:

- `TIMEOUT`: Request timeout
- `RATE_LIMIT`: Rate limit exceeded
- `UPSTREAM_ERROR`: Stellar server error
- `MALFORMED_RESPONSE`: Invalid response format
- `UNAUTHORIZED`: Authentication failure
- `UNKNOWN`: Unclassified error

## Error Handling

### Standard Error Response
```json
{
  "code": "VALIDATION_ERROR",
  "message": "offeringId is required and must be a string",
  "requestId": "req-123",
  "details": {}
}
```

### Error Codes
- `VALIDATION_ERROR`: Invalid input parameters
- `UNAUTHORIZED`: Authentication required
- `FORBIDDEN`: Insufficient permissions
- `NOT_FOUND`: Resource not found
- `INTERNAL_ERROR`: Server error
- `SERVICE_UNAVAILABLE`: External service unavailable

## Configuration

### Environment Variables
- `API_VERSION_PREFIX`: API version prefix (default: `/api/v1`)
- `LOG_LEVEL`: Logging level (default: `INFO`)
- `STELLAR_RPC_TIMEOUT`: Stellar RPC timeout (default: `30000ms`)

### Reconciliation Options
- `tolerance`: Amount tolerance for comparisons (default: `0.01`)
- `checkRoundingAdjustments`: Enable rounding checks (default: `false`)
- `checkInvestorAllocations`: Enable allocation checks (default: `false`)
- `validateChainEvents`: Enable chain validation (default: `false`)

## Monitoring & Alerting

### Key Metrics
- Reconciliation success rate
- Discrepancy detection rate
- Stellar RPC failure rate
- Audit log creation success rate
- Response times

### Recommended Alerts
- High reconciliation failure rate (>5%)
- High Stellar RPC failure rate (>10%)
- Audit log creation failures (>1%)
- Critical discrepancies detected

## Testing

### Test Coverage
- Unit tests: 95%+ coverage
- Integration tests: Database and Stellar integration
- Security tests: Authorization and input validation
- Performance tests: Large dataset handling

### Running Tests
```bash
# Run all tests
npm test

# Run reconciliation tests only
npm test -- --testNamePattern="reconciliation"

# Run with coverage
npm run test:coverage
```

## Security Considerations

### Input Validation
- All inputs are validated at runtime
- Amounts are handled as decimal strings
- Dates are validated for logical consistency
- SQL injection prevention via parameterized queries

### Data Protection
- No raw error messages exposed to clients
- Structured error responses prevent information leakage
- Audit logs support forensic analysis
- Request correlation enables efficient debugging

### Rate Limiting
- Awareness of Stellar rate limits
- Graceful degradation under high load
- Timeout handling for external service calls

## Troubleshooting

### Common Issues

#### Reconciliation Fails with "Revenue Mismatch"
- Check revenue report accuracy
- Verify payout calculations
- Review transaction timestamps

#### Chain Event Validation Fails
- Verify Stellar network connectivity
- Check transaction hash validity
- Review rate limit status

#### Audit Log Creation Fails
- Check database connectivity
- Verify audit log table permissions
- Review database transaction status

### Debug Information
All requests include a correlation ID in logs and error responses for debugging purposes.

## Performance Considerations

### Large Dataset Handling
- Pagination for large result sets
- Efficient database queries with proper indexing
- Timeout handling for long-running operations

### Concurrent Operations
- Database transaction isolation
- Optimistic locking for data consistency
- Queue-based processing for bulk operations

## Future Enhancements

### Planned Features
- Real-time reconciliation monitoring
- Automated discrepancy resolution
- Advanced analytics and reporting
- Multi-chain support

### Performance Improvements
- Caching for frequently accessed data
- Parallel processing for large reconciliations
- Optimized database queries

## API Versioning

Current version: `v1`

Versioning follows semantic versioning. Breaking changes require version increment.

## Support

For support and questions:
- Review the troubleshooting section
- Check audit logs for detailed error information
- Contact the development team with correlation IDs

## License

This API is part of the Revora-Backend project. See the main project license for details.
