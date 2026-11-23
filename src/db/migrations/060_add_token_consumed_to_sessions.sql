-- Add token_consumed_at to sessions to mark refresh tokens as consumed on rotation
ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS token_consumed_at TIMESTAMP WITH TIME ZONE NULL;

-- Backfill: NULL means not consumed. No further action required.
