import { Pool, QueryResult } from 'pg';

/**
 * Audit Log entity
 */
export interface AuditLog {
  id: string;
  user_id?: string | null;
  action: string;
  resource?: string | null;
  details?: string | null;
  ip_address?: string | null;
  user_agent?: string | null;
  created_at: Date;
}

/**
 * Audit Log input for creation
 */
export interface CreateAuditLogInput {
  user_id?: string | null;
  action: string;
  resource?: string | null;
  details?: string | null;
  ip_address?: string | null;
  user_agent?: string | null;
}

/**
 * Audit Log Repository
 * Handles database operations for audit logs
 */
export class AuditLogRepository {
  constructor(private db: Pool) {}

  /**
   * Create a new audit log entry
   * @param input Audit log data
   * @returns Created audit log
   */
  async createAuditLog(input: CreateAuditLogInput): Promise<AuditLog> {
    const query = `
      INSERT INTO audit_logs (
        user_id,
        action,
        resource,
        details,
        ip_address,
        user_agent,
        created_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, NOW())
      RETURNING *
    `;

    const values = [
      input.user_id,
      input.action,
      input.resource,
      input.details,
      input.ip_address,
      input.user_agent,
    ];

    const result: QueryResult<AuditLog> = await this.db.query(query, values);

    if (result.rows.length === 0) {
      throw new Error('Failed to create audit log');
    }

    return this.mapAuditLog(result.rows[0]);
  }

  /**
   * Get audit logs by user
   * @param userId User ID
   * @param limit Optional limit
   * @returns Array of audit logs
   */
  async getAuditLogsByUser(
    userId: string,
    limit: number = 50
  ): Promise<AuditLog[]> {
    const query = `
      SELECT * FROM audit_logs
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT $2
    `;

    const result: QueryResult<AuditLog> = await this.db.query(query, [
      userId,
      limit,
    ]);

    return result.rows.map((row) => this.mapAuditLog(row));
  }

  /**
   * Get audit logs by action
   * @param action Action type
   * @param limit Optional limit
   * @returns Array of audit logs
   */
  async getAuditLogsByAction(
    action: string,
    limit: number = 50
  ): Promise<AuditLog[]> {
    const query = `
      SELECT * FROM audit_logs
      WHERE action = $1
      ORDER BY created_at DESC
      LIMIT $2
    `;

    const result: QueryResult<AuditLog> = await this.db.query(query, [
      action,
      limit,
    ]);

    return result.rows.map((row) => this.mapAuditLog(row));
  }

  private mapAuditLog(row: any): AuditLog {
    return {
      id: row.id,
      user_id: row.user_id,
      action: row.action,
      resource: row.resource,
      details: row.details,
      ip_address: row.ip_address,
      user_agent: row.user_agent,
      created_at: row.created_at,
    };
  }
}