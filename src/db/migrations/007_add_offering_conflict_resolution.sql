-- Migration: Add conflict resolution fields to offerings table
-- Description: Adds version tracking and sync hash for optimistic locking

-- Add version column for optimistic locking
ALTER TABLE offerings
ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 0;

-- Add sync_hash column for idempotent sync operations
ALTER TABLE offerings
ADD COLUMN IF NOT EXISTS sync_hash VARCHAR(64);

-- Add contract_address column if it doesn't exist
ALTER TABLE offerings
ADD COLUMN IF NOT EXISTS contract_address VARCHAR(255);

-- Add total_raised column if it doesn't exist
ALTER TABLE offerings
ADD COLUMN IF NOT EXISTS total_raised DECIMAL(20, 2) DEFAULT 0.00;

-- Create index on version for conflict detection queries
CREATE INDEX IF NOT EXISTS idx_offerings_version ON offerings (version);

-- Create index on sync_hash for idempotency checks
CREATE INDEX IF NOT EXISTS idx_offerings_sync_hash ON offerings (sync_hash);

-- Create index on contract_address for blockchain lookups
CREATE INDEX IF NOT EXISTS idx_offerings_contract_address ON offerings (contract_address);

-- Add comment explaining the conflict resolution strategy
COMMENT ON COLUMN offerings.version IS 'Optimistic lock version for conflict detection';
COMMENT ON COLUMN offerings.sync_hash IS 'Hash of blockchain state for idempotent sync operations';
