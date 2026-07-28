# Investor Statement Draft Watermark and Version Stamp (#487)

## Overview

Draft investor statements shared pre-audit must be visibly marked `"DRAFT - subject to audit"` to ensure no version confusion reaches auditors or external stakeholders.

This component adds:
1. **Diagonal Draft Watermark**: Applied to all pre-audit statement PDFs by default (`"DRAFT - subject to audit"`).
2. **Footer Version Stamp**: Keyed to the `ledger_revision` hash, embedded into every statement PDF (draft and final).
3. **Ed25519 Treasury Signature Verification**: Suppresses the draft watermark **only** when a valid signature from the treasury role key is verified against the statement payload.
4. **Audit Event Emission**: Emits a `pdf.watermark.suppressed` audit event whenever watermark suppression is granted.

---

## Architecture & Flow

```
                                  ┌───────────────────────────────┐
                                  │      renderStatementPdf       │
                                  └───────────────┬───────────────┘
                                                  │
                                                  ▼
                                 ┌─────────────────────────────────┐
                                 │ Is valid Ed25519 Treasury Sig?  │
                                 └────────┬────────────────┬───────┘
                                          │                │
                                       NO │                │ YES
                                          ▼                ▼
                     ┌──────────────────────────┐   ┌─────────────────────────────┐
                     │ Keep Watermark ON        │   │ Suppress Watermark          │
                     │ "DRAFT - subject to audit"│   │ Emit pdf.watermark.suppressed│
                     └────────────┬─────────────┘   └──────────────┬──────────────┘
                                  │                                │
                                  └────────────────┬───────────────┘
                                                   │
                                                   ▼
                                  ┌─────────────────────────────────┐
                                  │ Attach Footer Version Stamp     │
                                  │ ledger_revision=<hash>          │
                                  └─────────────────────────────────┘
```

---

## Technical Specification

### 1. Draft Watermark Layer
- **Text**: `DRAFT - subject to audit`
- **Orientation**: Diagonal (45° angle)
- **PDF Structure**: PDF pagination watermark annotation + text comment stream.
- **Default State**: Active (ON).

### 2. Footer Version Stamp
- **Text**: `ledger_revision=<hash>`
- **Keying**: Bound to `ledgerRevisionHash` or checksum of `period_id:investor_id`.
- **Presence**: Embedded in all statements (both draft and final).

### 3. Treasury Role Key Ed25519 Verification
- **Key Source**: `options.treasuryPublicKey` or `process.env.TREASURY_ED25519_PUBKEY`.
- **Supported Formats**:
  - PEM string (`-----BEGIN PUBLIC KEY----- ...`)
  - SPKI DER Buffer / Hex / Base64
  - Raw 32-byte Ed25519 public key (Hex or Base64)
  - Node.js `crypto.KeyObject`

#### Signed Payload Structure
```typescript
export interface FinalSignaturePayload {
  periodId: string;
  investorId: string;
  ledgerRevisionHash: string;
  timestamp: number;
  expiresAt?: number;
}
```

#### Verification Steps
1. Verify `payload.periodId === job.period_id`.
2. Verify `payload.investorId === job.investor_id`.
3. Verify `payload.ledgerRevisionHash === options.ledgerRevisionHash` (if provided).
4. Verify `expiresAt`: If `Date.now() > expiresAt`, reject (expired).
5. Verify `timestamp`: Reject future timestamps (> 5 min) or stale timestamps (> 24 hours without `expiresAt`).
6. Verify Ed25519 signature over canonical payload string using treasury public key.

### 4. Audit Event Emission
When watermark suppression succeeds:
- Event name: `pdf.watermark.suppressed`
- Global emitter: `statementPdfEventEmitter`
- Payload:
  ```json
  {
    "event": "pdf.watermark.suppressed",
    "periodId": "2026-07",
    "investorId": "inv-123",
    "ledgerRevisionHash": "rev-hash-abc",
    "batchId": "batch-456",
    "timestamp": "2026-07-28T12:00:00.000Z"
  }
  ```
- If `auditLogRepository` is provided, a row is inserted into `audit_logs` with action `pdf.watermark.suppressed`.

---

## Security Assumptions & Boundary Enforcement

| Scenario / Edge Case | Behaviour | Resulting State |
|----------------------|-----------|-----------------|
| Missing final signature | Watermark retained | `DRAFT - subject to audit` |
| Forged or incorrect Ed25519 signature | Signature verification fails | `DRAFT - subject to audit` |
| Signature expired (`expiresAt` in past) | Expiry check fails | `DRAFT - subject to audit` |
| Period or Investor ID mismatch | Payload validation fails | `DRAFT - subject to audit` |
| Mismatched ledger revision hash | Ledger hash check fails | `DRAFT - subject to audit` |
| Treasury public key missing | Key lookup fails | `DRAFT - subject to audit` |
| Valid Ed25519 signature by treasury key | All checks pass | Watermark SUPPRESSED + Audit Event Emitted |

---

## Code Locations

| Component | Path |
|-----------|------|
| PDF Renderer & Signature Verification | [`src/services/statementPdfService.ts`](../src/services/statementPdfService.ts) |
| Batch Worker Integration | [`src/services/statementPdfBatchWorker.ts`](../src/services/statementPdfBatchWorker.ts) |
| Environment Schema | [`src/config/env.ts`](../src/config/env.ts) |
| Unit Tests | [`src/services/statementPdfService.test.ts`](../src/services/statementPdfService.test.ts) |
| Batch Worker Tests | [`src/services/statementPdfBatchWorker.test.ts`](../src/services/statementPdfBatchWorker.test.ts) |

---

## Running Tests

```bash
npx jest --runInBand \
  src/services/statementPdfService.test.ts \
  src/services/statementPdfBatchWorker.test.ts \
  --coverage \
  --collectCoverageFrom='src/services/statementPdfService.ts' \
  --collectCoverageFrom='src/services/statementPdfBatchWorker.ts'
```
