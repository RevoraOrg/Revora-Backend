-- Migration: Create distribution_schedules with cron column
-- Description: Persist per-offering deferred distribution cron-expression window
--              definitions so treasury operators can tune settlement cadence
--              without redeploys. Validated by CronWindowValidator before insert.
--
-- Issue: #661
--
-- Columns
--   id                     UUID PK
--   offering_id            UUID FK → offerings(id) UNIQUE
--   cron                   VARCHAR(100) NOT NULL
--     Standard 5-field cron expression (minute hour dom month dow).
--   timezone               VARCHAR(100) NOT NULL DEFAULT 'UTC'
--     IANA timezone for wall-clock evaluation.
--   created_at / updated_at
--
-- Note: offerings.cron_expression / offerings.distribution_timezone (migration 020)
-- remain as a denormalised mirror for scheduler joins. Application code should
-- write through OfferingRepository.updateCronSchedule which keeps both in sync
-- when a distribution_schedules row is present.
--
-- DOWN Migration (manual rollback):
--   DROP TABLE IF EXISTS distribution_schedules;

CREATE TABLE IF NOT EXISTS distribution_schedules (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  offering_id UUID NOT NULL REFERENCES offerings(id) ON DELETE CASCADE,
  cron        VARCHAR(100) NOT NULL,
  timezone    VARCHAR(100) NOT NULL DEFAULT 'UTC',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_distribution_schedules_offering UNIQUE (offering_id),
  CONSTRAINT chk_distribution_schedules_cron_nonempty CHECK (char_length(trim(cron)) > 0)
);

CREATE INDEX IF NOT EXISTS idx_distribution_schedules_cron
  ON distribution_schedules (cron);

COMMENT ON TABLE distribution_schedules IS
  'Per-offering deferred distribution cron windows. Validated by CronWindowValidator before persistence.';

COMMENT ON COLUMN distribution_schedules.cron IS
  'Standard 5-field cron expression (minute hour dom month dow). Rejected if overlapping Stellar maintenance.';
