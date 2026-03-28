# Graceful Shutdown Completeness

## Overview
This document describes the implementation rationale, security assumptions, and abuse paths surrounding the **Graceful Shutdown** mechanism within the Revora-Backend.

A graceful shutdown is critical in a production Node.js/Express environment to prevent dropping active HTTP requests out of nowhere during scaling events, rolling restarts, or unplanned terminations (e.g., OOM killed pending). It ensures connections successfully drain before the process formally exits.

## Implementation Details
The process listens for `SIGTERM` and `SIGINT` signals. Upon receiving a termination signal, `src/index.ts` invokes the exported `shutdown(signal: string)` function, which executes the following steps:

1. **Timeout Initiation:** A hard timeout (default: 10 seconds) is spawned immediately (`setTimeout`). If the shutdown sequence exceeds this threshold, the node process forcefully exits with code `1`.
2. **HTTP Server Teardown:** `server.close()` is called. This stops the server from accepting any *new* connections while waiting for currently active requests to complete and respond.
3. **Downstream Connections Closed:** We call `closePool()` closing the PostgreSQL client connection safely. If active DB transactions are ongoing, `pg` gracefully allows them to clear unless the 10-second timeout disrupts them.
4. **Clean Exit:** Once both the server and database pool close cleanly, `process.exit(0)` is invoked explicitly.

## Abuse and Failure Paths (Security Assumptions)
- **Hanging Active Requests (Zombie Processes):** If an active HTTP request or DB transaction hangs indefinitely (e.g., due to a slow network or deadlocks), the server will refuse to shut down organically. The 10-second timeout acts as a deterministic circuit breaker preventing the compute node from persisting in an ephemeral, un-routable zombie state.
- **DDoS During Shutdown:** Because `server.close()` stops accepting *new* connections synchronously upon receiving a termination signal, the node is immediately removed from the active routing pool regardless of inbound bot traffic. 
- **DB Connection Failure:** If `closePool()` rejects or throws an unexpected error, the `catch` block traps the exception and forcefully terminates the application (`process.exit(1)`). Relying on process manager restarts if necessary.

## Test Coverage
The shutdown implementation relies on deterministic tests residing in `src/routes/health.test.ts` mocking `process.exit`, `dbHealth/closePool`, and hijacking timers (`jest.useFakeTimers()`) to validate 95%+ coverage across success and failure branches, including explicit timeout assertions.
