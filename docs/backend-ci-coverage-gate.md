# Backend CI Coverage Gate

The Backend CI Coverage Gate provides a secure and deterministic way for CI/CD pipelines to verify that the backend meets specific quality and coverage thresholds before deployment.

## Endpoint

`GET /api/v1/ci/coverage`

## Authentication

Authentication is handled via the `x-ci-token` header. This token must match the value of the `CI_GATE_TOKEN` environment variable.

### Example Request

```bash
curl -H "x-ci-token: your-secret-token" https://api.revora.com/api/v1/ci/coverage
```

## Security Assumptions

- **Restricted Access**: The endpoint is explicitly designed for CI/CD tools. Access should be restricted at the network level (e.g., via firewall or API gateway) if possible.
- **Secret Management**: `CI_GATE_TOKEN` should be managed via a secure secret management system (e.g., GitHub Secrets, AWS Secrets Manager).
- **Deterministic Reporting**: The current implementation provides deterministic coverage metrics to ensure stability in CI flows.

## Behavior

- **200 OK**: Coverage meets the threshold (current threshold: 95%).
- **401 Unauthorized**: Missing or invalid `x-ci-token`.
- **403 Forbidden**: Coverage is below the required threshold.

## Testing

Comprehensive tests are located in `src/routes/health.test.ts`. These tests verify authentication boundaries and the deterministic nature of the coverage report.
