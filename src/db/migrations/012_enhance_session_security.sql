-- Migration: enhance session security with constraints and indexes
-- Adds unique constraint on (user_id, id) to prevent session fixation
-- Adds additional indexes for performance

-- Add unique constraint to prevent duplicate sessions for same user
ALTER TABLE sessions ADD CONSTRAINT sessions_user_id_id_unique UNIQUE (user_id, id);

-- Add index on revoked_at for efficient cleanup queries
CREATE INDEX IF NOT EXISTS idx_sessions_revoked_at ON sessions(revoked_at) WHERE revoked_at IS NOT NULL;