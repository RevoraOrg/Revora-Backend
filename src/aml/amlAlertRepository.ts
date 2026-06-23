/**
 * AML Alert Repository
 * 
 * Manages AML alerts generated from rule evaluations
 * and their association with cases.
 */

import { Pool, QueryResult } from 'pg';
import {
  AMLAlert,
  AMLCase,
  CreateCaseInput,
  UpdateCaseInput,
  AMLCaseStatus,
} from './types';

/**
 * Repository for AML alert management
 */
export class AMLAlertRepository {
  constructor(private db: Pool) {}

  /**
   * Create a new AML alert
   * @param alert Alert data
   * @returns Created alert
   */
  async create(alert: Omit<AMLAlert, 'id' | 'created_at' | 'updated_at'>): Promise<AMLAlert> {
    const query = `
      INSERT INTO aml_alerts (
        id, investment_id, investor_id, rule_id, rule_version, severity, details, status, case_id, created_at, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW())
      RETURNING *
    `;

    const values = [
      this.generateId(),
      alert.investment_id,
      alert.investor_id,
      alert.rule_id,
      JSON.stringify(alert.rule_version),
      alert.severity,
      JSON.stringify(alert.details),
      alert.status,
      alert.case_id || null,
    ];

    const result: QueryResult<AMLAlert> = await this.db.query(query, values);
    return this.mapAlert(result.rows[0]);
  }

  /**
   * Find alert by ID
   * @param alertId Alert ID
   * @returns Alert or null
   */
  async findById(alertId: string): Promise<AMLAlert | null> {
    const query = 'SELECT * FROM aml_alerts WHERE id = $1';
    const result: QueryResult<AMLAlert> = await this.db.query(query, [alertId]);
    
    return result.rows.length > 0 ? this.mapAlert(result.rows[0]) : null;
  }

  /**
   * Find alerts by investment ID
   * @param investmentId Investment ID
   * @returns Array of alerts
   */
  async findByInvestment(investmentId: string): Promise<AMLAlert[]> {
    const query = 'SELECT * FROM aml_alerts WHERE investment_id = $1 ORDER BY created_at DESC';
    const result: QueryResult<AMLAlert> = await this.db.query(query, [investmentId]);
    return result.rows.map(row => this.mapAlert(row));
  }

  /**
   * Find alerts by investor ID
   * @param investorId Investor ID
   * @returns Array of alerts
   */
  async findByInvestor(investorId: string): Promise<AMLAlert[]> {
    const query = 'SELECT * FROM aml_alerts WHERE investor_id = $1 ORDER BY created_at DESC';
    const result: QueryResult<AMLAlert> = await this.db.query(query, [investorId]);
    return result.rows.map(row => this.mapAlert(row));
  }

  /**
   * Find pending alerts (not yet assigned to a case)
   * @returns Array of pending alerts
   */
  async findPending(): Promise<AMLAlert[]> {
    const query = `
      SELECT * FROM aml_alerts 
      WHERE status = 'pending' AND case_id IS NULL 
      ORDER BY created_at DESC
    `;
    const result: QueryResult<AMLAlert> = await this.db.query(query);
    return result.rows.map(row => this.mapAlert(row));
  }

  /**
   * Update alert status and optionally assign to case
   * @param alertId Alert ID
   * @param status New status
   * @param caseId Optional case ID
   * @returns Updated alert
   */
  async updateStatus(alertId: string, status: AMLAlert['status'], caseId?: string): Promise<AMLAlert> {
    const query = `
      UPDATE aml_alerts
      SET status = $1, case_id = $2, updated_at = NOW()
      WHERE id = $3
      RETURNING *
    `;

    const result: QueryResult<AMLAlert> = await this.db.query(query, [status, caseId || null, alertId]);
    
    if (result.rows.length === 0) {
      throw new Error(`Alert ${alertId} not found`);
    }

    return this.mapAlert(result.rows[0]);
  }

  /**
   * Create a new AML case
   * @param input Case creation data
   * @returns Created case
   */
  async createCase(input: CreateCaseInput): Promise<AMLCase> {
    const client = await this.db.connect();
    
    try {
      await client.query('BEGIN');

      // Create case
      const caseQuery = `
        INSERT INTO aml_cases (
          id, alert_ids, investor_id, status, assigned_to, disposition, notes, created_at, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
        RETURNING *
      `;

      const caseId = this.generateId();
      const caseValues = [
        caseId,
        JSON.stringify(input.alert_ids),
        input.investor_id,
        input.assigned_to ? 'assigned' : 'open',
        input.assigned_to || null,
        null,
        input.notes || null,
      ];

      const caseResult: QueryResult<AMLCase> = await client.query(caseQuery, caseValues);
      const amlCase = this.mapCase(caseResult.rows[0]);

      // Update alerts to link to case
      for (const alertId of input.alert_ids) {
        await client.query(
          'UPDATE aml_alerts SET status = $1, case_id = $2, updated_at = NOW() WHERE id = $3',
          ['reviewed', caseId, alertId]
        );
      }

      await client.query('COMMIT');
      return amlCase;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Find case by ID
   * @param caseId Case ID
   * @returns Case or null
   */
  async findCaseById(caseId: string): Promise<AMLCase | null> {
    const query = 'SELECT * FROM aml_cases WHERE id = $1';
    const result: QueryResult<AMLCase> = await this.db.query(query, [caseId]);
    
    return result.rows.length > 0 ? this.mapCase(result.rows[0]) : null;
  }

  /**
   * Find cases by status
   * @param status Case status
   * @returns Array of cases
   */
  async findCasesByStatus(status: AMLCaseStatus): Promise<AMLCase[]> {
    const query = 'SELECT * FROM aml_cases WHERE status = $1 ORDER BY created_at DESC';
    const result: QueryResult<AMLCase> = await this.db.query(query, [status]);
    return result.rows.map(row => this.mapCase(row));
  }

  /**
   * Find cases assigned to a specific analyst
   * @param analystId Analyst user ID
   * @returns Array of cases
   */
  async findCasesByAnalyst(analystId: string): Promise<AMLCase[]> {
    const query = 'SELECT * FROM aml_cases WHERE assigned_to = $1 ORDER BY created_at DESC';
    const result: QueryResult<AMLCase> = await this.db.query(query, [analystId]);
    return result.rows.map(row => this.mapCase(row));
  }

  /**
   * Update a case
   * @param caseId Case ID
   * @param input Update data
   * @returns Updated case
   */
  async updateCase(caseId: string, input: UpdateCaseInput): Promise<AMLCase> {
    const updates: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (input.status !== undefined) {
      updates.push(`status = $${paramIndex++}`);
      values.push(input.status);
    }
    if (input.assigned_to !== undefined) {
      updates.push(`assigned_to = $${paramIndex++}`);
      values.push(input.assigned_to);
    }
    if (input.disposition !== undefined) {
      updates.push(`disposition = $${paramIndex++}`);
      values.push(input.disposition);
    }
    if (input.notes !== undefined) {
      updates.push(`notes = $${paramIndex++}`);
      values.push(input.notes);
    }

    // Set closed_at if status is closed or dismissed
    if (input.status === 'closed' || input.status === 'dismissed') {
      updates.push(`closed_at = NOW()`);
    }

    updates.push(`updated_at = NOW()`);
    values.push(caseId);

    const query = `
      UPDATE aml_cases
      SET ${updates.join(', ')}
      WHERE id = $${paramIndex}
      RETURNING *
    `;

    const result: QueryResult<AMLCase> = await this.db.query(query, values);
    
    if (result.rows.length === 0) {
      throw new Error(`Case ${caseId} not found`);
    }

    return this.mapCase(result.rows[0]);
  }

  /**
   * Get alerts for a case
   * @param caseId Case ID
   * @returns Array of alerts
   */
  async getAlertsForCase(caseId: string): Promise<AMLAlert[]> {
    const query = 'SELECT * FROM aml_alerts WHERE case_id = $1 ORDER BY created_at DESC';
    const result: QueryResult<AMLAlert> = await this.db.query(query, [caseId]);
    return result.rows.map(row => this.mapAlert(row));
  }

  /**
   * Map database row to AMLAlert
   */
  private mapAlert(row: { [key: string]: any }): AMLAlert {
    return {
      id: row.id,
      investment_id: row.investment_id,
      investor_id: row.investor_id,
      rule_id: row.rule_id,
      rule_version: typeof row.rule_version === 'string' ? JSON.parse(row.rule_version) : row.rule_version,
      severity: row.severity,
      details: typeof row.details === 'string' ? JSON.parse(row.details) : row.details,
      status: row.status,
      case_id: row.case_id || undefined,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  /**
   * Map database row to AMLCase
   */
  private mapCase(row: { [key: string]: any }): AMLCase {
    return {
      id: row.id,
      alert_ids: typeof row.alert_ids === 'string' ? JSON.parse(row.alert_ids) : row.alert_ids,
      investor_id: row.investor_id,
      status: row.status,
      assigned_to: row.assigned_to || undefined,
      disposition: row.disposition || undefined,
      notes: row.notes || undefined,
      created_at: row.created_at,
      updated_at: row.updated_at,
      closed_at: row.closed_at || undefined,
    };
  }

  /**
   * Generate unique ID
   */
  private generateId(): string {
    return `aml_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
}
