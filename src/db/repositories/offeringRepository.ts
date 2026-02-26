import { Pool, QueryResult } from 'pg';

export interface Offering {
  id: string;
  issuer_id: string;
  name: string;
  symbol: string;
  status: 'draft' | 'active' | 'completed';
  created_at: Date;
  updated_at: Date;
}

export class OfferingRepository {
  constructor(private db: Pool) {}

  async findById(id: string): Promise<Offering | null> {
    const query = 'SELECT * FROM offerings WHERE id = $1';
    const result: QueryResult<Offering> = await this.db.query(query, [id]);

    if (result.rows.length === 0) {
      return null;
    }

    return result.rows[0];
  }

  async isOwner(offeringId: string, issuerId: string): Promise<boolean> {
    const offering = await this.findById(offeringId);
    return offering !== null && offering.issuer_id === issuerId;
  }
}
