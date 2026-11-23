import { QueryResult } from 'pg';
import { SanctionsListRepository, SanctionsEntry } from './sanctionsListRepository';

/**
 * Regression suite for the failure / empty-result paths in
 * `src/db/repositories/sanctionsListRepository.ts`.
 *
 * Branch evidence:
 *   - `saveSnapshot` throws `Failed to save sanctions snapshot` when Postgres
 *     returns no `RETURNING` row (a write that silently did nothing);
 *   - `findLatest` fails **closed** with a deterministic message when a source
 *     has no verified snapshot — screening must never be cleared against an
 *     empty list;
 *   - `findBySourceAndVersion` returns `null` (not an error) for an unknown
 *     version, and `mapSnapshot` defaults a missing `entries` payload to `[]`.
 *
 * The happy paths are covered by `sanctionsListRepository.test.ts`; this file
 * covers the branches where a repository mistake becomes a compliance failure.
 */

function mockResult(rows: unknown[]): QueryResult<any> {
  return { rows, rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] };
}

function makeEntry(uid: string, name: string, aliases: string[] = []): SanctionsEntry {
  return { uid, name, aliases };
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'snap-1',
    list_source: 'ofac',
    version: '2026-01-01',
    entry_count: 1,
    normalized_checksum: 'checksum',
    entries: [makeEntry('1', 'Alice')],
    created_at: new Date(),
    ...overrides,
  };
}

describe('SanctionsListRepository failure paths', () => {
  let pool: { query: jest.Mock };
  let repo: SanctionsListRepository;

  beforeEach(() => {
    pool = { query: jest.fn() };
    repo = new SanctionsListRepository(pool as never);
  });

  describe('saveSnapshot empty-RETURNING failure', () => {
    it('throws a deterministic error when the insert returns no row', async () => {
      pool.query.mockResolvedValueOnce(mockResult([]));

      await expect(
        repo.saveSnapshot({
          list_source: 'ofac',
          version: '2026-01-01',
          entries: [makeEntry('1', 'Alice')],
        }),
      ).rejects.toThrow('Failed to save sanctions snapshot');
    });

    it('does not resolve with a partially populated snapshot on the failure path', async () => {
      pool.query.mockResolvedValueOnce(mockResult([]));

      await expect(
        repo.saveSnapshot({ list_source: 'ofac', version: 'v1', entries: [] }),
      ).rejects.toBeInstanceOf(Error);
    });

    it('persists the computed checksum, entry count and JSON payload as parameters', async () => {
      const entries = [makeEntry('1', 'Alice', ['Ali']), makeEntry('2', 'Bob')];
      pool.query.mockResolvedValueOnce(mockResult([row({ entries, entry_count: entries.length })]));

      await repo.saveSnapshot({ list_source: 'ofac', version: '2026-02-01', entries });

      const [sql, params] = pool.query.mock.calls[0];
      expect(sql).toContain('INSERT INTO sanctions_screening_snapshots');
      expect(sql).toContain('ON CONFLICT (list_source, version)');
      expect(sql).toContain('RETURNING *');
      expect(params[0]).toBe('ofac');
      expect(params[1]).toBe('2026-02-01');
      expect(params[2]).toBe(2);
      expect(params[3]).toBe(repo.calculateChecksum(entries));
      expect(params[4]).toBe(JSON.stringify(entries));
    });

    it('propagates constraint failures (e.g. unsupported list_source)', async () => {
      pool.query.mockRejectedValueOnce(new Error('violates check constraint "sanctions_source_check"'));

      await expect(
        repo.saveSnapshot({ list_source: 'not_a_source', version: 'v1', entries: [] }),
      ).rejects.toThrow(/check constraint/);
    });
  });

  describe('findLatest fail-closed path', () => {
    it('throws a message that names the source and the fail-closed policy', async () => {
      pool.query.mockResolvedValueOnce(mockResult([]));

      await expect(repo.findLatest('ofac')).rejects.toThrow(
        'No verified sanctions snapshot is available for list_source "ofac". Refusing to screen against an empty list (fail-closed).',
      );
    });

    it('keeps the error deterministic across repeated calls', async () => {
      pool.query.mockResolvedValue(mockResult([]));

      const first = await repo.findLatest('eu_consolidated').catch((e: Error) => e);
      const second = await repo.findLatest('eu_consolidated').catch((e: Error) => e);

      expect(first.message).toBe(second.message);
      expect(first).toBeInstanceOf(Error);
    });

    it('parameterizes the source and limits the scan to the newest snapshot', async () => {
      pool.query.mockResolvedValueOnce(mockResult([row()]));

      const snapshot = await repo.findLatest('ofac');

      expect(snapshot.version).toBe('2026-01-01');
      const [sql, params] = pool.query.mock.calls[0];
      expect(sql).toContain('WHERE list_source = $1');
      expect(sql).toContain('ORDER BY created_at DESC, version DESC');
      expect(sql).toContain('LIMIT 1');
      expect(params).toEqual(['ofac']);
    });
  });

  describe('findBySourceAndVersion empty-result path', () => {
    it('returns null (not an error) when the version is unknown', async () => {
      pool.query.mockResolvedValueOnce(mockResult([]));

      await expect(repo.findBySourceAndVersion('ofac', 'missing')).resolves.toBeNull();
    });

    it('returns the snapshot when the source+version pair exists', async () => {
      pool.query.mockResolvedValueOnce(mockResult([row({ id: 'snap-audit', version: 'v9' })]));

      const snapshot = await repo.findBySourceAndVersion('ofac', 'v9');

      expect(snapshot?.id).toBe('snap-audit');
      expect(pool.query.mock.calls[0][1]).toEqual(['ofac', 'v9']);
    });
  });

  describe('findLatestAcrossSources boundary handling', () => {
    it('returns an empty array for an empty source list without querying', async () => {
      await expect(repo.findLatestAcrossSources([])).resolves.toEqual([]);
      expect(pool.query).not.toHaveBeenCalled();
    });

    it('builds one placeholder per requested source', async () => {
      pool.query.mockResolvedValueOnce(mockResult([]));

      await repo.findLatestAcrossSources(['ofac', 'eu_consolidated', 'un_sc']);

      const [sql, params] = pool.query.mock.calls[0];
      expect(sql).toContain('WHERE list_source IN ($1, $2, $3)');
      expect(params).toEqual(['ofac', 'eu_consolidated', 'un_sc']);
    });
  });

  describe('mapSnapshot empty-result defaults', () => {
    it('substitutes an empty entries array when the column is null', async () => {
      pool.query.mockResolvedValueOnce(mockResult([row({ entries: null })]));

      const snapshot = await repo.findLatest('ofac');

      expect(snapshot.entries).toEqual([]);
      expect(repo.verifyChecksum(snapshot)).toBe(true);
    });

    it('substitutes an empty entries array when the column is undefined', async () => {
      pool.query.mockResolvedValueOnce(mockResult([row({ entries: undefined })]));

      const snapshot = await repo.findLatest('ofac');

      expect(snapshot.entries).toEqual([]);
    });
  });
});
