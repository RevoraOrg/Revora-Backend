# Idempotency Store Security Assumptions

## Overview

The idempotency middleware ensures that duplicate requests with the same idempotency key return the same response, preventing duplicate processing of operations like investments or payouts. This document outlines the security assumptions for both the in-memory and PostgreSQL-backed implementations.

## Threat Model

### Attack Vectors Prevented

1. **Duplicate Processing**
   - Prevents multiple instances of the same operation (e.g., double-charging a payment)
   - Ensures idempotency guarantees across multiple backend instances
   - Handles concurrent requests with the same idempotency key

2. **Race Conditions**
   - Row-level locking (SELECT ... FOR UPDATE) prevents concurrent duplicate processing
   - In-flight state prevents multiple instances from processing the same key simultaneously
   - Transaction rollback on errors prevents partial state corruption

3. **Stale Data Reuse**
   - TTL expiry enforcement prevents reuse of old cached responses
   - Expired records are filtered during checkAndReserve
   - Periodic cleanup prevents table bloat

## Security Assumptions

### InMemoryIdempotencyStore

- **Assumption**: Single-instance deployment
- **Risk**: Idempotency guarantees break across multiple instances or after restart
- **Mitigation**: Use PostgresIdempotencyStore for production multi-instance deployments
- **Limitation**: In-memory data is lost on restart

### PostgresIdempotencyStore

- **Assumption**: Database connection is secure and properly configured
- **Risk**: Database compromise could allow manipulation of idempotency records
- **Mitigation**: Use connection pooling, SSL/TLS, and proper database security practices
- **Coverage**: Row-level locking ensures atomic operations across instances

- **Assumption**: Row-level locking (SELECT ... FOR UPDATE) prevents race conditions
- **Risk**: Long-running transactions could cause lock contention
- **Mitigation**: Transactions are short-lived and rollback on errors
- **Limitation**: Database must support row-level locking (PostgreSQL does)

- **Assumption**: TTL expiry is enforced at query time
- **Risk**: Expired records may persist until cleanup runs
- **Mitigation**: Expired records are filtered during checkAndReserve regardless of cleanup
- **Recommendation**: Run periodic cleanup job to prevent table bloat

- **Assumption**: Database failures fail open to avoid blocking requests
- **Risk**: Temporary database outage could allow duplicate processing
- **Mitigation**: Monitor database health and implement circuit breakers
- **Trade-off**: Availability over consistency for idempotency

## Implementation Details

### Module: `src/middleware/idempotency.ts`

#### IdempotencyStore Interface

```typescript
export interface IdempotencyStore {
  checkAndReserve(key: string): Promise<IdempotencyCheckResult>;
  save(key: string, record: IdempotencyRecord): Promise<void>;
  release(key: string): Promise<void>;
}
```

#### PostgresIdempotencyStore

PostgreSQL-backed implementation with:
- Row-level locking for concurrent request safety
- TTL support with automatic expiry
- State machine: `inflight` → `completed` or `released`
- Fingerprint support for request payload validation

**checkAndReserve Implementation**:
1. Begin transaction
2. SELECT ... FOR UPDATE to lock the row
3. Filter expired records (expires_at < NOW())
4. Return appropriate state based on existing record
5. Insert/update in-flight entry if no valid record exists
6. Commit transaction

**save Implementation**:
- Updates record state to `completed`
- Stores response status, body, content type, and fingerprint
- Updates expires_at based on TTL

**release Implementation**:
- Updates record state to `released`
- Only affects records in `inflight` state
- Allows retry of failed requests

**cleanupExpired Implementation**:
- Deletes records where expires_at < NOW()
- Should be run periodically (e.g., via cron)
- Returns count of deleted records

### Database Schema

```sql
CREATE TABLE idempotency_keys (
  key TEXT PRIMARY KEY,
  response_status INTEGER NOT NULL,
  response_body TEXT NOT NULL,
  response_content_type TEXT,
  fingerprint TEXT,
  state TEXT NOT NULL DEFAULT 'inflight' CHECK (state IN ('inflight', 'completed', 'released')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ
);

CREATE INDEX idx_idempotency_keys_created_at
  ON idempotency_keys (created_at DESC);

CREATE INDEX idx_idempotency_keys_expires_at
  ON idempotency_keys (expires_at) WHERE expires_at IS NOT NULL;

CREATE INDEX idx_idempotency_keys_state
  ON idempotency_keys (state) WHERE state = 'inflight';
```

## Usage

### Using InMemoryIdempotencyStore (Single Instance)

```typescript
import { createIdempotencyMiddleware, InMemoryIdempotencyStore } from './middleware/idempotency';

const store = new InMemoryIdempotencyStore({ ttlMs: 3600000 }); // 1 hour TTL
const middleware = createIdempotencyMiddleware({ store });

app.use('/api/payments', middleware);
```

### Using PostgresIdempotencyStore (Multi-Instance)

```typescript
import { createIdempotencyMiddleware, PostgresIdempotencyStore } from './middleware/idempotency';
import { pool } from './db/pool';

const store = new PostgresIdempotencyStore({ 
  pool, 
  ttlMs: 3600000 // 1 hour TTL
});
const middleware = createIdempotencyMiddleware({ store });

app.use('/api/payments', middleware);
```

### Periodic Cleanup

```typescript
// Run cleanup periodically (e.g., every hour)
setInterval(async () => {
  const deletedCount = await store.cleanupExpired();
  console.log(`Cleaned up ${deletedCount} expired idempotency records`);
}, 3600000);
```

## Abuse/Failure Paths Handled

### Database Connection Failure
- **Action**: Fail open (return state: 'new')
- **Logging**: Error logged with context
- **Impact**: Temporary duplicate processing possible
- **Recovery**: Automatic when database recovers

### Concurrent Duplicate Requests
- **Action**: Serialize using row-level locking
- **Logging**: None (normal operation)
- **Impact**: First request proceeds, others wait or receive 409
- **Recovery**: Automatic when in-flight request completes

### Expired Records
- **Action**: Filter out during checkAndReserve
- **Logging**: None (normal operation)
- **Impact**: Old records not reused
- **Recovery**: Periodic cleanup removes expired records

### Transaction Rollback
- **Action**: Rollback on any error
- **Logging**: Error logged with context
- **Impact**: No partial state corruption
- **Recovery**: Request can be retried

### Long-Running Transactions
- **Action**: Timeout via connection pool settings
- **Logging**: Error logged with context
- **Impact**: Request fails open (state: 'new')
- **Recovery**: Request can be retried

## Testing

Comprehensive test coverage is provided in `src/middleware/idempotency.test.ts`:

- **Middleware tests**: Basic functionality, replay, concurrent requests
- **PostgresIdempotencyStore tests**: 15 test cases covering:
  - checkAndReserve (new, inflight, cached, released states)
  - TTL expiry enforcement
  - Concurrent request handling with row-level locking
  - Fingerprint storage and validation
  - Database error handling (fail open)
  - save operation with expires_at update
  - release operation for in-flight keys
  - cleanupExpired operation
  - Integration with middleware

## Recommendations

### Production Deployment

1. **Use PostgresIdempotencyStore**
   - Required for multi-instance deployments
   - Provides persistence across restarts
   - Ensures idempotency guarantees across instances

2. **Configure Appropriate TTL**
   - Balance between cache hit rate and data freshness
   - Typical values: 1-24 hours depending on use case
   - Shorter TTL for financial operations, longer for idempotent reads

3. **Monitor Database Performance**
   - Track query latency for idempotency operations
   - Monitor lock contention on idempotency_keys table
   - Set up alerts for database connection failures

4. **Run Periodic Cleanup**
   - Schedule cleanup job (e.g., hourly or daily)
   - Monitor table size and cleanup effectiveness
   - Consider partitioning by created_at for large deployments

5. **Handle Database Failures Gracefully**
   - Implement circuit breaker pattern
   - Log failures for monitoring
   - Consider fallback to in-memory store during outages

### Security Best Practices

1. **Database Security**
   - Use SSL/TLS for database connections
   - Implement least-privilege database users
   - Regularly rotate database credentials

2. **Idempotency Keys**
   - Use cryptographically random keys (UUID v4)
   - Never expose internal state in keys
   - Validate key format and length

3. **Response Caching**
   - Only cache non-sensitive responses
   - Consider redacting sensitive data from cached responses
   - Implement fingerprint validation for sensitive operations

4. **Monitoring**
   - Track idempotency hit/miss ratios
   - Monitor for unusual patterns (e.g., high inflight rate)
   - Alert on database errors affecting idempotency

## Migration from InMemoryIdempotencyStore

To migrate from InMemoryIdempotencyStore to PostgresIdempotencyStore:

1. **Run the migration**
   ```bash
   # Apply the idempotency_keys table migration
   psql -U postgres -d revora -f src/db/migrations/002_create_idempotency_keys.sql
   ```

2. **Update middleware configuration**
   ```typescript
   // Before
   const store = new InMemoryIdempotencyStore({ ttlMs: 3600000 });
   
   // After
   const store = new PostgresIdempotencyStore({ 
     pool, 
     ttlMs: 3600000 
   });
   ```

3. **Deploy with zero downtime**
   - Deploy new code with PostgresIdempotencyStore
   - In-memory data will be lost (acceptable for idempotency)
   - New requests will use PostgreSQL
   - Old in-flight requests will complete or timeout

4. **Monitor and verify**
   - Check that idempotency still works as expected
   - Monitor database performance
   - Verify cleanup job is working

## References

- [RFC 7231 - Idempotent Methods](https://tools.ietf.org/html/rfc7231#section-4.2.2)
- [PostgreSQL Row-Level Locking](https://www.postgresql.org/docs/current/explicit-locking.html)
- [OWASP Idempotency](https://owasp.org/www-community/controls/Idempotency)
