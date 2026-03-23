# Offering Validation Matrix Documentation

## Overview

The Offering Validation Matrix is a production-grade validation framework for the Stellar RevenueShare (Revora) backend that provides comprehensive security, business rule, and technical validation for all offering operations.

## Architecture

### Core Components

1. **Validation Matrix Engine** (`src/lib/validationMatrix.ts`)
   - Central validation orchestration
   - Rule-based validation system
   - Deterministic execution with priority ordering
   - Comprehensive error reporting and audit trails

2. **Validation Service** (`src/services/offeringValidationService.ts`)
   - Service layer for validation operations
   - Integration with existing repositories
   - Business logic enforcement

3. **Validation Middleware** (`src/middleware/offeringValidation.ts`)
   - Express middleware integration
   - Request/response handling
   - Error formatting and status code determination

## Security Model

### Threat Model

The validation matrix addresses the following threat vectors:

- **Injection Attacks**: SQL injection, XSS, command injection
- **Privilege Escalation**: Role-based access control violations
- **Resource Exhaustion**: Large payloads, rate limiting abuse
- **Data Integrity**: Invalid data formats, boundary violations
- **Race Conditions**: Concurrent operation conflicts

### Security Assumptions

- All input is untrusted and must be validated
- Authentication is handled separately but roles are enforced
- Rate limiting and request size limits are applied upstream
- Database transactions ensure atomicity
- Audit trails are maintained for compliance

### Security Controls

#### Input Sanitization
```typescript
// SQL injection detection
const sqlPatterns = [/(\b(SELECT|INSERT|UPDATE|DELETE|DROP|CREATE|ALTER)\b)/i, /(\b(UNION|OR|AND)\b.*\b(=|LIKE)\b)/i];

// XSS detection  
const xssPatterns = [/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, /javascript:/i];
```

#### Role Authorization
```typescript
// Only startup users can create offerings
if (operation === 'create' && user.role !== 'startup') {
  return {
    isValid: false,
    errors: [{
      code: 'INSUFFICIENT_PRIVILEGES',
      severity: 'critical',
      category: 'security'
    }]
  };
}
```

#### Rate Limiting
```typescript
// Check for excessive creation attempts
if (operation === 'create' && existingOfferings.length > 10) {
  warnings.push({
    code: 'MANY_OFFERINGS',
    category: 'business'
  });
}
```

## Validation Rules

### Rule Categories

1. **Security Rules** (Priority: 1-10)
   - `input_sanitization`: Prevent injection attacks
   - `role_authorization`: Enforce role-based access
   - `rate_limit_check`: Prevent abuse

2. **Business Rules** (Priority: 10-20)
   - `offering_name_validation`: Name requirements and format
   - `revenue_share_validation`: Percentage constraints
   - `token_asset_validation`: Asset format compliance
   - `status_transition_validation`: State machine enforcement

3. **Technical Rules** (Priority: 20-30)
   - `payload_size_validation`: Request size limits
   - `duplicate_offering_check`: Uniqueness enforcement

### Rule Execution

Rules are executed in priority order with fail-fast behavior for critical security errors:

```typescript
for (const ruleName of ruleSet) {
  const result = await rule.validate(context);
  
  // Fail fast on critical security errors
  if (result.errors.some(e => e.severity === 'critical' && e.category === 'security')) {
    break;
  }
}
```

## API Integration

### Middleware Usage

```typescript
import { validateOfferingCreation } from './middleware/offeringValidation';

// Apply validation to offering creation endpoint
apiRouter.post('/offerings', 
  requireAuth,
  validateOfferingCreation(offeringRepository, investmentRepository),
  (req, res) => {
    // Validation passed, proceed with creation
    res.status(201).json({
      message: 'Offering created successfully',
      data: req.body,
      validation: req.validationResult?.metadata
    });
  }
);
```

### Response Format

#### Successful Validation
```json
{
  "message": "Offering created successfully",
  "data": { /* offering data */ },
  "validation": {
    "timestamp": "2026-03-23T22:00:00.000Z",
    "executionTimeMs": 45,
    "rulesApplied": ["input_sanitization", "role_authorization", ...]
  }
}
```

#### Validation Failure
```json
{
  "error": "Validation failed",
  "code": "VALIDATION_ERROR",
  "details": [
    {
      "code": "NAME_REQUIRED",
      "message": "Offering name is required",
      "field": "name",
      "severity": "error",
      "category": "business",
      "remediation": "Provide a valid offering name"
    }
  ],
  "warnings": [],
  "metadata": {
    "timestamp": "2026-03-23T22:00:00.000Z",
    "executionTimeMs": 23,
    "rulesApplied": ["input_sanitization", "role_authorization"]
  }
}
```

## Error Handling

### HTTP Status Codes

- **400 Bad Request**: Technical validation errors
- **401 Unauthorized**: Authentication failures
- **403 Forbidden**: Authorization/security violations
- **422 Unprocessable Entity**: Business rule violations
- **500 Internal Server Error**: Validation service errors

### Error Categories

- **Security**: Critical security violations
- **Business**: Business rule violations
- **Technical**: Technical/validation errors
- **Compliance**: Regulatory/compliance issues

### Error Codes

| Code | Category | Description |
|------|----------|-------------|
| `SQL_INJECTION_DETECTED` | Security | SQL injection pattern found |
| `XSS_PATTERN_DETECTED` | Security | XSS pattern found |
| `INSUFFICIENT_PRIVILEGES` | Security | User lacks required role |
| `NAME_REQUIRED` | Business | Offering name is required |
| `REVENUE_SHARE_OUT_OF_RANGE` | Business | Revenue share percentage invalid |
| `INVALID_TOKEN_FORMAT` | Business | Token asset format invalid |
| `PAYLOAD_TOO_LARGE` | Technical | Request size exceeds limit |
| `DUPLICATE_OFFERING_NAME` | Business | Offering name already exists |

## Performance Considerations

### Execution Time

- Target: < 100ms per validation
- Rules execute in parallel where possible
- Fail-fast on critical errors
- Caching for expensive operations

### Memory Usage

- Stateless validation engine
- Minimal object allocation
- Garbage collection friendly

### Concurrency

- Thread-safe validation execution
- No shared mutable state
- Handles concurrent requests

## Testing Strategy

### Test Coverage

- **Unit Tests**: Individual rule validation
- **Integration Tests**: Middleware and service integration
- **Security Tests**: Attack vector validation
- **Performance Tests**: Load and timing validation
- **Edge Case Tests**: Boundary conditions

### Test Categories

1. **Security Validation Tests**
   ```typescript
   it('should detect SQL injection attempts', async () => {
     const maliciousContext = {
       offeringData: { name: "Test'; DROP TABLE offerings; --" }
     };
     
     const result = await validationMatrix.validateOffering(maliciousContext);
     
     expect(result.isValid).toBe(false);
     expect(result.errors.some(e => e.code === 'SQL_INJECTION_DETECTED')).toBe(true);
   });
   ```

2. **Business Rule Tests**
   ```typescript
   it('should reject invalid revenue share', async () => {
     const context = {
       offeringData: { revenue_share_bps: 15000 } // > 100%
     };
     
     const result = await validationMatrix.validateOffering(context);
     
     expect(result.isValid).toBe(false);
     expect(result.errors.some(e => e.code === 'REVENUE_SHARE_OUT_OF_RANGE')).toBe(true);
   });
   ```

3. **Performance Tests**
   ```typescript
   it('should complete validation within performance thresholds', async () => {
     const startTime = Date.now();
     const result = await validationMatrix.validateOffering(context);
     const endTime = Date.now();
     
     expect(endTime - startTime).toBeLessThan(1000);
     expect(result.metadata.executionTimeMs).toBeLessThan(1000);
   });
   ```

## Monitoring and Observability

### Metrics

- Validation execution time
- Error rates by category
- Rule execution frequency
- Concurrent validation count

### Logging

```typescript
console.log(`[domain-event] vault.milestone.validated`, payload);
console.warn(`Validation warnings for request ${requestId}:`, warnings);
console.error(`Validation rule '${rule.name}' failed:`, error);
```

### Health Checks

```typescript
// Validation matrix health endpoint
app.get('/health/validation-matrix', async (req, res) => {
  const health = await checkValidationMatrixHealth();
  res.status(health.healthy ? 200 : 503).json(health);
});
```

## Configuration

### Environment Variables

```bash
# Validation settings
VALIDATION_MAX_PAYLOAD_SIZE=1048576    # 1MB
VALIDATION_TIMEOUT_MS=1000            # 1 second
VALIDATION_MAX_OFFERINGS_PER_USER=50
VALIDATION_ENABLE_DEBUG_LOGGING=false
```

### Rule Configuration

Rules can be configured via environment or configuration files:

```typescript
// Custom rule example
validationMatrix.addRule({
  name: 'custom_business_rule',
  description: 'Custom validation for specific business logic',
  category: 'business',
  priority: 15,
  isRequired: true,
  validate: async (context) => {
    // Custom validation logic
    return { isValid: true, errors: [], warnings: [] };
  }
});
```

## Deployment Considerations

### Production Deployment

1. **Resource Allocation**
   - Memory: 512MB minimum per instance
   - CPU: 0.5 cores minimum
   - Network: Low bandwidth requirements

2. **Scaling**
   - Horizontal scaling supported
   - No shared state between instances
   - Load balancer friendly

3. **Monitoring**
   - Alert on error rates > 5%
   - Alert on response times > 500ms
   - Monitor validation matrix health

### Security Hardening

1. **Input Validation**
   - All inputs sanitized before processing
   - Pattern-based detection of malicious content
   - Size limits enforced

2. **Error Handling**
   - No sensitive information in error responses
   - Generic error messages for security
   - Audit logging for security events

3. **Rate Limiting**
   - Per-user rate limiting
   - IP-based limiting for abuse prevention
   - Exponential backoff for repeated failures

## Maintenance and Operations

### Rule Updates

Rules can be updated without code deployment:

```typescript
// Runtime rule update
validationMatrix.addRule(newRule);
validationMatrix.removeRule('old_rule_name');
```

### Monitoring

- Daily validation error reports
- Weekly performance metrics
- Monthly security audit logs

### Troubleshooting

Common issues and solutions:

1. **High Validation Latency**
   - Check rule execution times
   - Optimize expensive database queries
   - Consider rule caching

2. **False Positives**
   - Review rule patterns
   - Adjust validation thresholds
   - Update business logic

3. **Security Alerts**
   - Review attack patterns
   - Update detection rules
   - Enhance monitoring

## Compliance and Auditing

### Audit Trail

All validation executions are logged with:

- Timestamp and execution time
- User context and IP address
- Rules applied and results
- Errors and warnings generated

### Data Privacy

- No personal data stored in validation logs
- PII redacted from error messages
- GDPR compliant data handling

### Regulatory Compliance

- SOX compliance for financial validations
- PCI DSS compliance for payment data
- GDPR compliance for EU user data

## Future Enhancements

### Planned Features

1. **Machine Learning Integration**
   - Anomaly detection for unusual patterns
   - Adaptive rule tuning
   - Predictive validation

2. **Advanced Analytics**
   - Validation trend analysis
   - Performance optimization
   - Risk scoring

3. **Multi-tenant Support**
   - Per-tenant rule sets
   - Isolated validation contexts
   - Custom validation policies

### Extension Points

The validation matrix is designed for extensibility:

```typescript
// Custom validation rule interface
interface ValidationRule {
  name: string;
  description: string;
  category: 'security' | 'business' | 'technical' | 'compliance';
  priority: number;
  validate: (context: ValidationContext) => Promise<ValidationRuleResult>;
  isRequired: boolean;
}
```

## Conclusion

The Offering Validation Matrix provides a robust, secure, and scalable validation framework for the Revora backend. With comprehensive security controls, detailed error reporting, and extensive testing coverage, it ensures the integrity and reliability of all offering operations while maintaining high performance and observability.

For questions or support, contact the development team or refer to the API documentation and test suites for detailed usage examples.
