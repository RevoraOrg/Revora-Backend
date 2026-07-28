-- Migration: Create social identities table
-- Description: Links verified Google/Apple provider subjects to existing users.

CREATE TABLE IF NOT EXISTS social_identities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('google', 'apple')),
  provider_subject TEXT NOT NULL,
  provider_email TEXT NOT NULL,
  email_verified BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  CONSTRAINT social_identities_provider_subject_unique
    UNIQUE (provider, provider_subject),
  CONSTRAINT social_identities_user_provider_unique
    UNIQUE (user_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_social_identities_user_id
  ON social_identities(user_id);

CREATE INDEX IF NOT EXISTS idx_social_identities_provider_email
  ON social_identities(provider, provider_email);
