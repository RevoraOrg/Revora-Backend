# Indexer Health Endpoint - Deployment Guide

## Overview

This guide provides comprehensive instructions for deploying the enhanced indexer health endpoint feature. The endpoint exposes real-time health metrics including ledger synchronization status, indexed event counts, uptime tracking, and degradation detection.

**Feature:** Indexer Health Endpoint Enhancement  
**Endpoint:** `GET /health`  
**Status Codes:** 200 (healthy), 503 (degraded)

## Prerequisites

Before deploying this feature, ensure:

1. PostgreSQL database is accessible
2. Stellar RPC endpoint is available
3. Node.js 18+ is installed
4. Docker (optional, for containerized deployment)

## Required Environment Variables

### Core Configuration

```bash
# Database connection (REQUIRED)
DATABASE_URL="postgresql://user:password@host:5432/revora"

# Stellar RPC endpoint (REQUIRED)
STELLAR_RPC_URL="https://soroban-testnet.stellar.org"
# Production: https://soroban-mainnet.stellar.org

# Application port (OPTIONAL, default: 3000)
PORT=3000

# Node environment (OPTIONAL, default: development)
NODE_ENV=production
```

### Health Endpoint Configuration

```bash
# Health lag threshold in ledgers (OPTIONAL, default: 100)
# The indexer is marked "degraded" when lag exceeds this value
HEALTH_LAG_THRESHOLD=100
```

### Environment Variable Details

| Variable               | Required | Default                               | Description                                          |
| ---------------------- | -------- | ------------------------------------- | ---------------------------------------------------- |
| `DATABASE_URL`         | Yes      | None                                  | PostgreSQL connection string                         |
| `STELLAR_RPC_URL`      | Yes      | `https://soroban-testnet.stellar.org` | Stellar Soroban RPC endpoint                         |
| `PORT`                 | No       | `3000`                                | HTTP server port                                     |
| `NODE_ENV`             | No       | `development`                         | Runtime environment (development/production)         |
| `HEALTH_LAG_THRESHOLD` | No       | `100`                                 | Maximum acceptable ledger lag before degraded status |
| `JWT_SECRET`           | Yes      | None                                  | JWT signing secret (for authenticated endpoints)     |

### Configuration Examples

**Development:**

```bash
DATABASE_URL="postgresql://localhost:5432/revora_dev"
STELLAR_RPC_URL="https://soroban-testnet.stellar.org"
HEALTH_LAG_THRESHOLD=50
NODE_ENV=development
```

**Production:**

```bash
DATABASE_URL="postgresql://prod-db.example.com:5432/revora"
STELLAR_RPC_URL="https://soroban-mainnet.stellar.org"
HEALTH_LAG_THRESHOLD=100
NODE_ENV=production
JWT_SECRET="your-secure-secret-key-min-32-chars"
```

## Database Migration Steps

### Step 1: Verify Database Connection

Test your database connection before running migrations:

```bash
# Using psql
psql "$DATABASE_URL" -c "SELECT version();"

# Expected output: PostgreSQL version information
```

### Step 2: Run Database Migrations

Execute the migration to create required tables:

```bash
# Set DATABASE_URL if not already in environment
export DATABASE_URL="postgresql://user:password@host:5432/revora"

# Run migrations
npm run migrate
```

**Expected Output:**

```
Connecting to database...
Connected successfully
Checking for pending migrations...
Applying migration: 012_create_indexer_tables.sql
Migration 012_create_indexer_tables.sql applied successfully
All migrations completed
```

### Step 3: Verify Migration Success

Confirm all required tables were created:

```sql
-- Connect to database
psql "$DATABASE_URL"

-- Check tables exist
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN ('indexer_state', 'proposals', 'votes', 'delegates');

-- Expected output: 4 rows showing all tables

-- Verify indexer_state initialization
SELECT * FROM indexer_state;

-- Expected output: One row with last_indexed_ledger = 0
```

### Step 4: Verify Table Structure

Confirm table schemas match requirements:

```sql
-- Check indexer_state structure
\d indexer_state

-- Expected columns:
-- id (SERIAL PRIMARY KEY)
-- last_indexed_ledger (BIGINT NOT NULL)
-- updated_at (TIMESTAMPTZ NOT NULL)

-- Check proposals structure
\d proposals

-- Check votes structure
\d votes

-- Check delegates structure
\d delegates
```

## Deployment Procedures

### Local Development Deployment

1. **Install dependencies:**

   ```bash
   npm install
   ```

2. **Configure environment:**

   ```bash
   cp .env.example .env
   # Edit .env with your configuration
   ```

3. **Run migrations:**

   ```bash
   npm run migrate
   ```

4. **Start development server:**

   ```bash
   npm run dev
   ```

5. **Verify health endpoint:**
   ```bash
   curl http://localhost:3000/health
   ```

### Production Deployment (Node.js)

1. **Build application:**

   ```bash
   npm ci --only=production
   npm run build
   ```

2. **Set production environment variables:**

   ```bash
   export NODE_ENV=production
   export DATABASE_URL="postgresql://prod-host:5432/revora"
   export STELLAR_RPC_URL="https://soroban-mainnet.stellar.org"
   export HEALTH_LAG_THRESHOLD=100
   export JWT_SECRET="your-secure-secret"
   export PORT=3000
   ```

3. **Run migrations:**

   ```bash
   npm run migrate
   ```

4. **Start application:**

   ```bash
   npm start
   ```

5. **Verify deployment:**
   ```bash
   curl http://localhost:3000/health
   ```

### Docker Deployment

The Dockerfile includes built-in health check configuration.

1. **Build Docker image:**

   ```bash
   docker build -t revora-backend:latest .
   ```

2. **Run container:**

   ```bash
   docker run -d \
     --name revora-backend \
     -p 3000:3000 \
     -e DATABASE_URL="postgresql://host.docker.internal:5432/revora" \
     -e STELLAR_RPC_URL="https://soroban-mainnet.stellar.org" \
     -e HEALTH_LAG_THRESHOLD=100 \
     -e JWT_SECRET="your-secure-secret" \
     -e NODE_ENV=production \
     revora-backend:latest
   ```

3. **Check container health:**

   ```bash
   docker ps
   # Look for "healthy" status in the STATUS column

   docker inspect --format='{{.State.Health.Status}}' revora-backend
   # Expected: "healthy"
   ```

4. **View health check logs:**
   ```bash
   docker inspect --format='{{json .State.Health}}' revora-backend | jq
   ```

### Docker Health Check Configuration

The Dockerfile includes the following health check (already configured):

```dockerfile
HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=10s \
  CMD curl -f http://localhost:3000/health || exit 1
```

**Parameters:**

- `interval=30s`: Check every 30 seconds
- `timeout=5s`: Fail if check takes longer than 5 seconds
- `retries=3`: Mark unhealthy after 3 consecutive failures
- `start-period=10s`: Grace period during container startup

### Kubernetes Deployment

Example Kubernetes deployment with health probes:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: revora-backend
spec:
  replicas: 3
  selector:
    matchLabels:
      app: revora-backend
  template:
    metadata:
      labels:
        app: revora-backend
    spec:
      containers:
        - name: revora-backend
          image: revora-backend:latest
          ports:
            - containerPort: 3000
          env:
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: revora-secrets
                  key: database-url
            - name: STELLAR_RPC_URL
              value: "https://soroban-mainnet.stellar.org"
            - name: HEALTH_LAG_THRESHOLD
              value: "100"
            - name: JWT_SECRET
              valueFrom:
                secretKeyRef:
                  name: revora-secrets
                  key: jwt-secret
            - name: NODE_ENV
              value: "production"

          # Liveness probe - restart if unhealthy
          livenessProbe:
            httpGet:
              path: /health
              port: 3000
            initialDelaySeconds: 10
            periodSeconds: 30
            timeoutSeconds: 5
            failureThreshold: 3

          # Readiness probe - remove from load balancer if not ready
          readinessProbe:
            httpGet:
              path: /health
              port: 3000
            initialDelaySeconds: 5
            periodSeconds: 10
            timeoutSeconds: 5
            failureThreshold: 2

          resources:
            requests:
              memory: "256Mi"
              cpu: "250m"
            limits:
              memory: "512Mi"
              cpu: "500m"
```

## Monitoring Integration Examples

### Prometheus Metrics Scraping

Configure Prometheus to scrape health endpoint metrics:

```yaml
# prometheus.yml
scrape_configs:
  - job_name: "revora-backend"
    scrape_interval: 30s
    metrics_path: "/health"
    static_configs:
      - targets: ["revora-backend:3000"]
    metric_relabel_configs:
      - source_labels: [__name__]
        target_label: service
        replacement: "revora-indexer"
```

**Custom Prometheus Exporter Script:**

```javascript
// prometheus-exporter.js
const express = require("express");
const axios = require("axios");

const app = express();
const HEALTH_URL = process.env.HEALTH_URL || "http://localhost:3000/health";

app.get("/metrics", async (req, res) => {
  try {
    const response = await axios.get(HEALTH_URL);
    const health = response.data;

    const metrics = `
# HELP indexer_lag_ledgers Number of ledgers behind network tip
# TYPE indexer_lag_ledgers gauge
indexer_lag_ledgers ${health.lag_ledgers}

# HELP indexer_lag_seconds Seconds behind network tip
# TYPE indexer_lag_seconds gauge
indexer_lag_seconds ${health.lag_seconds}

# HELP indexer_proposals_total Total proposals indexed
# TYPE indexer_proposals_total counter
indexer_proposals_total ${health.total_proposals_indexed}

# HELP indexer_votes_total Total votes indexed
# TYPE indexer_votes_total counter
indexer_votes_total ${health.total_votes_indexed}

# HELP indexer_delegates_total Total delegates indexed
# TYPE indexer_delegates_total counter
indexer_delegates_total ${health.total_delegates_indexed}

# HELP indexer_uptime_seconds Indexer uptime in seconds
# TYPE indexer_uptime_seconds gauge
indexer_uptime_seconds ${health.uptime_seconds}

# HELP indexer_status Indexer status (1=ok, 0=degraded)
# TYPE indexer_status gauge
indexer_status ${health.status === "ok" ? 1 : 0}
    `.trim();

    res.set("Content-Type", "text/plain");
    res.send(metrics);
  } catch (error) {
    res.status(503).send("# Health endpoint unavailable\n");
  }
});

app.listen(9090, () => console.log("Prometheus exporter on :9090"));
```

### Datadog Integration

Monitor health endpoint with Datadog:

```yaml
# datadog-agent.yaml
init_config:

instances:
  - url: http://revora-backend:3000/health
    name: revora_indexer
    timeout: 5

    # Parse JSON response
    json_path:
      - lag_ledgers: "lag_ledgers"
      - lag_seconds: "lag_seconds"
      - proposals: "total_proposals_indexed"
      - votes: "total_votes_indexed"
      - delegates: "total_delegates_indexed"
      - uptime: "uptime_seconds"

    # Alert on degraded status
    tags:
      - service:revora-indexer
      - env:production
```

**Datadog Alert Configuration:**

```json
{
  "name": "Indexer Health Degraded",
  "type": "metric alert",
  "query": "avg(last_5m):avg:revora.indexer.lag_ledgers{*} > 100",
  "message": "Indexer has fallen behind by {{value}} ledgers. @pagerduty",
  "tags": ["service:revora-indexer"],
  "options": {
    "thresholds": {
      "critical": 100,
      "warning": 50
    },
    "notify_no_data": true,
    "no_data_timeframe": 10
  }
}
```

### Grafana Dashboard

Example Grafana dashboard JSON:

```json
{
  "dashboard": {
    "title": "Revora Indexer Health",
    "panels": [
      {
        "title": "Ledger Lag",
        "targets": [
          {
            "expr": "indexer_lag_ledgers",
            "legendFormat": "Lag (ledgers)"
          }
        ],
        "type": "graph"
      },
      {
        "title": "Indexer Status",
        "targets": [
          {
            "expr": "indexer_status",
            "legendFormat": "Status (1=ok, 0=degraded)"
          }
        ],
        "type": "stat"
      },
      {
        "title": "Event Counts",
        "targets": [
          {
            "expr": "indexer_proposals_total",
            "legendFormat": "Proposals"
          },
          {
            "expr": "indexer_votes_total",
            "legendFormat": "Votes"
          },
          {
            "expr": "indexer_delegates_total",
            "legendFormat": "Delegates"
          }
        ],
        "type": "graph"
      }
    ]
  }
}
```

### PagerDuty Integration

Configure PagerDuty alerts for health endpoint:

```bash
# Health check script for PagerDuty
#!/bin/bash
HEALTH_URL="http://revora-backend:3000/health"
PAGERDUTY_KEY="your-integration-key"

response=$(curl -s -w "\n%{http_code}" "$HEALTH_URL")
http_code=$(echo "$response" | tail -n1)
body=$(echo "$response" | head -n-1)

if [ "$http_code" != "200" ]; then
  # Trigger PagerDuty incident
  curl -X POST https://events.pagerduty.com/v2/enqueue \
    -H 'Content-Type: application/json' \
    -d "{
      \"routing_key\": \"$PAGERDUTY_KEY\",
      \"event_action\": \"trigger\",
      \"payload\": {
        \"summary\": \"Revora Indexer Health Degraded\",
        \"severity\": \"error\",
        \"source\": \"revora-indexer\",
        \"custom_details\": $body
      }
    }"
fi
```

### Simple Uptime Monitoring

Basic monitoring script for cron:

```bash
#!/bin/bash
# /usr/local/bin/check-indexer-health.sh

HEALTH_URL="http://localhost:3000/health"
ALERT_EMAIL="ops@example.com"
LOG_FILE="/var/log/indexer-health.log"

response=$(curl -s -w "\n%{http_code}" "$HEALTH_URL")
http_code=$(echo "$response" | tail -n1)
body=$(echo "$response" | head -n-1)

timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

if [ "$http_code" = "200" ]; then
  echo "$timestamp [OK] Indexer healthy" >> "$LOG_FILE"
else
  echo "$timestamp [DEGRADED] HTTP $http_code: $body" >> "$LOG_FILE"

  # Send alert email
  echo "Indexer health check failed at $timestamp" | \
    mail -s "ALERT: Indexer Health Degraded" "$ALERT_EMAIL"
fi
```

**Cron configuration:**

```cron
# Check health every 5 minutes
*/5 * * * * /usr/local/bin/check-indexer-health.sh
```

## Rollback Procedures

### Emergency Rollback (Application Level)

If the health endpoint causes issues, rollback to previous version:

1. **Stop current application:**

   ```bash
   # For systemd
   sudo systemctl stop revora-backend

   # For Docker
   docker stop revora-backend

   # For Kubernetes
   kubectl rollout undo deployment/revora-backend
   ```

2. **Deploy previous version:**

   ```bash
   # Git rollback
   git checkout <previous-commit-hash>
   npm ci
   npm run build
   npm start

   # Docker rollback
   docker run -d revora-backend:<previous-tag>

   # Kubernetes rollback
   kubectl rollout undo deployment/revora-backend
   ```

3. **Verify rollback:**
   ```bash
   curl http://localhost:3000/health
   # Should return previous health endpoint behavior
   ```

### Database Rollback

If you need to rollback the database migration:

**WARNING:** This will delete all indexed data. Only perform with proper backups.

```sql
-- Connect to database
psql "$DATABASE_URL"

-- Drop tables in reverse dependency order
DROP TABLE IF EXISTS delegates CASCADE;
DROP TABLE IF EXISTS votes CASCADE;
DROP TABLE IF EXISTS proposals CASCADE;
DROP TABLE IF EXISTS indexer_state CASCADE;

-- Remove migration record
DELETE FROM schema_version WHERE version = '012_create_indexer_tables.sql';
```

**Restore from backup (recommended):**

```bash
# Restore database from backup
pg_restore -d revora -c backup.dump

# Or restore specific tables
pg_restore -d revora -t indexer_state -t proposals -t votes -t delegates backup.dump
```

### Partial Rollback (Disable Health Checks Only)

If you want to keep the application but disable health checks:

**Docker:**

```bash
# Remove health check from running container (requires restart)
docker run -d \
  --name revora-backend \
  --no-healthcheck \
  -p 3000:3000 \
  -e DATABASE_URL="..." \
  revora-backend:latest
```

**Kubernetes:**

```yaml
# Remove health probes from deployment
apiVersion: apps/v1
kind: Deployment
metadata:
  name: revora-backend
spec:
  template:
    spec:
      containers:
        - name: revora-backend
          # Comment out or remove livenessProbe and readinessProbe
          # livenessProbe: ...
          # readinessProbe: ...
```

### Rollback Verification Checklist

After rollback, verify:

- [ ] Application starts successfully
- [ ] Database connections work
- [ ] Existing endpoints respond correctly
- [ ] No error logs related to health endpoint
- [ ] Monitoring systems updated (if health endpoint was integrated)
- [ ] Load balancers/orchestrators updated (if using health checks)

## Troubleshooting

### Common Issues

#### Issue: Health endpoint returns 503 with "RPC client unavailable"

**Cause:** Cannot connect to Stellar RPC endpoint

**Solution:**

```bash
# Verify STELLAR_RPC_URL is set
echo $STELLAR_RPC_URL

# Test RPC endpoint manually
curl -X POST "$STELLAR_RPC_URL" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"getLatestLedger"}'

# Check network connectivity
ping soroban-testnet.stellar.org

# Update to working RPC endpoint
export STELLAR_RPC_URL="https://soroban-testnet.stellar.org"
```

#### Issue: Health endpoint returns 503 with "Database query failed"

**Cause:** Cannot connect to PostgreSQL database

**Solution:**

```bash
# Verify DATABASE_URL is set
echo $DATABASE_URL

# Test database connection
psql "$DATABASE_URL" -c "SELECT 1;"

# Check if tables exist
psql "$DATABASE_URL" -c "\dt"

# Run migrations if tables missing
npm run migrate

# Check database logs for connection errors
# PostgreSQL logs location varies by installation
tail -f /var/log/postgresql/postgresql-*.log
```

#### Issue: Health endpoint shows high lag_ledgers

**Cause:** Indexer is behind network tip

**Solution:**

```bash
# Check if indexer process is running
ps aux | grep indexer

# Check indexer logs for errors
tail -f /var/log/indexer.log

# Verify last_indexed_ledger is updating
psql "$DATABASE_URL" -c "SELECT * FROM indexer_state;"

# Wait a few minutes and check again
# If not updating, restart indexer process
```

#### Issue: Health endpoint timeout (no response)

**Cause:** Queries taking longer than 5 seconds

**Solution:**

```bash
# Check database query performance
psql "$DATABASE_URL" -c "EXPLAIN ANALYZE SELECT COUNT(*) FROM proposals;"

# Check for missing indexes
psql "$DATABASE_URL" -c "\d proposals"

# Check database connection pool
# Look for connection exhaustion in logs

# Increase timeout (if appropriate)
# Note: Default 5s timeout is by design for container orchestration
```

#### Issue: HEALTH_LAG_THRESHOLD not being respected

**Cause:** Environment variable not set or invalid value

**Solution:**

```bash
# Check current value
echo $HEALTH_LAG_THRESHOLD

# Set valid value (must be positive integer)
export HEALTH_LAG_THRESHOLD=100

# Restart application
npm start

# Verify in logs
# Application should log: "Health lag threshold: 100"
```

#### Issue: Docker health check always failing

**Cause:** Container networking or curl not available

**Solution:**

```bash
# Check if curl is installed in container
docker exec revora-backend which curl

# Test health endpoint from inside container
docker exec revora-backend curl -f http://localhost:3000/health

# Check container logs
docker logs revora-backend

# Verify port mapping
docker port revora-backend

# Test from host
curl http://localhost:3000/health
```

### Debug Mode

Enable detailed logging for troubleshooting:

```bash
# Set log level to debug
export LOG_LEVEL=DEBUG
export NODE_ENV=development

# Restart application
npm start

# Health endpoint will log detailed information:
# - RPC client requests/responses
# - Database query execution times
# - Lag calculation details
# - Status determination logic
```

## Verification and Testing

### Post-Deployment Verification

After deployment, verify the health endpoint is working correctly:

```bash
# 1. Test basic connectivity
curl -i http://localhost:3000/health

# Expected: HTTP 200 or 503 with JSON response

# 2. Verify response structure
curl -s http://localhost:3000/health | jq

# Expected output:
# {
#   "status": "ok",
#   "last_indexed_ledger": 12345,
#   "current_ledger": 12350,
#   "lag_ledgers": 5,
#   "lag_seconds": 25,
#   "total_proposals_indexed": 10,
#   "total_votes_indexed": 50,
#   "total_delegates_indexed": 5,
#   "uptime_seconds": 3600,
#   "timestamp": "2024-01-15T10:30:00.000Z"
# }

# 3. Verify status determination
# If lag_ledgers > HEALTH_LAG_THRESHOLD, status should be "degraded"
curl -s http://localhost:3000/health | jq '.status'

# 4. Verify HTTP status codes
curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/health
# Expected: 200 (ok) or 503 (degraded)

# 5. Test response time
time curl -s http://localhost:3000/health > /dev/null
# Expected: < 5 seconds
```

### Load Testing

Test health endpoint under load:

```bash
# Using Apache Bench
ab -n 1000 -c 10 http://localhost:3000/health

# Expected results:
# - All requests succeed (200 or 503)
# - Average response time < 1 second
# - No connection errors

# Using wrk
wrk -t4 -c100 -d30s http://localhost:3000/health

# Monitor during load test
watch -n 1 'curl -s http://localhost:3000/health | jq ".uptime_seconds, .lag_ledgers"'
```

### Integration Testing

Test health endpoint integration with monitoring systems:

```bash
# Test Prometheus scraping
curl -s http://localhost:9090/metrics | grep indexer

# Test Datadog agent
datadog-agent status | grep revora

# Test Kubernetes probes
kubectl describe pod <pod-name> | grep -A 5 "Liveness\|Readiness"

# Test Docker health check
docker inspect --format='{{json .State.Health}}' revora-backend | jq
```

## Security Considerations

### Network Security

1. **Firewall Rules:**

   ```bash
   # Allow health endpoint from monitoring systems only
   iptables -A INPUT -p tcp --dport 3000 -s 10.0.0.0/8 -j ACCEPT
   iptables -A INPUT -p tcp --dport 3000 -j DROP
   ```

2. **TLS/HTTPS:**
   ```bash
   # Use reverse proxy (nginx/traefik) for TLS termination
   # Health endpoint itself does not require authentication
   ```

### Data Security

1. **No Sensitive Data:** Health endpoint exposes only operational metrics
2. **No PII:** All data is derived from public blockchain events
3. **Error Sanitization:** Error messages do not expose internal details
4. **Read-Only:** Health endpoint performs only SELECT queries

### Access Control

The health endpoint is intentionally **unauthenticated** for:

- Container orchestration (Docker, Kubernetes)
- Load balancers
- Monitoring systems

If you need to restrict access:

```typescript
// Add IP whitelist middleware (optional)
import { Request, Response, NextFunction } from "express";

const ALLOWED_IPS = ["10.0.0.0/8", "172.16.0.0/12"];

function healthAuthMiddleware(req: Request, res: Response, next: NextFunction) {
  const clientIp = req.ip;

  if (isIpAllowed(clientIp, ALLOWED_IPS)) {
    next();
  } else {
    res.status(403).json({ error: "Forbidden" });
  }
}

// Apply to health route
app.get("/health", healthAuthMiddleware, healthHandler);
```

## Performance Optimization

### Database Query Optimization

The health endpoint executes multiple queries. Optimize for performance:

```sql
-- Add indexes for faster COUNT queries (if not already present)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_proposals_indexed_at
  ON proposals(indexed_at);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_votes_indexed_at
  ON votes(indexed_at);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_delegates_indexed_at
  ON delegates(indexed_at);

-- Analyze tables for query planner
ANALYZE indexer_state;
ANALYZE proposals;
ANALYZE votes;
ANALYZE delegates;

-- Monitor query performance
SELECT query, mean_exec_time, calls
FROM pg_stat_statements
WHERE query LIKE '%COUNT%'
ORDER BY mean_exec_time DESC;
```

### Connection Pooling

Ensure database connection pool is properly configured:

```typescript
// src/db/pool.ts
import { Pool } from "pg";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20, // Maximum pool size
  idleTimeoutMillis: 30000, // Close idle connections after 30s
  connectionTimeoutMillis: 5000, // Fail fast if no connection available
});

export default pool;
```

### Caching Considerations

**Do NOT cache health endpoint responses** because:

- Health data must reflect real-time state
- Caching defeats the purpose of health monitoring
- Container orchestrators expect fresh data

However, you can optimize internal queries:

```typescript
// Cache RPC client instance (not responses)
let rpcClientInstance: StellarRpcClient | null = null;

function getRpcClient(): StellarRpcClient {
  if (!rpcClientInstance) {
    rpcClientInstance = new StellarRpcClientImpl({
      serverUrl: process.env.STELLAR_RPC_URL,
      timeout: 5000,
    });
  }
  return rpcClientInstance;
}
```

## Maintenance and Operations

### Regular Maintenance Tasks

1. **Monitor Table Growth:**

   ```sql
   -- Check table sizes weekly
   SELECT
     schemaname,
     tablename,
     pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) AS size,
     pg_total_relation_size(schemaname||'.'||tablename) AS bytes
   FROM pg_tables
   WHERE tablename IN ('indexer_state', 'proposals', 'votes', 'delegates')
   ORDER BY bytes DESC;
   ```

2. **Vacuum Tables:**

   ```sql
   -- Run monthly or when tables grow significantly
   VACUUM ANALYZE indexer_state;
   VACUUM ANALYZE proposals;
   VACUUM ANALYZE votes;
   VACUUM ANALYZE delegates;
   ```

3. **Monitor Health Endpoint Performance:**
   ```bash
   # Track response times
   while true; do
     time curl -s http://localhost:3000/health > /dev/null
     sleep 60
   done
   ```

### Backup Procedures

Backup indexer data regularly:

```bash
# Full database backup
pg_dump "$DATABASE_URL" -Fc -f revora-backup-$(date +%Y%m%d).dump

# Backup only indexer tables
pg_dump "$DATABASE_URL" \
  -t indexer_state \
  -t proposals \
  -t votes \
  -t delegates \
  -Fc -f indexer-tables-$(date +%Y%m%d).dump

# Automated daily backups (cron)
0 2 * * * pg_dump "$DATABASE_URL" -Fc -f /backups/revora-$(date +\%Y\%m\%d).dump
```

### Log Rotation

Configure log rotation for health check logs:

```bash
# /etc/logrotate.d/indexer-health
/var/log/indexer-health.log {
    daily
    rotate 30
    compress
    delaycompress
    notifempty
    create 0640 revora revora
    sharedscripts
    postrotate
        systemctl reload revora-backend > /dev/null 2>&1 || true
    endscript
}
```

### Scaling Considerations

For high-traffic deployments:

1. **Horizontal Scaling:**
   - Each instance tracks its own uptime independently
   - All instances share the same database state
   - Load balancer should check health of each instance

2. **Database Read Replicas:**

   ```typescript
   // Use read replica for health queries
   const readPool = new Pool({
     connectionString: process.env.DATABASE_READ_URL,
     max: 10,
   });

   // Health endpoint uses read replica
   // Write operations use primary database
   ```

3. **Rate Limiting:**

   ```typescript
   // Protect health endpoint from abuse
   import rateLimit from "express-rate-limit";

   const healthLimiter = rateLimit({
     windowMs: 60 * 1000, // 1 minute
     max: 100, // 100 requests per minute per IP
     message: "Too many health check requests",
   });

   app.get("/health", healthLimiter, healthHandler);
   ```

## Upgrade Path

### Upgrading from Previous Versions

If upgrading from a version without the health endpoint:

1. **Backup database:**

   ```bash
   pg_dump "$DATABASE_URL" -Fc -f pre-upgrade-backup.dump
   ```

2. **Run migrations:**

   ```bash
   npm run migrate
   ```

3. **Deploy new version:**

   ```bash
   npm ci
   npm run build
   npm start
   ```

4. **Verify health endpoint:**

   ```bash
   curl http://localhost:3000/health
   ```

5. **Update monitoring systems** to use new endpoint

6. **Update container orchestration** to use health checks

## Reference

### Health Endpoint Response Schema

```typescript
interface IndexerHealthResponse {
  status: "ok" | "degraded";
  last_indexed_ledger: number; // Non-negative integer
  current_ledger: number; // Non-negative integer
  lag_ledgers: number; // Non-negative integer
  lag_seconds: number; // Non-negative integer (lag_ledgers * 5)
  total_proposals_indexed: number; // Non-negative integer
  total_votes_indexed: number; // Non-negative integer
  total_delegates_indexed: number; // Non-negative integer
  uptime_seconds: number; // Non-negative integer
  timestamp: string; // ISO 8601 UTC datetime
  error?: string; // Present only when status is "degraded"
}
```

### HTTP Status Codes

| Status Code | Meaning  | When Returned                               |
| ----------- | -------- | ------------------------------------------- |
| `200`       | Healthy  | `status === "ok"` and all queries succeeded |
| `503`       | Degraded | `status === "degraded"` or any query failed |

### Environment Variables Reference

| Variable               | Type    | Default                               | Validation                                 |
| ---------------------- | ------- | ------------------------------------- | ------------------------------------------ |
| `DATABASE_URL`         | string  | None                                  | Must be valid PostgreSQL connection string |
| `STELLAR_RPC_URL`      | string  | `https://soroban-testnet.stellar.org` | Must be valid HTTPS URL                    |
| `HEALTH_LAG_THRESHOLD` | integer | `100`                                 | Must be positive integer                   |
| `PORT`                 | integer | `3000`                                | Must be valid port number (1-65535)        |
| `NODE_ENV`             | string  | `development`                         | `development` or `production`              |

### Related Documentation

- [Database Setup Guide](./indexer-health-endpoint-database-setup.md)
- [API Documentation](./api-docs-route-security.md)
- [Migration Guide](../README-MIGRATIONS.md)
- [Testing Guide](../TESTING.md)

### Support and Contact

For deployment issues or questions:

1. Check [Troubleshooting](#troubleshooting) section
2. Review application logs
3. Verify environment configuration
4. Test database and RPC connectivity
5. Contact DevOps team with logs and error details

## Quick Reference Commands

### Deployment

```bash
# Install and build
npm ci && npm run build

# Run migrations
npm run migrate

# Start production
NODE_ENV=production npm start
```

### Verification

```bash
# Check health
curl http://localhost:3000/health | jq

# Check status code
curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/health

# Monitor continuously
watch -n 5 'curl -s http://localhost:3000/health | jq ".status, .lag_ledgers"'
```

### Database

```bash
# Verify tables
psql "$DATABASE_URL" -c "\dt"

# Check indexer state
psql "$DATABASE_URL" -c "SELECT * FROM indexer_state;"

# Check event counts
psql "$DATABASE_URL" -c "SELECT
  (SELECT COUNT(*) FROM proposals) as proposals,
  (SELECT COUNT(*) FROM votes) as votes,
  (SELECT COUNT(*) FROM delegates) as delegates;"
```

### Docker

```bash
# Build and run
docker build -t revora-backend:latest .
docker run -d -p 3000:3000 --name revora-backend revora-backend:latest

# Check health
docker inspect --format='{{.State.Health.Status}}' revora-backend

# View logs
docker logs -f revora-backend
```

### Troubleshooting

```bash
# Test RPC connectivity
curl -X POST "$STELLAR_RPC_URL" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"getLatestLedger"}'

# Test database connectivity
psql "$DATABASE_URL" -c "SELECT 1;"

# Check environment
env | grep -E "DATABASE_URL|STELLAR_RPC_URL|HEALTH_LAG_THRESHOLD"
```

---

**Document Version:** 1.0  
**Last Updated:** 2024-01-15  
**Feature:** Indexer Health Endpoint Enhancement  
**Spec:** indexer-health-endpoint-enhancement
