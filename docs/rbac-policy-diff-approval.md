# RBAC Policy Diff Approval Process

## Overview

Small edits to `src/security/rbac.test.ts` or `src/security/types.ts` can inadvertently grant new capabilities or alter the authorization surface. To prevent accidental privilege expansion, the repository enforces a **policy-diff CI gate** that prints every added or removed permission grant per PR and blocks the merge unless an authorized reviewer applies the `rbac-approved` label.

## How It Works

1. **Trigger** — The `RBAC Policy Diff Gate` workflow runs automatically on every PR that touches `src/security/**`, `src/index.ts`, or any workflow file.
2. **Diff Computation** — The workflow extracts the canonical `enabledPermissions` matrix from `src/security/types.ts` on both the PR base branch and the PR head branch, serializes both to deterministic JSON fingerprints, and computes the symmetric difference.
3. **Label Gate** — If the diff is non-empty the workflow **fails** unless the PR carries the `rbac-approved` label. No-diff PRs pass automatically.
4. **Reviewer Action** — An authorized reviewer inspects the diff in the CI logs and, if the change is intentional, applies the `rbac-approved` label.

## Approver Responsibilities

- Verify that each added grant is required by a legitimate use case.
- Verify that each removed grant does not break existing service functionality or test expectations.
- Confirm the change aligns with the principle of least privilege.
- Apply the `rbac-approved` label only after the above checks are satisfied.

## Failure Paths

| Scenario | Result |
| :-------- | :------ |
| Noil diff | Pass automatically |
| Diff present, no `rbac-approved` label | Blocked with CI failure |
| Diff present, `rbac-approved` label present | Pass |
| Source parsing fails | Blocked (CI error) |

## Security Assumptions

- The canonical policy matrix is defined solely in `src/security/types.ts` (`DEFAULT_SECURITY_CONFIG.enabledPermissions`).
- The `rbac-approved` label represents an explicit human attestation that the permission change was reviewed.
- The workflow runs in the base-branch context (`pull_request_target`) and never executes untrusted PR code with a privileged token.
- The diff is computed from a deterministic serialization, so reviews are reproducible.

## Related Documents

- [`docs/security/milestone-validation-auth-matrix.md`](../docs/security/milestone-validation-auth-matrix.md)
- [`docs/rate-limiter-tier-policies.md`](../docs/rate-limiter-tier-policies.md)

## Troubleshooting

**Q: The workflow failed but I did not change permissions.**
A: Ensure you did not accidentally modify the `enabledPermissions` object in any checked-in file. Whitespace-only changes inside the block can also trigger the diff; re-check your edits.

**Q: Who can apply the `rbac-approved` label?**
A: Any user with write access to the repository. In a protected-branch setup, the label should be applied by a security-aware reviewer or maintainer.

**Q: Can I bypass the gate in an emergency?**
A: No automated bypass exists. Emergency changes still require review and the `rbac-approved` label; this prevents privilege-creep under pressure.
