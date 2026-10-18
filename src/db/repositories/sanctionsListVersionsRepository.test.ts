import { QueryResult } from 'pg';
import {
  SanctionsListVersionsRepository,
  SanctionsListVersion,
  CreateVersionInput,
} from './sanctionsListVersionsRepository';

function makePool(): { query: jest.Mock } {
  return { query: jest.fn() };
}

function mockResult(rows: unknown[]): QueryResult<any> {
  return { rows, rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] };
}

describe('SanctionsListVersionsRepository', () => {
  let pool: { query: jest.Mock };
  let repo: SanctionsListVersionsRepository;

  beforeEach(() => {
    pool = makePool();
    repo = new SanctionsListVersionsRepository(pool as never);
  });

  describe('createVersion', () => {
    const input: CreateVersionInput = {
      list_source: 'ofac',
      version: '2026-01-01',
      raw_payload_hash: 'raw123',
      parse_hash: 'parse123',
      entry_count: 10,
      signature_valid: true,
    };

    it('creates and returns a version on successful insert', async () => {
      const mockRow = {
        id: 'v1',
        list_source: 'ofac',
        version: '2026-01-01',
        raw_payload_hash: 'raw123',
        parse_hash: 'parse123',
        entry_count: 10,
        diff_summary: null,
        diff_size: null,
        previous_version_id: null,
        signature_valid: true,
        loaded_at: new Date(),
        created_at: new Date(),
      };
      pool.query.mockResolvedValueOnce(mockResult([mockRow]));

      const version = await repo.createVersion(input);
      expect(version.id).toBe('v1');
      expect(pool.query).toHaveBeenCalledTimes(1);
    });

    it('throws an error if insert returns no rows', async () => {
      pool.query.mockResolvedValueOnce(mockResult([]));

      await expect(repo.createVersion(input)).rejects.toThrow('Failed to create sanctions list version');
    });
  });

  describe('findLatestVersion', () => {
    it('returns the latest version when found', async () => {
      const mockRow = {
        id: 'v1',
        list_source: 'ofac',
        version: '2026-01-01',
        raw_payload_hash: 'raw123',
        parse_hash: 'parse123',
        entry_count: 10,
        diff_summary: null,
        diff_size: null,
        previous_version_id: null,
        signature_valid: true,
        loaded_at: new Date(),
        created_at: new Date(),
      };
      pool.query.mockResolvedValueOnce(mockResult([mockRow]));

      const version = await repo.findLatestVersion('ofac');
      expect(version).not.toBeNull();
      expect(version?.id).toBe('v1');
    });

    it('returns null if no version is found', async () => {
      pool.query.mockResolvedValueOnce(mockResult([]));

      const version = await repo.findLatestVersion('ofac');
      expect(version).toBeNull();
    });
  });

  describe('findVersionBySourceAndVersion', () => {
    it('returns the version when found by source and version', async () => {
      const mockRow = {
        id: 'v1',
        list_source: 'ofac',
        version: '2026-01-01',
        raw_payload_hash: 'raw123',
        parse_hash: 'parse123',
        entry_count: 10,
        diff_summary: null,
        diff_size: null,
        previous_version_id: null,
        signature_valid: true,
        loaded_at: new Date(),
        created_at: new Date(),
      };
      pool.query.mockResolvedValueOnce(mockResult([mockRow]));

      const version = await repo.findVersionBySourceAndVersion('ofac', '2026-01-01');
      expect(version).not.toBeNull();
      expect(version?.id).toBe('v1');
    });

    it('returns null if no version is found by source and version', async () => {
      pool.query.mockResolvedValueOnce(mockResult([]));

      const version = await repo.findVersionBySourceAndVersion('ofac', '2026-01-01');
      expect(version).toBeNull();
    });
  });
});
