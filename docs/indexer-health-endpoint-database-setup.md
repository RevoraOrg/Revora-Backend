# Indexer Health Endpoint - Database Setup

## Overview

This document describes the database schema required for the indexer health endpoint enhancement feature. The schema supports tracking the last indexed ledger and storing governance events (proposals, votes, delegates).

## Migration File

**File:** `src/db/migrations/012_create_indexer_tables.sql`

This migration creates four tables required for the health endpoint:

### 1. indexer_state

Stores the last successfully indexed ledger sequence number.

| Column                | Type          | Constraints                  | Description                                            |
| --------------------- | ------------- | ---------------------------- | ------------------------------------------------------ |
| `id`                  | `SERIAL`      | `PRIMARY KEY`                | Auto-incrementing identifier                           |
| `last_indexed_ledger` | `BIGINT`      | `NOT NULL`, Default: `0`     | The most recent ledger sequence successfully processed |
| `updated_at`          | `TIMESTAMPTZ` | `NOT NULL`, Default: `NOW()` | Timestamp of last update                               |

**Initial Data:** The migration inserts a single row with `last_indexed_ledger = 0` if the table is empty.

**Trigger:** Automatically updates `updated_at` on row modification.

### 2. proposals

Stores indexed proposal governance events.

| Column        | Type          | Constraints                                 | Description                                      |
| ------------- | ------------- | ------------------------------------------- | ------------------------------------------------ |
| `id`          | `UUID`        | `PRIMARY KEY`, Default: `gen_random_uuid()` | Unique identifier                                |
| `proposal_id` | `TEXT`        | `NOT NULL`, `UNIQUE`                        | Unique proposal identifier from blockchain       |
| `title`       | `TEXT`        | Optional                                    | Proposal title                                   |
| `description` | `TEXT`        | Optional                                    | Proposal description                             |
| `proposer`    | `TEXT`        | `NOT NULL`                                  | Address of the proposer                          |
| `status`      | `TEXT`        | `NOT NULL`                                  | Proposal status (e.g., active, passed, rejected) |
| `created_at`  | `TIMESTAMPTZ` | `NOT NULL`, Default: `NOW()`                | Timestamp when proposal was created              |
| `indexed_at`  | `TIMESTAMPTZ` | `NOT NULL`, Default: `NOW()`                | Timestamp when proposal was indexed              |

**Indexes:**

- `idx_proposals_proposal_id` on `proposal_id` for fast lookups

### 3. votes

Stores indexed vote governance events.

| Column         | Type          | Constraints                                 | Description                          |
| -------------- | ------------- | ------------------------------------------- | ------------------------------------ |
| `id`           | `UUID`        | `PRIMARY KEY`, Default: `gen_random_uuid()` | Unique identifier                    |
| `proposal_id`  | `TEXT`        | `NOT NULL`                                  | Reference to proposal                |
| `voter`        | `TEXT`        | `NOT NULL`                                  | Address of the voter                 |
| `vote_choice`  | `TEXT`        | `NOT NULL`                                  | Vote choice (e.g., yes, no, abstain) |
| `voting_power` | `BIGINT`      | Optional                                    | Voting power at time of vote         |
| `created_at`   | `TIMESTAMPTZ` | `NOT NULL`, Default: `NOW()`                | Timestamp when vote was cast         |
| `indexed_at`   | `TIMESTAMPTZ` | `NOT NULL`, Default: `NOW()`                | Timestamp when vote was indexed      |

**Constraints:**

- `UNIQUE(proposal_id, voter)` - One vote per voter per proposal

**Indexes:**

- `idx_votes_proposal_id` on `proposal_id`
- `idx_votes_voter` on `voter`

### 4. delegates

Stores indexed delegation governance events.

| Column             | Type          | Constraints                                 | Description                           |
| ------------------ | ------------- | ------------------------------------------- | ------------------------------------- |
| `id`               | `UUID`        | `PRIMARY KEY`, Default: `gen_random_uuid()` | Unique identifier                     |
| `delegator`        | `TEXT`        | `NOT NULL`                                  | Address delegating voting power       |
| `delegatee`        | `TEXT`        | `NOT NULL`                                  | Address receiving delegated power     |
| `delegation_power` | `BIGINT`      | Optional                                    | Amount of voting power delegated      |
| `created_at`       | `TIMESTAMPTZ` | `NOT NULL`, Default: `NOW()`                | Timestamp when delegation was created |
| `indexed_at`       | `TIMESTAMPTZ` | `NOT NULL`, Default: `NOW()`                | Timestamp when delegation was indexed |

**Constraints:**

- `UNIQUE(delegator, delegatee)` - One delegation per delegator-delegatee pair

**Indexes:**

- `idx_delegates_delegator` on `delegator`
- `idx_delegates_delegatee` on `delegatee`

## Running the Migration

### Prerequisites

1. Ensure `DATABASE_URL` is set in your environment:

   ```bash
   export DATABASE_URL="postgresql://user:password@localhost:5432/revora"
   ```

2. Ensure the database exists and is accessible.

### Execute Migration

Run the migration script:

```bash
npm run migrate
```

This will:

1. Connect to the database specified by `DATABASE_URL`
2. Create the `schema_version` table if it doesn't exist
3. Apply `012_create_indexer_tables.sql` if not already applied
4. Record the migration in `schema_version`

### Verification

After running the migration, verify the tables were created:

```sql
-- Check tables exist
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN ('indexer_state', 'proposals', 'votes', 'delegates');

-- Verify initial indexer_state row
SELECT * FROM indexer_state;
-- Expected: One row with last_indexed_ledger = 0

-- Verify tables are empty
SELECT COUNT(*) FROM proposals;
SELECT COUNT(*) FROM votes;
SELECT COUNT(*) FROM delegates;
-- Expected: 0 for all
```

## Usage by Health Endpoint

The health endpoint queries these tables to provide monitoring metrics:

1. **indexer_state**: Retrieves `last_indexed_ledger` to calculate lag
2. **proposals**: Counts total rows for `total_proposals_indexed`
3. **votes**: Counts total rows for `total_votes_indexed`
4. **delegates**: Counts total rows for `total_delegates_indexed`

## Indexer Integration

The indexer process (not part of this feature) will:

1. Process Stellar ledgers sequentially
2. Extract governance events (proposals, votes, delegates)
3. Insert events into respective tables
4. Update `indexer_state.last_indexed_ledger` after successful processing

## Rollback

If you need to rollback this migration:

```sql
-- Drop tables in reverse dependency order
DROP TABLE IF EXISTS delegates CASCADE;
DROP TABLE IF EXISTS votes CASCADE;
DROP TABLE IF EXISTS proposals CASCADE;
DROP TABLE IF EXISTS indexer_state CASCADE;

-- Remove migration record
DELETE FROM schema_version WHERE version = '012_create_indexer_tables.sql';
```

**Warning:** This will delete all indexed data. Only perform in development or with proper backups.

## Security Considerations

1. **No PII**: Tables contain only blockchain addresses and governance data
2. **Public Data**: All data is derived from public blockchain events
3. **Read-Only Access**: Health endpoint only performs SELECT queries
4. **No User Input**: Tables are populated by trusted indexer process only
5. **Indexes**: Optimized for fast COUNT(\*) queries without exposing sensitive data

## Performance Notes

1. **COUNT Queries**: The health endpoint uses `COUNT(*)` which is optimized by PostgreSQL
2. **Indexes**: All foreign key-like columns are indexed for fast lookups
3. **No Joins**: Health endpoint queries are simple aggregations, no complex joins
4. **Connection Pooling**: Uses existing database connection pool, no additional connections

## Maintenance

### Monitoring

Monitor table growth over time:

```sql
SELECT
  schemaname,
  tablename,
  pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) AS size
FROM pg_tables
WHERE tablename IN ('indexer_state', 'proposals', 'votes', 'delegates')
ORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC;
```

### Archival

For long-running deployments, consider archival strategies:

1. **Partition by Date**: Partition tables by `indexed_at` for easier archival
2. **Retention Policy**: Define how long to keep historical governance events
3. **Archive Tables**: Move old data to archive tables for historical analysis

## References

- [PostgreSQL CREATE TABLE](https://www.postgresql.org/docs/current/sql-createtable.html)
- [PostgreSQL Indexes](https://www.postgresql.org/docs/current/indexes.html)
- [PostgreSQL Triggers](https://www.postgresql.org/docs/current/trigger-definition.html)
