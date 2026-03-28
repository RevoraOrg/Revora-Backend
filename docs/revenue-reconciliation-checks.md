# Revenue Reconciliation Checks

## Overview

The Revenue Reconciliation Checks feature provides deterministic validation of revenue distribution integrity within the Revora platform. It ensures that reported revenue matches payouts, investor allocations are correct, and no discrepancies exist in the distribution ledger.

## Architecture

### Components

1. **RevenueReconciliationService** (`src/services/revenueReconciliationService.ts`)
   - Core business logic for reconciliation operations
   - Validates revenue reports against distribution runs
   - Detects discrepancies with configurable severity levels

2. **Reconciliation Routes** (`src/routes/reconciliationRoutes.ts`)
   - REST API endpoints for reconciliation operations
   - Authentication and authorization enforcement
   - Input validation and error handling

### Data Flow

```
┌─────────────────┐     ┌──────────────────────────────┐
│  Revenue Report │────▶│ RevenueReconciliationService │
│   Submission   │     └──────────────────────────────┘
└─────────────────┘                    │
                                       ▼
┌─────────────────┐     ┌──────────────────────────────┐
│ Distribution    │◀───▶│   Reconciliation Checks      │
│     Runs        │     │  - Revenue Mismatch           │
└─────────────────┘     │  - Payout Integrity           │
                        │  - Investor Allocations       │
                        └──────────────────────────────┘
```

## Security Assumptions

### Authentication
- All reconciliation endpoints require valid authentication headers (`x-user-id`, `x-user-role`)
- Empty or missing headers result in HTTP 401 Unauthorized

### Authorization
- **Admin role**: Full access to all reconciliation operations
- **Startup role**: Limited to own offerings only
- **Other roles**: Cannot access reconciliation endpoints

### Input Validation
- All inputs are validated before processing
- SQL injection and XSS attacks are mitigated through type checking
- Amount values must be non-negative strings
- Date ranges must have valid format and logical ordering

## API Endpoints

### POST /api/v1/reconciliation/reconcile

Perform comprehensive reconciliation check for an offering.

**Request Body:**
```json
{
  "offeringId": "string (required)",
  "periodStart": "ISO 8601 date (required)",
  "periodEnd": "ISO 8601 date (required)",
  "options": {
    "tolerance": "number (optional, default: 0.01)",
    "checkRoundingAdjustments": "boolean (optional)",
    "checkInvestorAllocations": "boolean (optional)"
  }
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "offeringId": "string",
    "periodStart": "ISO 8601 date",
    "periodEnd": "ISO 8601 date",
    "isBalanced": "boolean",
    "discrepancies": [
      {
        "type": "REVENUE_MISMATCH | PAYOUT_SUM_MISMATCH | ...",
        "severity": "warning | error | critical",
        "message": "string",
        "details": {}
      }
    ],
    "summary": {
      "totalRevenueReported": "string",
      "totalPayouts": "string",
      "discrepancyAmount": "string",
      "investorCount": "number",
      "payoutsProcessed": "number",
      "payoutsFailed": "number"
    },
    "checkedAt": "ISO 8601 date"
  }
}
```

### GET /api/v1/reconciliation/balance-check/:offeringId

Perform quick balance check without detailed analysis.

**Query Parameters:**
- `periodStart`: ISO 8601 date (required)
- `periodEnd`: ISO 8601 date (required)

**Response:**
```json
{
  "success": true,
  "data": {
    "isBalanced": "boolean",
    "difference": "string"
  }
}
```

### POST /api/v1/reconciliation/verify-distribution/:runId

Verify integrity of a specific distribution run. Requires admin role.

**Response:**
```json
{
  "success": true,
  "data": {
    "isValid": "boolean",
    "errors": ["string"]
  }
}
```

### POST /api/v1/reconciliation/validate-report

Validate revenue report before submission.

**Request Body:**
```json
{
  "offeringId": "string (required)",
  "amount": "string (required, non-negative)",
  "periodStart": "ISO 8601 date (required)",
  "periodEnd": "ISO 8601 date (required)"
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "isValid": "boolean",
    "errors": ["string"]
  }
}
```

## Discrepancy Types

| Type | Severity | Description |
|------|----------|-------------|
| `REVENUE_MISMATCH` | error/critical | Reported revenue differs from payout sum |
| `PAYOUT_SUM_MISMATCH` | error | Individual payout sum doesn't match run total |
| `INVESTOR_ALLOCATION_ERROR` | error | Invalid investor allocation detected |
| `ROUNDING_LOSS_UNACCOUNTED` | warning | Rounding loss not properly handled |
| `MISSING_PAYOUT` | error | Expected payout not found |
| `DUPLICATE_PAYOUT` | error | Duplicate payout detected |
| `OVERPAYMENT` | critical | Payout exceeds expected amount |
| `UNDERPAMENT` | error | Payout below expected amount |
| `DISTRIBUTION_STATUS_INVALID` | warning/error | Distribution run in invalid state |

## Tolerance Configuration

The reconciliation service uses a configurable tolerance (default: 0.01) to handle floating-point precision issues:

- Differences within tolerance are considered balanced
- Differences exceeding tolerance trigger `REVENUE_MISMATCH`
- Critical severity applied when difference > 1.00

## Test Coverage

### Unit Tests
- Service method tests
- Input validation tests
- Edge case handling
- Date range processing

### Integration Tests
- Authentication boundary tests
- Authorization enforcement
- API endpoint tests
- Error response validation

### Security Tests
- Authentication bypass attempts
- Authorization escalation
- SQL injection prevention
- XSS prevention

### Edge Cases Covered
- Zero and negative amounts
- Large numeric values
- Single-day periods
- Leap year dates
- Multiple reports/runs per period
- Various distribution statuses

## Error Handling

| HTTP Status | Error Code | Scenario |
|-------------|------------|----------|
| 400 | VALIDATION_ERROR | Invalid input parameters |
| 401 | UNAUTHORIZED | Missing or invalid authentication |
| 403 | FORBIDDEN | Insufficient permissions |
| 404 | NOT_FOUND | Resource not found |
| 500 | INTERNAL_ERROR | Server-side error |

## Configuration

Environment variables:
- `API_VERSION_PREFIX`: API route prefix (default: `/api/v1`)

## Dependencies

- `RevenueReportRepository`: Revenue report data access
- `DistributionRepository`: Distribution run and payout data access
- `InvestmentRepository`: Investor data access
- `OfferingRepository`: Offering metadata for authorization

## Future Enhancements

1. Automated reconciliation scheduling
2. Webhook notifications for discrepancies
3. Historical reconciliation tracking
4. Machine learning anomaly detection
5. Multi-currency support
