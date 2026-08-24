# Pull Request: Contract Upgrade Canary Rollout

## Summary

Adds a guarded canary phase before global Soroban contract rollout. Approved and simulated upgrades can activate against a network-configured shadow offering, hold for a required period, and promote only when the latest metrics remain within threshold.

## Changes

- Added `CANARY_OFFERING_ID_TESTNET` and `CANARY_OFFERING_ID_MAINNET` configuration.
- Uses the active network's configured shadow offering when the request omits an override.
- Allows `canary_passed` upgrades to proceed through `applyUpgrade` for general rollout.
- Rejects invalid, non-finite metrics, thresholds, and out-of-range hold periods.
- Preserves automatic and explicit canary rollback with audit events and alarm logging.
- Updated canary tests and operational documentation.

## Security Notes

- Existing attestation, two-key approval, code-id pinning, and simulation gates remain required.
- A canary metric breach automatically transitions the upgrade to `rolled_back`.
- Promotion requires elapsed hold time and clean latest metrics.
- Explicit offering overrides should be restricted to controlled operator workflows; production deployments should rely on network configuration.

## Validation

- `npx jest --runInBand --coverage=false src/__tests__/contractUpgradeOrchestratorService.test.ts src/__tests__/contractUpgradeRoutes.test.ts`
  - 2 suites passed, 62 tests passed.
- `npm test -- --runInBand`
  - Blocked by existing repository-wide `ts-jest`/TypeScript module-resolution failures in unrelated suites.
- `npm run build`
  - Blocked by existing repository-wide TypeScript errors outside the canary change.

## Deployment

Set the appropriate variable before enabling canary starts:

```env
CANARY_OFFERING_ID_TESTNET=<testnet-shadow-offering-id>
CANARY_OFFERING_ID_MAINNET=<public-shadow-offering-id>
```

Apply migration `020_contract_upgrades_canary.sql` before using the canary endpoints.