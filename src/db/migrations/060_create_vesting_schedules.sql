-- Migration: Create vesting_schedules table
-- This table stores vesting schedules with user ownership to prevent
-- unauthorized claims and ensure proper persistence of claim state.

CREATE TABLE IF NOT EXISTS vesting_schedules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  total_amount NUMERIC(20, 8) NOT NULL CHECK (total_amount >= 0),
  claimed_amount NUMERIC(20, 8) NOT NULL DEFAULT 0 CHECK (claimed_amount >= 0),
  last_claim_index INTEGER NOT NULL DEFAULT -1,
  schedule_data JSONB NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT valid_claim_amount CHECK (claimed_amount <= total_amount)
);

-- Index for efficient user ownership lookups
CREATE INDEX idx_vesting_schedules_user_id ON vesting_schedules(user_id);

-- Index for schedule lookups by ID
CREATE INDEX idx_vesting_schedules_id ON vesting_schedules(id);

-- Trigger to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_vesting_schedules_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_vesting_schedules_updated_at
  BEFORE UPDATE ON vesting_schedules
  FOR EACH ROW
  EXECUTE FUNCTION update_vesting_schedules_updated_at();

-- Security note: user_id foreign key with CASCADE ensures that when a user
-- is deleted, all their vesting schedules are also deleted, preventing orphaned
-- schedules that could be exploited.
