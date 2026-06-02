/**
 * P99 Latency Budget Testing and SLA Enforcement
 * 
 * Comprehensive guide to the p99 latency budget system for hot routes.
 * Describes how budgets are configured, monitored, and enforced.
 */

# P99 Latency Budget Testing and SLA Enforcement

## Overview

The p99 latency budget system enforces performance SLAs for hot routes in the
backend API. Each critical route has a documented p99 (99th percentile) latency
budget that is monitored and tested to detect performance regressions.

Budgets are enforced through:
- **Synthetic load testing**: Periodic tests that drive synthetic load against routes
- **Regression detection**: Automated alerts when p99 exceeds the budget
- **Clear documentation**: Each budget has documented rationale
- **Conservative margins**: Budgets include safety margins for network jitter

## Budget Configuration

Budgets are defined in `src/lib/latency-budgets.ts`:

```typescript
export const HOT_ROUTE_BUDGETS: LatencyBudgetConfig[] = [
  {
    name: 'Health Check',
    method: 'GET',
    path: '/api/v1/health',
    p99BudgetMs: 200,
    description: 'Simple health check with minimal processing',
  },
  // ... more routes
];
```

### Current Budgets

| Route | Method | Budget | Rationale |
|-------|--------|--------|-----------|
| `/api/v1/health` | GET | 200ms | Simple DB query, no auth |
| `/api/v1/offerings/validation-matrix` | POST | 250ms | Stateless validation |
| `/api/investments` | POST | 500ms | Write-heavy with external calls |

## Modifying Budgets

### When to Update Budgets

**Increase a budget if:**
- The route legitimately requires more processing (schema changes, new business logic)
- You've added new downstream dependencies (database joins, external API calls)
- You've measured baseline latency and the new budget is still conservative

**Decrease a budget if:**
- You've optimized the route (database indexing, caching)
- You've reduced dependencies or made them more efficient
- You have evidence the route can sustain lower latency

### Update Procedure

1. **Gather baseline data**: Run the load test with current config
   ```bash
   npm test -- p99-latency-budgets.test.ts --verbose
   ```

2. **Understand the change**: What changed? Why should the budget change?

3. **Update the budget** in `src/lib/latency-budgets.ts`:
   ```typescript
   {
     name: 'Health Check',
     method: 'GET',
     path: '/api/v1/health',
     p99BudgetMs: 250,  // Updated from 200ms
     description: 'Increased budget due to additional health checks',
   }
   ```

4. **Run tests to validate** the new budget is achievable:
   ```bash
   npm test -- p99-latency-budgets.test.ts
   ```

5. **Document the change** in your commit message:
   ```
   fix: increase /health p99 budget to 250ms due to new health checks

   Rationale: Added readiness probe that requires additional queries.
   Measured baseline with 100 requests: p99 = 210ms
   ```

## Testing

### Run the Full Test Suite

```bash
npm test -- p99-latency-budgets.test.ts
```

This will:
- Run synthetic load against all hot routes
- Extract histogram observations from MetricsCollector
- Compute p99 latency
- Assert against configured budgets
- Log detailed statistics and failure reports

### Run with Verbose Output

```bash
npm test -- p99-latency-budgets.test.ts --verbose
```

This will print latency statistics for each route:
```
Health Check: n=100, min=45.23ms, p50=52.10ms, p95=78.45ms, p99=89.23ms, p999=95.67ms, max=98.45ms
```

### Run Specific Test

```bash
npm test -- p99-latency-budgets.test.ts -t "enforces p99 budget for GET /api/v1/health"
```

### Run Edge Case Tests

```bash
npm test -- p99-latency-budgets.test.ts -t "Histogram edge cases"
```

## Test Structure

The test suite has three main sections:

### 1. Hot Route Tests
Tests that p99 stays within budget for each production route:
- GET `/api/v1/health`
- POST `/api/v1/offerings/validation-matrix`
- POST `/api/investments`

**How it works:**
- Creates an in-process Express app
- Makes N synthetic requests (default: 100 per route)
- Extracts histogram observations from MetricsCollector
- Computes p99 latency
- Asserts p99 <= budget

### 2. Edge Case Tests
Tests histogram edge conditions:
- Empty histogram (0 observations)
- Single-sample histogram (1 observation)
- Burst of slow requests (90 fast + 10 slow)
- Percentile accuracy (known distribution)

### 3. Unit Tests
Tests percentile calculation implementation:
- p50 calculation (median)
- p95 calculation
- p99 calculation
- Edge percentiles (p0, p100)
- Invalid percentile handling

## Metrics Collection

The `MetricsCollector` automatically records HTTP request durations
via `metricsMiddleware` which is installed in `src/app.ts`:

```typescript
app.use(metricsMiddleware({ metrics }));
```

For each request, it records:
- `http_request_duration_ms` histogram with labels: `method`, `route`, `status_class`
- `http_requests_total` counter
- `errors_total` counter (for 4xx, 5xx responses)

The histogram is stored internally as an array of observations,
which can be extracted using utilities in `src/__tests__/metrics-test-utils.ts`:

```typescript
const observations = extractRawHistogramObservations(metrics, 'GET', '/api/v1/health');
const stats = computeHistogramStats(observations);
console.log(stats.p99); // 99th percentile latency
```

## Utilities

Latency testing utilities are in `src/__tests__/metrics-test-utils.ts`:

### `computeHistogramStats(observations)`
Compute comprehensive statistics from observations.

```typescript
const stats = computeHistogramStats([10, 20, 30, ..., 100]);
// {
//   count: 100,
//   min: 10,
//   max: 100,
//   mean: 55,
//   p50: 50,
//   p95: 95,
//   p99: 99,
//   sum: 5500
// }
```

### `calculatePercentile(sortedObservations, percentile)`
Calculate specific percentile from sorted observations.

```typescript
const sorted = [1, 2, 3, ..., 100].sort((a, b) => a - b);
const p99 = calculatePercentile(sorted, 99); // 99th percentile
```

### `extractRawHistogramObservations(metrics, method, path)`
Extract observations from MetricsCollector for a specific route.

```typescript
const obs = extractRawHistogramObservations(metrics, 'GET', '/api/v1/health');
// Array of latency measurements in milliseconds
```

### `assertP99WithinBudget(p99Value, budgetMs, routeName)`
Assert p99 is within budget, throw with helpful error message on failure.

```typescript
assertP99WithinBudget(89.5, 200, 'Health Check'); // Passes
assertP99WithinBudget(250, 200, 'Health Check'); // Throws with details
```

## Troubleshooting

### Budget Exceeded

If p99 exceeds the budget, the test will output:
```
P99 LATENCY BUDGET EXCEEDED: Health Check
Budget: 200ms | Observed p99: 215.45ms
Exceedance: 15.45ms (+7.7%)
Requests: 100 | Min: 45.23ms | Max: 450.67ms
p50: 52.10ms | p95: 78.45ms | p999: 95.67ms
```

**Investigation steps:**
1. Check if the route has new dependencies (database joins, API calls)
2. Look for database query slowness: `npm run db:analyze`
3. Check for memory/CPU pressure: `npm run metrics`
4. Compare with baseline: run test on clean checkout
5. Check recent code changes affecting the route

### No Observations Collected

If the test reports "No observations collected for /api/v1/health",
it means the metrics middleware didn't record the route.

**Verification steps:**
1. Confirm the route is registered: check `src/app.ts`
2. Confirm metricsMiddleware is installed: check app startup
3. Check that synthetic requests actually hit the route (not 404)
4. Run a simple test:
   ```bash
   curl -i http://localhost:3000/api/v1/health
   ```

### Percentile Calculations Look Wrong

The test includes unit tests for percentile calculation.
Run them to verify the implementation:
```bash
npm test -- p99-latency-budgets.test.ts -t "Percentile calculation"
```

## CI/CD Integration

The p99 latency budget tests should be part of your CI pipeline:

```yaml
# In your CI workflow (GitHub Actions, etc.)
- name: Test p99 latency budgets
  run: npm test -- p99-latency-budgets.test.ts
  if: github.event_name == 'pull_request'
```

Any PR that increases p99 above the budget will fail the check,
requiring investigation or explicit budget increase.

## Security Assumptions

- **Budget values are conservative**: Include 5-10ms safety margin for network jitter
- **Measurements exclude test framework**: Only measure HTTP request processing
- **Budgets are regression detectors**: Not traffic-shaping gates
- **Budget enforcement is local**: Doesn't affect production traffic
- **Sensitive data is excluded**: No PII in metric labels

## Edge Cases Covered

The test suite covers important edge cases:

1. **Empty histogram**: Gracefully handles routes with no observations
2. **Single-sample histogram**: Correctly handles single request
3. **Two-sample histogram**: Accurate percentile calculation with minimal data
4. **Burst of slow requests**: Detects when slow requests push p99 over budget
5. **Known distribution accuracy**: Validates percentile calculation against known values

## Future Improvements

- **Adaptive budgets**: Use statistical process control to auto-adjust budgets
- **Multi-percentile tracking**: Track p50, p95, p999 in CI
- **Continuous monitoring**: Export metrics to monitoring system
- **Budget tiers**: Different budgets for different deployment environments
- **Load profile variations**: Test with different request patterns

## References

- [Metrics Collection](../src/lib/metrics.ts)
- [Metrics Middleware](../src/middleware/metricsMiddleware.ts)
- [Test Utilities](../src/__tests__/metrics-test-utils.ts)
- [Test Suite](../src/__tests__/p99-latency-budgets.test.ts)
- [Latency Budget Config](../src/lib/latency-budgets.ts)
