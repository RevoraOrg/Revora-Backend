# Postgres-backed session store & hardened cookies

## Why

The original `SessionStore` (`src/lib/sessionStore.ts`) kept sessions in a
process-local `Map`. Sessions were therefore lost on every restart and were not
shared across instances behind a load balancer. The session middleware also
accepted a bearer token without enforcing any cookie-security defaults.

This change adds a Postgres-backed store and a hardened cookie issuer while
keeping the in-memory store (used by unit tests and single-process dev) intact.

## What changed

| File | Change |
| --- | --- |
| `src/lib/sessionStore.ts` | New `ISessionStore` interface, `PostgresSessionStore`, and token helpers (`hashSessionToken`, `generateSessionToken`, `constantTimeHexEqual`). |
| `src/db/repositories/sessionRepository.ts` | Web-session helpers: `createWebSession`, `findByTokenHash`, `deleteByTokenHash`, `touchExpiryByTokenHash`, `deleteExpired`, `countActive`; `role` column mapping. |
| `src/middleware/session.ts` | Depends on `ISessionStore`; new secure cookie issuer (`buildSessionCookie`, `issueSessionCookie`, `clearSessionCookie`); login issues the cookie, logout clears it. |
| `src/db/migrations/sessions.sql` | Adds `role TEXT` to `sessions`. |

`PostgresSessionStore` implements the same `ISessionStore` surface as the
in-memory store, so the middleware works with either:

```ts
import { PostgresSessionStore } from "./lib/sessionStore";
import { SessionRepository } from "./db/repositories/sessionRepository";
import { getPool } from "./db/pool";

const store = new PostgresSessionStore(new SessionRepository(getPool()), {
  ttlMs: 60 * 60 * 1000,        // 1 hour
  cleanupIntervalMs: 5 * 60 * 1000,
});
store.startCleanup();           // periodic deletion of expired rows
```

## Security model

- **Token hashing.** The store generates an opaque 128-bit random token and
  persists only its SHA-256 hash (`token_hash`). The plaintext token is never
  written to the database. SHA-256 — not a slow KDF — is correct here because
  the token already has full cryptographic entropy and is not brute-forceable
  from its hash.
- **Constant-time lookup.** After fetching by `token_hash`, the store compares
  the stored hash against the recomputed hash with `crypto.timingSafeEqual`
  (`constantTimeHexEqual`) before honoring the session.
- **Expiry / revocation.** Expired (`expires_at <= now`) and revoked
  (`revoked_at` set) sessions are rejected and are indistinguishable from
  unknown tokens. Expired rows are lazily deleted on read and bulk-removed by
  the `cleanupExpired` job.
- **Cookie hardening.** `buildSessionCookie` always emits `HttpOnly`,
  `SameSite=Strict`, and `Path=/`. In production (`NODE_ENV=production`) the
  `Secure` attribute is mandatory — issuing a non-Secure session cookie throws,
  so a session token can never be sent over plaintext HTTP.

## Tests

- `src/lib/postgresSessionStore.test.ts` — create/get/touch/delete,
  hash-only storage, constant-time guard, expiry & revocation rejection,
  `cleanupExpired`, and restart/shared-instance persistence (two store
  instances over one backing DB).
- `src/middleware/sessionCookie.test.ts` — required attributes, production
  Secure enforcement, and the clear-cookie path.

Run them with:

```bash
npx jest src/lib/postgresSessionStore.test.ts \
         src/middleware/sessionCookie.test.ts \
         src/middleware/session.test.ts \
         src/db/repositories/sessionRepository.test.ts
```
