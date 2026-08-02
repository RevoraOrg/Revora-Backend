# Prometheus Metrics Endpoint

## Overview

The Revora Backend exposes application metrics in Prometheus text format via the `/metrics` endpoint. This endpoint is backed by the `MetricsCollector` service and provides observability into HTTP request patterns, system resources, and application health.

## Endpoint Details

- **URL**: `GET /metrics`
- **Format**: Prometheus text exposition format (version 0.0.4)
- **Content-Type**: `text/plain; version=0.0.4`
- **Authentication**: Bearer token (production only)

## Security

### Authentication

The `/metrics` endpoint is protected by bearer token authentication in production environments:

```bash
# Set the metrics token (production)
export METRICS_TOKEN="your-secure-random-token-here"

# Access metrics with authentication
curl -H "Authorization: Bearer your-secure-random-token-here" \
  http://localhost:4000/metrics
```

### Security Assumptions

1. **Token Protection**: The `METRICS_TOKEN` environment variable must be set in production
2. **Token Strength**: Token should be a cryptographically random string (minimum 32 characters recommended)
3. **Timing-Safe Comparison**: Token validation uses constant-time comparison to prevent timing attacks
4. **Development Access**: In development/test environments, the endpoint is accessible without authentication for convenience
5. **PII Protection**: Metrics labels are automatically filtered to prevent PII exposure (emails, phone numbers, IPs, UUIDs)
6. **Cardinality Limits**: Maximum 1000 unique metric combinations to prevent memory exhaustion

### Generating a Secure Token

```bash
# Generate a secure random token (Linux/macOS)
openssl rand -base64 32

# Or using Node.js
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

## Metrics Collected

### HTTP Request Metrics

#### `http_requests_total` (Counter)
Total number of HTTP requests by method, route, status code, and status class.

**Labels**:
- `method`: HTTP method (GET, POST, PUT, DELETE, etc.)
- `route`: Normalized route pattern (IDs replaced with `:id`)
- `status`: HTTP status code (200, 404, 500, etc.)
- `status_class`: Status code class (2xx, 3xx, 4xx, 5xx)
- `user_role`: User role if authenticated (startup, investor, admin, compliance)

**Example**:
```
http_requests_total{method="GET",route="/api/v1/offerings/:id",status="200",status_class="2xx"} 1523
http_requests_total{method="POST",route="/api/v1/investments",status="201",status_class="2xx"} 847
```

#### `http_request_duration_ms` (Histogram)
HTTP request duration in milliseconds.

**Labels**:
- `method`: HTTP method
- `route`: Normalized route pattern
- `status_class`: Status code class

**Buckets**: 10ms, 25ms, 50ms, 100ms, 250ms, 500ms, 1s, 2.5s, 5s, 10s, 30s

**Example**:
```
http_request_duration_ms{method="GET",route="/api/v1/health",status_class="2xx"} 45.2
```

### Error Metrics

#### `errors_total` (Counter)
Total errors by type, status code, and route.

**Labels**:
- `type`: Error type (`client_error` for 4xx, `server_error` for 5xx)
- `status`: HTTP status code
- `route`: Normalized route pattern

**Example**:
```
errors_total{type="client_error",status="404",route="/api/v1/unknown"} 23
errors_total{type="server_error",status="500",route="/api/v1/distributions"} 2
```

### Health Check Metrics

#### `health_checks_total` (Counter)
Total health check executions by check type and status.

**Labels**:
- `check`: Health check type (`database`, `stellar-horizon`)
- `status`: Check result (`success`, `failure`)

**Example**:
```
health_checks_total{check="database",status="success"} 5432
health_checks_total{check="stellar-horizon",status="failure"} 12
```

#### `health_check_duration_ms` (Histogram)
Health check execution duration in milliseconds.

**Labels**:
- `endpoint`: Health endpoint (`ready`, `live`, `startup`)

**Example**:
```
health_check_duration_ms{endpoint="ready"} 15.7
```

### Active Connections

The `MetricsCollector` tracks active HTTP connections in real-time through the metrics middleware.

## DB Pool Saturation Metrics (Autoscaling)

`GET /metrics/db-pool` exposes DB connection-pool saturation in **OpenMetrics
format v1.0.0** for horizontal autoscaling (KEDA / HPA / Prometheus). It is
guarded by the same bearer-token scrape auth as `/metrics`.

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `db.pool.waiters` | gauge | `pool` (`primary` \| `replica`) | Clients waiting to acquire a connection |
| `db.pool.utilization` | gauge | `pool` (`primary` \| `replica`) | In-use connections / pool `max` ratio (0.0–1.0) |

Both gauges are refreshed on every scrape from pg's synchronous pool counters
(no queries issued) and remain defined (value 0) when the pool is idle.

```bash
curl -H "Authorization: Bearer $METRICS_TOKEN" http://localhost:4000/metrics/db-pool
```

For HPA/KEDA configuration, alert rules, and target thresholds, see
[Autoscaling: DB Pool Saturation Signal](./autoscaling-db-pool-signal.md).

## Cardinality Protection

The metrics system enforces strict cardinality limits to prevent memory exhaustion:

- **Maximum Cardinality**: 1000 unique metric combinations
- **Route Normalization**: Dynamic segments (IDs, UUIDs) are replaced with `:id` placeholders
- **PII Detection**: Automatic filtering of personally identifiable information in labels
- **Silent Dropping**: Metrics exceeding cardinality limits are silently dropped

### Route Normalization Examples

```
/api/v1/users/123                    → /api/v1/users/:id
/api/v1/offerings/abc-def-123        → /api/v1/offerings/:id
/api/v1/users/123/investments/456    → /api/v1/users/:id/investments/:id
```

### PII Filtering

The following patterns are automatically redacted from metric labels:

- **Email addresses**: `user@example.com` → `[REDACTED_EMAIL]`
- **Phone numbers**: `+1-555-0123` → `[REDACTED_PHONE]`
- **IP addresses**: `192.168.1.1` → `[REDACTED_IP]`
- **UUIDs**: `550e8400-e29b-41d4-a716-446655440000` → `[REDACTED_ID]`
- **Long numeric IDs**: `1234567890123` → `[REDACTED_NUMERIC_ID]`

## Integration with Prometheus

### Scrape Configuration

Add the following to your `prometheus.yml`:

```yaml
scrape_configs:
  - job_name: 'revora-backend'
    scrape_interval: 15s
    scrape_timeout: 10s
    scheme: http
    authorization:
      type: Bearer
      credentials: 'your-secure-random-token-here'
    static_configs:
      - targets: ['localhost:4000']
        labels:
          environment: 'production'
          service: 'revora-backend'
```

### Kubernetes Service Monitor

For Kubernetes deployments using the Prometheus Operator:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: revora-backend
  namespace: monitoring
spec:
  selector:
    matchLabels:
      app: revora-backend
  endpoints:
    - port: http
      path: /metrics
      interval: 15s
      bearerTokenSecret:
        name: metrics-token
        key: token
```

## Example Queries

### Request Rate by Route

```promql
rate(http_requests_total[5m])
```

### Error Rate

```promql
rate(errors_total[5m])
```

### 95th Percentile Response Time

```promql
histogram_quantile(0.95, rate(http_request_duration_ms_bucket[5m]))
```

### Success Rate

```promql
sum(rate(http_requests_total{status_class="2xx"}[5m])) 
/ 
sum(rate(http_requests_total[5m]))
```

### Database Health Check Failures

```promql
rate(health_checks_total{check="database",status="failure"}[5m])
```

## Grafana Dashboard

### Recommended Panels

1. **Request Rate**: Line graph of `rate(http_requests_total[5m])`
2. **Error Rate**: Line graph of `rate(errors_total[5m])`
3. **Response Time**: Heatmap of `http_request_duration_ms`
4. **Status Code Distribution**: Pie chart of `http_requests_total` by `status_class`
5. **Active Connections**: Gauge of active HTTP connections
6. **Health Check Status**: Status panel for `health_checks_total`

### Sample Dashboard JSON

```json
{
  "dashboard": {
    "title": "Revora Backend Metrics",
    "panels": [
      {
        "title": "Request Rate",
        "targets": [
          {
            "expr": "rate(http_requests_total[5m])"
          }
        ]
      },
      {
        "title": "Error Rate",
        "targets": [
          {
            "expr": "rate(errors_total[5m])"
          }
        ]
      }
    ]
  }
}
```

## Testing

### Manual Testing

```bash
# Development (no auth required)
curl http://localhost:4000/metrics

# Production (with auth)
curl -H "Authorization: Bearer your-token" \
  https://api.revora.example/metrics
```

### Expected Output Format

```
# HELP http_requests_total Total HTTP requests
# TYPE http_requests_total counter
http_requests_total{method="GET",route="/api/v1/health",status="200",status_class="2xx"} 1523 1640000000000
http_requests_total{method="POST",route="/api/v1/investments",status="201",status_class="2xx"} 847 1640000000000

# HELP http_request_duration_ms HTTP request duration in milliseconds
# TYPE http_request_duration_ms histogram
http_request_duration_ms{method="GET",route="/api/v1/health",status_class="2xx"} 45.2 1640000000000

# HELP errors_total Total errors by type
# TYPE errors_total counter
errors_total{type="client_error",status="404",route="/api/v1/unknown"} 23 1640000000000
```

### Automated Testing

The metrics endpoint includes comprehensive test coverage:

- ✅ Authentication enforcement in production
- ✅ Token validation with timing-safe comparison
- ✅ PII filtering in labels
- ✅ Cardinality limit enforcement
- ✅ Empty registry handling
- ✅ Prometheus format compliance

Run tests:

```bash
npm test -- src/middleware/metricsMiddleware.test.ts
```

## Troubleshooting

### Endpoint Returns 401 Unauthorized

**Cause**: Missing or invalid bearer token in production.

**Solution**: Ensure `METRICS_TOKEN` is set and the correct token is provided:

```bash
export METRICS_TOKEN="your-secure-token"
curl -H "Authorization: Bearer your-secure-token" http://localhost:4000/metrics
```

### Endpoint Returns 503 Service Unavailable

**Cause**: `METRICS_TOKEN` environment variable not set in production.

**Solution**: Set the environment variable:

```bash
export METRICS_TOKEN="$(openssl rand -base64 32)"
```

### Metrics Not Appearing

**Cause**: Metrics collection may be disabled or no traffic has occurred.

**Solution**: 
1. Verify `MetricsCollector` is initialized with `enabled: true`
2. Generate some traffic to the application
3. Check that `metricsMiddleware` is registered before route handlers

### High Cardinality Warning

**Cause**: Too many unique label combinations (exceeds 1000 limit).

**Solution**: 
1. Review metric labels for high-cardinality values (user IDs, timestamps, etc.)
2. Ensure route normalization is working correctly
3. Enable PII detection: `enablePIIDetection: true`

### Memory Usage Growing

**Cause**: Histogram observations accumulating without bounds.

**Solution**: The `MetricsCollector` automatically limits histogram observations to `maxPoints` (default: 10,000). Adjust if needed:

```typescript
const metrics = new MetricsCollector({
  maxPoints: 5000, // Reduce memory footprint
});
```

## Configuration

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `METRICS_TOKEN` | Yes (prod) | - | Bearer token for metrics endpoint authentication |
| `NODE_ENV` | No | `development` | Environment mode (affects auth requirements) |

### MetricsCollector Options

```typescript
const metrics = new MetricsCollector({
  enabled: true,                    // Enable/disable metrics collection
  maxPoints: 10000,                 // Max histogram observations to retain
  histogramBuckets: [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000],
  maxCardinality: 1000,             // Max unique metric combinations
  enablePIIDetection: true,         // Enable PII filtering in labels
});
```

## Performance Considerations

- **Overhead**: Metrics collection adds ~1-2ms per request
- **Memory**: Approximately 100-200 bytes per unique metric combination
- **CPU**: Minimal impact (<1% CPU usage under normal load)
- **Network**: Metrics endpoint response size typically 10-50KB

## Security Best Practices

1. **Rotate Tokens**: Regularly rotate the `METRICS_TOKEN` (e.g., every 90 days)
2. **Network Isolation**: Restrict `/metrics` endpoint to internal networks only
3. **TLS**: Always use HTTPS in production
4. **Monitoring**: Alert on unauthorized access attempts (401 responses)
5. **Audit**: Log all metrics endpoint access for security auditing

## Related Documentation

- [MetricsCollector API](../src/lib/metrics.ts)
- [Metrics Middleware](../src/middleware/metricsMiddleware.ts)
- [Health Endpoints](./health-readiness-probe-expansion.md)
- [Autoscaling: DB Pool Saturation Signal](./autoscaling-db-pool-signal.md)
- [Prometheus Documentation](https://prometheus.io/docs/introduction/overview/)

## Changelog

### 2026-08-02
- ✅ Added `GET /metrics/db-pool` (OpenMetrics) exposing `db.pool.waiters` and
  `db.pool.utilization` for the horizontal autoscaler, guarded by the same
  `METRICS_TOKEN` bearer auth as `/metrics`

### 2024-01-15
- ✅ Initial implementation of `/metrics` endpoint
- ✅ Bearer token authentication for production
- ✅ PII detection and filtering
- ✅ Cardinality limit enforcement
- ✅ Prometheus text format serialization
- ✅ Integration with existing MetricsCollector
- ✅ Comprehensive test coverage
