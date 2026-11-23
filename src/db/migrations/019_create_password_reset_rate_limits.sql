-- Migration: Create password_reset_rate_limits table
-- Stores rate limiting data for password reset requests

CREATE TABLE IF NOT EXISTS password_reset_rate_limits (
  identifier VARCHAR(255) PRIMARY KEY,
  request_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  blocked_until TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_password_reset_rate_limits_identifier
  ON password_reset_rate_limits(identifier);

CREATE INDEX IF NOT EXISTS idx_password_reset_rate_limits_blocked_until
  ON password_reset_rate_limits(blocked_until);

CREATE INDEX IF NOT EXISTS idx_password_reset_rate_limits_request_at
  ON password_reset_rate_limits(request_at);
