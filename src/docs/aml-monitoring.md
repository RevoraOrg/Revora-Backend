# AML Transaction Monitoring

## Overview

The AML (Anti-Money Laundering) transaction monitoring system provides regulatory compliance capabilities with configurable rules and a case-management workflow for analysts to review flagged events.

## Features

### Rule Engine
- **Velocity Rules**: Detect high transaction frequency or amount within time windows
- **Structuring Rules**: Identify transaction structuring (smurfing) patterns
- **Geo-Mismatch Rules**: Flag geographic inconsistencies in transactions
- **Amount Threshold Rules**: Alert on single transactions exceeding thresholds

### Rule Versioning
- All rules use semantic versioning (semver) for tracking changes
- Version history is audit-logged with change reasons and user attribution
- Rollback capability to previous rule versions
- Automatic version bumping:
  - Config changes: minor version increment
  - Enable/disable or metadata changes: patch version increment

### Case Management Workflow
- **Open**: Case created from alerts
- **Assigned**: Case assigned to an analyst
- **Investigating**: Under active investigation
- **Closed**: Case resolved with disposition
- **Dismissed**: Case dismissed as false positive

### Disposition Outcomes
- `confirmed_suspicious`: Suspicious activity confirmed
- `false_positive`: Alert determined to be false positive
- `inconclusive`: Investigation inconclusive
- `legitimate`: Activity deemed legitimate

## Architecture

### Components

#### 1. Rule Evaluator (`src/aml/ruleEvaluator.ts`)
Evaluates transactions against enabled AML rules.

```typescript
class RuleEvaluator {
  async evaluate(context: TransactionContext, rules: AMLRule[]): Promise<RuleEvaluationResult[]>
}
```

#### 2. AML Service (`src/aml/amlService.ts`)
Orchestrates rule evaluation, alert creation, and case management with audit logging.

```typescript
class AMLService {
  async evaluateTransaction(context: TransactionContext): Promise<AMLAlert[]>
  async createRule(input: CreateRuleInput): Promise<AMLRule>
  async updateRule(ruleId: string, input: UpdateRuleInput): Promise<AMLRule>
  async rollbackRule(ruleId: string, version: SemVer): Promise<AMLRule>
  async createCase(input: CreateCaseInput): Promise<AMLCase>
  async updateCase(caseId: string, input: UpdateCaseInput): Promise<AMLCase>
}
```

#### 3. Repositories
- **AMLRuleRepository**: Manages rule definitions with versioning
- **AMLAlertRepository**: Manages alerts and case workflow

#### 4. API Routes (`src/routes/amlRoutes.ts`)
REST endpoints for rule management and case workflow.

## Database Schema

### Tables

#### `aml_rules`
Stores rule definitions with versioning.

```sql
CREATE TABLE aml_rules (
  id VARCHAR(255) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  description TEXT NOT NULL,
  type VARCHAR(50) NOT NULL,
  version JSONB NOT NULL,
  severity VARCHAR(20) NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  config JSONB NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
```

#### `aml_rule_version_history`
Audit trail for rule changes.

```sql
CREATE TABLE aml_rule_version_history (
  id VARCHAR(255) PRIMARY KEY,
  rule_id VARCHAR(255) NOT NULL REFERENCES aml_rules(id),
  version JSONB NOT NULL,
  config JSONB NOT NULL,
  enabled BOOLEAN NOT NULL,
  changed_by VARCHAR(255) NOT NULL,
  change_reason TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
```

#### `aml_alerts`
Stores alerts generated from rule evaluations.

```sql
CREATE TABLE aml_alerts (
  id VARCHAR(255) PRIMARY KEY,
  investment_id VARCHAR(255) NOT NULL,
  investor_id VARCHAR(255) NOT NULL,
  rule_id VARCHAR(255) NOT NULL REFERENCES aml_rules(id),
  rule_version JSONB NOT NULL,
  severity VARCHAR(20) NOT NULL,
  details JSONB NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  case_id VARCHAR(255),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
```

#### `aml_cases`
Stores cases for analyst workflow.

```sql
CREATE TABLE aml_cases (
  id VARCHAR(255) PRIMARY KEY,
  alert_ids JSONB NOT NULL,
  investor_id VARCHAR(255) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'open',
  assigned_to VARCHAR(255),
  disposition VARCHAR(30),
  notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  closed_at TIMESTAMP WITH TIME ZONE
);
```

## API Endpoints

### Rule Management

#### GET `/aml/rules`
Get all AML rules.

#### GET `/aml/rules/enabled`
Get only enabled rules.

#### GET `/aml/rules/:ruleId/history`
Get version history for a rule.

#### POST `/aml/rules`
Create a new rule.

```json
{
  "name": "High Velocity Rule",
  "description": "Detects high transaction frequency",
  "type": "velocity",
  "severity": "high",
  "config": {
    "window_minutes": 60,
    "max_amount": 10000,
    "max_count": 5
  }
}
```

#### PUT `/aml/rules/:ruleId`
Update an existing rule.

```json
{
  "name": "Updated Rule",
  "enabled": false,
  "change_reason": "Disable for testing"
}
```

#### POST `/aml/rules/:ruleId/rollback`
Rollback to a specific version.

```json
{
  "version": {
    "major": 1,
    "minor": 0,
    "patch": 0
  }
}
```

### Case Management

#### GET `/aml/cases?status=open`
Get cases by status.

#### GET `/aml/cases?analyst_id=user123`
Get cases assigned to an analyst.

#### GET `/aml/cases/:caseId`
Get a specific case.

#### GET `/aml/cases/:caseId/alerts`
Get alerts for a case.

#### POST `/aml/cases`
Create a new case.

```json
{
  "alert_ids": ["alert_1", "alert_2"],
  "investor_id": "inv_1",
  "assigned_to": "analyst_1",
  "notes": "Initial investigation"
}
```

#### PUT `/aml/cases/:caseId`
Update a case.

```json
{
  "status": "closed",
  "disposition": "false_positive",
  "notes": "Investigation complete"
}
```

### Alert Management

#### GET `/aml/alerts/pending`
Get pending alerts not assigned to cases.

#### GET `/aml/alerts/investor/:investorId`
Get alerts for a specific investor.

#### POST `/aml/alerts/:alertId/dismiss`
Dismiss an alert as false positive.

## Integration with Investment Pipeline

The AML service is integrated into the investment creation pipeline in `src/services/investmentService.ts`:

```typescript
// Run AML transaction monitoring if service is available
if (this.amlService) {
  try {
    const context: TransactionContext = {
      investment_id: investment.id,
      investor_id: investment.investor_id,
      offering_id: investment.offering_id,
      amount: investment.amount,
      asset: investment.asset,
      timestamp: investment.created_at,
    };
    
    // Run AML evaluation asynchronously (non-blocking)
    this.amlService.evaluateTransaction(context).catch(error => {
      console.error('AML evaluation failed:', error);
    });
  } catch (error) {
    console.error('AML evaluation setup failed:', error);
  }
}
```

## Security Assumptions

1. **Caller Identity**: User identity is asserted by trusted upstream auth middleware before AML operations.
2. **Audit Logging**: All rule changes and case updates are audit-logged for compliance.
3. **Non-Blocking**: AML evaluation runs asynchronously to avoid blocking investment creation.
4. **Error Handling**: AML evaluation failures do not fail investment creation but are logged.
5. **Version Control**: Rule changes are versioned and audit-tracked for regulatory compliance.

## Testing

### Test Coverage
- **AML Module**: 92.55% line coverage
- **Rule Repository**: 97.77% line coverage
- **Alert Repository**: 92.2% line coverage
- **Service Layer**: 88.88% line coverage
- **Rule Evaluator**: 88.52% line coverage
- **API Routes**: 79.36% line coverage

### Running Tests
```bash
npm test -- --testPathPatterns="aml"
```

### Test Files
- `src/aml/amlRuleRepository.test.ts` - Repository tests
- `src/aml/amlAlertRepository.test.ts` - Alert repository tests
- `src/aml/amlService.test.ts` - Service layer tests
- `src/aml/ruleEvaluator.test.ts` - Rule evaluation tests
- `src/routes/amlRoutes.test.ts` - API endpoint tests

## Configuration Examples

### Velocity Rule
```json
{
  "type": "velocity",
  "config": {
    "window_minutes": 60,
    "max_amount": 10000,
    "max_count": 5
  }
}
```

### Structuring Rule
```json
{
  "type": "structuring",
  "config": {
    "window_hours": 24,
    "amount_threshold": 1000,
    "min_transactions": 3,
    "reporting_threshold": 10000
  }
}
```

### Geo-Mismatch Rule
```json
{
  "type": "geo_mismatch",
  "config": {
    "high_risk_countries": ["XX", "YY", "ZZ"],
    "max_country_changes": 3
  }
}
```

### Amount Threshold Rule
```json
{
  "type": "amount_threshold",
  "config": {
    "threshold": 50000
  }
}
```

## Audit Compliance

All AML operations are audit-logged through the security audit repository:

- Rule creation, updates, and rollbacks
- Case creation and updates
- Alert dismissals
- User attribution for all changes

Audit events include:
- User ID who performed the action
- Action type and resource affected
- Change reason (for rule updates)
- Timestamp
- Request context

## Error Handling

- AML evaluation failures are logged but don't block investment creation
- Invalid rule configurations are rejected during creation/update
- Rollback to non-existent versions throws errors
- Case updates for non-existent cases throw errors
- All errors are logged for debugging and audit purposes
