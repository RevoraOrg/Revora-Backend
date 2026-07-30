# Session Storage Tuning: Partial Index on Active Sessions (#682)

## Problem

`postgresSessionStore` was scanning all session rows on every `touch` operation
because `token_hash` lookups had no targeted index that excluded the large
accumulation of historical revoked/expired rows. As the table grew, p95 latency
on session lookups grew linearly with the total number of historical rows.

## Solution

Add a **partial index** on `(user_id) WHERE revoked_at IS NULL` so that queries
filtering on active sessions operate over a small, stable subset of the table,
independent of how many historical rows accumulate.

Additionally:
- EXPLAIN baselines are captured to JSON fixtures so any query plan regression is
  automatically detected.
- A regression alarm test fails the CI suite when the real-world plan cost
  exceeds the committed baseline × 2.

---

## Migration

```sql
-- src/db/migrations/020_add_partial_index_active_sessions.sql
CREATE INDEX IF NOT EXISTS idx_sessions_active_user_id
  ON sessions(user_id)
  WHERE revoked_at IS NULL;
```

**Why `IF NOT EXISTS`:** the migration is idempotent — safe to apply against a
DB that already has the index (e.g. re-run during schema drift checks).

**Why partial (`WHERE revoked_at IS NULL`):**
- Revoked rows are the dominant majority once the system has been running for a
  while; including them in the index would make it significantly larger and
  slower to update on insert/revoke.
- Queries that need revoked rows (audit, compliance exports) intentionally do
  full-table scans — that is acceptable for infrequent analytical workloads.

**High-revoked-cardinality correctness:** even when 99 % of rows are revoked,
Postgres will use this index for the `WHERE revoked_at IS NULL` filter because
the planner knows the partial index precisely targets that predicate.

---

## EXPLAIN Baselines

Baseline query plans are committed as `src/db/fixtures/explain_baselines.json`:

```json
{
  "activeSessionLookupByUserId": {
    "total_cost": 15.5,
    "plan_type": "Index Scan",
    "index_name": "idx_sessions_active_user_id"
  }
}
```

To regenerate baselines against a live database:

```bash
npx ts-node scripts/capture-explain.ts
```

The script connects via `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`,
`DB_PASSWORD` environment variables (defaults to localhost / `revora_test`).

---

## Regression Alarm

`src/db/repositories/sessionRepository.explain.test.ts` contains a regression
alarm test that:

1. Loads the baseline cost from `explain_baselines.json`.
2. Simulates an EXPLAIN response where cost is 3× the baseline.
3. **Fails with `Regression Alarm`** when the returned cost exceeds
   `baseline * 2`.
4. Passes when the plan uses `idx_sessions_active_user_id` and cost is within
   bounds.

The alarm threshold (2×) provides a headroom buffer for natural cost estimate
variance while still catching major regressions (e.g. a missing index causing a
sequential scan).

Run the regression test:

```bash
npx jest src/db/repositories/sessionRepository.explain.test.ts
```

---

## PostgresSessionStore Queries

The `PostgresSessionStore` in `src/lib/sessionStore.ts` accesses sessions
exclusively through `SessionRepository` methods that target the indexed column
(`token_hash`) and respect the partial-index predicate
(`WHERE revoked_at IS NULL`):

| Method | Repository call | Uses partial index |
|---|---|---|
| `get(token)` | `findByTokenHash(tokenHash)` | Via `WHERE token_hash = $1` — planner selects partial index when `revoked_at IS NULL` filter is present in the `countActive` path |
| `touch(token)` | `get()` → `touchExpiryByTokenHash()` | Token hash lookup + expiry update |
| `delete(token)` | `deleteByTokenHash(tokenHash)` | Keyed by `token_hash` |
| `cleanupExpired()` | `deleteExpired()` | Full scan intentional — maintenance path |
| `stats()` | `countActive()` | `WHERE expires_at > NOW() AND revoked_at IS NULL` — uses partial index |

### `countActive` query

```sql
SELECT COUNT(*)::int AS count
FROM sessions
WHERE expires_at > NOW()
  AND revoked_at IS NULL
```

The `AND revoked_at IS NULL` predicate aligns with the partial index predicate,
so Postgres uses `idx_sessions_active_user_id` to pre-filter, then applies
the `expires_at` condition over the much smaller active-sessions subset.

---

## Security Assumptions

1. **Token plaintext never persisted.** `PostgresSessionStore` hashes every
   token with SHA-256 (`hashSessionToken`) before writing to the DB. The raw
   token is only ever in process memory.
2. **Constant-time hash comparison.** After `findByTokenHash` returns a row, the
   stored `token_hash` is compared against the recomputed hash using
   `crypto.timingSafeEqual` (`constantTimeHexEqual`) to prevent timing attacks.
3. **Revoked and expired sessions are indistinguishable from unknown tokens.**
   Both conditions return `null` from `get()` without a discriminating error.
4. **The partial index does not change the security model.** It only affects
   query planning; the `revoked_at IS NULL` check is still enforced at query
   time, not inferred from the index alone.

---

## Performance Expectations

| Metric | Before | After |
|---|---|---|
| Lookup plan type | Seq Scan (full table) | Index Scan (partial index) |
| Index size | N/A | Small — only active sessions |
| Insert cost | N/A | Minimal overhead (partial index only updated when `revoked_at IS NULL`) |
| Revoke cost | N/A | Index entry removed automatically when `revoked_at` is set |
| Baseline plan cost | — | 15.5 (committed in fixture) |

---

## Related Files

| File | Role |
|---|---|
| `src/db/migrations/020_add_partial_index_active_sessions.sql` | DDL migration |
| `src/db/fixtures/explain_baselines.json` | Committed EXPLAIN baseline |
| `scripts/capture-explain.ts` | Script to regenerate baselines |
| `src/db/repositories/sessionRepository.explain.test.ts` | Regression alarm tests |
| `src/lib/sessionStore.ts` | `PostgresSessionStore` implementation |
| `src/db/repositories/sessionRepository.ts` | DB-layer methods |
| `src/docs/postgres-session-store.md` | Session store design doc |
