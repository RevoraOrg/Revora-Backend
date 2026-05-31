# Webhook Dead-Letter Inspection and Replay

This document describes the new observability and admin routes for inspecting and replaying webhook dead-letter deliveries.

## Metrics

- Metric: `webhook_dead_letter_total{endpoint="<endpoint-id>"}`
  - Type: gauge
  - Description: Number of deliveries marked `dead_letter` for the endpoint.
  - Cardinality: capped by `MetricsCollector.maxCardinality` (default 1000).
  - Emitted whenever a delivery is moved to `dead_letter`.

## Admin Endpoints (requires admin session auth)

Base path: `/api/v1/admin/webhooks`

- `GET /:endpointId/dead-letters`
  - Returns recent dead-letter deliveries for the given endpoint.
  - Query params: `page` (default 0), `limit` (default 50, max 100).
  - Response: `{ total, limit, page, items: [WebhookDelivery] }`

- `POST /dead-letters/:id/replay`
  - Idempotently re-enqueues the given dead-lettered delivery.
  - Implementation: updates the existing delivery record back to `pending`, resets `attempts`, clears `last_error` and `next_retry_at`.
  - Triggers an immediate background re-processing attempt when the in-process `WebhookQueue` is available; otherwise it will be picked up by the normal retry/resume mechanism.

## Security and correctness notes

- Endpoints are protected by the existing session-based `requireAuth` middleware and additionally require the `admin` role.
- Replay is idempotent: it reuses the existing delivery record (no new delivery rows are created).
- Pagination guard prevents large responses (`limit` capped to 100).
- Metric labels are sanitized and subject to `MetricsCollector` cardinality limits to avoid explosion of unique label values.

## Testing

- Unit tests added: `src/routes/adminWebhooks.test.ts` covering listing, replay success, non-admin access, and invalid-replay cases.

## Usage

- To view metrics (Prometheus format): `GET /metrics` (requires internal `METRICS_TOKEN` in production).
- To inspect dead letters: call the admin endpoints described above with an admin session.
