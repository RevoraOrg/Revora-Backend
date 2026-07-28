# OIDC Discovery Document TTL and Digest Change Alert

## Purpose

IdP `.well-known/openid-configuration` documents can change authorization, token, or JWKS endpoints without an operator noticing. This feature refreshes discovery at a configurable TTL, stores a content digest per issuer, and emits an `oidc.discovery.changed` alert when the digest changes so admins can confirm the update is expected.

## Behavior

1. On `getDiscovery(issuerUrl)`, return the in-memory document if still within TTL.
2. On TTL expiry (or cold cache), fetch `/.well-known/openid-configuration`.
3. Validate required fields and issuer match (unchanged security checks).
4. Compute SHA-256 over a **canonical** JSON serialization of public discovery fields (sorted keys; `_cachedUntil` excluded).
5. Compare to the last digest stored for that issuer:
   - **First observation** — store digest, no alert.
   - **Same digest** — refresh TTL only (whitespace / key-order-only responses are no-ops).
   - **Different digest** — update stored digest, emit `oidc.discovery.changed`, and log a warning with truncated digests.

## Configuration

| Source | Key | Default |
|--------|-----|---------|
| Env | `OIDC_DISCOVERY_TTL_MS` | `3600000` (1 hour) |
| Constructor | `OidcAdapterServiceOptions.discoveryTtlMs` | env / default |

Inject `metrics` (same shape as `MetricsCollector.incrementCounter`) for tests; production uses `globalMetrics`.

## Metric / alert

- **Name:** `oidc.discovery.changed` (Prometheus export sanitizes to `oidc_discovery_changed`)
- **Type:** counter
- **Labels:** `issuer`
- **Meaning:** discovery document semantic content changed for that issuer since the previous refresh

Wire this counter into your alerting pipeline so on-call can review endpoint deltas.

## Security and correctness notes

- Digest is **per issuer URL** and never includes cache metadata.
- Canonicalization ensures whitespace-only and key-order-only changes do **not** fire alerts.
- Failed fetches / issuer mismatches still throw; digests are updated only after successful validation.
- Discovery continues to be used for authorize/token/JWKS; the alert is advisory and does not auto-block flows (operators validate expected migrations).

## Testing

```bash
npx jest --runInBand src/auth/oidc/oidc.test.ts
```

Coverage includes fixture rotation (endpoint change → alert) and whitespace-only refresh (no alert).
