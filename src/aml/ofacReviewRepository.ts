import { Pool, PoolClient, QueryResult } from 'pg';
import { CreateOFACReviewInput, OFACReview } from './types';

export class OFACReviewRepository {
  constructor(private db: Pool) {}

  async create(input: CreateOFACReviewInput, creatorId: string): Promise<OFACReview> {
    const query = `
      INSERT INTO ofac_reviews (
        id, alert_id, case_id, investor_id, matched_name, list_entry_id,
        status, created_by, clearance_rationale, expires_at, created_at, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, 'pending_first_approval', $7, $8, $9, NOW(), NOW())
      RETURNING *
    `;
    const values = [
      this.generateId(),
      input.alert_id,
      input.case_id || null,
      input.investor_id,
      input.matched_name,
      input.list_entry_id || null,
      creatorId,
      input.rationale,
      input.expires_at || this.defaultExpiry(),
    ];

    const result: QueryResult<OFACReview> = await this.db.query(query, values);
    return this.mapReview(result.rows[0]);
  }

  async findQueue(now = new Date()): Promise<OFACReview[]> {
    await this.reopenExpired(now);

    const query = `
      SELECT *
      FROM ofac_reviews
      WHERE status IN ('pending_first_approval', 'pending_second_approval')
      ORDER BY created_at ASC
    `;
    const result: QueryResult<OFACReview> = await this.db.query(query);
    return result.rows.map(row => this.mapReview(row));
  }

  async findById(reviewId: string): Promise<OFACReview | null> {
    const result: QueryResult<OFACReview> = await this.db.query(
      'SELECT * FROM ofac_reviews WHERE id = $1',
      [reviewId]
    );
    return result.rows.length > 0 ? this.mapReview(result.rows[0]) : null;
  }

  async approve(reviewId: string, approverId: string, rationale: string, now = new Date()): Promise<OFACReview> {
    const client = await this.db.connect();

    try {
      await client.query('BEGIN');
      const locked = await client.query('SELECT * FROM ofac_reviews WHERE id = $1 FOR UPDATE', [reviewId]);
      if (locked.rows.length === 0) {
        throw new Error(`OFAC review ${reviewId} not found`);
      }

      let review = this.mapReview(locked.rows[0]);
      if (review.expires_at.getTime() <= now.getTime() && review.status !== 'cleared') {
        review = await this.resetExpiredReview(client, review.id, now);
      }

      if (review.status === 'cleared') {
        throw new Error(`OFAC review ${reviewId} is already cleared`);
      }
      if (review.created_by === approverId) {
        throw new Error('Review creator cannot approve their own OFAC clearance');
      }
      if (review.first_approver_id === approverId) {
        throw new Error('Same compliance officer cannot approve an OFAC review twice');
      }

      const updated = review.status === 'pending_first_approval'
        ? await this.recordFirstApproval(client, reviewId, approverId, rationale, now)
        : await this.recordSecondApproval(client, review, approverId, rationale, now);

      await client.query('COMMIT');
      return updated;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async reopenExpired(now = new Date()): Promise<void> {
    await this.db.query(
      `
        UPDATE ofac_reviews
        SET status = 'pending_first_approval',
            first_approver_id = NULL,
            first_approval_rationale = NULL,
            first_approved_at = NULL,
            second_approver_id = NULL,
            second_approval_rationale = NULL,
            second_approved_at = NULL,
            cleared_at = NULL,
            updated_at = NOW()
        WHERE status = 'pending_second_approval' AND expires_at <= $1
      `,
      [now]
    );
  }

  private async recordFirstApproval(
    client: PoolClient,
    reviewId: string,
    approverId: string,
    rationale: string,
    now: Date
  ): Promise<OFACReview> {
    const result = await client.query(
      `
        UPDATE ofac_reviews
        SET status = 'pending_second_approval',
            first_approver_id = $1,
            first_approval_rationale = $2,
            first_approved_at = $3,
            updated_at = NOW()
        WHERE id = $4
        RETURNING *
      `,
      [approverId, rationale, now, reviewId]
    );
    return this.mapReview(result.rows[0]);
  }

  private async recordSecondApproval(
    client: PoolClient,
    review: OFACReview,
    approverId: string,
    rationale: string,
    now: Date
  ): Promise<OFACReview> {
    const clearanceRationale = [
      review.clearance_rationale,
      `first approver ${review.first_approver_id}: ${review.first_approval_rationale}`,
      `second approver ${approverId}: ${rationale}`,
    ].filter(Boolean).join('\n');

    const result = await client.query(
      `
        UPDATE ofac_reviews
        SET status = 'cleared',
            second_approver_id = $1,
            second_approval_rationale = $2,
            second_approved_at = $3,
            clearance_rationale = $4,
            cleared_at = $3,
            updated_at = NOW()
        WHERE id = $5
        RETURNING *
      `,
      [approverId, rationale, now, clearanceRationale, review.id]
    );
    return this.mapReview(result.rows[0]);
  }

  private async resetExpiredReview(client: PoolClient, reviewId: string, now: Date): Promise<OFACReview> {
    const result = await client.query(
      `
        UPDATE ofac_reviews
        SET status = 'pending_first_approval',
            first_approver_id = NULL,
            first_approval_rationale = NULL,
            first_approved_at = NULL,
            second_approver_id = NULL,
            second_approval_rationale = NULL,
            second_approved_at = NULL,
            cleared_at = NULL,
            updated_at = NOW()
        WHERE id = $1 AND expires_at <= $2
        RETURNING *
      `,
      [reviewId, now]
    );
    return this.mapReview(result.rows[0]);
  }

  private mapReview(row: { [key: string]: any }): OFACReview {
    return {
      id: row.id,
      alert_id: row.alert_id,
      case_id: row.case_id || undefined,
      investor_id: row.investor_id,
      matched_name: row.matched_name,
      list_entry_id: row.list_entry_id || undefined,
      status: row.status,
      created_by: row.created_by,
      created_at: row.created_at,
      first_approver_id: row.first_approver_id || undefined,
      first_approval_rationale: row.first_approval_rationale || undefined,
      first_approved_at: row.first_approved_at || undefined,
      second_approver_id: row.second_approver_id || undefined,
      second_approval_rationale: row.second_approval_rationale || undefined,
      second_approved_at: row.second_approved_at || undefined,
      clearance_rationale: row.clearance_rationale || undefined,
      cleared_at: row.cleared_at || undefined,
      expires_at: row.expires_at,
      updated_at: row.updated_at,
    };
  }

  private defaultExpiry(): Date {
    return new Date(Date.now() + 24 * 60 * 60 * 1000);
  }

  private generateId(): string {
    return `ofac_review_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
}
