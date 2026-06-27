# TODO - Contract Upgrade Orchestrator

## Step 1: Repo understanding (completed)
- [x] Reviewed migration runner + filename safety rules
- [x] Reviewed relevant service/security/admin files

## Step 2: Database migration
- [ ] Create `src/db/migrations/XXX_create_contract_upgrades.sql`
  - [ ] Define `contract_upgrades` table and status workflow
  - [ ] Add indexes + constraints for idempotency and monotonicity

## Step 3: Orchestrator service
- [ ] Implement `ContractUpgradeOrchestratorService`
  - [ ] Create request (status=pending, pin target `code_id`)
  - [ ] Approve request (two-key approval, distinct identities)
  - [ ] Apply request
    - [ ] Run dry-run simulation first
    - [ ] Block submission on any simulation failure/timeout
    - [ ] Record tx hash on success and set status=applied
    - [ ] Record failure details on failure and set status=failed

## Step 4: Horizon dry-run + real submission wiring
- [ ] Implement simulation logic (Horizon simulate) with deterministic parsing
- [ ] Ensure apply uses the exact pinned `proposed_code_id`
- [ ] Alarm emission on dry-run failure

## Step 5: Audit log integration
- [ ] Persist upgrade lifecycle events to existing audit log/audit hashing system

## Step 6: Admin endpoints
- [ ] Add endpoints to `src/routes/admin.ts`
  - [ ] POST create
  - [ ] POST approve
  - [ ] POST apply

## Step 7: Tests (>=95% coverage target)
- [ ] Unit tests for orchestrator state transitions and security edge cases
  - [ ] Happy path
  - [ ] Approver collusion (same identity)
  - [ ] Code-id mismatch protection
  - [ ] Dry-run failure blocks submission + records failure + alarm
  - [ ] Dry-run timeout treated as failure
- [ ] Run `npm test`

## Step 8: Migration execution
- [ ] Run `npm run migrate` against local DB (with DATABASE_URL set)

