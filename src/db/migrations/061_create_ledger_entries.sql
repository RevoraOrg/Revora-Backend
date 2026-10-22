-- Migration: create ledger_entries table for general ledger export
-- Stores double-entry GL records queryable by account with cursor pagination.
-- PgLedgerEntryRepository (src/db/repositories/ledgerEntryRepository.ts) reads
-- this table; the composite index on (gl_account, id) supports keyset pagination.

CREATE TABLE IF NOT EXISTS ledger_entries (
  -- Stable, monotonically-ordered surrogate key used as cursor anchor.
  -- Using TEXT (UUID or opaque string) keeps the repository agnostic of the
  -- generation strategy and allows the in-memory implementation to match IDs.
  id            TEXT PRIMARY KEY,

  -- Account identifier in the chart of accounts (e.g. "1050-Custody").
  gl_account    TEXT NOT NULL,

  -- Calendar date the entry applies to (accounting date, not insertion time).
  entry_date    DATE NOT NULL,

  -- Human-readable narrative for the journal line.
  description   TEXT NOT NULL,

  -- Amounts stored as NUMERIC(24,8) to avoid floating-point rounding.
  -- Exactly one of debit/credit should be non-zero per entry; both columns
  -- are present so the schema mirrors standard double-entry bookkeeping.
  debit_amount  NUMERIC(24, 8) NOT NULL DEFAULT 0 CHECK (debit_amount  >= 0),
  credit_amount NUMERIC(24, 8) NOT NULL DEFAULT 0 CHECK (credit_amount >= 0),

  -- ISO 4217 currency code.
  currency      CHAR(3) NOT NULL,

  -- Wall-clock timestamp the row was inserted (used for audit trails).
  recorded_at   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

  -- Discriminator for programmatic filtering (e.g. 'deposit', 'fee', 'revenue').
  entry_type    TEXT NOT NULL
);

-- Primary access pattern: paginate all entries for a given account ordered by id.
-- Covers both the initial fetch (gl_account = $1 ORDER BY id LIMIT n) and the
-- cursor fetch (gl_account = $1 AND id > $cursor ORDER BY id LIMIT n).
CREATE INDEX IF NOT EXISTS idx_ledger_entries_gl_account_id
  ON ledger_entries (gl_account, id);

-- Secondary index to support date-range queries (future reporting features).
CREATE INDEX IF NOT EXISTS idx_ledger_entries_entry_date
  ON ledger_entries (entry_date);
