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

## Jest Coverage Gate (`jest.config.js`)

Jest enforces global coverage thresholds across both baseline operational modules and security-critical auth, signature, SSRF protection, and ledger modules via `collectCoverageFrom` and `coverageThreshold.global` in `jest.config.js`.

### Covered Modules (`collectCoverageFrom`)

#### Auth & Session
- `src/middleware/auth.ts`
- `src/middleware/authWithSession.ts`
- `src/middleware/scimAuth.ts`
- `src/lib/jwt.ts`

#### Signatures & Webhooks
- `src/middleware/adminSignature.ts`
- `src/middleware/deviceSignature.ts`
- `src/middleware/webhookAuth.ts`
- `src/lib/webhookSignature.ts`

#### SSRF Protection
- `src/lib/ssrfProtection.ts`

#### Ledger
- `src/services/accountingLedgerService.ts`
- `src/services/ledgerService.ts`
- `src/db/repositories/ledgerEntryRepository.ts`
- `src/db/repositories/ledgerPeriodLockRepository.ts`
- `src/db/repositories/disputeLedgerEventRepository.ts`

#### Baseline Route & Operational Modules
- `src/routes/offerings.investments.ts`
- `src/lib/pressureGauge.ts`
- `src/services/outboxDispatcher.ts`
- `src/lib/metrics.ts`
- `src/db/repositories/scheduledDistributionRepository.ts`

### Global Thresholds (`coverageThreshold.global`)

- **Branches**: `70%`
- **Functions**: `75%`
- **Lines**: `74%`
- **Statements**: `74%`

### Running Locally

```bash
npm run test:coverage
```

Configuration invariants for `collectCoverageFrom` and `coverageThreshold.global` are verified in `src/__tests__/jestCoverageConfig.test.ts`.
