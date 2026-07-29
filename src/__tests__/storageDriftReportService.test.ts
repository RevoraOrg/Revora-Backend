import { StorageDriftReportService, validateDescriptor } from '../services/storageDriftReportService';

const validCurrent = {
  version: '1.0',
  codeId: 'aaa',
  entries: [
    { key: 'balance', storageType: 'persistent', valueType: 'Uint128' },
    { key: 'owner', storageType: 'instance', valueType: 'Address' },
  ],
};

const validTargetSafe = {
  version: '1.0',
  codeId: 'bbb',
  entries: [
    { key: 'balance', storageType: 'persistent', valueType: 'Uint128' },
    { key: 'owner', storageType: 'instance', valueType: 'Address' },
  ],
};

const validTargetAdded = {
  version: '1.0',
  codeId: 'bbb',
  entries: [
    { key: 'balance', storageType: 'persistent', valueType: 'Uint128' },
    { key: 'owner', storageType: 'instance', valueType: 'Address' },
    { key: 'fee_rate', storageType: 'persistent', valueType: 'Uint32' },
  ],
};

const validTargetBreaking = {
  version: '1.0',
  codeId: 'bbb',
  entries: [
    { key: 'balance', storageType: 'persistent', valueType: 'Uint128' },
    { key: 'owner', storageType: 'persistent', valueType: 'Address' },
  ],
};

const validTargetRemoved = {
  version: '1.0',
  codeId: 'bbb',
  entries: [
    { key: 'balance', storageType: 'persistent', valueType: 'Uint128' },
  ],
};

describe('StorageDriftReportService', () => {
  let service: StorageDriftReportService;

  beforeEach(() => {
    service = new StorageDriftReportService();
  });

  describe('generateReport', () => {
    it('returns safe report for identical layouts', async () => {
      const result = await service.generateReport({
        currentDescriptor: validCurrent,
        targetDescriptor: validTargetSafe,
      });
      expect(result.report.recommendation).toBe('safe');
      expect(result.alertEmitted).toBe(false);
      expect(result.report.hasBreakingChanges).toBe(false);
    });

    it('returns review_required for additions only', async () => {
      const result = await service.generateReport({
        currentDescriptor: validCurrent,
        targetDescriptor: validTargetAdded,
      });
      expect(result.report.recommendation).toBe('review_required');
      expect(result.alertEmitted).toBe(false);
      expect(result.report.diff.added).toHaveLength(1);
      expect(result.report.diff.added[0].entry.key).toBe('fee_rate');
    });

    it('emits alert for breaking modifications', async () => {
      const result = await service.generateReport({
        currentDescriptor: validCurrent,
        targetDescriptor: validTargetBreaking,
        upgradeId: 'upgrade-123',
      });
      expect(result.report.recommendation).toBe('blocking');
      expect(result.alertEmitted).toBe(true);
      expect(result.report.hasBreakingChanges).toBe(true);
    });

    it('emits alert for removals', async () => {
      const result = await service.generateReport({
        currentDescriptor: validCurrent,
        targetDescriptor: validTargetRemoved,
      });
      expect(result.report.recommendation).toBe('blocking');
      expect(result.alertEmitted).toBe(true);
      expect(result.report.breakingChanges[0]).toContain("Removed storage entry 'owner'");
    });

    it('includes upgradeId in report context when provided', async () => {
      const result = await service.generateReport({
        currentDescriptor: validCurrent,
        targetDescriptor: validTargetBreaking,
        upgradeId: 'upg-42',
      });
      expect(result.report.hasBreakingChanges).toBe(true);
      expect(result.alertEmitted).toBe(true);
    });

    it('works without upgradeId', async () => {
      const result = await service.generateReport({
        currentDescriptor: validCurrent,
        targetDescriptor: validTargetSafe,
      });
      expect(result.report.recommendation).toBe('safe');
      expect(result.alertEmitted).toBe(false);
    });

    it('throws on invalid current descriptor', async () => {
      await expect(
        service.generateReport({
          currentDescriptor: { invalid: true },
          targetDescriptor: validTargetSafe,
        }),
      ).rejects.toThrow();
    });

    it('throws on invalid target descriptor', async () => {
      await expect(
        service.generateReport({
          currentDescriptor: validCurrent,
          targetDescriptor: { invalid: true },
        }),
      ).rejects.toThrow();
    });

    it('throws on null current descriptor', async () => {
      await expect(
        service.generateReport({
          currentDescriptor: null,
          targetDescriptor: validTargetSafe,
        }),
      ).rejects.toThrow();
    });

    it('handles both empty entry lists', async () => {
      const empty = { version: '1.0', codeId: 'x', entries: [] };
      const result = await service.generateReport({
        currentDescriptor: empty,
        targetDescriptor: { ...empty, codeId: 'y' },
      });
      expect(result.report.recommendation).toBe('safe');
      expect(result.alertEmitted).toBe(false);
    });

    it('detects simultaneous additions and breaking removals', async () => {
      const current = {
        version: '1.0',
        codeId: 'aaa',
        entries: [
          { key: 'a', storageType: 'persistent', valueType: 'Bytes' },
        ],
      };
      const target = {
        version: '1.0',
        codeId: 'bbb',
        entries: [
          { key: 'b', storageType: 'persistent', valueType: 'Bytes' },
        ],
      };
      const result = await service.generateReport({
        currentDescriptor: current,
        targetDescriptor: target,
      });
      expect(result.report.recommendation).toBe('blocking');
      expect(result.alertEmitted).toBe(true);
      expect(result.report.diff.added).toHaveLength(1);
      expect(result.report.diff.removed).toHaveLength(1);
    });
  });
});

describe('validateDescriptor', () => {
  it('returns valid descriptor', () => {
    const result = validateDescriptor(validCurrent);
    expect(result.codeId).toBe('aaa');
    expect(result.entries).toHaveLength(2);
  });

  it('throws on invalid descriptor', () => {
    expect(() => validateDescriptor({})).toThrow();
  });
});
