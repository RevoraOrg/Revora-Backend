# Admin Nonce Store Security Assumptions

## Overview

The admin signature middleware (`verifyAdminSignature`) authenticates
privileged admin actions with an Ed25519 signature over `{ action, offeringId,
nonce, timestamp }`. Each request carries a single-use `nonce` that is part of
the signed payload, so it cannot be tampered with after signing. To reject
replays the middleware records every nonce it has already accepted and refuses
duplicates within the replay window.

The replay cache was previously a per-process in-memory `Set` stored on
`req.app` (`adminNonceStore`). That cache is lost on restart and never seen by
other replicas, so a captured signed admin request could be replayed against a
different replica inside the 30-second freshness window, and any restart
cleared all history.

`PostgresAdminNonceStore` moves the replay history into a shared, persistent
table. The in-memory `Set` remains the default when no store is configured, so
tests and single-instance development are unchanged.

## Threat Model

### Attack Vectors Prevented

1. **Cross-Replica Replay**
   - A shared store means a nonce accepted by one replica is visible to all
     others, so a captured request replayed against a different replica is
     rejected.
   - Previously, each replica had its own `Set`, so a replay against a replica
     that had not yet seen the nonce succeeded.

2. **Post-Restart Replay**
   - The Postgres store persists accepted nonces, so a restart no longer clears
     replay history. A captured request cannot be replayed after the process
     restarts (within the replay window).

3. **Concurrent Duplicate Submission**
   - Detecting a replay and recording a fresh nonce are a single atomic
     statement (`INSERT ... ON CONFLICT (kid, nonce) DO UPDATE ... WHERE
     expires_at <= NOW()`). Two concurrent submissions of the same signed
     request are serialised by PostgreSQL's unique-index insertion: the first
     wins, the second resolves to the conflict path and is reported as a
     replay.

4. **Stale Nonce Reuse**
   - TTL expiry is enforced at query time, so an expired record is never
     treated as a live replay even before the cleanup job runs.

5. **Cross-Key Nonce Collisions**
   - Rows are keyed by `(kid, nonce)`, so a nonce consumed under one admin key
     cannot block (or be confused with) an unrelated admin key's request.

## Security Assumptions

### In-memory fallback (default when no store is configured)

- **Intended Use**: **Development and single-instance testing only** — do not
  use in production.
- **Assumption**: Single-process environment.
- **Risk**: Replays are not detected across instances or after restart; the
  store is process-local and does not expire entries.
- **Mitigation**: Use `PostgresAdminNonceStore` for all production and
  multi-instance deployments.

### PostgresAdminNonceStore

- **Assumption**: The database connection is secure and properly configured.
- **Risk**: Database compromise could allow manipulation of nonce records.
- **Mitigation**: Use connection pooling, SSL/TLS, and proper database
  security practices; grant least privilege to the application role.

- **Assumption**: The single atomic `INSERT ... ON CONFLICT DO UPDATE`
  statement serialises concurrent duplicates.
- **Risk**: None under PostgreSQL — the unique index on `(kid, nonce)` makes
  the conflicting insert block until the first commits, then resolve to the
  conflict path.
- **Limitation**: Relies on PostgreSQL's unique-index insertion semantics.

- **Assumption**: TTL expiry is enforced at query time.
- **Risk**: Expired rows may persist until the cleanup job runs.
- **Mitigation**: Expired rows are filtered by the `WHERE expires_at <= NOW()`
  predicate during `consume` regardless of cleanup.
- **Recommendation**: Run periodic cleanup to prevent table bloat.

- **Assumption**: Infrastructure failures throw, and the caller decides
  fail-open vs. fail-closed.
- **Risk**: A database outage during `consume` causes the store to throw.
- **Mitigation**: The middleware fails **closed by default** (rejects the
  request with a 500) to preserve replay safety. Operators may opt into
  fail-open (`failOpenOnStoreError: true`) to keep admin actions reachable
  during an outage, accepting a potential replay window as a trade-off.

## Replay Window Sizing

The middleware rejects any request whose `timestamp` is more than 30 seconds
from `now` (`Math.abs(now - timestamp) > 30`). A captured request therefore
stays valid for the attacker for up to ~60 seconds from the moment it was first
sighted (the timestamp may be up to 30s in the past or future of first
sighting).

The nonce TTL **must** cover this full window. The default is **120 seconds**
(`DEFAULT_ADMIN_NONCE_TTL_MS`, twice the worst-case window) to add clock-skew
margin. Setting `nonceTtlMs` / `ADMIN_NONCE_TTL_MS` below ~60s weakens replay
protection; setting it much higher wastes storage. Nonce rows are tiny (two
short strings + two timestamps), so the default is cheap.

Misconfiguration fails safe: zero, negative, non-numeric or `NaN` TTL values
are logged and replaced with the 120s default; `PostgresAdminNonceStore.consume`
also rejects a non-positive TTL rather than inserting an immediately-expired
row.

## Configuration

| Setting | Type | Default | Purpose |
| :--- | :--- | :--- | :--- |
| `verifyAdminSignature({ store })` | `AdminNonceStore` | none (in-memory `Set` fallback) | Shared replay store. Inject `PostgresAdminNonceStore` in production. |
| `verifyAdminSignature({ nonceTtlMs })` | `number` | `120000` | Replay window override; wins over the env var. |
| `ADMIN_NONCE_TTL_MS` | positive integer string | `120000` | Deployment-wide replay window when the option is not passed. |
| `verifyAdminSignature({ failOpenOnStoreError })` | `boolean` | `false` | Whether a store outage accepts (true) or rejects (false) the request. |
| `PostgresAdminNonceStore({ pool })` | `pg.Pool` | required | Shared connection pool; the store does not create its own. |

No new *required* environment variable is introduced: without a store the
middleware behaves exactly as before (process-local `Set`).

## Implementation Details

### Module: `src/middleware/adminSignature.ts`

#### AdminNonceStore Interface

```typescript
export interface AdminNonceStore {
  /**
   * Atomically record `kid` + `nonce` as seen within the replay window.
   * @returns `true` if newly recorded (not a replay); `false` if a replay
   *          was detected (record already exists and is unexpired).
   * @throws  on infrastructure failure (caller decides fail-open/closed).
   */
  consume(kid: string, nonce: string, ttlMs: number): Promise<boolean>;
}
```

`kid` is the verified `x-admin-kid` header. It matches the public key whose
signature was just verified, so both values in the key are authenticated
before the store is touched.

#### PostgresAdminNonceStore

PostgreSQL-backed implementation with:

- A single atomic `consume` statement (no multi-statement transaction needed).
- TTL expiry checked at query time.
- `cleanupExpired()` for periodic table-bloat control.
- Infrastructure failures throw so the middleware can apply its fail policy.

**consume Implementation**:

```sql
INSERT INTO admin_nonces (kid, nonce, expires_at)
VALUES ($1, $2, $3)
ON CONFLICT (kid, nonce) DO UPDATE
  SET expires_at = EXCLUDED.expires_at,
      created_at = NOW()
WHERE admin_nonces.expires_at <= NOW()
RETURNING 1
```

- **New `(kid, nonce)`**: INSERT succeeds → row returned → `true`.
- **Live, unexpired row**: the `WHERE expires_at <= NOW()` predicate is false →
  no update, no row returned → `false` (replay).
- **Expired row**: the predicate is true → row refreshed and returned → `true`
  (treated as new, which is safe because a stale request has already been
  rejected by the timestamp check before reaching the store).

**cleanupExpired Implementation**:

- `DELETE FROM admin_nonces WHERE expires_at < NOW()`
- Should be run periodically (e.g. via a scheduled job).
- Returns the count of deleted rows; errors propagate to the caller.

### Database Schema

`src/db/migrations/062_create_admin_nonce_store.sql`:

```sql
CREATE TABLE IF NOT EXISTS admin_nonces (
  kid TEXT NOT NULL,
  nonce TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (kid, nonce)
);

CREATE INDEX IF NOT EXISTS idx_admin_nonces_expires_at
  ON admin_nonces (expires_at);
```

The composite primary key is the unique constraint used by
`ON CONFLICT (kid, nonce)`; the separate index supports time-based cleanup.

## Usage

### Default (process-local in-memory — development / single-instance only)

When no store is configured, the middleware falls back to a process-local
`Set` on `req.app` (unchanged behaviour).

```typescript
import { verifyAdminSignature } from '../middleware/adminSignature';

// No store: falls back to the process-local in-memory Set on req.app.
router.post('/api/startup/offerings/:id/approve',
  verifyJWT,
  verifyAdminSignature(),
  handlers.approveOffering);
```

### PostgresAdminNonceStore (multi-instance / production)

```typescript
import {
  verifyAdminSignature,
  PostgresAdminNonceStore,
} from '../middleware/adminSignature';
import { pool } from '../db/pool';

const adminNonceStore = new PostgresAdminNonceStore({ pool });

router.post('/api/startup/offerings/:id/approve',
  verifyJWT,
  verifyAdminSignature({ store: adminNonceStore }),
  handlers.approveOffering);
```

`createOfferingsRouter` forwards an optional `adminNonceStore` to every
admin-signed offering route:

```typescript
app.use(createOfferingsRouter({
  offeringRepo,
  verifyJWT,
  adminNonceStore, // omit to keep the in-memory default
}));
```

### TTL via environment

```bash
# Replay window in milliseconds; defaults to 120000 when unset/invalid.
ADMIN_NONCE_TTL_MS=120000
```

```typescript
// Explicit option wins over the environment.
verifyAdminSignature({ store: adminNonceStore, nonceTtlMs: 120_000 });
```

### Periodic Cleanup

```typescript
// Run cleanup periodically (e.g. every few minutes) to prevent table bloat.
setInterval(async () => {
  try {
    const deleted = await adminNonceStore.cleanupExpired();
    console.log(`Cleaned up ${deleted} expired admin nonces`);
  } catch (error) {
    console.error('Admin nonce cleanup failed', error);
  }
}, 300_000);
```

## Abuse/Failure Paths Handled

### Database Connection Failure
- **Action**: `consume` throws; middleware fails closed by default (500) or
  open if configured (`failOpenOnStoreError: true`).
- **Logging**: Error logged at CRITICAL level with kid and nonce context.
- **Impact**: Closed → admin actions refused during outage; Open → potential
  replay window during outage.
- **Recovery**: Automatic when the database recovers.

### Concurrent Duplicate Requests
- **Action**: Serialised by the unique-index insertion; first wins, rest are
  replays.
- **Logging**: Replays logged as a warning.
- **Impact**: First request proceeds, concurrent duplicates get 409.
- **Recovery**: N/A (normal operation).

### Expired Records
- **Action**: Filtered at query time; removed by periodic cleanup.
- **Logging**: None (normal operation).
- **Impact**: Stale data is never reused.
- **Recovery**: Periodic cleanup removes expired records.

### Malformed Configuration
- **Action**: Invalid TTL env/option falls back to 120s and logs a warning; the
  store rejects a non-positive TTL before querying.
- **Impact**: Replay protection is never silently disabled by config.

## Migration

To migrate from the in-memory fallback to `PostgresAdminNonceStore`:

1. **Apply the migration**

   ```bash
   psql -U postgres -d revora -f src/db/migrations/062_create_admin_nonce_store.sql
   # or: npm run migrate
   ```

2. **Construct and inject the store**

   ```typescript
   // Before (single-instance)
   verifyAdminSignature()

   // After (multi-instance)
   const adminNonceStore = new PostgresAdminNonceStore({ pool });
   verifyAdminSignature({ store: adminNonceStore })
   ```

3. **Deploy with zero downtime**
   - Deploy new code that constructs `PostgresAdminNonceStore`.
   - The in-memory `Set` on `req.app` is simply no longer consulted; existing
     in-flight nonces were only valid for ~30s anyway, so the transition is
     seamless.
   - New requests use PostgreSQL; replays are now rejected across replicas and
     after restarts.

4. **Schedule cleanup**
   - Run `adminNonceStore.cleanupExpired()` periodically to prevent table bloat.

## Test Coverage

- `src/middleware/adminSignature.test.ts`
  - Mocked-pool tests for `consume` (insert, replay/no-row, invalid TTL, DB
    errors) and `cleanupExpired`.
  - Middleware tests for kid scoping, TTL option/env resolution, replay
    rejection, fail-closed default and explicit fail-open.
  - In-memory fallback behaviour is retained and still covered.
- `src/middleware/adminSignature.integration.test.ts`
  - Gated real-PostgreSQL tests (skipped unless
    `ADMIN_NONCE_TEST_DATABASE_URL` is set or Docker is available): cross-pool
    replay rejection, per-kid scoping, concurrent duplicates, expiry reuse and
    cleanup.

## Recommendations

### Production Deployment

1. **Use `PostgresAdminNonceStore`** for any deployment with more than one
   instance or that must survive restarts.
2. **Keep the default fail-closed behaviour** (`failOpenOnStoreError: false`)
   unless availability of admin actions during a DB outage is a hard
   requirement; only enable fail-open with that explicit trade-off in mind.
3. **Configure an adequate TTL** — at least ~60s to cover the replay window;
   the 120s default adds safe margin.
4. **Run periodic cleanup** to keep the table small.
5. **Monitor** nonce-store error rates and 409 (replay) rates.

### Security Best Practices

1. **Database Security** — SSL/TLS, least-privilege roles, rotated credentials.
2. **Nonces** — generate cryptographically random, single-use nonces; the nonce
   is authenticated by the signature before reaching the store.
3. **Monitoring** — alert on elevated replay rates (possible attack) and on
   store errors (possible outage).

## References

- `src/middleware/adminSignature.ts` — middleware and store implementations
- `src/db/migrations/062_create_admin_nonce_store.sql` — schema
- `src/middleware/idempotency.ts` — `PostgresIdempotencyStore` used as the
  pattern for the Postgres-backed store
- `docs/security/idempotency-store-security-assumptions.md` — analogous security
  assumptions for the idempotency store
- [PostgreSQL Unique Indexes / INSERT ON CONFLICT](https://www.postgresql.org/docs/current/sql-insert.html#SQL-ON-CONFLICT)
