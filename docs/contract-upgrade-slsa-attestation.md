# Contract Upgrade SLSA Attestation Verification

This document describes the contract upgrade attestation verification flow implemented for the Revora backend.

## Purpose

When a new Soroban contract code-id is proposed for upgrade, the backend verifies a reproducible build attestation (SLSA level 3) before accepting the proposal.

## Security controls

- Builder identity list is stored in tenant settings.
- The upload API rejects proposals lacking a valid reproducible build attestation.
- Attestation builder identity must match one of the configured tenant builder identities.
- The attestation subject must contain a digest that matches the target Soroban code-id.

## Audit logging

A successful attestation verification emits the `upgrade.attestation.verified` audit event before the upgrade proposal is recorded.

## Implementation details

- New security module: `src/security/attestationVerifier.ts`
- New route: `src/routes/contractUpgradeRoutes.ts`
- New tenant settings repository: `src/db/repositories/tenantSettingsRepository.ts`
- Updated contract upgrade orchestrator service to perform verification before proposal creation
- Database migrations:
  - `src/db/migrations/016_create_contract_upgrades.sql`
  - `src/db/migrations/017_create_tenant_settings.sql`

## Assumptions

- Tenant settings are authoritative for which builder identities are trusted.
- The attestation payload contains a `builder.id` and a `subject` digest matching the code-id.
- Invalid or unknown builders are rejected before any contract upgrade proposal is persisted.
