/**
 * OFAC false-positive review queue.
 *
 * Clearance requires two independent compliance approvals. The review row is
 * mutable only for workflow state; every clearance action is also written to
 * immutable security audit events by AMLService.
 */

CREATE TABLE IF NOT EXISTS ofac_reviews (
  id VARCHAR(255) PRIMARY KEY,
  alert_id VARCHAR(255) NOT NULL REFERENCES aml_alerts(id),
  case_id VARCHAR(255) REFERENCES aml_cases(id),
  investor_id VARCHAR(255) NOT NULL,
  matched_name VARCHAR(255) NOT NULL,
  list_entry_id VARCHAR(255),
  status VARCHAR(40) NOT NULL CHECK (
    status IN ('pending_first_approval', 'pending_second_approval', 'cleared', 'expired', 'rejected')
  ) DEFAULT 'pending_first_approval',
  created_by VARCHAR(255) NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  first_approver_id VARCHAR(255),
  first_approval_rationale TEXT,
  first_approved_at TIMESTAMP WITH TIME ZONE,
  second_approver_id VARCHAR(255),
  second_approval_rationale TEXT,
  second_approved_at TIMESTAMP WITH TIME ZONE,
  clearance_rationale TEXT NOT NULL,
  cleared_at TIMESTAMP WITH TIME ZONE,
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  CONSTRAINT ofac_review_creator_not_first_approver
    CHECK (first_approver_id IS NULL OR first_approver_id <> created_by),
  CONSTRAINT ofac_review_creator_not_second_approver
    CHECK (second_approver_id IS NULL OR second_approver_id <> created_by),
  CONSTRAINT ofac_review_dual_control
    CHECK (
      first_approver_id IS NULL OR
      second_approver_id IS NULL OR
      first_approver_id <> second_approver_id
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ofac_reviews_open_alert
  ON ofac_reviews(alert_id)
  WHERE status IN ('pending_first_approval', 'pending_second_approval');

CREATE INDEX IF NOT EXISTS idx_ofac_reviews_queue
  ON ofac_reviews(status, created_at ASC)
  WHERE status IN ('pending_first_approval', 'pending_second_approval');

CREATE INDEX IF NOT EXISTS idx_ofac_reviews_investor_id ON ofac_reviews(investor_id);
CREATE INDEX IF NOT EXISTS idx_ofac_reviews_expires_at ON ofac_reviews(expires_at);
CREATE INDEX IF NOT EXISTS idx_ofac_reviews_created_by ON ofac_reviews(created_by);
CREATE INDEX IF NOT EXISTS idx_ofac_reviews_approvers
  ON ofac_reviews(first_approver_id, second_approver_id);

COMMENT ON TABLE ofac_reviews IS 'OFAC false-positive reviews requiring two independent compliance clearances';
COMMENT ON COLUMN ofac_reviews.clearance_rationale IS 'Creator rationale plus final dual-control clearance rationale';
