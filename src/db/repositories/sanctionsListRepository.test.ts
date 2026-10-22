import { QueryResult } from 'pg';
import { SanctionsListRepository, SanctionsEntry } from './sanctionsListRepository';

function makePool(): { query: jest.Mock } {
  return { query: jest.fn() };
}

function mockResult(rows: unknown[]): QueryResult<any> {
  return { rows, rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] };
}

function makeEntry(uid: string, name: string, aliases: string[] = []): SanctionsEntry {
  return { uid, name, aliases };
}

describe('SanctionsListRepository', () => {
  let pool: { query: jest.Mock };
  let repo: SanctionsListRepository;

  beforeEach(() => {
    pool = makePool();
    repo = new SanctionsListRepository(pool as never);
  });

  describe('calculateChecksum', () => {
    it('is deterministic for equal entries regardless of program order', () => {
      const a = repo.calculateChecksum([
        { uid: '1', name: 'A', programs: ['b', 'a'] },
      ]);
      const b = repo.calculateChecksum([
        { uid: '1', name: 'A', programs: ['a', 'b'] },
      ]);
      expect(a).toBe(b);
    });

    it('differs when names differ', () => {
      expect(repo.calculateChecksum([{ uid: '1', name: 'Alice' }])).not.toBe(
        repo.calculateChecksum([{ uid: '1', name: 'Bob' }]),
      );
    });
  });

  describe('saveSnapshot', () => {
    it('inserts a snapshot and returns its stored checksum', async () => {
      pool.query.mockResolvedValueOnce(
        mockResult([
          {
            id: 'snap-1',
            list_source: 'ofac',
            version: '2026-01-01',
            entry_count: 1,
            normalized_checksum: repo.calculateChecksum([makeEntry('1', 'Alice')]),
            entries: [makeEntry('1', 'Alice')],
            created_at: new Date(),
          },
        ]),
      );

      const saved = await repo.saveSnapshot({
        list_source: 'ofac',
        version: '2026-01-01',
        entries: [makeEntry('1', 'Alice')],
      });
      expect(saved.id).toBe('snap-1');
      expect(saved.entry_count).toBe(1);
      expect(pool.query).toHaveBeenCalledTimes(1);
    });
  });

  describe('findLatest', () => {
    it('returns the newest snapshot for a source', async () => {
      pool.query.mockResolvedValueOnce(
        mockResult([
          {
            id: 'snap-2',
            list_source: 'ofac',
            version: '2026-01-02',
            entry_count: 1,
            normalized_checksum: 'abc',
            entries: [makeEntry('1', 'Alice')],
            created_at: new Date(),
          },
        ]),
      );
      const snap = await repo.findLatest('ofac');
      expect(snap.version).toBe('2026-01-02');
    });

    it('throws fail-closed when no snapshot exists for the source', async () => {
      pool.query.mockResolvedValueOnce(mockResult([]));
      await expect(repo.findLatest('ofac')).rejects.toThrow(/fail-closed/);
    });
  });

  describe('findLatestAcrossSources', () => {
    it('returns latest snapshot per requested source', async () => {
      pool.query.mockResolvedValueOnce(
        mockResult([
          { id: 's1', list_source: 'ofac', version: 'v1', entry_count: 1, normalized_checksum: 'c', entries: [], created_at: new Date() },
        ]),
      );
      const snaps = await repo.findLatestAcrossSources(['ofac', 'eu_consolidated']);
      expect(snaps).toHaveLength(1);
      expect(snaps[0].list_source).toBe('ofac');
    });

    it('returns empty for no sources', async () => {
      const snaps = await repo.findLatestAcrossSources([]);
      expect(snaps).toEqual([]);
      expect(pool.query).not.toHaveBeenCalled();
    });
  });

  describe('findBySourceAndVersion', () => {
    it('returns the snapshot when found and null otherwise', async () => {
      pool.query.mockResolvedValueOnce(
        mockResult([
          { id: 's1', list_source: 'ofac', version: 'v1', entry_count: 1, normalized_checksum: 'c', entries: [], created_at: new Date() },
        ]),
      );
      const found = await repo.findBySourceAndVersion('ofac', 'v1');
      expect(found?.id).toBe('s1');

      pool.query.mockResolvedValueOnce(mockResult([]));
      expect(await repo.findBySourceAndVersion('ofac', 'nope')).toBeNull();
    });
  });

  describe('verifyChecksum', () => {
    it('verifies intact and detects tampered snapshots', () => {
      const entries = [makeEntry('1', 'Alice', ['Ali'])];
      const checksum = repo.calculateChecksum(entries);
      const good = { id: 's', list_source: 'ofac', version: 'v', entry_count: 1, normalized_checksum: checksum, entries, created_at: new Date() };
      expect(repo.verifyChecksum(good)).toBe(true);

      const tampered = { ...good, entries: [makeEntry('1', 'Eve')] };
      expect(repo.verifyChecksum(tampered)).toBe(false);
    });
  });
});