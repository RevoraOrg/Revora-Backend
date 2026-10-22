-- Migration: update sessions table for refresh token rotation
-- Adds parent_id for token lineage and revoked_at for revocation

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS parent_id UUID REFERENCES sessions(id) ON DELETE CASCADE;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMP WITH TIME ZONE;

CREATE INDEX IF NOT EXISTS idx_sessions_parent_id ON sessions(parent_id);
