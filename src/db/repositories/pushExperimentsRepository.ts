import { Pool, QueryResult } from 'pg';

export interface PushExperiment {
  id: string;
  tenant_id: string;
  experiment_key: string;
  status: 'draft' | 'active' | 'paused' | 'completed';
  allocation_strategy: 'weighted' | 'uniform';
  started_at: Date | null;
  ended_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface PushExperimentVariant {
  id: string;
  experiment_id: string;
  variant_key: string;
  weight: number;
  title_template: string;
  body_template: string;
  data_template: Record<string, unknown> | null;
  is_control: boolean;
  created_at: Date;
}

export interface PushExperimentAssignment {
  id: string;
  experiment_id: string;
  variant_id: string;
  user_id: string;
  assigned_at: Date;
  delivered_at: Date | null;
  opened_at: Date | null;
}

export interface PushExperimentLegalAllowlist {
  id: string;
  tenant_id: string;
  field_key: string;
  required_value: string;
  created_at: Date;
}

export interface CreateExperimentInput {
  tenant_id: string;
  experiment_key: string;
  allocation_strategy?: 'weighted' | 'uniform';
}

export interface CreateVariantInput {
  experiment_id: string;
  variant_key: string;
  weight: number;
  title_template: string;
  body_template: string;
  data_template?: Record<string, unknown>;
  isControl?: boolean;
}

export class PushExperimentsRepository {
  constructor(private readonly db: Pool) {}

  async createExperiment(input: CreateExperimentInput): Promise<PushExperiment> {
    const query = `
      INSERT INTO push_experiments (tenant_id, experiment_key, allocation_strategy, status)
      VALUES ($1, $2, $3, 'draft')
      RETURNING *
    `;
    const values = [
      input.tenant_id,
      input.experiment_key,
      input.allocation_strategy ?? 'weighted',
    ];
    const result: QueryResult = await this.db.query(query, values);
    if (result.rows.length === 0) throw new Error('Failed to create experiment');
    return this.mapExperiment(result.rows[0] as Record<string, unknown>);
  }

  async findExperimentByKey(
    tenantId: string,
    experimentKey: string
  ): Promise<PushExperiment | null> {
    const query = `
      SELECT * FROM push_experiments
      WHERE tenant_id = $1 AND experiment_key = $2
      LIMIT 1
    `;
    const result: QueryResult = await this.db.query(query, [tenantId, experimentKey]);
    if (result.rows.length === 0) return null;
    return this.mapExperiment(result.rows[0] as Record<string, unknown>);
  }

  async findActiveExperiments(tenantId: string): Promise<PushExperiment[]> {
    const query = `
      SELECT * FROM push_experiments
      WHERE tenant_id = $1 AND status = 'active'
      ORDER BY created_at DESC
    `;
    const result: QueryResult = await this.db.query(query, [tenantId]);
    return result.rows.map((row) => this.mapExperiment(row as Record<string, unknown>));
  }

  async updateExperimentStatus(
    experimentId: string,
    status: 'draft' | 'active' | 'paused' | 'completed'
  ): Promise<PushExperiment> {
    const now = status === 'active' ? 'started_at = NOW()' : 
                status === 'completed' || status === 'paused' ? 'ended_at = NOW()' : '';
    
    const query = `
      UPDATE push_experiments
      SET status = $1, updated_at = NOW()${now ? ', ' + now : ''}
      WHERE id = $2
      RETURNING *
    `;
    const result: QueryResult = await this.db.query(query, [status, experimentId]);
    if (result.rows.length === 0) throw new Error('Failed to update experiment status');
    return this.mapExperiment(result.rows[0] as Record<string, unknown>);
  }

  async createVariant(input: CreateVariantInput): Promise<PushExperimentVariant> {
    const query = `
      INSERT INTO push_experiment_variants 
        (experiment_id, variant_key, weight, title_template, body_template, data_template, is_control)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *
    `;
    const values = [
      input.experiment_id,
      input.variant_key,
      input.weight,
      input.title_template,
      input.body_template,
      input.data_template ? JSON.stringify(input.data_template) : null,
      input.isControl ?? false,
    ];
    const result: QueryResult = await this.db.query(query, values);
    if (result.rows.length === 0) throw new Error('Failed to create variant');
    return this.mapVariant(result.rows[0] as Record<string, unknown>);
  }

  async findVariantsByExperiment(experimentId: string): Promise<PushExperimentVariant[]> {
    const query = `
      SELECT * FROM push_experiment_variants
      WHERE experiment_id = $1
      ORDER BY is_control DESC, weight DESC
    `;
    const result: QueryResult = await this.db.query(query, [experimentId]);
    return result.rows.map((row) => this.mapVariant(row as Record<string, unknown>));
  }

  async findVariantById(variantId: string): Promise<PushExperimentVariant | null> {
    const query = `
      SELECT * FROM push_experiment_variants
      WHERE id = $1
      LIMIT 1
    `;
    const result: QueryResult = await this.db.query(query, [variantId]);
    if (result.rows.length === 0) return null;
    return this.mapVariant(result.rows[0] as Record<string, unknown>);
  }

  async assignUserToVariant(
    experimentId: string,
    variantId: string,
    userId: string
  ): Promise<PushExperimentAssignment> {
    const query = `
      INSERT INTO push_experiment_assignments (experiment_id, variant_id, user_id)
      VALUES ($1, $2, $3)
      ON CONFLICT (experiment_id, user_id) 
      DO UPDATE SET variant_id = $2, assigned_at = NOW()
      RETURNING *
    `;
    const result: QueryResult = await this.db.query(query, [experimentId, variantId, userId]);
    if (result.rows.length === 0) throw new Error('Failed to assign user to variant');
    return this.mapAssignment(result.rows[0] as Record<string, unknown>);
  }

  async findAssignmentByUser(
    experimentId: string,
    userId: string
  ): Promise<PushExperimentAssignment | null> {
    const query = `
      SELECT * FROM push_experiment_assignments
      WHERE experiment_id = $1 AND user_id = $2
      LIMIT 1
    `;
    const result: QueryResult = await this.db.query(query, [experimentId, userId]);
    if (result.rows.length === 0) return null;
    return this.mapAssignment(result.rows[0] as Record<string, unknown>);
  }

  async markDelivered(assignmentId: string): Promise<void> {
    const query = `
      UPDATE push_experiment_assignments
      SET delivered_at = NOW()
      WHERE id = $1 AND delivered_at IS NULL
    `;
    await this.db.query(query, [assignmentId]);
  }

  async markOpened(assignmentId: string): Promise<void> {
    const query = `
      UPDATE push_experiment_assignments
      SET opened_at = NOW()
      WHERE id = $1 AND opened_at IS NULL
    `;
    await this.db.query(query, [assignmentId]);
  }

  async getExperimentMetrics(experimentId: string): Promise<{
    total_assignments: number;
    total_delivered: number;
    total_opened: number;
    variant_metrics: Array<{
      variant_id: string;
      variant_key: string;
      assignments: number;
      delivered: number;
      opened: number;
      open_rate: number;
    }>;
  }> {
    const totalQuery = `
      SELECT 
        COUNT(*) as total,
        COUNT(delivered_at) as delivered,
        COUNT(opened_at) as opened
      FROM push_experiment_assignments
      WHERE experiment_id = $1
    `;
    const totalResult: QueryResult = await this.db.query(totalQuery, [experimentId]);
    
    const variantQuery = `
      SELECT 
        v.id as variant_id,
        v.variant_key,
        COUNT(a.id) as assignments,
        COUNT(a.delivered_at) as delivered,
        COUNT(a.opened_at) as opened
      FROM push_experiment_variants v
      LEFT JOIN push_experiment_assignments a ON v.id = a.variant_id
      WHERE v.experiment_id = $1
      GROUP BY v.id, v.variant_key
    `;
    const variantResult: QueryResult = await this.db.query(variantQuery, [experimentId]);
    
    const variantMetrics = variantResult.rows.map(row => ({
      variant_id: row.variant_id,
      variant_key: row.variant_key,
      assignments: parseInt(row.assignments),
      delivered: parseInt(row.delivered),
      opened: parseInt(row.opened),
      open_rate: parseInt(row.assignments) > 0 
        ? parseInt(row.opened) / parseInt(row.assignments) 
        : 0,
    }));

    return {
      total_assignments: parseInt(totalResult.rows[0].total),
      total_delivered: parseInt(totalResult.rows[0].delivered),
      total_opened: parseInt(totalResult.rows[0].opened),
      variant_metrics: variantMetrics,
    };
  }

  async addLegalAllowlistEntry(
    tenantId: string,
    fieldKey: string,
    requiredValue: string
  ): Promise<PushExperimentLegalAllowlist> {
    const query = `
      INSERT INTO push_experiment_legal_allowlist (tenant_id, field_key, required_value)
      VALUES ($1, $2, $3)
      ON CONFLICT (tenant_id, field_key)
      DO UPDATE SET required_value = $3
      RETURNING *
    `;
    const result: QueryResult = await this.db.query(query, [tenantId, fieldKey, requiredValue]);
    if (result.rows.length === 0) throw new Error('Failed to add legal allowlist entry');
    return this.mapLegalAllowlist(result.rows[0] as Record<string, unknown>);
  }

  async getLegalAllowlist(tenantId: string): Promise<PushExperimentLegalAllowlist[]> {
    const query = `
      SELECT * FROM push_experiment_legal_allowlist
      WHERE tenant_id = $1
    `;
    const result: QueryResult = await this.db.query(query, [tenantId]);
    return result.rows.map((row) => this.mapLegalAllowlist(row as Record<string, unknown>));
  }

  private mapExperiment(row: Record<string, unknown>): PushExperiment {
    return {
      id: row.id as string,
      tenant_id: row.tenant_id as string,
      experiment_key: row.experiment_key as string,
      status: row.status as 'draft' | 'active' | 'paused' | 'completed',
      allocation_strategy: row.allocation_strategy as 'weighted' | 'uniform',
      started_at: row.started_at as Date | null,
      ended_at: row.ended_at as Date | null,
      created_at: row.created_at as Date,
      updated_at: row.updated_at as Date,
    };
  }

  private mapVariant(row: Record<string, unknown>): PushExperimentVariant {
    return {
      id: row.id as string,
      experiment_id: row.experiment_id as string,
      variant_key: row.variant_key as string,
      weight: row.weight as number,
      title_template: row.title_template as string,
      body_template: row.body_template as string,
      data_template: row.data_template as Record<string, unknown> | null,
      is_control: row.is_control as boolean,
      created_at: row.created_at as Date,
    };
  }

  private mapAssignment(row: Record<string, unknown>): PushExperimentAssignment {
    return {
      id: row.id as string,
      experiment_id: row.experiment_id as string,
      variant_id: row.variant_id as string,
      user_id: row.user_id as string,
      assigned_at: row.assigned_at as Date,
      delivered_at: row.delivered_at as Date | null,
      opened_at: row.opened_at as Date | null,
    };
  }

  private mapLegalAllowlist(row: Record<string, unknown>): PushExperimentLegalAllowlist {
    return {
      id: row.id as string,
      tenant_id: row.tenant_id as string,
      field_key: row.field_key as string,
      required_value: row.required_value as string,
      created_at: row.created_at as Date,
    };
  }
}
