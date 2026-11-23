-- Migration: ledger-export retention labels with legal-hold override (#565)
-- Periods under an active legal hold must not be purged even after retention expiry.

CREATE TABLE IF NOT EXISTS retention_labels (
  period_id VARCHAR(16) PRIMARY KEY,
  legal_hold BOOLEAN NOT NULL DEFAULT FALSE,
  reason TEXT,
  pending_action VARCHAR(16) NULL
    CHECK (pending_action IS NULL OR pending_action IN ('add', 'remove')),
  pending_proposed_by UUID NULL,
  pending_proposed_at TIMESTAMP WITH TIME ZONE NULL,
  activated_by UUID NULL,
  activated_at TIMESTAMP WITH TIME ZONE NULL,
  released_by UUID NULL,
  released_at TIMESTAMP WITH TIME ZONE NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  CONSTRAINT retention_labels_period_id_format
    CHECK (period_id ~ '^[0-9]{4}-[0-9]{2}$')
);

CREATE INDEX IF NOT EXISTS idx_retention_labels_legal_hold
  ON retention_labels (legal_hold)
  WHERE legal_hold = TRUE;

CREATE INDEX IF NOT EXISTS idx_retention_labels_pending_action
  ON retention_labels (pending_action)
  WHERE pending_action IS NOT NULL;

COMMENT ON TABLE retention_labels IS
  'Per-period retention labels for ledger/audit exports. Active legal_hold blocks purge.';
COMMENT ON COLUMN retention_labels.period_id IS
  'UTC calendar period key YYYY-MM derived from audit_logs.created_at for purge matching.';
COMMENT ON COLUMN retention_labels.legal_hold IS
  'When true, purge must skip audit rows belonging to this period.';
COMMENT ON COLUMN retention_labels.pending_action IS
  'Dual-control queue: add = propose hold, remove = propose release. Requires second admin.';
