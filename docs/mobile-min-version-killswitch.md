# Mobile Companion API — Minimum-Version Kill Switch

> **Issue:** [#692](https://github.com/RevoraOrg/Revora-Backend/issues/692)
> **Status:** Implemented

## Overview

Old mobile clients occasionally send legacy payloads that bypass new validation.
This feature adds a **signed minimum-version enforcement gate** to the mobile
companion API (`/mobile/*` routes) that forces outdated clients to upgrade.

The gate reads the client's version from the `X-Client-Min-Version` request
header and compares it against a server-held **Ed25519-signed policy document**
that declares the oldest acceptable client version.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Mobile Client                         │
│  X-Client-Min-Version: 2.3.1                           │
└──────────────────────┬──────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────┐
│           Version Gate Middleware                         │
│  1. Read X-Client-Min-Version header                     │
│  2. Compare to policy.minClientVersion                   │
│  3. Reject with 503 + upgradeUrl if below minimum       │
│  4. Emit mobile.min_version.rejected metric              │
└──────────────────────┬──────────────────────────────────┘
                       │ (if allowed)
                       ▼
┌─────────────────────────────────────────────────────────┐
│         Device Signature Middleware                       │
│  Ed25519 per-device request signing verification         │
└──────────────────────┬──────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────┐
│               Route Handler                              │
└─────────────────────────────────────────────────────────┘
```

## Policy Document Format

The signed policy document is a JSON object with the following structure:

```json
{
  "version": "1.0.0",
  "counter": 42,
  "minClientVersion": "2.3.0",
  "upgradeUrl": "https://example.com/upgrade",
  "expiresAt": "2026-12-31T23:59:59.999Z"
}
```

### Fields

| Field              | Type     | Required | Description                                                        |
|--------------------|----------|----------|--------------------------------------------------------------------|
| `version`          | string   | Yes      | Semver of this policy document                                     |
| `counter`          | number   | Yes      | Monotonic counter — rejects policy downgrade                       |
| `minClientVersion` | string   | Yes      | Oldest client version the server will accept (semver)              |
| `upgradeUrl`       | string   | Yes      | Actionable URL the client should open to upgrade                   |
| `expiresAt`        | string   | No       | ISO-8601 expiry timestamp; if in the past, the policy is rejected  |

### Signing

The policy JSON is serialized with **deterministic key ordering** (sorted keys,
recursively), then signed with an **Ed25519 private key**. The server holds the
corresponding public key and verifies the signature before accepting the policy.

The `SignedPolicyBundle` wire format is:

```json
{
  "policyBase64": "<base64-encoded canonical JSON>",
  "signatureBase64url": "<base64url-encoded Ed25519 signature>"
}
```

## Security Model

### Invariants

1. **Signed policy only** — the policy document must carry a valid Ed25519
   signature against the server's trusted public key. An unsigned or
   invalidly-signed policy is rejected.

2. **Monotonic counter** — the `counter` field in the policy must be
   **≥ the currently loaded counter**. An attempt to load a policy with a
   lower counter is rejected, preventing rollback of version enforcement.

3. **Expiry enforcement** — if `expiresAt` is present and in the past, the
   policy is treated as stale and rejected.

4. **Fail-open on missing header** — if the client does not send the
   `X-Client-Min-Version` header, the request is **allowed through**.
   This prevents a misconfigured client from being accidentally locked out,
   and the device-signature middleware still enforces authentication.

5. **Fail-closed on invalid format** — if the client sends a version header
   that is not valid semver, the request is **rejected with 400**.

### Threat Considerations

| Threat                          | Mitigation                                                          |
|---------------------------------|---------------------------------------------------------------------|
| Attacker forges policy          | Ed25519 signature verification against trusted public key           |
| Attacker rolls back policy      | Monotonic counter enforcement                                       |
| Expired policy stays active     | `expiresAt` checked on load                                         |
| Client sends garbage version    | Invalid semver → 400 Bad Request                                    |
| Missing version header          | Fail-open; device auth still enforced                               |
| Version comparison bypass       | Semver parsed as `[major, minor, patch]` tuple, compared lexicographically |

## Usage

### 1. Generate a signing keypair

```bash
# Generate Ed25519 keypair for policy signing
openssl genpkey -algorithm Ed25519 -out policy-signing-key.pem
openssl pkey -in policy-signing-key.pem -pubout -out policy-verification-key.pem
```

### 2. Create a policy document

```typescript
import { stableStringify, MobileVersionPolicy } from './middleware/mobileMinVersion';
import crypto from 'crypto';

const policy: MobileVersionPolicy = {
  version: '1.0.0',
  counter: 1,
  minClientVersion: '2.0.0',
  upgradeUrl: 'https://revora.com/upgrade',
};

const canonicalJson = stableStringify(policy);
const policyBase64 = Buffer.from(canonicalJson, 'utf-8').toString('base64');

const privateKey = crypto.createPrivateKey(fs.readFileSync('policy-signing-key.pem', 'utf-8'));
const sigBuffer = crypto.sign(null as any, Buffer.from(canonicalJson, 'utf-8'), privateKey);
const signatureBase64url = sigBuffer.toString('base64url');

const bundle = { policyBase64, signatureBase64url };
```

### 3. Wire into the mobile companion router

```typescript
import { createMobileMinVersionMiddleware } from './middleware/mobileMinVersion';
import { createMobileCompanionRouter } from './routes/mobileCompanion';

const versionGate = createMobileMinVersionMiddleware({
  trustedPublicKeyPem: fs.readFileSync('policy-verification-key.pem', 'utf-8'),
});

// Load the initial policy at startup
versionGate.loadPolicy(initialPolicyBundle);

// Mount the mobile companion router with the version gate
apiRouter.use('/mobile', createMobileCompanionRouter({
  versionGateMiddleware: versionGate.middleware,
}));
```

### 4. Rotate the policy

To update the minimum version, create a new policy with a **higher counter**
and call `versionGate.loadPolicy(newBundle)`. The old policy is replaced
atomically.

```typescript
// Update the policy (counter must be > current)
const newPolicy: MobileVersionPolicy = {
  version: '1.1.0',
  counter: 2,  // must be > 1
  minClientVersion: '2.5.0',
  upgradeUrl: 'https://revora.com/upgrade',
};
versionGate.loadPolicy(signAndEncode(newPolicy));
```

## Metrics

| Metric                              | Type    | Description                                           |
|-------------------------------------|---------|-------------------------------------------------------|
| `mobile.min_version.rejected`       | counter | Incremented for every rejected request                |
| `mobile.min_version.policy_loaded`  | counter | Incremented when a new policy is successfully loaded  |
| `mobile.min_version.signature_failed` | counter | Incremented when a policy signature verification fails |

## Error Responses

### 400 Bad Request — Invalid Version Format

```json
{
  "code": "BAD_REQUEST",
  "message": "Invalid client version format: \"abc\" — expected semver (e.g. 1.2.3)"
}
```

### 503 Service Unavailable — Version Too Old

```json
{
  "code": "SERVICE_UNAVAILABLE",
  "message": "Client version 1.0.0 is below the minimum required version 2.0.0. Please upgrade.",
  "details": {
    "code": "CLIENT_VERSION_TOO_OLD",
    "minRequiredVersion": "2.0.0",
    "clientVersion": "1.0.0",
    "upgradeUrl": "https://revora.com/upgrade"
  }
}
```

## Testing

Run the test suite:

```bash
npx jest --testPathPatterns='mobileMinVersion' --coverage
```

The test suite covers:
- Semver parsing and comparison (edge cases, invalid input)
- Policy signature verification (valid, tampered, wrong key, garbage)
- Signed policy loading (valid, invalid base64, invalid JSON, missing fields,
  counter downgrade, expired policy, invalid semver)
- Version gate evaluation (allow, reject, missing header, invalid format)
- Express middleware integration (allow, reject, custom header)
- Mobile companion route integration (version gate before device auth)
- Edge cases (large counters, zero counter, two-part versions)

## Design Decisions

### Why fail-open on missing header?

An alternative would be to **reject** requests without a version header. However,
this creates a risk: if a client update removes the header accidentally, all
such clients would be locked out immediately. The fail-open approach is safer
because:

1. The device-signature middleware still enforces authentication.
2. The operator can observe the `mobile.min_version.rejected` metric to see
   if many clients are below the minimum.
3. A future enhancement could add a "strict mode" that rejects missing headers.

### Why Ed25519?

Ed25519 is the same algorithm used by the device-signature middleware and the
OFAC sanctions loader, maintaining consistency with the existing crypto
infrastructure. It provides fast signing/verification and strong security.

### Why monotonic counter instead of just semver comparison of the policy?

A monotonic counter is simpler and more reliable than comparing the entire
policy document. It directly answers the question "is this an older policy
than what we have?" without needing to parse and compare individual fields.

## Follow-up Issues

- [ ] **Policy distribution service**: Currently the policy is loaded manually.
      A background service could periodically fetch and verify the latest
      policy from a signed endpoint.
- [ ] **Strict mode**: Add an option to reject requests without a version
      header (for environments where all clients are expected to send it).
- [ ] **Client-side SDK**: Publish a client-side library that reads the
      policy's `upgradeUrl` and shows an upgrade prompt.
