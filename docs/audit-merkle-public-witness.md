# Audit Log Public Witness (Merkle Root)

**Issue:** [#721](https://github.com/RevoraOrg/Revora-Backend/issues/721) — Audit-log integrity proofs: publish Merkle root to a public witness periodically  
**Status:** Implemented

---

## Overview

`auditHashChain` provides **internal** tamper-evidence. This feature adds a
periodic job that:

1. Computes the **Merkle root of the day's** audit `row_hash` values.
2. Posts the root to a public timestamping witness (Stellar memo / mock / injectable Rekor).
3. Persists the receipt in `audit_witness_receipts` for later verification.
4. Emits `audit.witness.published` on success.

Failed publishes retry with bounded exponential backoff and raise an ALARM on
exhaustion. **Witness downtime never breaks local integrity verification.**

---

## Architecture

```
  AuditIntegrityScheduler (nightly)
            │
            ├─ verifyAuditLogIntegrity()   ← local hash chain
            │
            └─ AuditWitnessPublisher
                   │
                   ├─ load day's row_hash values
                   ├─ computeMerkleRoot(leaves)
                   ├─ WitnessClient.publish(root)   ← mock | stellar | custom
                   └─ INSERT audit_witness_receipts
```

---

## Components

| File | Role |
|------|------|
| `src/security/auditMerkle.ts` | Pure Merkle helpers (`computeMerkleRoot`, `utcDayBounds`) |
| `src/security/witnessClient.ts` | `WitnessClient` interface + `MockWitnessClient` + `StellarMemoWitnessClient` |
| `src/security/auditWitnessPublisher.ts` | Day-root + chain-head publish with retry/backoff |
| `src/security/auditIntegrityScheduler.ts` | Nightly job wires verification → witness publish |
| `src/db/migrations/018_create_audit_witness_receipts.sql` | Receipt storage |

---

## Metrics

| Metric | Type | When |
|--------|------|------|
| `audit.witness.published` | counter | Root successfully published + receipt saved |
| `audit.witness.publish_errors` | counter | Retry budget exhausted (ALARM also logged) |

---

## Security assumptions

1. Only already-hashed `row_hash` values leave the system — no raw audit details
   are posted to the public witness.
2. Stellar text memos are truncated to 28 bytes; the full root is stored in the
   receipt for offline verification.
3. `STELLAR_SERVER_SECRET` (if used by an injected Horizon submitter) is never logged.
4. Publish failures are swallowed so local integrity checks always complete.

---

## Abuse / failure paths

| Scenario | Behaviour |
|----------|-----------|
| Empty day (no audit rows) | Skip publish; debug log |
| Root already published | Skip (idempotent) |
| Witness transient failure | Retry with exponential backoff |
| Witness downtime / exhausted retries | ALARM + `audit.witness.publish_errors`; local integrity unaffected |
| DB error loading day hashes | ALARM; local integrity unaffected |

---

## Testing

```bash
npx jest src/security/auditMerkle.test.ts src/security/auditWitnessPublisher.test.ts src/security/auditIntegrityScheduler.test.ts --forceExit
```

Covers Merkle construction (empty / single / odd leaf), day publish, retry,
exhaustion isolation, and Stellar dry-run receipts.
