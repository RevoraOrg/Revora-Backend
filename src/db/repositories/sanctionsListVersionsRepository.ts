import { Pool, QueryResult } from 'pg';

export interface SanctionsListVersion {
  id: string;
  list_source: string;
  version: string;
  raw_payload_hash: string;
  parse_hash: string;
  entry_count: number;
  diff_summary: Record<string, unknown> | null;
  diff_size: number | null;
  previous_version_id: string | null;
  signature_valid: boolean;
  loaded_at: Date;
  created_at: Date;
}

export interface SanctionsListDiffDetail {
  id: string;
  version_id: string;
  entity_uid: string;
  entity_name: string;
  change_type: 'added' | 'removed' | 'modified';
  previous_data: Record<string, unknown> | null;
  new_data: Record<string, unknown> | null;
  created_at: Date;
}

export interface CreateVersionInput {
  list_source: string;
  version: string;
  raw_payload_hash: string;
  parse_hash: string;
  entry_count: number;
  diff_summary?: Record<string, unknown>;
  diff_size?: number;
  previous_version_id?: string | null;
  signature_valid: boolean;
  loaded_at?: Date;
}

export interface CreateDiffDetailInput {
  version_id: string;
  entity_uid: string;
  entity_name: string;
  change_type: 'added' | 'removed' | 'modified';
  previous_data?: Record<string, unknown> | null;
  new_data?: Record<string, unknown> | null;
}

export class SanctionsListVersionsRepository {
  constructor(private readonly db: Pool) {}

  async createVersion(input: CreateVersionInput): Promise<SanctionsListVersion> {
    const query = `
      INSERT INTO sanctions_list_versions 
        (list_source, version, raw_payload_hash, parse_hash, entry_count, diff_summary, diff_size, previous_version_id, signature_valid, loaded_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING *
    `;
    const values = [
      input.list_source,
      input.version,
      input.raw_payload_hash,
      input.parse_hash,
      input.entry_count,
      input.diff_summary ? JSON.stringify(input.diff_summary) : null,
      input.diff_size ?? null,
      input.previous_version_id ?? null,
      input.signature_valid,
      input.loaded_at ?? new Date(),
    ];
    const result: QueryResult = await this.db.query(query, values);
    if (result.rows.length === 0) throw new Error('Failed to create sanctions list version');
    return this.mapVersion(result.rows[0] as Record<string, unknown>);
  }

  async findLatestVersion(listSource: string): Promise<SanctionsListVersion | null> {
    const query = `
      SELECT * FROM sanctions_list_versions
      WHERE list_source = $1
      ORDER BY loaded_at DESC
      LIMIT 1
    `;
    const result: QueryResult = await this.db.query(query, [listSource]);
    if (result.rows.length === 0) return null;
    return this.mapVersion(result.rows[0] as Record<string, unknown>);
  }

  async findVersionBySourceAndVersion(
    listSource: string,
    version: string
  ): Promise<SanctionsListVersion | null> {
    const query = `
      SELECT * FROM sanctions_list_versions
      WHERE list_source = $1 AND version = $2
      LIMIT 1
    `;
    const result: QueryResult = await this.db.query(query, [listSource, version]);
    if (result.rows.length === 0) return null;
    return this.mapVersion(result.rows[0] as Record<string, unknown>);
  }

  async findVersionsBySource(listSource: string, limit: number = 100): Promise<SanctionsListVersion[]> {
    const query = `
      SELECT * FROM sanctions_list_versions
      WHERE list_source = $1
      ORDER BY loaded_at DESC
      LIMIT $2
    `;
    const result: QueryResult = await this.db.query(query, [listSource, limit]);
    return result.rows.map((row) => this.mapVersion(row as Record<string, unknown>));
  }

  async findVersionsAfterDate(listSource: string, date: Date): Promise<SanctionsListVersion[]> {
    const query = `
      SELECT * FROM sanctions_list_versions
      WHERE list_source = $1 AND loaded_at > $2
      ORDER BY loaded_at DESC
    `;
    const result: QueryResult = await this.db.query(query, [listSource, date]);
    return result.rows.map((row) => this.mapVersion(row as Record<string, unknown>));
  }

  async deleteVersionsOlderThan(date: Date): Promise<number> {
    const query = `
      DELETE FROM sanctions_list_versions
      WHERE loaded_at < $1
      RETURNING id
    `;
    const result: QueryResult = await this.db.query(query, [date]);
    return result.rowCount ?? 0;
  }

  async createDiffDetail(input: CreateDiffDetailInput): Promise<SanctionsListDiffDetail> {
    const query = `
      INSERT INTO sanctions_list_diff_details
        (version_id, entity_uid, entity_name, change_type, previous_data, new_data)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `;
    const values = [
      input.version_id,
      input.entity_uid,
      input.entity_name,
      input.change_type,
      input.previous_data ? JSON.stringify(input.previous_data) : null,
      input.new_data ? JSON.stringify(input.new_data) : null,
    ];
    const result: QueryResult = await this.db.query(query, values);
    if (result.rows.length === 0) throw new Error('Failed to create diff detail');
    return this.mapDiffDetail(result.rows[0] as Record<string, unknown>);
  }

  async findDiffDetailsByVersionId(versionId: string): Promise<SanctionsListDiffDetail[]> {
    const query = `
      SELECT * FROM sanctions_list_diff_details
      WHERE version_id = $1
      ORDER BY change_type, entity_name
    `;
    const result: QueryResult = await this.db.query(query, [versionId]);
    return result.rows.map((row) => this.mapDiffDetail(row as Record<string, unknown>));
  }

  async findDiffDetailsByChangeType(
    versionId: string,
    changeType: 'added' | 'removed' | 'modified'
  ): Promise<SanctionsListDiffDetail[]> {
    const query = `
      SELECT * FROM sanctions_list_diff_details
      WHERE version_id = $1 AND change_type = $2
      ORDER BY entity_name
    `;
    const result: QueryResult = await this.db.query(query, [versionId, changeType]);
    return result.rows.map((row) => this.mapDiffDetail(row as Record<string, unknown>));
  }

  async findDiffDetailsByEntityUid(entityUid: string): Promise<SanctionsListDiffDetail[]> {
    const query = `
      SELECT * FROM sanctions_list_diff_details
      WHERE entity_uid = $1
      ORDER BY created_at DESC
    `;
    const result: QueryResult = await this.db.query(query, [entityUid]);
    return result.rows.map((row) => this.mapDiffDetail(row as Record<string, unknown>));
  }

  /**
   * Generates a human-readable changelog for a version.
   */
  async generateChangelog(versionId: string): Promise<string> {
    const version = await this.findVersionById(versionId);
    if (!version) {
      throw new Error(`Version ${versionId} not found`);
    }

    const details = await this.findDiffDetailsByVersionId(versionId);
    const added = details.filter((d) => d.change_type === 'added');
    const removed = details.filter((d) => d.change_type === 'removed');
    const modified = details.filter((d) => d.change_type === 'modified');

    let changelog = `Sanctions List Changelog\n`;
    changelog += `======================\n`;
    changelog += `Source: ${version.list_source}\n`;
    changelog += `Version: ${version.version}\n`;
    changelog += `Loaded At: ${version.loaded_at.toISOString()}\n`;
    changelog += `Previous Version: ${version.previous_version_id || 'N/A'}\n`;
    changelog += `Total Changes: ${version.diff_size || 0}\n\n`;

    if (added.length > 0) {
      changelog += `Added Entities (${added.length}):\n`;
      for (const entity of added) {
        changelog += `  - ${entity.entity_name} (UID: ${entity.entity_uid})\n`;
      }
      changelog += `\n`;
    }

    if (removed.length > 0) {
      changelog += `Removed Entities (${removed.length}):\n`;
      for (const entity of removed) {
        changelog += `  - ${entity.entity_name} (UID: ${entity.entity_uid})\n`;
      }
      changelog += `\n`;
    }

    if (modified.length > 0) {
      changelog += `Modified Entities (${modified.length}):\n`;
      for (const entity of modified) {
        changelog += `  - ${entity.entity_name} (UID: ${entity.entity_uid})\n`;
      }
      changelog += `\n`;
    }

    if (added.length === 0 && removed.length === 0 && modified.length === 0) {
      changelog += `No changes detected in this update.\n`;
    }

    return changelog;
  }

  async findVersionById(versionId: string): Promise<SanctionsListVersion | null> {
    const query = `
      SELECT * FROM sanctions_list_versions
      WHERE id = $1
      LIMIT 1
    `;
    const result: QueryResult = await this.db.query(query, [versionId]);
    if (result.rows.length === 0) return null;
    return this.mapVersion(result.rows[0] as Record<string, unknown>);
  }

  private mapVersion(row: Record<string, unknown>): SanctionsListVersion {
    return {
      id: row.id as string,
      list_source: row.list_source as string,
      version: row.version as string,
      raw_payload_hash: row.raw_payload_hash as string,
      parse_hash: row.parse_hash as string,
      entry_count: row.entry_count as number,
      diff_summary: row.diff_summary as Record<string, unknown> | null,
      diff_size: row.diff_size as number | null,
      previous_version_id: row.previous_version_id as string | null,
      signature_valid: row.signature_valid as boolean,
      loaded_at: row.loaded_at as Date,
      created_at: row.created_at as Date,
    };
  }

  private mapDiffDetail(row: Record<string, unknown>): SanctionsListDiffDetail {
    return {
      id: row.id as string,
      version_id: row.version_id as string,
      entity_uid: row.entity_uid as string,
      entity_name: row.entity_name as string,
      change_type: row.change_type as 'added' | 'removed' | 'modified',
      previous_data: row.previous_data as Record<string, unknown> | null,
      new_data: row.new_data as Record<string, unknown> | null,
      created_at: row.created_at as Date,
    };
  }
}
