-- Migration: add investment-level sanctions screening columns and a
-- sanctions_screening_snapshots table for reproducible audit.
--
-- Design / security assumptions:
--   * Every investment row records `screening_status`, `screening_list_version`,
--     and a JSON `screening_result` so a past screening decision can be
--     reproduced against the exact list revision that produced it.
--   * `sanctions_screening_snapshots` stores a versioned, checksum-verified copy
--     of the normalized list. `screening_list_version` on the investment row
--     joins back to this table (by list_source + version) to prove which list
--     revision was used at submission time.
--   * Status values:
--       - 'passed'   → no exact/alias match, investor cleared to proceed.
--       - 'blocked'  → a sanctions hit was detected; the investment was rejected.
--       - 'error'    → screening could not be performed (fail-closed); the
--                      submission is rejected because no verified list is present.

ALTER TABLE investments
  ADD COLUMN IF NOT EXISTS screening_status VARCHAR(32) NULL,
  ADD COLUMN IF NOT EXISTS screening_list_version VARCHAR(128) NULL,
  ADD COLUMN IF NOT EXISTS screening_result JSONB NULL;

CREATE INDEX IF NOT EXISTS idx_investments_screening_status
  ON investments(screening_status);

CREATE TABLE IF NOT EXISTS sanctions_screening_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  list_source VARCHAR(32) NOT NULL,
  version VARCHAR(128) NOT NULL,
  entry_count INTEGER NOT NULL,
  normalized_checksum VARCHAR(64) NOT NULL,
  entries JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_snapshot_source_version UNIQUE (list_source, version)
);

CREATE INDEX IF NOT EXISTS idx_sanctions_screening_snapshots_source
  ON sanctions_screening_snapshots(list_source, created_at DESC);