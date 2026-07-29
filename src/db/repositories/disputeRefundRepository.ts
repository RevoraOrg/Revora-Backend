import { Pool } from 'pg';

export interface DisputeRefund {
  id: string;
  dispute_id: string;
  amount: string;
  reason: string | null;
  ledger_event_id: string | null;
  created_at: Date;
}

export class DisputeRefundRepository {
  constructor(private readonly db: Pool) {}

  async create(refund: Omit<DisputeRefund, 'id' | 'created_at'>): Promise<DisputeRefund> {
    const query = `
      INSERT INTO dispute_refunds (dispute_id, amount, reason, ledger_event_id)
      VALUES ($1, $2, $3, $4)
      RETURNING *
    `;
    const result = await this.db.query(query, [
      refund.dispute_id,
      refund.amount,
      refund.reason,
      refund.ledger_event_id,
    ]);
    return result.rows[0];
  }

  async sumRefundsForDispute(disputeId: string): Promise<number> {
    const query = `
      SELECT COALESCE(SUM(amount), 0) as total
      FROM dispute_refunds
      WHERE dispute_id = $1
    `;
    const result = await this.db.query(query, [disputeId]);
    return parseFloat(result.rows[0].total);
  }

  async listByDispute(disputeId: string): Promise<DisputeRefund[]> {
    const query = `
      SELECT *
      FROM dispute_refunds
      WHERE dispute_id = $1
      ORDER BY created_at ASC
    `;
    const result = await this.db.query(query, [disputeId]);
    return result.rows;
  }
}
