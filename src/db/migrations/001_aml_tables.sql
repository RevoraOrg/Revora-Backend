/**
 * AML Transaction Monitoring Database Schema
 * 
 * Creates tables for AML rules, alerts, cases, and version history.
 * All tables include proper indexes for performance and audit compliance.
 */

-- AML Rules Table
CREATE TABLE IF NOT EXISTS aml_rules (
  id VARCHAR(255) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  description TEXT NOT NULL,
  type VARCHAR(50) NOT NULL CHECK (type IN ('velocity', 'structuring', 'geo_mismatch', 'amount_threshold')),
  version JSONB NOT NULL,
  severity VARCHAR(20) NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  enabled BOOLEAN NOT NULL DEFAULT true,
  config JSONB NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Indexes for aml_rules
CREATE INDEX idx_aml_rules_type ON aml_rules(type);
CREATE INDEX idx_aml_rules_enabled ON aml_rules(enabled);
CREATE INDEX idx_aml_rules_severity ON aml_rules(severity);
CREATE INDEX idx_aml_rules_created_at ON aml_rules(created_at DESC);

-- AML Rule Version History Table
CREATE TABLE IF NOT EXISTS aml_rule_version_history (
  id VARCHAR(255) PRIMARY KEY,
  rule_id VARCHAR(255) NOT NULL REFERENCES aml_rules(id) ON DELETE CASCADE,
  version JSONB NOT NULL,
  config JSONB NOT NULL,
  enabled BOOLEAN NOT NULL,
  changed_by VARCHAR(255) NOT NULL,
  change_reason TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Indexes for aml_rule_version_history
CREATE INDEX idx_aml_rule_history_rule_id ON aml_rule_version_history(rule_id);
CREATE INDEX idx_aml_rule_history_created_at ON aml_rule_version_history(created_at DESC);
CREATE INDEX idx_aml_rule_history_changed_by ON aml_rule_version_history(changed_by);

-- AML Alerts Table
CREATE TABLE IF NOT EXISTS aml_alerts (
  id VARCHAR(255) PRIMARY KEY,
  investment_id VARCHAR(255) NOT NULL,
  investor_id VARCHAR(255) NOT NULL,
  rule_id VARCHAR(255) NOT NULL REFERENCES aml_rules(id),
  rule_version JSONB NOT NULL,
  severity VARCHAR(20) NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  details JSONB NOT NULL,
  status VARCHAR(20) NOT NULL CHECK (status IN ('pending', 'reviewed', 'dismissed')) DEFAULT 'pending',
  case_id VARCHAR(255),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Indexes for aml_alerts
CREATE INDEX idx_aml_alerts_investment_id ON aml_alerts(investment_id);
CREATE INDEX idx_aml_alerts_investor_id ON aml_alerts(investor_id);
CREATE INDEX idx_aml_alerts_rule_id ON aml_alerts(rule_id);
CREATE INDEX idx_aml_alerts_severity ON aml_alerts(severity);
CREATE INDEX idx_aml_alerts_status ON aml_alerts(status);
CREATE INDEX idx_aml_alerts_case_id ON aml_alerts(case_id);
CREATE INDEX idx_aml_alerts_created_at ON aml_alerts(created_at DESC);

-- AML Cases Table
CREATE TABLE IF NOT EXISTS aml_cases (
  id VARCHAR(255) PRIMARY KEY,
  alert_ids JSONB NOT NULL,
  investor_id VARCHAR(255) NOT NULL,
  status VARCHAR(20) NOT NULL CHECK (status IN ('open', 'assigned', 'investigating', 'closed', 'dismissed')) DEFAULT 'open',
  assigned_to VARCHAR(255),
  disposition VARCHAR(30) CHECK (disposition IN ('confirmed_suspicious', 'false_positive', 'inconclusive', 'legitimate')),
  notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  closed_at TIMESTAMP WITH TIME ZONE
);

-- Indexes for aml_cases
CREATE INDEX idx_aml_cases_investor_id ON aml_cases(investor_id);
CREATE INDEX idx_aml_cases_status ON aml_cases(status);
CREATE INDEX idx_aml_cases_assigned_to ON aml_cases(assigned_to);
CREATE INDEX idx_aml_cases_disposition ON aml_cases(disposition);
CREATE INDEX idx_aml_cases_created_at ON aml_cases(created_at DESC);

-- Add comments for documentation
COMMENT ON TABLE aml_rules IS 'AML rule definitions with semver versioning';
COMMENT ON TABLE aml_rule_version_history IS 'Version history for AML rules for audit compliance';
COMMENT ON TABLE aml_alerts IS 'Alerts generated when AML rules trigger';
COMMENT ON TABLE aml_cases IS 'Cases for analyst workflow to review alerts';

COMMENT ON COLUMN aml_rules.version IS 'Semver version as JSONB: {major, minor, patch}';
COMMENT ON COLUMN aml_rules.config IS 'Rule-specific configuration parameters';
COMMENT ON COLUMN aml_alerts.details IS 'Evaluation details explaining why rule triggered';
COMMENT ON COLUMN aml_cases.alert_ids IS 'Array of alert IDs associated with this case';
COMMENT ON COLUMN aml_cases.disposition IS 'Final outcome of case investigation';
