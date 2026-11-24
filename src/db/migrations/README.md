# Database Migrations

This directory contains SQL migration files for the Revora Backend database schema.

## Migration File Naming Convention

Migration files must follow the naming pattern: `{NNN}_{description}.sql`

- `{NNN}`: A 3-digit numeric prefix (e.g., `001`, `015`, `123`)
- `{description}`: A descriptive name for the migration (use underscores instead of spaces)
- Extension: Must end with `.sql`

**Rules:**
1. Numeric prefixes must be unique by default
2. Prefixes must be monotonically increasing (no gaps required, but order matters)
3. Prefix `999` is reserved for out-of-band migrations (e.g., test data, hotfixes)
4. Hidden files (starting with `.`) are ignored

## Legacy Duplicate Prefixes

The following prefixes have historical duplicates and are explicitly allowed:
- `021`: `021_create_scheduled_distributions.sql`, `021_update_sessions_for_rotation.sql`
- `025`: `025_add_investment_sanctions_screening.sql`, `025_add_revenue_reports_distribution_status.sql`
- `044`: `044_add_cron_schedule_to_offerings.sql`, `044_create_distribution_allocations.sql`
- `060`: `060_add_token_consumed_to_sessions.sql`, `060_create_vesting_schedules.sql`
- `061`: `061_add_distribution_payouts_investor_created_at_idx.sql`, `061_add_family_expires_at_to_sessions.sql`, `061_add_is_active_to_users.sql`, `061_add_unique_offering_period_to_distributions.sql`, `061_add_webhook_outbox_leases.sql`, `061_create_ledger_entries.sql`

**Important:** These legacy duplicates are tracked in the migration resolver's allowlist. Adding new duplicate prefixes is strongly discouraged and will cause validation errors unless explicitly added to the allowlist.

## Running Migrations

To apply pending migrations:
```bash
npm run migrate
```

The migration system:
- Tracks applied migrations in the `schema_version` table
- Stores the full filename as the version identifier
- Skips already-applied migrations
- Rolls back on failure (transactional)
- Supports idempotent re-runs

## Schema: Offerings Table

The `offerings` table stores information about revenue-share offerings issued by startup users on the platform.

## Schema Details

| Column | Type | Constraints | Description |
| :--- | :--- | :--- | :--- |
| `id` | `UUID` | `PRIMARY KEY`, Default: `gen_random_uuid()` | Unique identifier for the offering. |
| `issuer_user_id` | `UUID` | `NOT NULL`, `REFERENCES users(id) ON DELETE CASCADE` | The user ID of the startup issuing the offering. |
| `token_asset_id` | `VARCHAR(255)` | `NOT NULL` | The unique identifier or address of the token asset associated with the offering. |
| `revenue_share_bps` | `INTEGER` | `NOT NULL`, `CHECK (>= 0 AND <= 10000)` | The revenue share amount in basis points (1 bp = 0.01%). |
| `status` | `VARCHAR(50)` | `NOT NULL`, Default: `'draft'`, `CHECK IN ('draft', 'active', 'closed')` | The current lifecycle status of the offering. |
| `name` | `VARCHAR(255)` | `NOT NULL` | The name or title of the offering. |
| `description` | `TEXT` | Optional | A detailed description of the offering and its terms. |
| `created_at` | `TIMESTAMPTZ` | `NOT NULL`, Default: `NOW()` | Timestamp indicating when the offering was created. |
| `updated_at` | `TIMESTAMPTZ` | `NOT NULL`, Default: `NOW()` | Timestamp automatically updated whenever the offering record is modified. |

## Indexes

- `idx_offerings_issuer_user_id`: B-Tree index on `issuer_user_id` to quickly find all offerings by a specific issuer.
- `idx_offerings_status`: B-Tree index on `status` to quickly filter offerings by their current state (e.g., finding all 'active' offerings).

## Triggers

- `update_offerings_updated_at`: A `BEFORE UPDATE` trigger that automatically sets `updated_at` to the current time whenever a row is modified.
