-- Migration: Create KMS rotation state table for background column re-encryption tracking

CREATE TABLE IF NOT EXISTS kms_rotation_state (
  id VARCHAR(255) PRIMARY KEY,
  target_table VARCHAR(255) NOT NULL,
  target_column VARCHAR(255) NOT NULL,
  target_key_generation INTEGER NOT NULL,
  last_processed_id VARCHAR(255) NULL,
  status VARCHAR(50) NOT NULL CHECK (status IN ('pending', 'in_progress', 'completed', 'failed', 'paused')),
  total_rows INTEGER NOT NULL DEFAULT 0,
  reencrypted_rows INTEGER NOT NULL DEFAULT 0,
  failed_rows INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMP WITH TIME ZONE NULL,
  CONSTRAINT unique_kms_rotation_job UNIQUE (target_table, target_column, target_key_generation)
);

CREATE INDEX IF NOT EXISTS idx_kms_rotation_status ON kms_rotation_state(status);
CREATE INDEX IF NOT EXISTS idx_kms_rotation_table_col ON kms_rotation_state(target_table, target_column);

-- Sample table for KMS encrypted columns testing & demonstration
CREATE TABLE IF NOT EXISTS kms_sample_records (
  id VARCHAR(255) PRIMARY KEY,
  sensitive_data TEXT NOT NULL,
  key_generation INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kms_sample_records_key_gen ON kms_sample_records(key_generation);
