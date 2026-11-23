import { Pool } from 'pg';
import { DisputeRefundRepository, DisputeRefund } from '../db/repositories/disputeRefundRepository';
import { DisputeLedgerEventRepository } from '../db/repositories/disputeLedgerEventRepository';
import { DistributionRepository } from '../db/repositories/distributionRepository';
import { Errors } from '../lib/errors';
import { logger, Logger } from '../lib/logger';
import { Decimal } from '../lib/decimal';
import { withTransaction } from '../db/transaction';

const REFUND_SCALE = 4;
const PAYOUT_SCALE = 10;

export interface ProcessRefundParams {
  disputeId: string;
  amount: string;
  reason?: string;
  ledgerEventId?: string;
  distributionId: string;
}

interface ReversalAllocation {
  investorId: string;
  amountUnits: bigint;
  remainder: bigint;
}

function toUnits(value: string, scale: number): bigint {
  const [integer, fraction = ''] = value.split('.');
  if (fraction.length > scale) {
    throw Errors.badRequest(`Amount must not exceed ${scale} decimal places`);
  }
  return BigInt(integer) * (10n ** BigInt(scale)) +
    BigInt((fraction + '0'.repeat(scale)).slice(0, scale) || '0');
}

function toLedgerAmount(units: bigint): string {
  return Decimal.fromScaledBigInt(units, REFUND_SCALE).toString();
}

function allocateReversals(
  refundAmount: Decimal,
  payouts: Array<{ investor_id: string; amount: string }>,
): Array<{ investor_id: string; amount: string }> {
  const payoutUnits = payouts.map((payout) => {
    const amount = new Decimal(payout.amount);
    if (!amount.isPositive()) {
      throw Errors.badRequest('Distribution payouts must be positive');
    }
    return { investorId: payout.investor_id, units: toUnits(payout.amount, PAYOUT_SCALE) };
  });
  const totalPayoutUnits = payoutUnits.reduce((sum, payout) => sum + payout.units, 0n);
  if (totalPayoutUnits <= 0n) {
    throw Errors.badRequest('Distribution has no positive payouts to reverse');
  }

  const refundUnits = toUnits(refundAmount.toString(), REFUND_SCALE);
  let allocatedUnits = 0n;
  const allocations: ReversalAllocation[] = payoutUnits.map((payout) => {
    const numerator = refundUnits * payout.units;
    const amountUnits = numerator / totalPayoutUnits;
    allocatedUnits += amountUnits;
    return {
      investorId: payout.investorId,
      amountUnits,
      remainder: numerator % totalPayoutUnits,
    };
  });

  let remainderUnits = refundUnits - allocatedUnits;
  const largestShares = [...allocations].sort((left, right) => {
    if (left.remainder === right.remainder) {
      return left.investorId < right.investorId ? -1 : left.investorId > right.investorId ? 1 : 0;
    }
    return left.remainder > right.remainder ? -1 : 1;
  });
  for (let index = 0; remainderUnits > 0n; index += 1) {
    largestShares[index].amountUnits += 1n;
    remainderUnits -= 1n;
  }

  return allocations.map((allocation) => ({
    investor_id: allocation.investorId,
    amount: toLedgerAmount(-allocation.amountUnits),
  }));
}

export class DisputeRefundService {
  private readonly refundRepo: DisputeRefundRepository;
  private readonly ledgerEventRepo: DisputeLedgerEventRepository;
  private readonly distributionRepo: DistributionRepository;
  private readonly logger: Logger;
  private readonly db: Pool;

  constructor(db: Pool) {
    this.db = db;
    this.refundRepo = new DisputeRefundRepository(db);
    this.ledgerEventRepo = new DisputeLedgerEventRepository(db);
    this.distributionRepo = new DistributionRepository(db);
    this.logger = logger.child({ service: 'DisputeRefundService' });
  }

  /**
   * Processes a partial refund against its server-side distribution total.
   * Advisory locking and all associated reads/writes share one transaction.
   */
  async processPartialRefund(params: ProcessRefundParams): Promise<DisputeRefund> {
    const { disputeId, amount, reason, ledgerEventId, distributionId } = params;
    const refundAmount = new Decimal(amount);

    if (!refundAmount.isPositive()) {
      throw Errors.badRequest('Refund amount must be a positive number');
    }
    if (amount.split('.')[1]?.length > REFUND_SCALE) {
      throw Errors.badRequest(`Refund amount must not exceed ${REFUND_SCALE} decimal places`);
    }
    if (!distributionId) {
      throw Errors.badRequest('distributionId is required');
    }

    let refund: DisputeRefund | undefined;

    await withTransaction(this.db, async (client) => {
      // The table has no dispute parent row; this transaction-scoped lock serializes
      // every refund for the same dispute, including the first refund.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [disputeId]);

      const originalAmountValue = await this.distributionRepo.getDistributionTotal(distributionId, client);
      if (originalAmountValue === null) {
        throw Errors.badRequest('Distribution was not found');
      }
      const originalAmount = new Decimal(originalAmountValue);
      if (!originalAmount.isPositive()) {
        throw Errors.badRequest('Original distribution total must be positive');
      }

      const existingTotal = new Decimal(await this.refundRepo.sumRefundsForDispute(disputeId, client));
      const nextTotal = existingTotal.add(refundAmount);
      if (nextTotal.compareTo(originalAmount) > 0) {
        this.logger.warn('Partial refund invariant violation', {
          disputeId,
          existingTotal: existingTotal.toString(),
          refundAmount: refundAmount.toString(),
          originalAmount: originalAmount.toString(),
        });
        throw Errors.badRequest(
          `Sum of partial refunds (${nextTotal.toString()}) cannot exceed original disbursement (${originalAmount.toString()})`,
        );
      }

      const payouts = await this.distributionRepo.getPayoutsForRun(distributionId, client);
      if (payouts.length === 0) {
        throw Errors.badRequest('Distribution has no payouts to reverse');
      }

      const refundResult = await client.query(
        `INSERT INTO dispute_refunds (dispute_id, amount, reason, ledger_event_id)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [disputeId, refundAmount.toString(), reason || null, ledgerEventId || null],
      );
      refund = refundResult.rows[0];

      const eventsToInsert = allocateReversals(refundAmount, payouts).map((event) => ({
        ...event,
        dispute_id: disputeId,
        type: 'refund_reversal',
      }));
      await this.ledgerEventRepo.createBatch(eventsToInsert, client);

      this.logger.info('Processed proportional ledger reversals', {
        disputeId,
        distributionId,
        investorsAffected: payouts.length,
      });
    });

    if (!refund) {
      throw Errors.internal('Failed to create dispute refund record');
    }

    this.logger.info('Processed partial refund for dispute', {
      disputeId,
      refundId: refund.id,
      amount: refund.amount,
      ledgerEventId: refund.ledger_event_id,
    });
    return refund;
  }
}
