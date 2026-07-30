# Dispute evidence bundle export

## Summary

The dispute workflow now exposes a signed evidence bundle export endpoint at `/api/v1/disputes/:disputeId/evidence/export`.

## Behavior

- Accepts one or more stored artifacts and optional reviewer metadata.
- Builds a deterministic manifest with SHA-256 hashes for each artifact.
- Includes request-id chain and reviewer identity in the manifest for auditability.
- Encodes the artifact payloads in base64 for reproducible export.
- Produces an HMAC-SHA256 signature over a canonical manifest representation.

## Security notes

- The signing secret is sourced from `DISPUTE_EVIDENCE_SIGNING_SECRET`, falling back to existing audit/signing environment variables when present.
- The endpoint is protected by the existing authentication middleware and should be treated as a sensitive export endpoint.
- The bundle is intended for downstream verification rather than direct trust decisions.
