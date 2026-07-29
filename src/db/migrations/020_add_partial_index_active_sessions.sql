-- Migration: add partial index on active sessions
-- This speeds up lookup of active sessions (e.g. counting active sessions)
-- by ignoring all the revoked/expired history.

CREATE INDEX IF NOT EXISTS idx_sessions_active_user_id ON sessions(user_id) WHERE revoked_at IS NULL;
