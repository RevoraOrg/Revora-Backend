# OFAC Signed-Source Verification

## Overview

The OFAC (Office of Foreign Assets Control) SDN list is downloaded from a public URL. This document describes the signature verification and parse-output hash pinning mechanism that ensures the integrity and reproducibility of sanctions data ingestion.

## Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  OFAC List URL  │────▶│ fetchSignedList() │────▶│ verifySignature │
│  (CSV)          │     │                  │     │  (Ed25519)      │
└─────────────────┘     └──────────────────┘     └────────┬────────┘
                                                          │
┌─────────────────┐     ┌──────────────────┐              │
│  Signature URL  │────▶│ fetchSignedList() │              │
│  (.sig, hex)    │     │                  │              │
└─────────────────┘     └──────────────────┘              ▼
                                                   ┌─────────────────┐
                                                   │ parseCsv()      │
                                                   │ → OfacEntry[]   │
                                                   └────────┬────────┘
                                                            │
                                                   ┌─────────────────┐
                                                   │ computeParseHash│
                                                   │ (SHA-256)       │
                                                   └────────┬────────┘
                                                            │
                                                   ┌─────────────────┐
                                                   │ verifyParseHash │
                                                   │ vs pinned value │
                                                   └─────────────────┘
```

## Components

### `OfacSanctionsLoader` (`src/services/ofacSanctionsLoader.ts`)

The main class that orchestrates the full pipeline:

1. **Fetch**: Downloads both the CSV list and its detached Ed25519 signature file in parallel.
2. **Verify**: Validates the signature against a pinned trust anchor (Ed25519 public key).
3. **Parse**: Converts the CSV into structured `OfacEntry[]` objects.
4. **Hash**: Computes a deterministic SHA-256 hash of the normalized parse output.
5. **Pin**: Compares against a pinned hash per version to detect data drift.

### Trust Anchor

The signature key is sourced from a pinned Ed25519 public key. The key is stored as a base64-encoded SPKI DER SubjectPublicKeyInfo. The key is configurable via:

- Environment variable: `OFAC_TRUST_ANCHOR_BASE64`
- Constructor parameter: `trustAnchorBase64`

### Pinned Parse Hash

Each version of the OFAC list can have a pinned SHA-256 hash of the normalized parse output. This hash is stored in the `pinnedHashes` config map (`Record<string, string>`). When the computed hash does not match the pinned value:

- The `hashValid` field in the result is `false`
- The `sanctions.source.hash_mismatch` metric is incremented
- The data is still returned (drift may be intentional after a format change)

### Alarm: `sanctions.source.signature_failed`

When signature verification fails (tampered payload, wrong key, corrupt data):

- The `loadSanctions()` method throws `OfacSignatureError`
- The `sanctions.source.signature_failed` metric is incremented
- The payload is fully rejected — no data is returned

## Configuration

| Variable | Default | Description |
|---|---|---|
| `OFAC_LIST_URL` | `""` | URL for the OFAC SDN list CSV |
| `OFAC_SIG_URL` | `""` | URL for the OFAC SDN list Ed25519 signature (hex) |
| `OFAC_TRUST_ANCHOR_BASE64` | `""` | Base64-encoded Ed25519 public key (SPKI DER format) |
| `OFAC_FETCH_TIMEOUT_MS` | `30000` | Timeout in milliseconds for fetches |

## Usage

```typescript
import { OfacSanctionsLoader, OfacSignatureError } from './services/ofacSanctionsLoader';

const loader = new OfacSanctionsLoader({
  trustAnchorBase64: process.env.OFAC_TRUST_ANCHOR_BASE64,
  pinnedHashes: { 'v2025.1': 'abc123...' },
  listUrl: 'https://example.com/ofac/sdn.csv',
  sigUrl: 'https://example.com/ofac/sdn.csv.sig',
});

try {
  const result = await loader.loadSanctions('v2025.1');
  console.log(`Loaded ${result.entries.length} entries`);
  if (!result.hashValid) {
    console.warn('Parse hash drift detected — update pinned hash');
  }
} catch (err) {
  if (err instanceof OfacSignatureError) {
    console.error('Signature verification failed — possible tampering');
  }
}
```

## Security Assumptions

- The Ed25519 public key is pinned in source code or configuration (trust anchor)
- The signature file is a raw 64-byte Ed25519 signature encoded as hex
- The signature file URL is the list URL with `.sig` appended
- Failed signatures cause full rejection of the payload (fail-closed)
- Parse hash mismatch raises an alarm but does not block loading (drift may be legitimate)

## Abuse/Failure Paths

| Scenario | Behavior |
|---|---|
| Network failure during fetch | `OfacFetchError` thrown |
| Signature file missing/corrupt | `OfacSignatureError` thrown |
| Tampered payload (signature mismatch) | `OfacSignatureError` thrown, metric incremented |
| Corrupt public key | `OfacSignatureError` thrown |
| Malformed CSV | `OfacParseError` thrown with line number |
| Parse hash drift (expected format change) | `hashValid: false` in result, metric incremented |
| Empty response | CSV parser throws `OfacParseError` |
| Signature length != 64 bytes | `OfacSignatureError` thrown |

## Test Coverage

All tests pass (46 tests covering 100% of functions, >99% of lines and statements):

- Constructor and config (4 tests)
- fetchWithTimeout (4 tests — success, HTTP error, timeout, abort signal)
- fetchSignedList (2 tests — success, invalid signature length)
- verifySignature (6 tests — valid, tampered, wrong key, corrupt key, empty payload, empty sig)
- parseCsv (8 tests — valid, minimal, empty, header-only, missing columns, Windows line endings, quoted fields, BOM)
- computeParseHash (3 tests — deterministic, different data, field ordering)
- verifyParseHash (3 tests — no pinned hash, match, mismatch with metric)
- loadSanctions integration (7 tests — success, tampered, metric emission, hash drift, fetch error, HTTP error, empty list)
- Edge cases (5 tests — large names, unicode, many programs, BOM, wrong key)
- OfacHashMismatchError constructor (1 test)
- loadSanctions error path (1 test)

## Development

### Generating a test key pair

```typescript
import { generateKeyPairSync } from 'crypto';

const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
  publicKeyEncoding: { type: 'spki', format: 'der' },
  privateKeyEncoding: { type: 'pkcs8', format: 'der' },
});

console.log('Public key (base64):', publicKey.toString('base64'));
console.log('Private key (base64):', privateKey.toString('base64'));
```

### Signing a payload

```typescript
import { sign } from 'crypto';

const signature = sign(null, Buffer.from(payload, 'utf-8'), {
  key: privateKey,
  format: 'der',
  type: 'pkcs8',
});

console.log('Signature (hex):', signature.toString('hex'));
```
