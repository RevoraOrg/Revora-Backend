import { createHash } from 'crypto';
import { Pool, QueryResult } from 'pg';

/** A single normalized sanctions entity with its alias list. */
export interface SanctionsEntry {
  /** Stable identifier from the source list (e.g. OFAC `ent_num`). */
  uid: string;
  /** Primary display name. */
  name: string;
  /** Optional alternate names / aliases for the same entity. */
  aliases?: string[];
  /** Source program(s), e.g. ['SDGT']. */
  programs?: string[];
}

/** A versioned, checksum-verified snapshot of a sanctions list. */
export interface SanctionsSnapshot {
  id: string;
  list_source: string;
  version: string;
  entry_count: number;
  normalized_checksum: string;
  entries: SanctionsEntry[];
  created_at: Date;
}

export interface SaveSnapshotInput {
  list_source: string;
  version: string;
  entries: SanctionsEntry[];
}

/**
 * Repository for versioned sanctions list snapshots.
 *
 * Security / correctness assumptions:
 * - Every snapshot stores `normalized_checksum`: the SHA-256 of the
 *   canonicalized entry JSON. Callers (the daily refresh job) compute this
 *   against a trusted/pinned reference so a tampered or truncated download
 *   cannot be silently promoted to the current list.
 * - `calculateChecksum` is exported so the refresh job and tests can verify a
 *   snapshot's integrity deterministically.
 * - Screening always reads the newest snapshot for a source. If none exists the
 *   repo throws (fail-closed): investments must never be cleared against a
 *   missing list.
 * - `list_source` is one of the supported enum values validated by CHECK
 *   constraints in the underlying table; parameterized queries prevent
 *   injection.
 */
export class SanctionsListRepository {
  constructor(private readonly db: Pool) {}

  /** SHA-256 hex digest of the canonicalized entries array. */
  calculateChecksum(entries: SanctionsEntry[]): string {
    const canonical = JSON.stringify(entries.map((e) => ({
      uid: e.uid,
      name: e.name,
      aliases: e.aliases?.length ? e.aliases : [],
      programs: e.programs?.length ? [...e.programs].sort() : [],
    })));
    return createHash('sha256').update(canonical, 'utf8').digest('hex');
  }

  /**
   * Persist a new snapshot for a source+version. Overwrites on conflict so a
   * re-run of the daily job is idempotent.
   */
  async saveSnapshot(input: SaveSnapshotInput): Promise<SanctionsSnapshot> {
    const checksum = this.calculateChecksum(input.entries);
    const query = `
      INSERT INTO sanctions_screening_snapshots
        (list_source, version, entry_count, normalized_checksum, entries)
      VALUES ($1, $2, $3, $4, $5::jsonb)
      ON CONFLICT (list_source, version)
      DO UPDATE SET
        entry_count = EXCLUDED.entry_count,
        normalized_checksum = EXCLUDED.normalized_checksum,
        entries = EXCLUDED.entries,
        created_at = NOW()
      RETURNING *
    `;
    const result: QueryResult = await this.db.query(query, [
      input.list_source,
      input.version,
      input.entries.length,
      checksum,
      JSON.stringify(input.entries),
    ]);
    if (result.rows.length === 0) throw new Error('Failed to save sanctions snapshot');
    return this.mapSnapshot(result.rows[0]);
  }

  /**
   * Return the most recent snapshot for a source.
   * @throws when no verified snapshot exists for the source (fail-closed).
   */
  async findLatest(listSource: string): Promise<SanctionsSnapshot> {
    const query = `
      SELECT * FROM sanctions_screening_snapshots
      WHERE list_source = $1
      ORDER BY created_at DESC, version DESC
      LIMIT 1
    `;
    const result: QueryResult = await this.db.query(query, [listSource]);
    if (result.rows.length === 0) {
      throw new Error(
        `No verified sanctions snapshot is available for list_source "${listSource}". ` +
          'Refusing to screen against an empty list (fail-closed).',
      );
    }
    return this.mapSnapshot(result.rows[0]);
  }

  /**
   * Return the latest snapshot for each requested source. Sources with no
   * verified snapshot are omitted; callers that require a complete view should
   * detect the absence and respond fail-closed.
   */
  async findLatestAcrossSources(sources: string[]): Promise<SanctionsSnapshot[]> {
    if (sources.length === 0) return [];
    const placeholders = sources.map((_, i) => `$${i + 1}`).join(', ');
    const query = `
      SELECT DISTINCT ON (list_source) *
      FROM sanctions_screening_snapshots
      WHERE list_source IN (${placeholders})
      ORDER BY list_source, created_at DESC, version DESC
    `;
    const result: QueryResult = await this.db.query(query, sources);
    return result.rows.map((row) => this.mapSnapshot(row));
  }

  /**
   * Look up a specific snapshot by source+version so an investment's recorded
   * `screening_list_version` can be reproduced for audit.
   */
  async findBySourceAndVersion(
    listSource: string,
    version: string,
  ): Promise<SanctionsSnapshot | null> {
    const query = `
      SELECT * FROM sanctions_screening_snapshots
      WHERE list_source = $1 AND version = $2
      LIMIT 1
    `;
    const result: QueryResult = await this.db.query(query, [listSource, version]);
    if (result.rows.length === 0) return null;
    return this.mapSnapshot(result.rows[0]);
  }

  /**
   * Verify a snapshot's on-disk checksum matches a re-computation of its
   * entries. Returns true when intact; false when entries were tampered with.
   */
  verifyChecksum(snapshot: SanctionsSnapshot): boolean {
    return this.calculateChecksum(snapshot.entries) === snapshot.normalized_checksum;
  }

  private mapSnapshot(row: Record<string, unknown>): SanctionsSnapshot {
    return {
      id: row.id as string,
      list_source: row.list_source as string,
      version: row.version as string,
      entry_count: row.entry_count as number,
      normalized_checksum: row.normalized_checksum as string,
      entries: (row.entries ?? []) as SanctionsEntry[],
      created_at: row.created_at as Date,
    };
  }
}