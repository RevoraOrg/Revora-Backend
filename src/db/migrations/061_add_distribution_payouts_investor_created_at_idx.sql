-- Migration: Add composite index on distribution_payouts(investor_id, created_at)
-- Description: Supports the filtered, sorted, paginated payout queries issued by
--   DistributionRepository.searchPayoutsByInvestor.  The index covers the
--   mandatory equality predicate on investor_id and allows the planner to
--   satisfy ORDER BY created_at ASC/DESC via an index scan rather than a sort.
--   The status column index (idx_distribution_payouts_status) added in migration
--   015 remains useful for batch-level status sweeps; this index targets the
--   per-investor access pattern that dominates API traffic.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_distribution_payouts_investor_created_at
  ON distribution_payouts (investor_id, created_at);
