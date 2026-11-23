-- Migration: create users table
-- Columns:
-- id (UUID primary key), email (unique), password_hash, role (startup|investor), created_at

-- Note: `gen_random_uuid()` requires the `pgcrypto` extension; adjust if your setup uses `uuid-ossp`.
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('startup','investor')),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Add an index on email for faster lookups
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
