import { Pool, PoolClient } from 'pg';

export interface DisputeLedgerEvent {
  id: string;
  dispute_id: string;
  investor_id: string;
  amount: string;
  type: string;
  created_at: Date;
}

export class DisputeLedgerEventRepository {
  constructor(private readonly db: Pool) {}

  async createBatch(events: Omit<DisputeLedgerEvent, 'id' | 'created_at'>[], client?: PoolClient): Promise<DisputeLedgerEvent[]> {
    if (events.length === 0) return [];
    
    const queryable = client || this.db;
    
    // Construct parameterized batch insert
    const values: any[] = [];
    const placeholders: string[] = [];
    
    events.forEach((event, index) => {
      const offset = index * 4;
      placeholders.push(`($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4})`);
      values.push(event.dispute_id, event.investor_id, event.amount, event.type);
    });
    
    const query = `
      INSERT INTO dispute_ledger_events (dispute_id, investor_id, amount, type)
      VALUES ${placeholders.join(', ')}
      RETURNING *
    `;
    
    const result = await queryable.query(query, values);
    return result.rows;
  }

  async listByDispute(disputeId: string): Promise<DisputeLedgerEvent[]> {
    const query = `
      SELECT *
      FROM dispute_ledger_events
      WHERE dispute_id = $1
      ORDER BY created_at ASC
    `;
    const result = await this.db.query(query, [disputeId]);
    return result.rows;
  }
}
