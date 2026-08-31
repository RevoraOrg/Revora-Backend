-- Migration: Create email deliverability tables
-- Description: Tracks DKIM/DMARC/SPF alignment per domain, manages bounce
--   suppression lists, and logs raw bounce events for provider-agnostic
--   observability. Enables per-domain email.bounce_ratio gauge emission
--   and alarm triggers on alignment failures.
--
-- Security assumptions:
--   - Bounce event payloads are stripped of PII before storage (no raw message bodies).
--   - Suppressions auto-expire to prevent permanent blocking after transient errors.
--   - Domain records are upserted (INSERT … ON CONFLICT) so concurrent webhook
--     ingestion never produces duplicate rows.

-- =============================================================================
-- Table: email_deliverability_domains
-- Per-domain sending reputation and alignment state.
-- =============================================================================
CREATE TABLE IF NOT EXISTS email_deliverability_domains (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  domain           TEXT        NOT NULL UNIQUE,
  provider         TEXT        NOT NULL DEFAULT 'sendgrid',

  -- DKIM / DMARC / SPF alignment (last-known state)
  dkim_status      TEXT        CHECK (dkim_status IN ('pass', 'fail', 'neutral', 'none', 'temperror', 'permerror')),
  spf_status       TEXT        CHECK (spf_status IN ('pass', 'fail', 'neutral', 'none', 'temperror', 'permerror')),
  dmarc_status     TEXT        CHECK (dmarc_status IN ('pass', 'fail', 'neutral', 'none', 'temperror', 'permerror')),
  dmarc_policy     TEXT        CHECK (dmarc_policy IN ('none', 'quarantine', 'reject')),
  aligned          BOOLEAN     NOT NULL DEFAULT FALSE,

  -- Cumulative counters
  sent_count       BIGINT      NOT NULL DEFAULT 0,
  bounce_count     BIGINT      NOT NULL DEFAULT 0,
  complaint_count  BIGINT      NOT NULL DEFAULT 0,
  block_count      BIGINT      NOT NULL DEFAULT 0,

  -- Derived ratio (cached on each insertion; computed as bounce_count / NULLIF(sent_count, 0))
  bounce_ratio     DOUBLE PRECISION NOT NULL DEFAULT 0.0,

  -- Metadata
  last_sent_at     TIMESTAMPTZ,
  last_bounce_at   TIMESTAMPTZ,
  last_alarm_at    TIMESTAMPTZ,   -- When the last alignment-failure alarm was raised
  created_at       TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ    NOT NULL DEFAULT NOW()
);

-- Index for alarm queries (domains with active alignment failures)
CREATE INDEX IF NOT EXISTS idx_email_deliverability_domains_aligned
  ON email_deliverability_domains (aligned)
  WHERE aligned = FALSE;

-- Index for bounce ratio threshold scanning
CREATE INDEX IF NOT EXISTS idx_email_deliverability_domains_bounce_ratio
  ON email_deliverability_domains (bounce_ratio DESC)
  WHERE sent_count > 0;

-- Index for webhook lookup by domain name
CREATE INDEX IF NOT EXISTS idx_email_deliverability_domains_domain
  ON email_deliverability_domains (domain);

-- =============================================================================
-- Table: email_suppressions
-- Bounce / complaint suppression list with TTL.
-- =============================================================================
CREATE TABLE IF NOT EXISTS email_suppressions (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  email           TEXT        NOT NULL,
  reason          TEXT        NOT NULL CHECK (reason IN (
    'hard_bounce', 'soft_bounce', 'spam_complaint', 'block', 'manual'
  )),
  bounce_event_id UUID        REFERENCES email_bounce_events(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at      TIMESTAMPTZ,

  -- A given email-reason pair is unique so we never double-suppress
  UNIQUE (email, reason)
);

-- Fast lookup: is a given email currently suppressed?
CREATE INDEX IF NOT EXISTS idx_email_suppressions_active
  ON email_suppressions (email)
  WHERE expires_at IS NULL OR expires_at > NOW();

-- =============================================================================
-- Table: email_bounce_events
-- Provider-agnostic raw bounce event log.
-- =============================================================================
CREATE TABLE IF NOT EXISTS email_bounce_events (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  email               TEXT        NOT NULL,
  domain              TEXT        NOT NULL,
  provider            TEXT        NOT NULL,     -- 'sendgrid', 'ses', 'smtp'
  bounce_type         TEXT        NOT NULL CHECK (bounce_type IN (
    'hard_bounce', 'soft_bounce', 'block', 'spam_complaint', 'unsubscribe', 'other'
  )),
  status_code         TEXT,                     -- Provider-specific SMTP code or status
  provider_event_id   TEXT,                     -- Provider's unique event ID (dedup key)
  raw_payload         JSONB,                    -- Original provider payload (PII stripped)
  ingested_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Deduplication (replay-safe ingestion)
CREATE UNIQUE INDEX IF NOT EXISTS idx_email_bounce_events_provider_dedup
  ON email_bounce_events (provider, provider_event_id)
  WHERE provider_event_id IS NOT NULL;

-- Reverse-chronological lookup by email for investigation
CREATE INDEX IF NOT EXISTS idx_email_bounce_events_email
  ON email_bounce_events (email, ingested_at DESC);

-- Domain-level aggregation index
CREATE INDEX IF NOT EXISTS idx_email_bounce_events_domain
  ON email_bounce_events (domain, ingested_at DESC);

-- =============================================================================
-- Trigger function: auto-update updated_at column
-- =============================================================================
CREATE OR REPLACE FUNCTION update_email_deliverability_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_email_deliverability_domains_updated_at
  BEFORE UPDATE ON email_deliverability_domains
  FOR EACH ROW
  EXECUTE FUNCTION update_email_deliverability_updated_at();

