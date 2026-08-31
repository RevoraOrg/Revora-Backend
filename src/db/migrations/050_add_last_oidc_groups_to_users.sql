-- Migration: add last_oidc_groups to users table
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_oidc_groups JSONB;
