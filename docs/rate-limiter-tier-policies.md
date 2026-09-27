# Rate Limiter Tier Policies

## Overview
This capability enforces rate-limiting based on caller tiers, protecting the startup registration endpoint and other sensitive routes from abuse.

## Tiers
- **Standard**: Default tier for unauthenticated or unprivileged callers. (e.g. 5 req / time window)
- **Trusted**: Elevated tier for trusted third-party integrators. Requires a valid shared secret. (e.g. 10 req / time window)
- **Internal**: Highest tier for internal services. Requires a valid shared secret. (e.g. 25 req / time window)

## Security Assumptions
- Tier resolution is performed via the `x-revora-rate-tier` request header.
- Privileged tiers (`trusted`, `internal`) require a valid shared secret in `x-revora-tier-secret`; an absent, empty, or mismatched secret causes a silent downgrade to the `standard` tier (fail-safe).
- If no tier header is supplied, the request is treated as `standard`.
- Rate-limit state is currently in-process; a distributed store (e.g., Redis) must be substituted for multi-instance deployments.
