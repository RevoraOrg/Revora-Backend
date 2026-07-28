-- Migration: create indexer tables for health endpoint monitoring
-- Creates tables for tracking indexer state and governance events

-- Create indexer_state table to track the last successfully indexed ledger
CREATE TABLE IF NOT EXISTS indexer_state (
  id SERIAL PRIMARY KEY,
  last_indexed_ledger BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Insert initial row with last_indexed_ledger = 0
INSERT INTO indexer_state (last_indexed_ledger)
SELECT 0
WHERE NOT EXISTS (SELECT 1 FROM indexer_state);

-- Create proposals table for storing indexed proposal events
CREATE TABLE IF NOT EXISTS proposals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id TEXT NOT NULL UNIQUE,
  title TEXT,
  description TEXT,
  proposer TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  indexed_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Add index on proposal_id for faster lookups
CREATE INDEX IF NOT EXISTS idx_proposals_proposal_id ON proposals(proposal_id);

-- Create votes table for storing indexed vote events
CREATE TABLE IF NOT EXISTS votes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id TEXT NOT NULL,
  voter TEXT NOT NULL,
  vote_choice TEXT NOT NULL,
  voting_power BIGINT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  indexed_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  UNIQUE(proposal_id, voter)
);

-- Add indexes for faster lookups
CREATE INDEX IF NOT EXISTS idx_votes_proposal_id ON votes(proposal_id);
CREATE INDEX IF NOT EXISTS idx_votes_voter ON votes(voter);

-- Create delegates table for storing indexed delegate events
CREATE TABLE IF NOT EXISTS delegates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  delegator TEXT NOT NULL,
  delegatee TEXT NOT NULL,
  delegation_power BIGINT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  indexed_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  UNIQUE(delegator, delegatee)
);

-- Add indexes for faster lookups
CREATE INDEX IF NOT EXISTS idx_delegates_delegator ON delegates(delegator);
CREATE INDEX IF NOT EXISTS idx_delegates_delegatee ON delegates(delegatee);

-- Add trigger to automatically update indexer_state.updated_at
CREATE OR REPLACE FUNCTION update_indexer_state_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_indexer_state_updated_at
  BEFORE UPDATE ON indexer_state
  FOR EACH ROW
  EXECUTE FUNCTION update_indexer_state_updated_at();
