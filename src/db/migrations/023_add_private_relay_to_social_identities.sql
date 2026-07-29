-- Migration: Add private-relay flag to social identities
-- Description: Marks Apple "Hide My Email" addresses as transient so that
--              account lookups never key on the private-relay email.  New
--              relay emails from re-installs update the stored email without
--              affecting the stable (provider, provider_subject) identity.
--
-- Security context: LOW — additive-only schema change; no existing data is
--                   modified or moved.

ALTER TABLE social_identities
  ADD COLUMN IF NOT EXISTS is_private_relay BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN social_identities.is_private_relay IS
  'Apple "Hide My Email" flag. When TRUE the provider_email is a transient '
  'forwarding address that may change on app re-installation. Account lookup '
  'must key on provider_subject, not email.';
