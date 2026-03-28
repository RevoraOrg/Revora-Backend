# Health/Readiness Probe Expansion

## Overview

This document describes the production-grade Health/Readiness Probe Expansion capability implemented for the Revora Backend service. The system provides comprehensive health monitoring endpoints designed for container orchestration platforms like Kubernetes, load balancers, and monitoring systems.

## Architecture

### Health Check Types

The system implements three distinct types of health checks, each serving different operational purposes:

1. **Health Check (`/health`)** - Comprehensive system health assessment
2. **Readiness Probe (`/ready`)** - Kubernetes-compatible readiness verification
3. **Liveness Probe (`/live`)** - Minimal process responsiveness check

### Component Health Monitoring

The health system monitors the following critical components:

- **Database Connectivity** - PostgreSQL connection pool health with latency metrics
- **Stellar Network** - Horizon API connectivity and response time
- **Memory Usage** - Node.js process memory consumption monitoring
- **System Metrics** - Process uptime and basic system information

## API Endpoints

### Health Check Endpoint

**Endpoint:** `GET /health`

**Purpose:** Comprehensive health assessment for monitoring systems

**Response Format:**
```json
{
  "status": "healthy|degraded|unhealthy",
  "service": "revora-backend",
  "version": "0.1.0",
  "timestamp": "2024-03-24T10:30:00.000Z",
  "uptime": 3600,
  "checks": {
    "database": {
      "status": "up|down|degraded",
      "latencyMs": 45,
      "details": {
        "connectionCount": 5,
        "idleCount": 3,
        "waitingCount": 0
      }
    },
    "stellar": {
      "status": "up|down|degraded",
      "latencyMs": 120,
      "details": {
        "url": "https://horizon.stellar.org",
        "statusCode": 200
      }
    },
    "memory": {
      "status": "up|degraded",
      "details": {
        "heapUsedMb": 128,
        "heapTotalMb": 256,
        "thresholdMb": 512,
        "rss": 180,
        "external": 15
      }
    }
  },
  "requestId": "req-123-456-789"
}
```

**Status Codes:**
- `200` - System is healthy or degraded but operational
- `503` - System is unhealthy and not operational

**Status Determination:**
- `healthy` - All components are operational with good performance
- `degraded` - All components are operational but some show performance issues
- `unhealthy` - One or more critical components are down

### Readiness Probe Endpoint

**Endpoint:** `GET /ready`

**Purpose:** Kubernetes readiness probe for traffic routing decisions

**Response Format:**
```json
{
  "ready": true,
  "service": "revora-backend",
  "timestamp": "2024-03-24T10:30:00.000Z",
  "checks": ["database", "stellar"]
}
```

**Status Codes:**
- `200` - Service is ready to receive traffic
- `503` - Service is not ready for traffic

**Readiness Criteria:**
- Database connection is operational (not down)
- Stellar Horizon connectivity is operational (not down)
- Degraded performance is acceptable for readiness

### Liveness Probe Endpoint

**Endpoint:** `GET /live`

**Purpose:** Kubernetes liveness probe for container restart decisions

**Response Format:**
```json
{
  "alive": true,
  "service": "revora-backend",
  "timestamp": "2024-03-24T10:30:00.000Z",
  "uptime": 3600
}
```

**Status Codes:**
- `200` - Process is alive and responsive

**Liveness Criteria:**
- Process can respond to HTTP requests
- No external dependencies checked to avoid false positives

## Configuration

### Environment Variables

The health system respects the following environment variables:

- `STELLAR_HORIZON_URL` - Custom Stellar Horizon endpoint (default: https://horizon.stellar.org)
- `npm_package_version` - Service version for health responses

### Health Check Configuration

Default configuration values can be overridden when creating the health router:

```typescript
const healthRouter = createHealthRouter(pool, {
  dbTimeoutMs: 5000,        // Database health check timeout
  stellarTimeoutMs: 3000,   // Stellar health check timeout
  memoryThresholdMb: 512,   // Memory usage threshold for degraded status
  diskThresholdPercent: 90  // Disk usage threshold (future use)
});
```

## Security Considerations

### Information Disclosure

The health endpoints are designed to provide operational visibility without exposing sensitive information:

- **No Authentication Required** - Health endpoints are intentionally unauthenticated for infrastructure tooling
- **No Sensitive Data** - Responses exclude passwords, secrets, tokens, or API keys
- **Minimal Error Details** - Error messages provide operational context without internal implementation details
- **Request ID Tracking** - Includes request IDs when available for correlation without exposing user data

### Rate Limiting Considerations

While not implemented in the current version, production deployments should consider:

- Rate limiting health endpoints to prevent abuse
- Separate rate limits for different health check types
- Monitoring for unusual health check patterns

### Network Security

- Health endpoints bypass API versioning for infrastructure compatibility
- Endpoints should be accessible from load balancer and orchestration networks
- Consider firewall rules to restrict health endpoint access to authorized systems

## Performance Characteristics

### Timeout Configuration

- **Database Health Check:** 5 second default timeout with configurable override
- **Stellar Health Check:** 3 second default timeout with configurable override
- **Readiness Probe:** Reduced timeouts (3s DB, 2s Stellar) for faster decisions
- **Liveness Probe:** Immediate response with no external dependencies

### Performance Thresholds

- **Database Latency:** >1000ms triggers degraded status
- **Stellar Latency:** >2000ms triggers degraded status
- **Memory Usage:** Configurable threshold (default 512MB) for degraded status

### Concurrent Request Handling

- Health checks are designed to handle concurrent requests safely
- Database connection pooling prevents resource exhaustion
- Stellar checks use AbortController for proper timeout handling

## Monitoring and Alerting

### Recommended Monitoring

1. **Health Endpoint Availability** - Monitor `/health` endpoint response time and availability
2. **Component Status Tracking** - Alert on component status changes (up → degraded → down)
3. **Performance Degradation** - Monitor latency trends for early warning
4. **Memory Usage Trends** - Track memory consumption patterns

### Alert Thresholds

- **Critical:** Any component status = "down"
- **Warning:** Any component status = "degraded"
- **Info:** Health check response time > 5 seconds

### Log Analysis

Health check errors are logged with structured information:
- Request ID for correlation
- Component-specific error details
- Timestamp and service identification
- Performance metrics for trend analysis

## Kubernetes Integration

### Deployment Configuration

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: revora-backend
spec:
  template:
    spec:
      containers:
      - name: revora-backend
        image: revora-backend:latest
        ports:
        - containerPort: 4000
        livenessProbe:
          httpGet:
            path: /live
            port: 4000
          initialDelaySeconds: 30
          periodSeconds: 10
          timeoutSeconds: 5
          failureThreshold: 3
        readinessProbe:
          httpGet:
            path: /ready
            port: 4000
          initialDelaySeconds: 5
          periodSeconds: 5
          timeoutSeconds: 3
          failureThreshold: 2
```

### Load Balancer Configuration

```yaml
apiVersion: v1
kind: Service
metadata:
  name: revora-backend-service
spec:
  selector:
    app: revora-backend
  ports:
  - port: 80
    targetPort: 4000
  type: LoadBalancer
```

Health checks can be configured at the load balancer level using the `/health` endpoint for more comprehensive monitoring.

## Testing Strategy

### Unit Test Coverage

The health system includes comprehensive unit tests covering:

- Individual component health check functions
- Handler function behavior under various conditions
- Error handling and timeout scenarios
- Configuration parameter validation
- Mock external dependencies (database, Stellar network)

### Integration Test Coverage

Integration tests verify:

- End-to-end health endpoint functionality
- API version prefix consistency
- Security considerations (no sensitive data exposure)
- Performance characteristics
- Concurrent request handling
- Error recovery scenarios

### Test Execution

```bash
# Run all health-related tests
npm test -- --testPathPattern=health

# Run with coverage reporting
npm test -- --coverage --testPathPattern=health
```

### Minimum Coverage Requirements

- **95% line coverage** for all health-related code
- **100% branch coverage** for critical error handling paths
- **Edge case coverage** for timeout and failure scenarios

## Failure Scenarios and Recovery

### Database Connection Failures

**Scenario:** PostgreSQL database becomes unavailable

**Health System Response:**
- Database component status: "down"
- Overall system status: "unhealthy"
- Readiness probe: Not ready (503)
- Liveness probe: Still alive (200)

**Recovery:** Automatic recovery when database connectivity is restored

### Stellar Network Issues

**Scenario:** Stellar Horizon API becomes unavailable

**Health System Response:**
- Stellar component status: "down"
- Overall system status: "unhealthy"
- Readiness probe: Not ready (503)
- Liveness probe: Still alive (200)

**Recovery:** Automatic recovery when Stellar connectivity is restored

### Memory Pressure

**Scenario:** Application memory usage exceeds threshold

**Health System Response:**
- Memory component status: "degraded"
- Overall system status: "degraded"
- Readiness probe: Still ready (200)
- Liveness probe: Still alive (200)

**Recovery:** Manual intervention may be required to address memory leaks

### Timeout Scenarios

**Scenario:** Health checks exceed configured timeouts

**Health System Response:**
- Affected component status: "down"
- Timeout error logged with latency information
- Graceful degradation to prevent cascade failures

**Recovery:** Automatic retry on next health check cycle

## Future Enhancements

### Planned Improvements

1. **Disk Usage Monitoring** - Add filesystem usage health checks
2. **Custom Health Checks** - Plugin system for application-specific health checks
3. **Health Check Caching** - Cache results to reduce load on dependencies
4. **Metrics Export** - Prometheus metrics integration
5. **Circuit Breaker** - Implement circuit breaker pattern for external dependencies

### Extensibility

The health system is designed for extensibility:

- Component health check functions can be easily added
- Configuration system supports new parameters
- Response format allows for additional check types
- Handler functions can be composed for custom endpoints

## Troubleshooting

### Common Issues

1. **Health checks timing out**
   - Verify database connectivity
   - Check Stellar Horizon URL configuration
   - Review network connectivity and firewall rules

2. **Degraded performance warnings**
   - Monitor database query performance
   - Check Stellar network status
   - Review application memory usage patterns

3. **Readiness probe failures**
   - Ensure critical dependencies are operational
   - Verify configuration parameters
   - Check application startup sequence

### Debug Information

Enable debug logging by setting appropriate log levels:

```bash
# Enable debug logging for health checks
DEBUG=health:* npm start
```

Health check responses include detailed component information for troubleshooting operational issues.

## Compliance and Standards

### Industry Standards

- **RFC 7231** - HTTP status code usage for health endpoints
- **Kubernetes Health Checks** - Compatible with Kubernetes probe specifications
- **12-Factor App** - Health endpoints support operational visibility requirements

### Security Standards

- **OWASP** - No sensitive information disclosure in health responses
- **Principle of Least Privilege** - Minimal information exposure for operational needs
- **Defense in Depth** - Multiple layers of health monitoring and alerting

This health system provides production-grade monitoring capabilities while maintaining security best practices and operational simplicity.