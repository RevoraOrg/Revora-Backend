# Session Expiry Cleanup

> **Branch:** `feature/backend-039-session-expiry-cleanup`  
> **Scope:** `RevoraOrg/Revora-Backend`

---

## Overview

The session expiry cleanup system provides server-side session lifecycle management for the Revora backend. Sessions are created on login, validated on every protected request, and expired automatically — both lazily on access and proactively via a background sweep.

```
Client                    Revora Backend              SessionStore
  │                            │                           │
  │  POST /session/login       │                           │
  │ ─────────────────────────► │  store.create(userId)     │
  │                            │ ─────────────────────────►│
  │  { token, expiresAt }      │                           │
  │ ◄───────────────────────── │                           │
  │                            │                           │
  │  GET /protected            │                           │
  │  Authorization: Bearer ... │  store.get(token)         │
  │ ─────────────────────────► │ ─────────────────────────►│
  │                            │  session / null           │
  │  200 OK  /  401            │ ◄──────────────────────── │
  │ ◄───────────────────────── │                           │
  │                            │                           │
  │  POST /session/logout      │  store.delete(token)      │
  │ ─────────────────────────► │ ─────────────────────────►│
  │  204 No Content            │                           │
  │ ◄───────────────────────── │                           │
  │                            │                           │
  │                   [background sweep every 5 min]       │
  │                            │  store.sweep()            │
  │                            │ ─────────────────────────►│
  │                            │  N expired evicted        │
  │                            │ ◄──────────────────────── │
```

---

## Architecture

### Files

| File | Role |
|---|---|
| `src/session/SessionStore.ts` | Core session registry — create, get, delete, touch, sweep |
| `src/middleware/session.ts` | Express middleware factory + session route handlers |
| `src/index.ts` | Wires the store and routes into the app; starts the sweep on boot |
| `src/routes/health.test.ts` | Unit + integration test suite |

### Two-layer expiry strategy

Sessions are expired through two complementary paths so that neither alone is a single point of failure:

**Lazy expiry (on read)** — `store.get()` checks the TTL of every session it retrieves. An expired session is deleted immediately and `null` is returned to the caller. This means a session is never used after its TTL regardless of whether the background sweep has run.

**Background sweep (proactive)** — `SessionStore.startSweep()` starts a `setInterval` timer (default: every 5 minutes) that iterates all stored sessions and evicts any that have passed their TTL. This prevents unbounded memory growth from sessions that are never read again after expiry.

The timer is created with `.unref()` so it does not prevent the Node.js process from exiting cleanly.

---

## API Reference

### `SessionStore`

```ts
import { SessionStore, sessionStore } from "./session/SessionStore";

// Use the singleton
sessionStore.startSweep();

// Or create an isolated instance (useful in tests)
const store = new SessionStore({ ttlMs: 3_600_000, sweepIntervalMs: 300_000 });
```

| Method | Description |
|---|---|
| `create(userId, role)` | Creates a session, returns the full `Session` object including the opaque token |
| `get(token)` | Returns the session or `null` (expired = `null`, indistinguishable from unknown) |
| `touch(token)` | Extends TTL by `ttlMs` from now; returns `false` if expired or unknown |
| `delete(token)` | Explicitly invalidates a session; idempotent |
| `sweep()` | Synchronous sweep — evicts all expired sessions; returns count evicted |
| `startSweep()` | Starts the background timer; safe to call multiple times |
| `stop()` | Stops the timer and clears all sessions; call during graceful shutdown |
| `stats()` | Returns `{ activeSessions, expiredCleaned, totalCreated }` |

### HTTP Endpoints

#### `POST /api/v1/session/login`

Exchange credentials for a session token.

**Request headers:**
```
x-user-id:   <userId>
x-user-role: <role>
```

**Response `201`:**
```json
{ "token": "a3f8...", "expiresAt": "2025-06-01T12:00:00.000Z" }
```

**Response `401`:** Missing headers.

---

#### `POST /api/v1/session/logout`

Invalidate the current session.

**Request headers:**
```
Authorization: Bearer <token>
```

**Response `204`:** Session deleted. Token replay will return 401.

---

#### `GET /api/v1/session/me`

Return the current session's user context.

**Response `200`:**
```json
{ "userId": "user-1", "role": "admin" }
```

---

#### `GET /api/v1/session/stats`

Return session store metrics. No authentication required.

**Response `200`:**
```json
{
  "activeSessions": 14,
  "expiredCleaned": 302,
  "totalCreated":   316
}
```

---

#### `GET /health`

The existing health endpoint now includes session metrics.

**Response `200`:**
```json
{
  "status":  "ok",
  "service": "revora-backend",
  "db":      { "healthy": true },
  "session": { "activeSessions": 14, "expiredCleaned": 302, "totalCreated": 316 }
}
```

---

## Configuration

| Environment variable | Default | Description |
|---|---|---|
| `SESSION_TTL_MS` | `3600000` (1 hour) | Session lifetime in milliseconds |
| `SESSION_SWEEP_MS` | `300000` (5 minutes) | Background sweep interval |

Pass values to `SessionStore` constructor or read from env in `index.ts`.

---

## Security Notes

### Threat model

| Threat | Mitigation |
|---|---|
| Token forgery | Tokens are 128-bit random hex values (`crypto.randomBytes(16)`) — not guessable, not based on user input |
| Token replay after logout | `store.delete()` is called synchronously before the 204 response; any subsequent request with the same token returns 401 |
| Session fixation | The server always generates the token — the client cannot supply or influence it |
| Expired session use | Both lazy expiry (on read) and the background sweep ensure expired sessions are never returned |
| Information leakage | 401 responses for unknown and expired tokens are identical — no observable difference for an attacker |
| Header spoofing | `req.user` is populated exclusively from the server-side session record, never from request headers after login |
| Memory exhaustion | Background sweep + lazy eviction bound memory to `O(peak concurrent active sessions)` |

### What is NOT covered here

- Persistent session storage (Redis / Postgres) — the current store is in-memory and does not survive restarts.
- Multi-instance synchronisation — sessions are local to one process; a load balancer must use sticky sessions or a shared store.
- Credential verification — the login endpoint accepts any non-empty `x-user-id` / `x-user-role` headers as stand-in credentials. Replace with real auth (password hash, OAuth, etc.) before production use.
- Rate limiting on `/session/login` — add a rate-limiter middleware to prevent brute-force enumeration.

---

## Running Tests

```bash
npm test src/routes/health.test.ts   # targeted
npm test                              # full suite
npm run test:coverage                 # with coverage report
```

Expected output summary:

```
SessionStore
  create()      ✓ token format, unique tokens, counter
  get()         ✓ valid session, unknown token, lazy expiry
  delete()      ✓ removes session, idempotent
  touch()       ✓ extends TTL, rejects expired, rejects unknown
  sweep()       ✓ evicts expired, leaves live, partial sweep
  stats()       ✓ full lifecycle counts
  stop()        ✓ clears sessions, no throw on double-stop

Session middleware and routes
  POST /session/login     ✓ 201 with token, 401 missing id, 401 missing role
  GET  /protected         ✓ valid token, missing header, invalid token, expired
  POST /session/logout    ✓ 204 + replay rejected, 401 without token
  GET  /health            ✓ includes session stats, reflects sweep
  Security                ✓ lowercase bearer rejected, no leak, header bypass rejected
```