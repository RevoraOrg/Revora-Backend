# Offering Validation Matrix

## Overview

The Offering Validation Matrix is a production-grade security framework designed to validate Stellar RevenueShare offering operations with comprehensive input sanitization, business rule enforcement, and audit trail generation.

## Architecture

### Core Components

```
┌─────────────────────────────────────────────────────────────┐
│                    Validation Matrix                        │
├─────────────────────────────────────────────────────────────┤
│  ┌─────────────────┐  ┌─────────────────┐  ┌──────────────┐ │
│  │   Security      │  │   Business      │  │  Technical  │ │
│  │   Rules         │  │   Rules         │  │   Rules     │ │
│  └─────────────────┘  └─────────────────┘  └──────────────┘ │
├─────────────────────────────────────────────────────────────┤
│  ┌─────────────────┐  ┌─────────────────┐  ┌──────────────┐ │
│  │   Compliance    │  │   Performance   │  │   Audit     │ │
│  │   Rules         │  │   Rules         │  │   Trail     │ │
│  └─────────────────┘  └─────────────────┘  └──────────────┘ │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                 Validation Service                            │
├─────────────────────────────────────────────────────────────┤
│  • Context Enrichment                                        │
│  • Repository Integration                                   │
│  • Error Handling                                           │
│  • Metadata Generation                                      │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                 Express Middleware                           │
├─────────────────────────────────────────────────────────────┤
│  • Request/Response Handling                                │
│  • HTTP Status Mapping                                      │
│  • Error Formatting                                         │
│  • Logging Integration                                      │
└─────────────────────────────────────────────────────────────┘
```

### Data Flow

1. **Request Reception** - Express middleware receives HTTP request
2. **Context Building** - Validation context is constructed with user data, payload, and operation type
3. **Rule Execution** - Validation matrix executes rules in priority order
4. **Result Aggregation** - Errors and warnings are collected with metadata
5. **Response Generation** - HTTP response is formatted with appropriate status code

## Validation Categories

### 🔒 Security Rules

**Priority**: 1-3 (Critical)  
**Purpose**: Prevent injection attacks and unauthorized access

#### Input Sanitization
- **SQL Injection Detection**: Identifies SQL keywords and patterns
- **XSS Prevention**: Detects script tags and JavaScript URLs
- **NoSQL Injection**: Prevents MongoDB query injection
- **Command Injection**: Blocks shell command execution
- **Path Traversal**: Prevents directory traversal attacks
- **Dangerous Characters**: Filters null bytes and control characters

#### Authorization
- **Role-Based Access**: Ensures only startup users can create offerings
- **User Validation**: Verifies user authentication and status
- **Session Security**: Validates user session integrity

### 💼 Business Rules

**Priority**: 10-15 (High)  
**Purpose**: Enforce business logic and data integrity

#### Field Requirements
- **Name Validation**: Length, format, and character restrictions
- **Revenue Share**: Range validation (0-10000 basis points)
- **Token Asset**: Stellar format compliance
- **Status Transitions**: Valid state machine enforcement

#### Financial Controls
- **Overflow Protection**: Prevents integer overflow/underflow
- **Type Validation**: Ensures proper numeric types
- **Range Enforcement**: Validates percentage limits
- **Precision Checking**: Maintains financial accuracy

### 🔧 Technical Rules

**Priority**: 20-25 (Medium)  
**Purpose**: Ensure system stability and performance

#### Payload Validation
- **Size Limits**: Prevents resource exhaustion
- **Format Checking**: Ensures valid JSON structure
- **Field Length**: Enforces database constraints
- **Duplicate Detection**: Prevents data conflicts

#### Performance Rules
- **Rate Limiting**: Abuse prevention
- **Complexity Limits**: Prevents expensive operations
- **Resource Monitoring**: System health checks

### 📋 Compliance Rules

**Priority**: 30-35 (Low)  
**Purpose**: Regulatory and audit requirements

#### Audit Trail
- **Request Logging**: Complete request capture
- **User Tracking**: Action attribution
- **Timestamp Recording**: Chronological ordering
- **Rule Execution**: Validation transparency

## Rule Execution

### Priority System

Rules are executed in priority order (lower numbers = higher priority):

```
1. Input Sanitization (Security)
2. Role Authorization (Security)
3. Rate Limit Check (Security)
4. Payload Size Validation (Technical)
5. Offering Name Validation (Business)
6. Revenue Share Validation (Business)
7. Token Asset Validation (Business)
8. Status Transition Validation (Business)
9. Duplicate Offering Check (Technical)
```

### Fail-Fast Behavior

- **Critical Security Errors**: Immediate termination on critical security violations
- **Business Rule Errors**: Continue execution but aggregate all errors
- **Technical Errors**: Log and continue with warnings
- **Warning Collection**: Non-blocking issues collected for reporting

## Adding New Rules

### 1. Define Rule Interface

```typescript
const customRule: ValidationRule = {
  name: 'custom_business_rule',
  description: 'Validates custom business logic',
  category: 'business',
  priority: 15,
  isRequired: true,
  validate: async (context: OfferingValidationContext): Promise<ValidationRuleResult> => {
    const errors: ValidationError[] = [];
    const warnings: ValidationWarning[] = [];

    // Custom validation logic here
    if (/* condition */) {
      errors.push({
        code: 'CUSTOM_RULE_VIOLATION',
        message: 'Custom business rule violated',
        field: 'custom_field',
        severity: 'error',
        category: 'business',
        remediation: 'Fix the custom field value'
      });
    }

    return { isValid: errors.length === 0, errors, warnings };
  }
};
```

### 2. Register Rule

```typescript
const validationMatrix = new OfferingValidationMatrix();
validationMatrix.addRule(customRule);
```

### 3. Update Rule Sets (Optional)

```typescript
// Add to specific operation rule sets
validationMatrix.addRuleToSet('create', 'custom_business_rule');
validationMatrix.addRuleToSet('update', 'custom_business_rule');
```

## Security Assumptions

### Threat Model

1. **Injection Attacks**
   - **Assumption**: All user input is malicious
   - **Mitigation**: Comprehensive input sanitization and pattern detection
   - **Coverage**: SQL, NoSQL, XSS, Command injection

2. **Privilege Escalation**
   - **Assumption**: Users may attempt role manipulation
   - **Mitigation**: Server-side role validation and authorization checks
   - **Coverage**: Role-based access control

3. **Resource Exhaustion**
   - **Assumption**: Attackers may send large payloads
   - **Mitigation**: Payload size limits and rate limiting
   - **Coverage**: DoS prevention

4. **Data Integrity**
   - **Assumption**: Financial data may be manipulated
   - **Mitigation**: Type validation and range enforcement
   - **Coverage**: Overflow protection

### Security Boundaries

- **Input Boundary**: All external data enters through validation matrix
- **User Boundary**: Role-based access controls enforcement
- **Data Boundary**: Type safety and format validation
- **System Boundary**: Resource limits and monitoring

### Failure Modes

1. **Graceful Degradation**: Validation errors don't crash the system
2. **Fail-Secure**: Default to deny on validation failures
3. **Audit Trail**: All validation attempts are logged
4. **Error Isolation**: Rule failures don't affect other rules

## API Integration

### Middleware Usage

```typescript
import { validateOfferingCreation } from './middleware/offeringValidation';

// Apply to routes
router.post('/offerings', 
  requireAuth,
  validateOfferingCreation(offeringRepository, investmentRepository),
  offeringController.create
);
```

### Response Format

#### Success Response (200/201)
```json
{
  "message": "Offering created successfully",
  "data": { /* offering data */ },
  "validation": {
    "timestamp": "2024-03-24T08:00:00.000Z",
    "executionTimeMs": 15,
    "rulesApplied": ["input_sanitization", "role_authorization", "..."]
  }
}
```

#### Validation Error (400/422)
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
  "warnings": [
    {
      "code": "LONG_DESCRIPTION",
      "message": "Description is very long, consider shortening",
      "field": "description",
      "category": "performance"
    }
  ],
  "metadata": {
    "timestamp": "2024-03-24T08:00:00.000Z",
    "executionTimeMs": 12,
    "rulesApplied": ["input_sanitization", "role_authorization", "..."]
  }
}
```

## Testing Strategy

### Coverage Requirements

- **Minimum Coverage**: 95%
- **Critical Path Coverage**: 100%
- **Security Rule Coverage**: 100%
- **Error Path Coverage**: 90%

### Test Categories

1. **Success Cases**: Valid inputs pass validation
2. **Security Cases**: Attack vectors are blocked
3. **Boundary Cases**: Edge values are handled
4. **Error Cases**: Invalid inputs fail appropriately
5. **Performance Cases**: Load and concurrency testing

### Test Data

- **Malicious Inputs**: SQL injection, XSS, command injection
- **Boundary Values**: Minimum/maximum valid values
- **Invalid Types**: Wrong data types, null values
- **Large Payloads**: Size limit testing
- **Concurrent Requests**: Race condition testing

## Performance Considerations

### Optimization Strategies

1. **Rule Ordering**: Critical security rules first
2. **Early Termination**: Fail-fast on critical errors
3. **Caching**: Repeated validation caching
4. **Async Processing**: Non-blocking validation
5. **Memory Management**: Efficient data structures

### Monitoring Metrics

- **Validation Execution Time**: Per-rule timing
- **Error Rates**: Validation failure frequency
- **Throughput**: Requests per second
- **Memory Usage**: Peak consumption
- **Rule Performance**: Individual rule timing

## Troubleshooting

### Common Issues

1. **Validation Failures**
   - Check error codes and messages
   - Review field requirements
   - Verify user permissions

2. **Performance Issues**
   - Monitor rule execution times
   - Check for expensive operations
   - Review payload sizes

3. **Security Alerts**
   - Review attack patterns
   - Check rate limiting
   - Monitor user behavior

### Debug Information

Enable debug mode for detailed validation logging:

```typescript
const validationMatrix = new OfferingValidationMatrix();
validationMatrix.setDebugMode(true);
```

## Maintenance

### Rule Updates

1. **Regular Review**: Quarterly rule assessment
2. **Threat Intelligence**: Update attack patterns
3. **Business Logic**: Align with requirement changes
4. **Performance**: Optimize slow rules

### Compliance

1. **Audit Logs**: Retain validation logs for 1 year
2. **Security Review**: Annual security assessment
3. **Penetration Testing**: Bi-annual security testing
4. **Documentation**: Keep rules documented

## Version History

### v1.0.0 (Current)
- Initial production release
- Comprehensive security validation
- Business rule enforcement
- Audit trail generation
- 95%+ test coverage

### Future Enhancements

- **Machine Learning**: Anomaly detection
- **Dynamic Rules**: Runtime rule updates
- **Distributed Validation**: Microservice architecture
- **Advanced Analytics**: Validation pattern analysis

---

**Author**: Stellar Wave Program  
**Version**: 1.0.0  
**Last Updated**: March 24, 2026  
**Security Classification**: Internal Use Only

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
