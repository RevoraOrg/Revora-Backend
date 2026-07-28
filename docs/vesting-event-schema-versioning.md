# Vesting Event Schema Versioning

## Overview

This document defines the versioning scheme for vesting event schemas used in partial claim tracking and schedule management.

## Schema Versions

### v1.0 (Initial)
- Basic vesting event structure
- Fields: `amount`, `timestamp`, `vesting_schedule_id`
- No partial claim support

### v1.1 (Partial Claims)
- Added partial claim cursor fields
- New fields:
  - `claimed_amount`: Cumulative claimed
  - `last_claim_index`: Position in schedule
  - `ledger_entries`: Array of claim records
- Backward compatible with v1.0

### v1.2 (Future)
- Planned: Multi-asset vesting support
- Planned: Conditional vesting triggers

## Version Detection

Schemas include a `version` field to indicate the active schema version. Contracts must validate and migrate data as needed.

## Migration Rules

- v1.0 to v1.1: Initialize `claimed_amount` to 0, `last_claim_index` to -1
- Automatic migration on first partial claim

## Security Notes

- Schema versions prevent data corruption during upgrades
- All migrations are tested and audited
- Incompatible changes require explicit user consent
