-- Migration: Tamper-evident hash chain for audit_logs (append-only integrity)
-- Each row stores prev_hash (prior row_hash) and row_hash (SHA-256 of canonical payload).

CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE audit_logs
  ADD COLUMN IF NOT EXISTS prev_hash CHAR(64),
  ADD COLUMN IF NOT EXISTS row_hash CHAR(64);

-- Genesis anchor shared with application verifier (src/security/auditHashChain.ts)
-- SHA-256('REVORA_AUDIT_LOG_GENESIS_v1')
CREATE OR REPLACE FUNCTION audit_log_genesis_hash() RETURNS CHAR(64) AS $$
  SELECT 'bee58147dc813f93e3b43277b5da53c1a1620f2258f953b75a25fe5774f999be';
$$ LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION audit_log_canonical_payload(
  p_id UUID,
  p_user_id UUID,
  p_action VARCHAR,
  p_resource VARCHAR,
  p_details TEXT,
  p_ip_address INET,
  p_user_agent TEXT,
  p_created_at TIMESTAMPTZ,
  p_prev_hash CHAR(64)
) RETURNS TEXT AS $$
  SELECT concat_ws(
    '|',
    coalesce(p_id::text, ''),
    coalesce(p_user_id::text, ''),
    coalesce(p_action, ''),
    coalesce(p_resource, ''),
    coalesce(p_details, ''),
    coalesce(host(p_ip_address), ''),
    coalesce(p_user_agent, ''),
    coalesce(floor(extract(epoch FROM p_created_at) * 1000)::bigint::text, ''),
    coalesce(p_prev_hash, '')
  );
$$ LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION audit_log_compute_row_hash(
  p_id UUID,
  p_user_id UUID,
  p_action VARCHAR,
  p_resource VARCHAR,
  p_details TEXT,
  p_ip_address INET,
  p_user_agent TEXT,
  p_created_at TIMESTAMPTZ,
  p_prev_hash CHAR(64)
) RETURNS CHAR(64) AS $$
  SELECT encode(
    digest(audit_log_canonical_payload(
      p_id, p_user_id, p_action, p_resource, p_details,
      p_ip_address, p_user_agent, p_created_at, p_prev_hash
    ), 'sha256'),
    'hex'
  );
$$ LANGUAGE sql IMMUTABLE;

-- Backfill hash chain for existing rows before append-only enforcement
DO $$
DECLARE
  rec RECORD;
  chain_prev CHAR(64);
  computed_hash CHAR(64);
BEGIN
  chain_prev := audit_log_genesis_hash();

  FOR rec IN
    SELECT id, user_id, action, resource, details, ip_address, user_agent, created_at
    FROM audit_logs
    WHERE row_hash IS NULL
    ORDER BY created_at ASC, id ASC
  LOOP
    computed_hash := audit_log_compute_row_hash(
      rec.id,
      rec.user_id,
      rec.action,
      rec.resource,
      rec.details,
      rec.ip_address,
      rec.user_agent,
      rec.created_at,
      chain_prev
    );

    UPDATE audit_logs
    SET prev_hash = chain_prev,
        row_hash = computed_hash
    WHERE id = rec.id;

    chain_prev := computed_hash;
  END LOOP;
END $$;

ALTER TABLE audit_logs
  ALTER COLUMN prev_hash SET NOT NULL,
  ALTER COLUMN row_hash SET NOT NULL;

CREATE OR REPLACE FUNCTION audit_log_before_insert() RETURNS TRIGGER AS $$
DECLARE
  last_hash CHAR(64);
BEGIN
  IF NEW.created_at IS NULL THEN
    NEW.created_at := NOW();
  END IF;

  SELECT row_hash INTO last_hash
  FROM audit_logs
  ORDER BY created_at DESC, id DESC
  LIMIT 1;

  IF last_hash IS NULL THEN
    NEW.prev_hash := audit_log_genesis_hash();
  ELSE
    NEW.prev_hash := last_hash;
  END IF;

  NEW.row_hash := audit_log_compute_row_hash(
    NEW.id,
    NEW.user_id,
    NEW.action,
    NEW.resource,
    NEW.details,
    NEW.ip_address,
    NEW.user_agent,
    NEW.created_at,
    NEW.prev_hash
  );

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_log_hash_chain_trigger ON audit_logs;
CREATE TRIGGER audit_log_hash_chain_trigger
  BEFORE INSERT ON audit_logs
  FOR EACH ROW
  EXECUTE FUNCTION audit_log_before_insert();

CREATE OR REPLACE FUNCTION audit_log_deny_mutation() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only: % operations are forbidden', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_log_deny_update ON audit_logs;
CREATE TRIGGER audit_log_deny_update
  BEFORE UPDATE ON audit_logs
  FOR EACH ROW
  EXECUTE FUNCTION audit_log_deny_mutation();

DROP TRIGGER IF EXISTS audit_log_deny_delete ON audit_logs;
CREATE TRIGGER audit_log_deny_delete
  BEFORE DELETE ON audit_logs
  FOR EACH ROW
  EXECUTE FUNCTION audit_log_deny_mutation();

CREATE INDEX IF NOT EXISTS idx_audit_logs_hash_chain ON audit_logs(created_at ASC, id ASC);
