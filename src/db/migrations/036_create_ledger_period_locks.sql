-- Migration: Create ledger_period_locks table
-- Description: Stores period lock state for monthly ledger close operations.
--              Enforces dual-control authorization via initiation and confirmation actors.
--              Provides atomic transaction boundaries for export materialization.

CREATE TABLE IF NOT EXISTS ledger_period_locks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- Period identification (matches revenue_reports.period_id format)
  period_id VARCHAR(255) NOT NULL,
  offering_id UUID NOT NULL,
  
  -- Dual-control state machine
  status VARCHAR(50) NOT NULL DEFAULT 'pending_initiation' 
    CHECK (status IN ('pending_initiation', 'initiated', 'locked')),
  
  -- Initiation actor and timestamp
  initiated_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  initiated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  
  -- Confirmation actor and timestamp (NULL until confirmed)
  confirmed_by UUID,
  confirmed_at TIMESTAMP WITH TIME ZONE,
  
  -- Locked timestamp (when lock actually took effect)
  locked_at TIMESTAMP WITH TIME ZONE,
  
  -- Export materialization
  -- format: 'jsonl' or 'csv' to allow future flexibility
  export_format VARCHAR(50) NOT NULL DEFAULT 'jsonl'
    CHECK (export_format IN ('jsonl', 'csv')),
  
  -- Reference to where export is stored (e.g., object storage key, file path)
  export_reference TEXT,
  
  -- SHA-256 hash of the canonical export (hex-encoded)
  export_hash VARCHAR(64),
  
  -- HMAC-SHA256 signature of export_hash for tamper-evidence (hex-encoded)
  -- Signed with server key so that DB-access-only attacker cannot forge
  export_signature VARCHAR(128),
  
  -- Signing mechanism identifier (e.g., 'hmac-sha256-v1')
  signing_algorithm VARCHAR(50) DEFAULT 'hmac-sha256-v1',
  
  -- Key version used for signing (allows key rotation)
  signing_key_version INT DEFAULT 1,
  
  -- Number of journal entries materialized in this export
  entry_count INT,
  
  -- Audit and metadata
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  
  -- Constraints
  UNIQUE (offering_id, period_id),
  
  -- Enforce dual-control: confirmed_by cannot be same as initiated_by
  CONSTRAINT dual_control_different_actors CHECK (
    confirmed_by IS NULL OR confirmed_by <> initiated_by
  ),
  
  -- Enforce state transitions
  CONSTRAINT valid_state_transitions CHECK (
    (status = 'pending_initiation' AND confirmed_by IS NULL AND locked_at IS NULL) OR
    (status = 'initiated' AND confirmed_by IS NULL AND locked_at IS NULL) OR
    (status = 'locked' AND confirmed_by IS NOT NULL AND locked_at IS NOT NULL)
  )
);

-- Indices for query performance
CREATE INDEX IF NOT EXISTS idx_ledger_period_locks_offering_id 
  ON ledger_period_locks(offering_id);

CREATE INDEX IF NOT EXISTS idx_ledger_period_locks_period_id 
  ON ledger_period_locks(period_id);

CREATE INDEX IF NOT EXISTS idx_ledger_period_locks_status 
  ON ledger_period_locks(status);

CREATE INDEX IF NOT EXISTS idx_ledger_period_locks_initiated_by 
  ON ledger_period_locks(initiated_by);

CREATE INDEX IF NOT EXISTS idx_ledger_period_locks_confirmed_by 
  ON ledger_period_locks(confirmed_by);

CREATE INDEX IF NOT EXISTS idx_ledger_period_locks_created_at 
  ON ledger_period_locks(created_at);

-- Composite index for lookups by offering and status
CREATE INDEX IF NOT EXISTS idx_ledger_period_locks_offering_status 
  ON ledger_period_locks(offering_id, status);

-- Trigger for updated_at (reuses function from earlier migrations)
DROP TRIGGER IF EXISTS update_ledger_period_locks_updated_at ON ledger_period_locks;
CREATE TRIGGER update_ledger_period_locks_updated_at
    BEFORE UPDATE ON ledger_period_locks
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
