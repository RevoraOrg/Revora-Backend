# Dispute refund integrity

`POST /disputes/:disputeId/refund` accepts `amount`, `distributionId`, and optional
`reason`/`ledgerEventId`. It does not accept `originalDisbursement`: the refund
service reads `distributions.total_amount` using the supplied distribution ID.
Refund amounts must be positive and fit the database's four-decimal refund and
ledger precision.

Only authenticated `admin` and `compliance` identities may process refunds.
This policy is enforced by the route handler in addition to the route's
authentication middleware; investor and other roles receive HTTP 403. The
distribution reference and amount are treated as untrusted request input; the
server-side distribution row is the source of the cap.

Within a single database transaction, the service acquires a PostgreSQL
transaction-scoped advisory lock keyed by dispute ID, reads the distribution
total, re-sums prior refunds with decimal arithmetic, and creates the refund and
ledger reversals. The lock ensures concurrent requests for the same dispute
observe committed refunds before checking the cap. A hash collision can only
serialize otherwise unrelated disputes; it cannot bypass the cap.

Investor reversals use each payout's share of the distribution's payout total.
The service converts shares to four-decimal integer units and assigns rounding
remainders by largest fractional share, with investor ID as a deterministic tie
breaker. Therefore the reversal entries always sum exactly to the negative
refund amount. A refund against a distribution with no positive payouts is
rejected instead of creating an unbalanced refund.

The current dispute schema does not expose a dispute-to-distribution ownership
relationship, so the route's authorization policy is restricted to the
administrative/compliance roles. Any future investor-owner policy must verify
that relationship against server-side dispute data before it is enabled.
