-- Migration: Add cron-expression deferred distribution schedule to offerings
-- Description: Allows treasury operators to tune settlement cadence per offering
--              using a standard 5-field cron expression evaluated in a configurable
--              IANA timezone, without requiring a code redeploy.
--
-- Columns added
--   cron_expression       VARCHAR(100) NULL
--     Standard 5-field cron expression (minute hour dom month dow).
--     NULL means "no deferred schedule; use the default fixed-interval trigger".
--     Example: '0 3 L * 5' → "last business day of the month at 03:00 local time"
--     Validated by CronWindowValidator before persistence.
--
--   distribution_timezone VARCHAR(100) NULL DEFAULT 'UTC'
--     IANA timezone in which cron_expression is evaluated.
--     Defaults to UTC when NULL.
--
-- DOWN Migration (manual rollback):
--   ALTER TABLE offerings DROP COLUMN IF EXISTS cron_expression;
--   ALTER TABLE offerings DROP COLUMN IF EXISTS distribution_timezone;

ALTER TABLE offerings
  ADD COLUMN IF NOT EXISTS cron_expression VARCHAR(100) NULL,
  ADD COLUMN IF NOT EXISTS distribution_timezone VARCHAR(100) NULL DEFAULT 'UTC';

-- Optional: index for efficiently finding offerings that have a custom schedule
CREATE INDEX IF NOT EXISTS idx_offerings_cron_expression
  ON offerings (cron_expression)
  WHERE cron_expression IS NOT NULL;

COMMENT ON COLUMN offerings.cron_expression IS
  'Standard 5-field cron expression (minute hour dom month dow). NULL = default fixed-interval. Validated by CronWindowValidator before insert/update.';

COMMENT ON COLUMN offerings.distribution_timezone IS
  'IANA timezone for wall-clock evaluation of cron_expression. Defaults to UTC.';
