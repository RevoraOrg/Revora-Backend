# Offering Validation Matrix

## Summary

The backend now exposes a deterministic offering validation capability at `POST /api/v1/offerings/validation-matrix`.

It evaluates whether a caller is allowed to perform a specific offering action and which business-rule checks passed or failed. The response is intentionally reviewable and safe to return to clients: it contains stable rule codes, omits raw infrastructure errors, and never relies on implicit coercion for money or dates.

The payload parser, decision matrix, authentication middleware, and route factory live in `src/routes/offeringValidation.ts`; `src/index.ts` mounts that router under the versioned API.

## Supported actions

- `create`
- `update`
- `publish`
- `pause`
- `close`
- `cancel`
- `viewPrivate`
- `invest`

## Authentication boundary

The route requires both headers below:

- `x-user-id`
- `x-user-role`

Supported roles:

- `startup`
- `admin`
- `compliance`
- `investor`

If either header is missing or the role is unsupported, the route returns `401`.

## Decision model

The route returns:

- `200` when every matrix check passes
- `422` when the request is well formed but one or more validation rules fail
- `400` when the payload shape is invalid
- `401` when auth headers are missing or unsupported

Response shape:

```json
{
  "allowed": false,
  "decision": "deny",
  "action": "pause",
  "actor": {
    "id": "issuer-1",
    "role": "startup"
  },
  "offeringId": "off-2",
  "checks": [
    {
      "code": "ROLE_ALLOWED_FOR_ACTION",
      "passed": true,
      "severity": "error",
      "message": "startup may not perform pause for offering workflows"
    }
  ],
  "violations": [],
  "securityAssumptions": [
    "Caller identity is asserted by trusted upstream auth middleware before these rules are used for authorization."
  ]
}
```

`checks` always remain in deterministic order so logs, tests, and client-side review tooling can diff results safely.

## Security assumptions

- Upstream auth is trusted to bind `x-user-id` and `x-user-role` to a real principal.
- Decimal amounts are supplied as strings and validated strictly before numeric comparison.
- Startup actors can only manage their own offerings unless the actor is `admin` or `compliance`.
- Issuer self-investment is denied by default unless a future compliance flow explicitly allows it.
- Validation output is safe to log and expose because raw upstream or persistence-layer errors are not included.

## Abuse and failure-path notes

- Invalid `action`, `status`, amount, and date inputs are rejected explicitly instead of being coerced.
- Money parsing is bounded to avoid `Infinity`, exponent notation, and unexpected float parsing behavior.
- Investment validation denies requests outside the subscription window even when other checks pass.
- Management actions such as `pause`, `close`, and `cancel` are constrained by current offering status.
- Privileged review of private offerings is limited to `admin` and `compliance`, plus the issuer when ownership matches.

## Test coverage focus

The backend test suite now covers:

- direct decision-matrix evaluation with deterministic time input
- health dependency sanitization
- deterministic Stellar failure classification
- auth boundary enforcement for the matrix endpoint
- ownership checks
- investment-window validation
- self-investment denial
- privileged private-review access
- deterministic parsing helpers

## CI notes

CI-sensitive cleanup included:

- removing the circular dependency between `src/routes/health.ts` and `src/index.ts`
- deduplicating `UniqueConstraintError` in `src/lib/errors.ts`
- replacing the oversized `src/routes/health.test.ts` with focused, deterministic coverage
