import { Pool } from 'pg';
import { DisputeRefundRepository, DisputeRefund } from '../db/repositories/disputeRefundRepository';
import { DisputeLedgerEventRepository } from '../db/repositories/disputeLedgerEventRepository';
import { DistributionRepository } from '../db/repositories/distributionRepository';
import { Errors } from '../lib/errors';
import { logger, Logger } from '../lib/logger';
import { Decimal } from '../lib/decimal';
import { withTransaction } from '../db/transaction';

export interface ProcessRefundParams {
  disputeId: string;
  amount: string;
  originalDisbursement: string;
  reason?: string;
  ledgerEventId?: string;
  distributionId?: string;
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
   * Processes a partial refund for a dispute, enforcing the invariant that
   * the sum of all refunds cannot exceed the original disbursement amount.
   * Proportions the reversal across all investors in the original distribution.
   */
  async processPartialRefund(params: ProcessRefundParams): Promise<DisputeRefund> {
    const { disputeId, amount, originalDisbursement, reason, ledgerEventId, distributionId } = params;
    
    const refundAmountNum = parseFloat(amount);
    const originalAmountNum = parseFloat(originalDisbursement);

    if (isNaN(refundAmountNum) || refundAmountNum <= 0) {
      throw Errors.badRequest('Refund amount must be a positive number');
    }

    if (isNaN(originalAmountNum) || originalAmountNum <= 0) {
      throw Errors.badRequest('Original disbursement must be a positive number');
    }

    // Enforce sum invariant
    const existingTotal = await this.refundRepo.sumRefundsForDispute(disputeId);
    
    if (existingTotal + refundAmountNum > originalAmountNum) {
      this.logger.warn('Partial refund invariant violation', {
        disputeId,
        existingTotal,
        refundAmount: refundAmountNum,
        originalAmount: originalAmountNum,
      });
      throw Errors.badRequest(
        `Sum of partial refunds (${existingTotal + refundAmountNum}) cannot exceed original disbursement (${originalAmountNum})`
      );
    }

    const refundAmount = new Decimal(amount);
    const originalAmount = new Decimal(originalDisbursement);
    
    // We execute the refund creation and ledger reversals atomically
    let refund: DisputeRefund | undefined;
    
    await withTransaction(this.db, async (client) => {
      // Create the top-level refund record
      // Currently the DisputeRefundRepository uses the pool directly, 
      // but we can execute standard queries on the client for the transaction.
      const refundQuery = `
        INSERT INTO dispute_refunds (dispute_id, amount, reason, ledger_event_id)
        VALUES ($1, $2, $3, $4)
        RETURNING *
      `;
      const refundResult = await client.query(refundQuery, [
        disputeId,
        refundAmount.toString(),
        reason || null,
        ledgerEventId || null,
      ]);
      refund = refundResult.rows[0];

      // Proportional Ledger Reversal
      if (distributionId) {
        const payouts = await this.distributionRepo.getPayoutsForRun(distributionId);
        
        if (payouts.length > 0) {
          const eventsToInsert = payouts.map(payout => {
            const payoutAmount = new Decimal(payout.amount);
            // reversal = (payout / original_total) * refund
            const reversalShare = payoutAmount.divide(originalAmount).multiply(refundAmount);
            // Negate it to represent a reversal
            const reversalAmount = reversalShare.multiply(new Decimal('-1'));
            
            return {
              dispute_id: disputeId,
              investor_id: payout.investor_id,
              amount: reversalAmount.toString(),
              type: 'refund_reversal',
            };
          });

          await this.ledgerEventRepo.createBatch(eventsToInsert, client);
          
          this.logger.info('Processed proportional ledger reversals', {
            disputeId,
            distributionId,
            investorsAffected: payouts.length,
          });
        }
      }
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
