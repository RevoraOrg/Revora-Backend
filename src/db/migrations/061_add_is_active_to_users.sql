-- Migration: add is_active / deactivated_at to users (#1300)
-- Set by SCIM deprovisioning. Existing users stay active.
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE users ADD COLUMN IF NOT EXISTS deactivated_at TIMESTAMP WITH TIME ZONE;
