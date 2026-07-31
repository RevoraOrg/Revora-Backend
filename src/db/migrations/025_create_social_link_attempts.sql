-- Migration: Create social link attempts table
-- Description: Records social account-linking attempts for anomaly detection.
--              Each row is one (provider, provider_subject, user_id) candidate
--              account the social identity has been attempted against.  The
--              primary key guarantees each candidate account is counted exactly
--              once, so "identity spraying" (one social sub → many accounts)
--              is detected by counting distinct rows in a sliding window.
--
-- Security context: additive-only schema change.  Contains only provider
--                   subject claims and internal user IDs; no ID tokens or
--                   passwords are stored.

CREATE TABLE IF NOT EXISTS social_link_attempts (
  provider TEXT NOT NULL CHECK (provider IN ('google', 'apple')),
  provider_subject TEXT NOT NULL,
  user_id UUID NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN (
    'link_success',
    'step_up_failed',
    'identity_conflict',
    'email_conflict'
  )),
  attempted_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  PRIMARY KEY (provider, provider_subject, user_id)
);

CREATE INDEX IF NOT EXISTS idx_social_link_attempts_window
  ON social_link_attempts (provider, provider_subject, attempted_at DESC);

COMMENT ON TABLE social_link_attempts IS
  'Social account-linking attempts used by SocialLinkAnomalyDetector to detect '
  'a single social identity being sprayed across many candidate accounts.';

COMMENT ON COLUMN social_link_attempts.outcome IS
  'How the link attempt ended: link_success | step_up_failed | identity_conflict | email_conflict';
