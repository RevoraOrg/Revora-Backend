# Revora Backend

API and worker service for **Revora**, a revenue-sharing / investment platform on Stellar. Startups register and publish offerings, investors invest, revenue reports are ingested and reconciled, and payouts are distributed on a schedule with an audit trail. The service also covers KYC/AML and sanctions screening, tax lots, notifications, and webhooks.

- Frontend: [RevoraOrg/Revora-Frontend](https://github.com/RevoraOrg/Revora-Frontend)
- Smart contracts: [RevoraOrg/Revora-Contracts](https://github.com/RevoraOrg/Revora-Contracts)

## Architecture

Node.js + TypeScript (CommonJS via ts-node / `tsc`) + Express 4, PostgreSQL via `pg`, Stellar via `@stellar/stellar-sdk`, validation with zod. Entry point: `src/index.ts` (listens on `PORT`, default 4000). A `src/app.ts` wiring for auth routers also exists.

| Area | Location |
| --- | --- |
| Routers / handlers | `src/routes/`, `src/auth/` (register, login, refresh, logout, change-password, OIDC, social), `src/offerings/`, `src/vaults/` |
| Services (AML, KYC, FX, ledger, tax, outbox, payouts, reconciliation) | `src/services/`, `src/aml/`, `src/jobs/` |
| Persistence | `src/db/` (pool, replica-lag monitor, transactions, repositories, numbered SQL migrations in `src/db/migrations/`, runner `src/db/migrate.js`) |
| Middleware | `src/middleware/` (auth, CORS, rate limiting tiers, request id, metrics, error handler) |
| Config | `src/config/env.ts` (zod-validated env, documented in its header), `src/config/workerRole.ts` |
| Stray Rust files | `src/lib.rs`, `src/vesting.rs`, `Cargo.toml` (crate `revora-contracts`) sit in this repo but are not part of the Node build; the contracts live in Revora-Contracts |
| OpenAPI | `src/docs/openapi.yaml` |

**Worker roles.** The `ROLE` env var (`api`, `batch`, `all`) splits HTTP serving from background jobs (see [docs/worker-role-separation.md](docs/worker-role-separation.md)). `ROLE` must be set outside the test environment, otherwise startup exits.

## API surface

Versioned routes live under `API_VERSION_PREFIX` (default `/api/v1`). The authoritative contract is `src/docs/openapi.yaml` (served by `src/routes/apiDocs.ts`; conformance is tested, see [docs/openapi-conformance.md](docs/openapi-conformance.md)). Functional groups, from `src/index.ts` and `src/routes/`:

- **Health:** `GET /health`, `/health/failover`, `/health/live`, `/health/ready`, `/health/startup`, `/health/region`
- **Auth:** startup registration (`POST /api/v1/startup/register`), password reset (`POST /api/auth/forgot-password`, `/reset-password`), plus login/refresh/logout/change-password, OIDC and social login modules under `src/auth/`
- **Overview and offerings:** `GET /overview`, offerings catalog and startup offering lifecycle (approve/reject/archive), `POST /offerings/validation-matrix`, offering sync
- **Investments, payouts, statements:** investments list, payouts list with filters, investor statements (`/statements/:periodId/:investorId`)
- **Distributions:** distribute and preview per offering, pause/resume, schedule CRUD, ledger export
- **Vesting:** `POST /vesting/claim`
- **Compliance:** AML rules, cases, alerts, OFAC review queue (`/aml/*`), sanctions version changelog (`/compliance/*`), KYC risk tiers (`/admin/investors/:id/kyc-risk-tier`), SCIM 2.0 provisioning
- **Ledger and tax:** `/ledger/export`, `/admin/ledger/*`, `/taxation/{dispose,preview,wash-sale-detection,gains-summary,lots}`
- **Reconciliation and disputes:** reconcile/validate-report, dispute SLA timers and refunds
- **Admin:** audit-log export (`/admin/audit-log/export.csv`), retention labels and legal hold, webhook dead-letter inspection/replay, contract-upgrade routes
- **Notifications and webhooks:** notifications, per-user preferences, mobile companion/sync, inbound email webhooks (`/api/v1/email/webhooks/{sendgrid,ses,smtp}`), Prometheus `GET /metrics/reconciliation`

Not every router module is necessarily mounted in every deployment role; check `src/index.ts` for what is wired.

## Configuration

There is no `.env.example`. `src/config/env.ts` is the reference; its header lists each variable, default and whether it is required. Key variables:

| Variable | Notes |
| --- | --- |
| `NODE_ENV`, `PORT` (4000), `ROLE`, `API_VERSION_PREFIX` | runtime |
| `DATABASE_URL`, `JWT_SECRET` | required in production |
| `JWT_SECRET_PREVIOUS`, `JWT_KEY_ID`, `JWT_PREVIOUS_KEY_ID`, `JWT_ISSUER`, `JWT_AUDIENCE` | rotation and claims |
| `STELLAR_NETWORK` (testnet), `STELLAR_HORIZON_URL(S)`, `STELLAR_NETWORK_PASSPHRASE`, `STELLAR_SERVER_SECRET`, `STELLAR_TIMEOUT`, `STELLAR_MAX_FEE` | Stellar |
| `ALLOWED_ORIGINS` | explicit in production |
| `AUDIT_EXPORT_SIGNING_KEY` (prod), `AUDIT_EXPORT_PUBLIC_KEY`, `AUDIT_RETENTION_DAYS`, `SESSION_RETENTION_DAYS`, `CURSOR_SIGNING_SECRET` | audit and sessions |
| `EMAIL_PROVIDER` (sendgrid / smtp / mock), `FROM_EMAIL`, `SENDGRID_API_KEY`, `SMTP_*`, `SENDGRID_EVENT_WEBHOOK_SECRET`, `SES_SNS_TOPIC_ARN` | email |
| `OFAC_*`, `SCIM_TOKEN`, `KYC_CIRCUIT_*` | compliance |
| `REGION`, `FAILOVER_ACTIVE_REGION`, `OUTBOX_DISPATCHER_ENABLED`, `WEBHOOK_QUEUE_MAX_DEPTH`, `METRICS_TOKEN` | multi-region and ops |

## Running locally

Requires Node.js 22 (CI), PostgreSQL, and a `.env` you create from the table above.

```bash
npm ci
# create .env with at least DATABASE_URL, JWT_SECRET, STELLAR_SERVER_SECRET
npm run migrate      # applies src/db/migrations
npm run dev          # ts-node-dev on src/index.ts
```

Build and run: `npm run build && npm start`. Other scripts: `lint`, `audit:ci`, `validate:alert-mappings`, `drill:ttl-check`, `stryker`, `pact:verify`, `test:chaos`.

## Testing

Jest (`npm test` runs with coverage; `npm run test:coverage` runs in-band). Integration tests use Testcontainers PostgreSQL and Pact consumer contracts (`pacts/`). See [TESTING.md](TESTING.md), [E2E-TESTS-README.md](E2E-TESTS-README.md) and [docs/load-testing.md](docs/load-testing.md).

## CI and deployment

`.github/workflows/ci.yml` (push/PR to `master`) runs `npm ci` then `npx tsc --noCheck`, a minimal compile gate rather than the full suite. The `Dockerfile` is a multi-stage Node image (currently `node:18-alpine`). Operational docs: [docs/runbooks/](docs/runbooks/), [README-MIGRATIONS.md](README-MIGRATIONS.md), [docs/postmortems/](docs/postmortems/). Nothing here asserts a live deployment.

## Documentation

See [docs/index.md](docs/index.md) for a categorized index of the ~150 design docs.
