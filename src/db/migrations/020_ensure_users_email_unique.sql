-- Ensure users.email has a unique index (idempotent).
-- The UNIQUE constraint was originally created in 001_create_users.sql.
-- This migration makes the requirement explicit and versioned, and guards
-- against accidental removal of the constraint in future migrations.
-- PostgreSQL error code 23505 (unique_violation) is the enforcement mechanism.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_unique ON users(email);
