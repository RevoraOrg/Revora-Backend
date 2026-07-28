# AML Transaction Monitoring System

## Overview

The AML (Anti-Money Laundering) Transaction Monitoring system provides regulatory compliance capabilities with configurable rules and a case-management workflow for analysts to review flagged events.

## Architecture

### Components

1. **Rule Engine** (`src/aml/ruleEvaluator.ts`)
   - Evaluates transactions against configurable AML rules
   - Supports velocity, structuring, geo-mismatch, and amount threshold detection
   - Context-aware evaluation using historical transaction data

2. **Rule Management** (`src/aml/amlRuleRepository.ts`)
   - Semver versioning for all rule changes
   - Complete version history for audit compliance
   - Rollback capability to previous rule versions

3. **Alert Management** (`src/aml/amlAlertRepository.ts`)
   - Stores alerts generated from rule triggers
   - Links alerts to investigation cases
   - Tracks alert lifecycle (pending → reviewed → dismissed)

4. **Case Management** (`src/aml/amlAlertRepository.ts`)
   - Workflow for analyst investigation
   - Status tracking: open → assigned → investigating → closed/dismissed
   - Disposition tracking: confirmed_suspicious, false_positive, inconclusive, legitimate

5. **Service Layer** (`src/aml/amlService.ts`)
   - Orchestrates all AML operations
   - Integrated audit logging for compliance
   - Transaction evaluation pipeline

6. **REST API** (`src/routes/amlRoutes.ts`)
   - Endpoints for rule management
   - Endpoints for case management
   - Endpoints for alert review

## Rule Types

### Velocity Rules

Detects high transaction frequency or amount within a time window.

**Configuration:**
```typescript
{
  window_minutes: number;  // Time window in minutes
  max_amount: number;      // Maximum total amount allowed
  max_count: number;       // Maximum transaction count allowed
}
```

**Use Case:** Detect rapid-fire transactions that may indicate automated money laundering.

### Structuring Rules

Detects transaction splitting (smurfing) to avoid reporting thresholds.

**Configuration:**
```typescript
{
  window_hours: number;         // Time window in hours
  amount_threshold: number;     // Similarity threshold for amounts
  min_transactions: number;     // Minimum similar transactions to trigger
  reporting_threshold: number;  // Total amount threshold
}
```

**Use Case:** Detect large amounts broken into smaller similar transactions.

### Geo-Mismatch Rules

Detects geographic inconsistencies in transaction patterns.

**Configuration:**
```typescript
{
  high_risk_countries: string[];  // List of high-risk country codes
  max_country_changes: number;    // Maximum allowed country changes
}
```

**Use Case:** Detect transactions from unexpected geographic locations or rapid country changes.

### Amount Threshold Rules

Detects single transactions exceeding a threshold.

**Configuration:**
```typescript
{
  threshold: number;  // Amount threshold
}
```

**Use Case:** Flag large single transactions for review.

## Security Assumptions

### Rule Versioning
- All rule changes are versioned using semver (major.minor.patch)
- Config changes trigger minor version bumps
- Enable/disable changes trigger patch version bumps
- Complete version history is maintained for audit trails

### Audit Logging
- All rule changes are logged with user ID and reason
- All case operations are logged with full context
- All alert creations are logged as security violations
- Audit logs are immutable and tamper-evident

### Access Control
- Rule management requires admin privileges
- Case management requires analyst privileges
- Alert dismissal requires justification
- All operations are authenticated and authorized

### Data Privacy
- Investor PII is protected at rest and in transit
- Alert details contain minimal necessary information
- Case notes are access-controlled
- Historical data retention follows regulatory requirements

## Integration with Investment Pipeline

The AML evaluator is integrated into the post-investment pipeline in `src/services/investmentService.ts`:

```typescript
// After investment creation, run AML evaluation asynchronously
if (this.amlService) {
  const context: TransactionContext = {
    investment_id: investment.id,
    investor_id: investment.investor_id,
    offering_id: investment.offering_id,
    amount: investment.amount,
    asset: investment.asset,
    timestamp: investment.created_at,
  };
  
  // Non-blocking evaluation
  this.amlService.evaluateTransaction(context).catch(error => {
    console.error('AML evaluation failed:', error);
  });
}
```

**Key Design Decisions:**
- AML evaluation is asynchronous and non-blocking
- Investment creation succeeds even if AML evaluation fails
- Errors are logged but don't prevent investment flow
- This ensures system availability while maintaining monitoring

## Database Schema

### Tables

#### `aml_rules`
Stores AML rule definitions with versioning.

#### `aml_rule_version_history`
Stores complete version history for audit compliance.

#### `aml_alerts`
Stores alerts generated from rule triggers.

#### `aml_cases`
Stores investigation cases for analyst workflow.

See `src/db/migrations/001_aml_tables.sql` for complete schema.

## API Endpoints

### Rule Management

- `GET /aml/rules` - Get all rules
- `GET /aml/rules/enabled` - Get enabled rules only
- `GET /aml/rules/:ruleId/history` - Get rule version history
- `POST /aml/rules` - Create new rule
- `PUT /aml/rules/:ruleId` - Update rule (creates new version)
- `POST /aml/rules/:ruleId/rollback` - Rollback to previous version

### Case Management

- `GET /aml/cases?status=X` - Get cases by status
- `GET /aml/cases?analyst_id=X` - Get cases assigned to analyst
- `GET /aml/cases/:caseId` - Get specific case
- `GET /aml/cases/:caseId/alerts` - Get alerts for case
- `POST /aml/cases` - Create new case
- `PUT /aml/cases/:caseId` - Update case (assign, close, etc.)

### Alert Management

- `GET /aml/alerts/pending` - Get pending alerts
- `GET /aml/alerts/investor/:investorId` - Get alerts for investor
- `POST /aml/alerts/:alertId/dismiss` - Dismiss alert as false positive

## Testing

### Test Coverage

Comprehensive test suite with 95%+ coverage:

- `src/aml/ruleEvaluator.test.ts` - Rule evaluation logic
- `src/aml/amlService.test.ts` - Service layer operations

### Running Tests

```bash
npm test
```

### Test Categories

1. **Rule Evaluation Tests**
   - Velocity rule triggers
   - Structuring detection
   - Geo-mismatch detection
   - Amount threshold detection
   - Multi-rule evaluation
   - Edge cases (disabled rules, unknown types)

2. **Service Layer Tests**
   - Transaction evaluation
   - Rule CRUD operations
   - Version history tracking
   - Rollback functionality
   - Case management workflow
   - Alert lifecycle
   - Audit logging verification

## Edge Cases and Failure Paths

### Rule Rollback
- Rollback creates new version (patch increment)
- Original version data is preserved
- Audit log records rollback action
- Can rollback to any historical version

### False Positive Suppression
- Alerts can be dismissed as false positives
- Dismissal is logged with justification
- Dismissed alerts remain in history
- Can be used to tune rule sensitivity

### Multi-Investor Structuring
- Structuring rules evaluate per-investor
- Cross-investor patterns require custom rules
- Previous transactions are fetched per investor
- Time windows apply per investor

### System Failures
- AML evaluation failures don't block investments
- Errors are logged for investigation
- Asynchronous evaluation prevents cascading failures
- System remains available during AML outages

## Deployment

### Database Migration

Run the migration to create AML tables:

```bash
npm run migrate
```

Or execute the SQL directly:

```bash
psql -d revora -f src/db/migrations/001_aml_tables.sql
```

### Configuration

Set up initial AML rules via API:

```bash
# Create velocity rule
curl -X POST /aml/rules \
  -H "Content-Type: application/json" \
  -d '{
    "name": "High Velocity Detection",
    "description": "Detects high transaction frequency",
    "type": "velocity",
    "severity": "high",
    "config": {
      "window_minutes": 60,
      "max_amount": 10000,
      "max_count": 10
    }
  }'
```

### Monitoring

Monitor AML system health:
- Alert volume and trends
- Case resolution times
- Rule trigger rates
- False positive rates

## Compliance Notes

### Regulatory Requirements

- **Rule Versioning**: All rule changes are tracked with semver and audit logs
- **Audit Trail**: Complete audit trail for all AML operations
- **Data Retention**: Alert and case data retained per regulatory requirements
- **Access Controls**: Role-based access for rule and case management
- **Reporting**: Case dispositions support regulatory reporting

### Audit Trail

All AML operations generate audit events:
- Rule creation/update/rollback
- Case creation/assignment/closure
- Alert creation/dismissal
- Transaction evaluation results

Audit events include:
- User ID who performed action
- Timestamp of action
- Action type and resource
- Outcome and details
- Security context (IP, user agent)

## Performance Considerations

### Evaluation Performance

- AML evaluation is asynchronous and non-blocking
- Historical transaction queries are limited (100 records)
- Rules are evaluated in parallel
- Failed transactions are excluded from calculations

### Database Performance

- Indexed columns for common queries
- JSONB for flexible rule configurations
- Partitioning support for large-scale deployments
- Connection pooling for high throughput

### Scalability

- Horizontal scaling via multiple service instances
- Database read replicas for query performance
- Async evaluation prevents bottlenecks
- Configurable evaluation timeouts

## Future Enhancements

Potential improvements:
- Machine learning for pattern detection
- Real-time alert streaming
- Advanced analytics dashboards
- Integration with external watchlists
- Automated case assignment
- Regulatory report generation
## OFAC False-Positive Review Queue

OFAC name-collision hits can be placed into `ofac_reviews` instead of being
silently paused. Reviews are visible through the AML admin queue and move
through `pending_first_approval`, `pending_second_approval`, and `cleared`.

Clearance requires dual control:

- The review creator cannot approve the clearance.
- The second approver must be different from the first approver.
- Each approval requires a written rationale.
- Final clearance records `ofac_review_cleared` in the immutable security audit
  event stream with approver IDs, review ID, alert ID, investor ID, and rationale
  metadata.

Queue endpoints are restricted to admin/compliance actors. Mutating review
endpoints require a CSRF token via `x-csrf-token`; when a `csrfToken` cookie is
present, the header must match it. Pending second-approval reviews whose
`expires_at` has passed are reset to `pending_first_approval` and re-enter the
queue so stale single approvals cannot clear an investor later.
