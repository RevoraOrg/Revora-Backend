"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AuditLogRepository = void 0;
/**
 * Audit Log Repository
 * Handles database operations for audit logs
 */
class AuditLogRepository {
    constructor(db) {
        this.db = db;
    }
    /**
     * Create a new audit log entry
     * @param input Audit log data
     * @returns Created audit log
     */
    async createAuditLog(input) {
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
        const result = await this.db.query(query, values);
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
    async getAuditLogsByUser(userId, limit = 50) {
        const query = `
      SELECT * FROM audit_logs
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT $2
    `;
        const result = await this.db.query(query, [
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
    async getAuditLogsByAction(action, limit = 50) {
        const query = `
      SELECT * FROM audit_logs
      WHERE action = $1
      ORDER BY created_at DESC
      LIMIT $2
    `;
        const result = await this.db.query(query, [
            action,
            limit,
        ]);
        return result.rows.map((row) => this.mapAuditLog(row));
    }
    mapAuditLog(row) {
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
exports.AuditLogRepository = AuditLogRepository;
