-- Durable monthly spend totals shared by all application replicas.
CREATE TABLE fx_provider_spend (
  tenant_id   TEXT          NOT NULL,
  provider_id TEXT          NOT NULL,
  month_key   TEXT          NOT NULL
    CHECK (month_key ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  spend_usd   NUMERIC(24, 8) NOT NULL DEFAULT 0
    CHECK (spend_usd >= 0),
  updated_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  CONSTRAINT fx_provider_spend_tenant_provider_month_key
    UNIQUE (tenant_id, provider_id, month_key)
);
