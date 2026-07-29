# OIDC Group-to-Role Mapping

This feature enables mapping OIDC claims (specifically `groups`) to Revora roles (`startup` or `investor`).

## Overview
Enterprise investors often use groups in their Identity Providers (IdP) to manage application permissions. Revora supports mapping these incoming group claims to internal roles via the `oidc_group_mappings` table.

## Behavior
- **Mapping Lookup**: Upon successful IdP callback validation, the user's incoming `groups` claim is inspected.
- **Role Assignment**: If any group matches a configuration in `oidc_group_mappings` for the current tenant, the user is assigned the corresponding `revora_role`.
- **Audit Logging**: To ensure transparency and traceability, an `oidc.claim.changed` audit log is emitted whenever a user lands with a different set of groups than their last observed session (`last_oidc_groups` on the `users` table).
- **Missing Claims**: If the `groups` claim is absent or empty, the application **preserves** the existing roles (this prevents transient claim failures from abruptly revoking permissions).

## Database Schema
The mapping is stored in `oidc_group_mappings`, which is linked via foreign key to `oidc_providers`.

- `tenant_id`: The identifier for the IdP integration.
- `claim_group`: The name of the group expected from the IdP.
- `revora_role`: The internal Revora role to map to (`startup` or `investor`).

## Testing
This logic is comprehensively covered in `src/auth/oidc/oidcCallback.test.ts`, verifying both the audit-on-change requirement and the preservation of roles on missing claims.
