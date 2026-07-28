/**
 * AML Rule Repository
 * 
 * Manages AML rule definitions with semver versioning
 * and maintains version history for audit compliance.
 */

import { Pool, QueryResult } from 'pg';
import {
  AMLRule,
  SemVer,
  CreateRuleInput,
  UpdateRuleInput,
  RuleVersionHistory,
} from './types';

/**
 * Repository for AML rule management
 */
export class AMLRuleRepository {
  constructor(private db: Pool) {}

  /**
   * Create a new AML rule with initial version 1.0.0
   * @param input Rule creation data
   * @param userId User creating the rule
   * @returns Created rule
   */
  async create(input: CreateRuleInput, userId: string): Promise<AMLRule> {
    const client = await this.db.connect();
    
    try {
      await client.query('BEGIN');

      const initialVersion: SemVer = { major: 1, minor: 0, patch: 0 };
      
      // Insert rule
      const ruleQuery = `
        INSERT INTO aml_rules (
          id, name, description, type, version, severity, enabled, config, created_at, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())
        RETURNING *
      `;

      const ruleId = this.generateId();
      const ruleValues = [
        ruleId,
        input.name,
        input.description,
        input.type,
        JSON.stringify(initialVersion),
        input.severity,
        true, // enabled by default
        JSON.stringify(input.config),
      ];

      const ruleResult: QueryResult<AMLRule> = await client.query(ruleQuery, ruleValues);
      const rule = this.mapRule(ruleResult.rows[0]);

      // Record version history
      await this.recordVersionHistory(
        client,
        ruleId,
        initialVersion,
        input.config,
        true,
        userId,
        'Initial rule creation'
      );

      await client.query('COMMIT');
      return rule;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Find a rule by ID
   * @param ruleId Rule ID
   * @returns Rule or null
   */
  async findById(ruleId: string): Promise<AMLRule | null> {
    const query = 'SELECT * FROM aml_rules WHERE id = $1';
    const result: QueryResult<AMLRule> = await this.db.query(query, [ruleId]);
    
    return result.rows.length > 0 ? this.mapRule(result.rows[0]) : null;
  }

  /**
   * Find all enabled rules
   * @returns Array of enabled rules
   */
  async findEnabled(): Promise<AMLRule[]> {
    const query = 'SELECT * FROM aml_rules WHERE enabled = true ORDER BY created_at DESC';
    const result: QueryResult<AMLRule> = await this.db.query(query);
    return result.rows.map(row => this.mapRule(row));
  }

  /**
   * Find all rules
   * @returns Array of all rules
   */
  async findAll(): Promise<AMLRule[]> {
    const query = 'SELECT * FROM aml_rules ORDER BY created_at DESC';
    const result: QueryResult<AMLRule> = await this.db.query(query);
    return result.rows.map(row => this.mapRule(row));
  }

  /**
   * Update a rule and create new version
   * @param ruleId Rule ID
   * @param input Update data
   * @param userId User updating the rule
   * @returns Updated rule
   */
  async update(ruleId: string, input: UpdateRuleInput, userId: string): Promise<AMLRule> {
    const client = await this.db.connect();
    
    try {
      await client.query('BEGIN');

      // Get current rule
      const currentRule = await this.findById(ruleId);
      if (!currentRule) {
        throw new Error(`Rule ${ruleId} not found`);
      }

      // Calculate new version based on changes
      const newVersion = this.calculateNextVersion(currentRule.version, input);
      
      // Build update query
      const updates: string[] = [];
      const values: unknown[] = [];
      let paramIndex = 1;

      if (input.name !== undefined) {
        updates.push(`name = $${paramIndex++}`);
        values.push(input.name);
      }
      if (input.description !== undefined) {
        updates.push(`description = $${paramIndex++}`);
        values.push(input.description);
      }
      if (input.enabled !== undefined) {
        updates.push(`enabled = $${paramIndex++}`);
        values.push(input.enabled);
      }
      if (input.config !== undefined) {
        updates.push(`config = $${paramIndex++}`);
        values.push(JSON.stringify(input.config));
      }

      updates.push(`version = $${paramIndex++}`);
      values.push(JSON.stringify(newVersion));
      updates.push(`updated_at = NOW()`);

      values.push(ruleId);

      const query = `
        UPDATE aml_rules
        SET ${updates.join(', ')}
        WHERE id = $${paramIndex}
        RETURNING *
      `;

      const result: QueryResult<AMLRule> = await client.query(query, values);
      const updatedRule = this.mapRule(result.rows[0]);

      // Record version history
      await this.recordVersionHistory(
        client,
        ruleId,
        newVersion,
        input.config || currentRule.config,
        input.enabled !== undefined ? input.enabled : currentRule.enabled,
        userId,
        input.change_reason
      );

      await client.query('COMMIT');
      return updatedRule;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Get version history for a rule
   * @param ruleId Rule ID
   * @returns Version history
   */
  async getVersionHistory(ruleId: string): Promise<RuleVersionHistory[]> {
    const query = `
      SELECT * FROM aml_rule_version_history
      WHERE rule_id = $1
      ORDER BY created_at DESC
    `;
    const result: QueryResult<RuleVersionHistory> = await this.db.query(query, [ruleId]);
    return result.rows.map(row => this.mapVersionHistory(row));
  }

  /**
   * Rollback to a specific version
   * @param ruleId Rule ID
   * @param version Target version
   * @param userId User performing rollback
   * @returns Updated rule
   */
  async rollbackToVersion(ruleId: string, version: SemVer, userId: string): Promise<AMLRule> {
    const client = await this.db.connect();
    
    try {
      await client.query('BEGIN');

      // Get version history entry
      const historyQuery = `
        SELECT * FROM aml_rule_version_history
        WHERE rule_id = $1 AND version = $2
        ORDER BY created_at DESC
        LIMIT 1
      `;
      const historyResult: QueryResult<RuleVersionHistory> = await client.query(
        historyQuery,
        [ruleId, JSON.stringify(version)]
      );

      if (historyResult.rows.length === 0) {
        throw new Error(`Version ${JSON.stringify(version)} not found for rule ${ruleId}`);
      }

      const historyEntry = this.mapVersionHistory(historyResult.rows[0]);

      // Calculate rollback version (increment patch)
      const rollbackVersion: SemVer = {
        major: version.major,
        minor: version.minor,
        patch: version.patch + 1,
      };

      // Update rule with rollback version
      const query = `
        UPDATE aml_rules
        SET config = $1,
            enabled = $2,
            version = $3,
            updated_at = NOW()
        WHERE id = $4
        RETURNING *
      `;

      const result: QueryResult<AMLRule> = await client.query(query, [
        JSON.stringify(historyEntry.config),
        historyEntry.enabled,
        JSON.stringify(rollbackVersion),
        ruleId,
      ]);

      const updatedRule = this.mapRule(result.rows[0]);

      // Record rollback in history
      await this.recordVersionHistory(
        client,
        ruleId,
        rollbackVersion,
        historyEntry.config,
        historyEntry.enabled,
        userId,
        `Rollback to version ${JSON.stringify(version)}`
      );

      await client.query('COMMIT');
      return updatedRule;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Calculate next semver based on changes
   */
  private calculateNextVersion(current: SemVer, input: UpdateRuleInput): SemVer {
    // Config changes = minor version bump
    if (input.config !== undefined) {
      return {
        major: current.major,
        minor: current.minor + 1,
        patch: 0,
      };
    }
    
    // Enable/disable or metadata changes = patch version bump
    return {
      major: current.major,
      minor: current.minor,
      patch: current.patch + 1,
    };
  }

  /**
   * Record version history entry
   */
  private async recordVersionHistory(
    client: any,
    ruleId: string,
    version: SemVer,
    config: Record<string, unknown>,
    enabled: boolean,
    userId: string,
    reason: string
  ): Promise<void> {
    const query = `
      INSERT INTO aml_rule_version_history (
        id, rule_id, version, config, enabled, changed_by, change_reason, created_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
    `;

    await client.query(query, [
      this.generateId(),
      ruleId,
      JSON.stringify(version),
      JSON.stringify(config),
      enabled,
      userId,
      reason,
    ]);
  }

  /**
   * Map database row to AMLRule
   */
  private mapRule(row: { [key: string]: any }): AMLRule {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      type: row.type,
      version: typeof row.version === 'string' ? JSON.parse(row.version) : row.version,
      severity: row.severity,
      enabled: row.enabled,
      config: typeof row.config === 'string' ? JSON.parse(row.config) : row.config,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  /**
   * Map database row to RuleVersionHistory
   */
  private mapVersionHistory(row: { [key: string]: any }): RuleVersionHistory {
    return {
      id: row.id,
      rule_id: row.rule_id,
      version: typeof row.version === 'string' ? JSON.parse(row.version) : row.version,
      config: typeof row.config === 'string' ? JSON.parse(row.config) : row.config,
      enabled: row.enabled,
      changed_by: row.changed_by,
      change_reason: row.change_reason,
      created_at: row.created_at,
    };
  }

  /**
   * Generate unique ID
   */
  private generateId(): string {
    return `aml_rule_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
}
