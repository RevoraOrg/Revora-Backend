// src/lib/investmentConsistencyGuard.ts

import { PoolClient } from 'pg';
import { InvestmentRepository } from '../db/repositories/investmentRepository';

export type OfferingStatus =
  | "draft"
  | "pending_review"
  | "approved"
  | "rejected"
  | "published"
  | "archived";

/**
 * @notice Statuses that allow investments to be made
 * @dev Only published offerings can receive investments
 */
export const INVESTABLE_STATUSES: OfferingStatus[] = ["published"];

/**
 * @notice Checks if an offering can receive investments
 */
export function canInvest(offeringStatus: OfferingStatus): boolean {
  return INVESTABLE_STATUSES.includes(offeringStatus);
}

/**
 * @notice Validates investment amount
 * @dev Amount must be a positive number
 */
export function isValidAmount(amount: number): boolean {
  return typeof amount === "number" && amount > 0 && isFinite(amount);
}

/**
 * @notice Enforces all investment consistency rules
 * @throws Error if any rule is violated
 */
export function enforceInvestmentConsistency(input: {
  offeringStatus: OfferingStatus;
  amount: number;
  investorId: string;
  offeringId: string;
}): void {
  const { offeringStatus, amount, investorId, offeringId } = input;

  if (!offeringId) {
    throw new Error("Offering ID is required");
  }

  if (!investorId) {
    throw new Error("Investor ID is required");
  }

  if (!offeringStatus) {
    throw new Error("Offering status is required");
  }

  if (!INVESTABLE_STATUSES.includes(offeringStatus)) {
    throw new Error(
      `Offering is not open for investment. Current status: ${offeringStatus}`
    );
  }

  if (amount === undefined || amount === null) {
    throw new Error("Investment amount is required");
  }

  if (!isValidAmount(amount)) {
    throw new Error(
      "Investment amount must be a positive number"
    );
  }
}

/**
 * @notice Enforces the per-investor concentration cap atomically.
 *
 * Must be called inside an open database transaction:
 *   1. Locks the offering row FOR UPDATE (prevents concurrent overruns).
 *   2. Reads the investor's existing committed investment total.
 *   3. Rejects if (existing + newAmount) would exceed the cap.
 *
 * Falls back to allowing the investment when `max_investor_share_bps` is
 * NULL or missing (i.e. no cap configured on-chain).
 *
 * @param client  Active pg PoolClient with an open transaction.
 * @param repo    InvestmentRepository instance.
 * @param input   { investorId, offeringId, newAmount, totalOfferingAmount }
 *                - totalOfferingAmount: the offering's target/total size, used
 *                  to convert the BPS cap into an absolute amount. Pass as a
 *                  numeric string (e.g. offering.target_amount).
 * @throws Error if the cap would be exceeded.
 */
export async function enforceConcentrationCap(
  client: PoolClient,
  repo: InvestmentRepository,
  input: {
    investorId: string;
    offeringId: string;
    newAmount: number;
    totalOfferingAmount: number;
  },
): Promise<void> {
  const { investorId, offeringId, newAmount, totalOfferingAmount } = input;

  // 1. Lock the offering row so concurrent submissions serialize here.
  const offering = await repo.lockOffering(client, offeringId);
  if (!offering) {
    throw new Error(`Offering ${offeringId} not found`);
  }

  // 2. No cap configured — allow.
  if (offering.max_investor_share_bps == null) {
    return;
  }

  // 3. Compute absolute cap amount from BPS.
  const capAmount = (offering.max_investor_share_bps / 10_000) * totalOfferingAmount;

  // 4. Read existing investor commitment inside the same tx.
  const existingTotal = parseFloat(await repo.getInvestorTotalForOffering(client, investorId, offeringId));

  // 5. Reject if the new investment pushes the investor over the cap.
  if (existingTotal + newAmount > capAmount) {
    throw new Error(
      `Investment would exceed the per-investor concentration cap of ${offering.max_investor_share_bps} bps` +
      ` (${capAmount} units). Investor has already committed ${existingTotal} units.`,
    );
  }
}
