# Offerings Database Schema

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
