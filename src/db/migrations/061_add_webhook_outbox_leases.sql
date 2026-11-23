-- Claim ownership must survive the pool query's autocommit transaction.
ALTER TABLE webhook_outbox
  ADD COLUMN locked_until TIMESTAMPTZ,
  ADD COLUMN lease_token UUID;

ALTER TABLE webhook_outbox DROP CONSTRAINT webhook_outbox_status_check;
ALTER TABLE webhook_outbox ADD CONSTRAINT webhook_outbox_status_check
  CHECK (status IN ('pending', 'dispatching', 'dispatched', 'failed'));

ALTER TABLE webhook_outbox ADD CONSTRAINT webhook_outbox_lease_check
  CHECK (
    (status = 'dispatching' AND locked_until IS NOT NULL AND lease_token IS NOT NULL)
    OR
    (status <> 'dispatching' AND locked_until IS NULL AND lease_token IS NULL)
  );

CREATE INDEX idx_webhook_outbox_expired_leases
  ON webhook_outbox (locked_until)
  WHERE status = 'dispatching';
