-- Migration: add session_policy column to tenant_settings

ALTER TABLE tenant_settings 
ADD COLUMN IF NOT EXISTS session_policy VARCHAR(20) NOT NULL DEFAULT 'lax';
