# Load Testing Scenario

## Overview
This document describes the k6 load testing scenarios for the `/health` and `/api/offerings` endpoints, targeting the Express/TypeScript Revora-Backend. 

## Scenarios
The `test/load/k6-scenario.js` defines two main scenarios:
1. **GET `/health/ready`**: Verifies the health check endpoint returns 200 OK and valid JSON (`{ status: 'ok' }`). This endpoint checks the Postgres database connection and the Stellar Horizon RPC.
2. **GET `/api/offerings`**: Verifies the public offerings endpoint returns a catalog of open offerings in a paginated JSON format.

## Execution
To run the load tests locally (separate from prod):

```bash
# Ensure your local server is running
npm run start

# Run the k6 script
k6 run test/load/k6-scenario.js
```

You can customize the base URL using an environment variable:
```bash
k6 run -e BASE_URL=http://localhost:3000 test/load/k6-scenario.js
```

## Security Assumptions and Error Handling

1. **Structured Errors**: The backend leverages a centralized error handling mechanism defined in `src/lib/errors.ts`. No raw upstream database or third-party service error strings are leaked in client-facing JSON.
2. **Stellar RPC Failures**: The health check interacts with the Stellar Horizon RPC. If the RPC fails, the error is caught and passed to `mapHealthDependencyFailure`, which internally uses `classifyStellarRPCFailure` to normalize the upstream error. This prevents leaking raw Axios/fetch HTTP errors or Stellar stack traces to the caller. The failure class (e.g., `Timeout`, `NetworkError`) is included in the structured log but stripped/normalized before reaching the client response payload via the global `errorHandler`.
3. **Observability**: Structured JSON logging tracks rate-limiting, error responses, and stack traces (in non-production environments). Load testing will predictably increase the rate of log entries if limits are exceeded or services become degraded.
