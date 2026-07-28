import { Pool } from 'pg';
import { DisputeRefundRepository, DisputeRefund } from '../db/repositories/disputeRefundRepository';
import { Errors } from '../lib/errors';
import { logger, Logger } from '../lib/logger';

export interface ProcessRefundParams {
  disputeId: string;
  amount: string;
  originalDisbursement: string;
  reason?: string;
  ledgerEventId?: string;
}

export class DisputeRefundService {
  private readonly refundRepo: DisputeRefundRepository;
  private readonly logger: Logger;

  constructor(db: Pool) {
    this.refundRepo = new DisputeRefundRepository(db);
    this.logger = logger.child({ service: 'DisputeRefundService' });
  }

  /**
   * Processes a partial refund for a dispute, enforcing the invariant that
   * the sum of all refunds cannot exceed the original disbursement amount.
   */
  async processPartialRefund(params: ProcessRefundParams): Promise<DisputeRefund> {
    const { disputeId, amount, originalDisbursement, reason, ledgerEventId } = params;
    
    const refundAmount = parseFloat(amount);
    const originalAmount = parseFloat(originalDisbursement);

    if (isNaN(refundAmount) || refundAmount <= 0) {
      throw Errors.badRequest('Refund amount must be a positive number');
    }

    if (isNaN(originalAmount) || originalAmount <= 0) {
      throw Errors.badRequest('Original disbursement must be a positive number');
    }

    // Enforce sum invariant
    const existingTotal = await this.refundRepo.sumRefundsForDispute(disputeId);
    
    if (existingTotal + refundAmount > originalAmount) {
      this.logger.warn('Partial refund invariant violation', {
        disputeId,
        existingTotal,
        refundAmount,
        originalAmount,
      });
      throw Errors.badRequest(
        `Sum of partial refunds (${existingTotal + refundAmount}) cannot exceed original disbursement (${originalAmount})`
      );
    }

    const refund = await this.refundRepo.create({
      dispute_id: disputeId,
      amount: refundAmount.toFixed(4),
      reason: reason || null,
      ledger_event_id: ledgerEventId || null,
    });

    this.logger.info('Processed partial refund for dispute', {
      disputeId,
      refundId: refund.id,
      amount: refund.amount,
      ledgerEventId: refund.ledger_event_id,
    });

    return refund;
  }
}
