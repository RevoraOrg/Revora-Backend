# Refresh Token Replay Detection & Session Family Revocation

## Overview

Revora Backend enforces single-use refresh token rotation with cryptographic binding, consumption tracking, and immediate session family revocation upon replay or reuse detection.

## Architecture

When an authenticated client rotates its refresh token via `POST /api/auth/refresh`:
1. **Stateless verification**: The refresh token signature and payload (`userId`, `sessionId`, `role`) are validated outside the transaction.
2. **Atomic transaction**:
   - The session row is locked via `SELECT ... FOR UPDATE` using `findSessionByIdForUpdate`.
   - The token hash is verified (`token_hash === hashToken(token)`).
   - If the token was already consumed (`token_consumed_at` set), already revoked (`revoked_at` set), has a child session (`findSessionByParentId`), or token hash mismatches, the entire session family (lineage) is revoked in a single recursive CTE update (`revokeSessionAndDescendants`).
   - If valid, the parent session is marked as consumed (`setSessionConsumed`), and a new child session is inserted (`createSession` with `parent_id`).
3. **Concurrent Request Deduplication**:
   - In-flight refresh requests for the same `sessionId` within the process are tracked in an `inFlightSessions` Set, ensuring racing duplicate calls receive `null` without falsely revoking the winner.

## Security Model & Invariants

- **Single-use tokens**: Each refresh token is strictly single-use.
- **Family revocation**: Replaying any consumed ancestor revokes the ancestor and all descendants ($N \to N+1 \to \dots \to N+k$).
- **No token leakage**: Raw refresh tokens are never logged or stored in plaintext; only secure hashes are stored.
- **Lineage depth**: Recursive CTE revocation works across any lineage length (tested with $>10$ rotations).

## Test Coverage

- `src/auth/refresh/refreshService.test.ts`:
  - Valid rotation ($N \to N+1 \to N+2$)
  - Ancestor/grandparent replay triggering full descendant family revocation
  - Deep lineage revocation ($>10$ descendants)
  - Concurrent same-session rotation deduplication
  - Expired and revoked parent session handling
  - Token hash mismatch handling
  - Safe error recovery and log hygiene (no raw token leakage)
- `src/auth/refresh/repositoryAdapter.test.ts`:
  - Delegation of all repository methods to `SessionRepository`
- `src/auth/refresh/refreshHandler.test.ts`:
  - Route and HTTP handler status codes (200, 400, 401, 500)
- `src/db/repositories/sessionRepository.test.ts`:
  - Recursive CTE revocation, lock-for-update, consumption timestamps, parent-child queries.
