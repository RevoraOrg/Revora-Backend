-- Migration: create sanctions_list_versions table for audit trail and diff tracking
-- Stores every sanctions list load with raw payload hash and diff summary
-- Retains 7 years of list versions for compliance auditing

CREATE TABLE IF NOT EXISTS sanctions_list_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  list_source VARCHAR(32) NOT NULL, -- 'ofac', 'eu_consolidated', etc.
  version VARCHAR(128) NOT NULL,
  raw_payload_hash VARCHAR(64) NOT NULL, -- SHA-256 hash of raw CSV/JSON payload
  parse_hash VARCHAR(64) NOT NULL, -- SHA-256 hash of normalized parsed entries
  entry_count INTEGER NOT NULL,
  diff_summary JSONB, -- Summary of changes from previous version
  diff_size INTEGER, -- Number of entities changed (added + removed + modified)
  previous_version_id UUID REFERENCES sanctions_list_versions(id) ON DELETE SET NULL,
  signature_valid BOOLEAN NOT NULL,
  loaded_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_source_version UNIQUE (list_source, version),
  CONSTRAINT chk_list_source CHECK (list_source IN ('ofac', 'eu_consolidated', 'un_sc', 'uk_hmt'))
);

CREATE TABLE IF NOT EXISTS sanctions_list_diff_details (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id UUID NOT NULL REFERENCES sanctions_list_versions(id) ON DELETE CASCADE,
  entity_uid VARCHAR(128) NOT NULL,
  entity_name TEXT NOT NULL,
  change_type VARCHAR(16) NOT NULL, -- 'added', 'removed', 'modified'
  previous_data JSONB, -- For 'removed' and 'modified' - previous entity state
  new_data JSONB, -- For 'added' and 'modified' - new entity state
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_change_type CHECK (change_type IN ('added', 'removed', 'modified'))
);

-- Indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_sanctions_list_versions_source ON sanctions_list_versions(list_source);
CREATE INDEX IF NOT EXISTS idx_sanctions_list_versions_loaded_at ON sanctions_list_versions(loaded_at DESC);
CREATE INDEX IF NOT EXISTS idx_sanctions_list_versions_previous ON sanctions_list_versions(previous_version_id);
CREATE INDEX IF NOT EXISTS idx_sanctions_list_diff_details_version ON sanctions_list_diff_details(version_id);
CREATE INDEX IF NOT EXISTS idx_sanctions_list_diff_details_change_type ON sanctions_list_diff_details(change_type);
CREATE INDEX IF NOT EXISTS idx_sanctions_list_diff_details_entity_uid ON sanctions_list_diff_details(entity_uid);

-- Partition by list_source for better performance with large datasets
-- (Optional: can be added later if needed for scale)

-- Retention policy: Delete versions older than 7 years
-- This should be handled by a scheduled job, not a trigger
-- to avoid accidental data loss during bulk operations
