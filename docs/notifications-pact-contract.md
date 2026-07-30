# Notifications Pact Contract

## Purpose

This contract protects the `/notifications` API shape exposed to the frontend and prevents silent contract drift when response fields change without a consumer update.

## Contract coverage

The consumer tests in [src/routes/__tests__/notifications.consumer.test.ts](../src/routes/__tests__/notifications.consumer.test.ts) define the accepted response contract for:

- `GET /notifications`
- `PATCH /notifications/:id/read`

The provider verification in [src/routes/notifications.pact.test.ts](../src/routes/notifications.pact.test.ts) exercises the live Express handler from [src/routes/notifications.ts](../src/routes/notifications.ts) against those Pact files.

## Provider states

The contract uses provider states so the response can be deterministic and safe to review:

- `user has notifications`
- `user has no notifications`
- `a notification exists`
- `notification does not exist`

These states are set via the `/__state` hook used by the Pact verifier, keeping the contract contractually scoped to the authenticated notification flow.

## Security assumptions

- Authentication is required for all notification requests.
- The broker URL and token are injected via GitHub Actions secrets, not checked into source control.
- Verification fails if the provider response shape deviates from the consumer contract, making field removal or status regressions visible before merge.
- The route keeps authorization enforcement and validation separate from the business logic so regression tests catch unauthorized and malformed request paths.

## CI enforcement

The CI workflow in [.github/workflows/ci.yml](../.github/workflows/ci.yml) runs a dedicated `pact-notifications` job. It:

1. Installs dependencies.
2. Publishes the consumer contract when broker credentials are configured.
3. Verifies the live backend provider against the Pact broker if the secret-backed broker is available.
4. Falls back to the local Pact files when the broker is not configured so the contract still validates in local or unsigned CI environments.

## Drift detection

Removing a field from the notifications payload will fail the Pact verification until the consumer explicitly accepts the schema change. This protects frontend regressions from landing unnoticed.
