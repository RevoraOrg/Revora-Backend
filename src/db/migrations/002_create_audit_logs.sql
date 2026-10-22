-- Migration: Create audit_logs table
CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID,
  action VARCHAR(255) NOT NULL,
  resource VARCHAR(255),
  details TEXT,
  ip_address INET,
  user_agent TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create index on user_id for faster queries
CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id ON audit_logs(user_id);

-- Create index on action for faster queries
CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action);

-- Create index on created_at for faster queries and retention purge
-- (supports scheduled purge: DELETE FROM audit_logs WHERE created_at < :cutoff)
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at);
