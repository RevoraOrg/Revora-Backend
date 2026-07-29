import { SanctionsListDiffService } from '../sanctionsListDiffService';
import { SanctionsListVersionsRepository } from '../../db/repositories/sanctionsListVersionsRepository';
import { OfacEntry } from '../ofacSanctionsLoader';
import { MetricsCollector } from '../../lib/metrics';

jest.mock('../../db/repositories/sanctionsListVersionsRepository');
jest.mock('../../lib/metrics');

describe('SanctionsListDiffService', () => {
  let service: SanctionsListDiffService;
  let mockRepo: jest.Mocked<SanctionsListVersionsRepository>;
  let mockMetrics: jest.Mocked<MetricsCollector>;

  beforeEach(() => {
    mockRepo = new (SanctionsListVersionsRepository as any)();
    mockMetrics = {
      incrementCounter: jest.fn(),
      setGauge: jest.fn(),
    } as unknown as jest.Mocked<MetricsCollector>;
    service = new SanctionsListDiffService(mockRepo, mockMetrics);
    jest.clearAllMocks();
  });

  describe('computeDiff', () => {
    it('should detect added entries', () => {
      const previous: OfacEntry[] = [
        { uid: '1', name: 'Entity A', sdnType: 'individual', programs: [], addresses: [] },
      ];
      const current: OfacEntry[] = [
        { uid: '1', name: 'Entity A', sdnType: 'individual', programs: [], addresses: [] },
        { uid: '2', name: 'Entity B', sdnType: 'individual', programs: [], addresses: [] },
      ];

      const result = service.computeDiff(previous, current);

      expect(result.added).toHaveLength(1);
      expect(result.added[0].uid).toBe('2');
      expect(result.removed).toHaveLength(0);
      expect(result.modified).toHaveLength(0);
      expect(result.summary.total_added).toBe(1);
      expect(result.summary.total_changes).toBe(1);
    });

    it('should detect removed entries', () => {
      const previous: OfacEntry[] = [
        { uid: '1', name: 'Entity A', sdnType: 'individual', programs: [], addresses: [] },
        { uid: '2', name: 'Entity B', sdnType: 'individual', programs: [], addresses: [] },
      ];
      const current: OfacEntry[] = [
        { uid: '1', name: 'Entity A', sdnType: 'individual', programs: [], addresses: [] },
      ];

      const result = service.computeDiff(previous, current);

      expect(result.added).toHaveLength(0);
      expect(result.removed).toHaveLength(1);
      expect(result.removed[0].uid).toBe('2');
      expect(result.modified).toHaveLength(0);
      expect(result.summary.total_removed).toBe(1);
      expect(result.summary.total_changes).toBe(1);
    });

    it('should detect modified entries', () => {
      const previous: OfacEntry[] = [
        { uid: '1', name: 'Entity A', sdnType: 'individual', programs: [], addresses: [] },
      ];
      const current: OfacEntry[] = [
        { uid: '1', name: 'Entity A Updated', sdnType: 'individual', programs: [], addresses: [] },
      ];

      const result = service.computeDiff(previous, current);

      expect(result.added).toHaveLength(0);
      expect(result.removed).toHaveLength(0);
      expect(result.modified).toHaveLength(1);
      expect(result.modified[0].previous.name).toBe('Entity A');
      expect(result.modified[0].current.name).toBe('Entity A Updated');
      expect(result.summary.total_modified).toBe(1);
      expect(result.summary.total_changes).toBe(1);
    });

    it('should handle empty lists', () => {
      const previous: OfacEntry[] = [];
      const current: OfacEntry[] = [];

      const result = service.computeDiff(previous, current);

      expect(result.added).toHaveLength(0);
      expect(result.removed).toHaveLength(0);
      expect(result.modified).toHaveLength(0);
      expect(result.summary.total_changes).toBe(0);
    });

    it('should handle no changes', () => {
      const entry: OfacEntry = {
        uid: '1',
        name: 'Entity A',
        sdnType: 'individual',
        programs: [],
        addresses: [],
      };
      const previous: OfacEntry[] = [entry];
      const current: OfacEntry[] = [entry];

      const result = service.computeDiff(previous, current);

      expect(result.summary.total_changes).toBe(0);
    });

    it('should detect program changes', () => {
      const previous: OfacEntry[] = [
        { uid: '1', name: 'Entity A', sdnType: 'individual', programs: ['program-a'], addresses: [] },
      ];
      const current: OfacEntry[] = [
        { uid: '1', name: 'Entity A', sdnType: 'individual', programs: ['program-a', 'program-b'], addresses: [] },
      ];

      const result = service.computeDiff(previous, current);

      expect(result.modified).toHaveLength(1);
    });

    it('should detect address changes', () => {
      const previous: OfacEntry[] = [
        {
          uid: '1',
          name: 'Entity A',
          sdnType: 'individual',
          programs: [],
          addresses: [{ city: 'New York' }],
        },
      ];
      const current: OfacEntry[] = [
        {
          uid: '1',
          name: 'Entity A',
          sdnType: 'individual',
          programs: [],
          addresses: [{ city: 'London' }],
        },
      ];

      const result = service.computeDiff(previous, current);

      expect(result.modified).toHaveLength(1);
    });

    it('should ignore specified fields', () => {
      const previous: OfacEntry[] = [
        { uid: '1', name: 'Entity A', sdnType: 'individual', programs: [], addresses: [] },
      ];
      const current: OfacEntry[] = [
        { uid: '1', name: 'Entity B', sdnType: 'individual', programs: [], addresses: [] },
      ];

      const result = service.computeDiff(previous, current, { ignoreFields: ['name'] });

      expect(result.modified).toHaveLength(0);
    });

    it('should support case-insensitive comparison', () => {
      const previous: OfacEntry[] = [
        { uid: '1', name: 'Entity A', sdnType: 'individual', programs: [], addresses: [] },
      ];
      const current: OfacEntry[] = [
        { uid: '1', name: 'entity a', sdnType: 'individual', programs: [], addresses: [] },
      ];

      const result = service.computeDiff(previous, current, { caseInsensitive: true });

      expect(result.modified).toHaveLength(0);
    });
  });

  describe('recordLoadWithDiff', () => {
    it('should record a load with no previous version', async () => {
      const entries: OfacEntry[] = [
        { uid: '1', name: 'Entity A', sdnType: 'individual', programs: [], addresses: [] },
      ];
      const mockVersion = {
        id: 'version-1',
        list_source: 'ofac',
        version: '2024-01-01',
        raw_payload_hash: 'hash123',
        parse_hash: 'parsehash123',
        entry_count: 1,
        diff_summary: null,
        diff_size: null,
        previous_version_id: null,
        signature_valid: true,
        loaded_at: new Date(),
        created_at: new Date(),
      };

      mockRepo.findLatestVersion.mockResolvedValue(null);
      mockRepo.createVersion.mockResolvedValue(mockVersion);

      const result = await service.recordLoadWithDiff('ofac', '2024-01-01', 'raw data', entries, true);

      expect(mockRepo.findLatestVersion).toHaveBeenCalledWith('ofac');
      expect(mockRepo.createVersion).toHaveBeenCalledWith({
        list_source: 'ofac',
        version: '2024-01-01',
        raw_payload_hash: expect.any(String),
        parse_hash: expect.any(String),
        entry_count: 1,
        diff_summary: null,
        diff_size: null,
        previous_version_id: null,
        signature_valid: true,
      });
      expect(result).toEqual(mockVersion);
    });

    it('should record a load with diff when previous version exists', async () => {
      const previousEntries: OfacEntry[] = [
        { uid: '1', name: 'Entity A', sdnType: 'individual', programs: [], addresses: [] },
      ];
      const currentEntries: OfacEntry[] = [
        { uid: '1', name: 'Entity A', sdnType: 'individual', programs: [], addresses: [] },
        { uid: '2', name: 'Entity B', sdnType: 'individual', programs: [], addresses: [] },
      ];
      const mockPreviousVersion = {
        id: 'version-0',
        list_source: 'ofac',
        version: '2024-01-01',
        raw_payload_hash: 'hash123',
        parse_hash: 'parsehash123',
        entry_count: 1,
        diff_summary: null,
        diff_size: null,
        previous_version_id: null,
        signature_valid: true,
        loaded_at: new Date(),
        created_at: new Date(),
      };
      const mockVersion = {
        id: 'version-1',
        list_source: 'ofac',
        version: '2024-01-02',
        raw_payload_hash: 'hash456',
        parse_hash: 'parsehash456',
        entry_count: 2,
        diff_summary: { added: 1, removed: 0, modified: 0, total_changes: 1 },
        diff_size: 1,
        previous_version_id: 'version-0',
        signature_valid: true,
        loaded_at: new Date(),
        created_at: new Date(),
      };

      mockRepo.findLatestVersion.mockResolvedValue(mockPreviousVersion);
      mockRepo.createVersion.mockResolvedValue(mockVersion);
      mockRepo.createDiffDetail.mockResolvedValue({} as any);

      const result = await service.recordLoadWithDiff('ofac', '2024-01-02', 'raw data', currentEntries, true);

      expect(mockRepo.createDiffDetail).toHaveBeenCalled();
      expect(mockMetrics.setGauge).toHaveBeenCalledWith(
        'sanctions.list.diff.size',
        1,
        { list_source: 'ofac', version: '2024-01-02' },
        'Number of entities changed in sanctions list update'
      );
      expect(mockMetrics.incrementCounter).toHaveBeenCalledWith(
        'sanctions.list.diff.changes_detected',
        { list_source: 'ofac', version: '2024-01-02' },
        1,
        'Sanctions list changes detected'
      );
    });

    it('should not alert on no-change updates', async () => {
      const entries: OfacEntry[] = [
        { uid: '1', name: 'Entity A', sdnType: 'individual', programs: [], addresses: [] },
      ];
      const mockPreviousVersion = {
        id: 'version-0',
        list_source: 'ofac',
        version: '2024-01-01',
        raw_payload_hash: 'hash123',
        parse_hash: 'parsehash123',
        entry_count: 1,
        diff_summary: null,
        diff_size: null,
        previous_version_id: null,
        signature_valid: true,
        loaded_at: new Date(),
        created_at: new Date(),
      };
      const mockVersion = {
        id: 'version-1',
        list_source: 'ofac',
        version: '2024-01-02',
        raw_payload_hash: 'hash456',
        parse_hash: 'parsehash456',
        entry_count: 1,
        diff_summary: { added: 0, removed: 0, modified: 0, total_changes: 0 },
        diff_size: 0,
        previous_version_id: 'version-0',
        signature_valid: true,
        loaded_at: new Date(),
        created_at: new Date(),
      };

      mockRepo.findLatestVersion.mockResolvedValue(mockPreviousVersion);
      mockRepo.createVersion.mockResolvedValue(mockVersion);

      await service.recordLoadWithDiff('ofac', '2024-01-02', 'raw data', entries, true);

      expect(mockMetrics.incrementCounter).not.toHaveBeenCalledWith(
        'sanctions.list.diff.changes_detected',
        expect.any(Object),
        expect.any(Number),
        expect.any(String)
      );
    });

    it('should use provided parse hash', async () => {
      const entries: OfacEntry[] = [
        { uid: '1', name: 'Entity A', sdnType: 'individual', programs: [], addresses: [] },
      ];
      const mockVersion = {
        id: 'version-1',
        list_source: 'ofac',
        version: '2024-01-01',
        raw_payload_hash: 'hash123',
        parse_hash: 'custom-hash',
        entry_count: 1,
        diff_summary: null,
        diff_size: null,
        previous_version_id: null,
        signature_valid: true,
        loaded_at: new Date(),
        created_at: new Date(),
      };

      mockRepo.findLatestVersion.mockResolvedValue(null);
      mockRepo.createVersion.mockResolvedValue(mockVersion);

      await service.recordLoadWithDiff('ofac', '2024-01-01', 'raw data', entries, true, 'custom-hash');

      expect(mockRepo.createVersion).toHaveBeenCalledWith(
        expect.objectContaining({
          parse_hash: 'custom-hash',
        })
      );
    });
  });

  describe('generateChangelog', () => {
    it('should generate changelog from repository', async () => {
      const mockChangelog = 'Sanctions List Changelog\n======================\nSource: ofac\nVersion: 2024-01-01\n';
      mockRepo.generateChangelog.mockResolvedValue(mockChangelog);

      const result = await service.generateChangelog('version-1');

      expect(mockRepo.generateChangelog).toHaveBeenCalledWith('version-1');
      expect(result).toBe(mockChangelog);
    });
  });

  describe('applyRetentionPolicy', () => {
    it('should delete old versions and emit metric', async () => {
      const cutoffDate = new Date('2020-01-01');
      mockRepo.deleteVersionsOlderThan.mockResolvedValue(5);

      const result = await service.applyRetentionPolicy(cutoffDate);

      expect(mockRepo.deleteVersionsOlderThan).toHaveBeenCalledWith(cutoffDate);
      expect(mockMetrics.incrementCounter).toHaveBeenCalledWith(
        'sanctions.list.retention.applied',
        {},
        5,
        'Sanctions list versions deleted due to retention policy'
      );
      expect(result).toBe(5);
    });
  });
});
