import {
  compareStorageLayouts,
  buildDriftReport,
  parseStorageDescriptor,
  StorageDescriptor,
  StorageEntry,
} from './storageLayoutDescriptor';

// ─── parseStorageDescriptor ──────────────────────────────────────────────────

describe('parseStorageDescriptor', () => {
  it('parses a valid descriptor', () => {
    const raw = {
      version: '1.0',
      codeId: 'abc123',
      entries: [
        { key: 'balance', storageType: 'persistent', valueType: 'Uint128' },
      ],
    };
    const result = parseStorageDescriptor(raw);
    expect(result.version).toBe('1.0');
    expect(result.codeId).toBe('abc123');
    expect(result.entries).toHaveLength(1);
  });

  it('parses descriptor with empty entries', () => {
    const result = parseStorageDescriptor({
      version: '1.0',
      codeId: 'x',
      entries: [],
    });
    expect(result.entries).toHaveLength(0);
  });

  it('parses entry with optional description', () => {
    const result = parseStorageDescriptor({
      version: '1.0',
      codeId: 'x',
      entries: [
        { key: 'k', storageType: 'instance', valueType: 'Bytes', description: 'desc' },
      ],
    });
    expect(result.entries[0].description).toBe('desc');
  });

  it('throws on missing version', () => {
    expect(() =>
      parseStorageDescriptor({ codeId: 'x', entries: [] }),
    ).toThrow();
  });

  it('throws on missing codeId', () => {
    expect(() =>
      parseStorageDescriptor({ version: '1.0', entries: [] }),
    ).toThrow();
  });

  it('throws on invalid storageType', () => {
    expect(() =>
      parseStorageDescriptor({
        version: '1.0',
        codeId: 'x',
        entries: [{ key: 'k', storageType: 'global', valueType: 'Bytes' }],
      }),
    ).toThrow();
  });

  it('throws on empty key', () => {
    expect(() =>
      parseStorageDescriptor({
        version: '1.0',
        codeId: 'x',
        entries: [{ key: '', storageType: 'persistent', valueType: 'Bytes' }],
      }),
    ).toThrow();
  });

  it('throws on empty valueType', () => {
    expect(() =>
      parseStorageDescriptor({
        version: '1.0',
        codeId: 'x',
        entries: [{ key: 'k', storageType: 'persistent', valueType: '' }],
      }),
    ).toThrow();
  });

  it('throws on non-object input', () => {
    expect(() => parseStorageDescriptor(null)).toThrow();
  });
});

// ─── compareStorageLayouts ───────────────────────────────────────────────────

function entry(
  key: string,
  storageType: StorageEntry['storageType'] = 'persistent',
  valueType = 'Uint128',
): StorageEntry {
  return { key, storageType, valueType };
}

function descriptor(codeId: string, entries: StorageEntry[]): StorageDescriptor {
  return { version: '1.0', codeId, entries };
}

describe('compareStorageLayouts', () => {
  describe('no changes', () => {
    it('returns empty diff for identical descriptors', () => {
      const a = descriptor('v1', [entry('a'), entry('b')]);
      const b = descriptor('v2', [entry('a'), entry('b')]);
      const diff = compareStorageLayouts(a, b);
      expect(diff.added).toHaveLength(0);
      expect(diff.removed).toHaveLength(0);
      expect(diff.modified).toHaveLength(0);
    });

    it('returns empty diff for both empty', () => {
      const diff = compareStorageLayouts(
        descriptor('v1', []),
        descriptor('v2', []),
      );
      expect(diff.added).toHaveLength(0);
      expect(diff.removed).toHaveLength(0);
      expect(diff.modified).toHaveLength(0);
    });
  });

  describe('additions', () => {
    it('detects a single added entry', () => {
      const diff = compareStorageLayouts(
        descriptor('v1', [entry('a')]),
        descriptor('v2', [entry('a'), entry('new_entry')]),
      );
      expect(diff.added).toHaveLength(1);
      expect(diff.added[0].entry.key).toBe('new_entry');
      expect(diff.removed).toHaveLength(0);
    });

    it('detects multiple added entries', () => {
      const diff = compareStorageLayouts(
        descriptor('v1', []),
        descriptor('v2', [entry('x'), entry('y'), entry('z')]),
      );
      expect(diff.added).toHaveLength(3);
    });
  });

  describe('removals', () => {
    it('detects a single removed entry', () => {
      const diff = compareStorageLayouts(
        descriptor('v1', [entry('a'), entry('b')]),
        descriptor('v2', [entry('a')]),
      );
      expect(diff.removed).toHaveLength(1);
      expect(diff.removed[0].entry.key).toBe('b');
      expect(diff.added).toHaveLength(0);
    });

    it('detects multiple removed entries', () => {
      const diff = compareStorageLayouts(
        descriptor('v1', [entry('x'), entry('y'), entry('z')]),
        descriptor('v2', []),
      );
      expect(diff.removed).toHaveLength(3);
    });
  });

  describe('modifications', () => {
    it('detects storage type change', () => {
      const diff = compareStorageLayouts(
        descriptor('v1', [entry('k', 'persistent', 'Uint128')]),
        descriptor('v2', [entry('k', 'instance', 'Uint128')]),
      );
      expect(diff.modified).toHaveLength(1);
      expect(diff.modified[0].breaking).toBe(true);
      expect(diff.modified[0].reason).toContain('storage type changed');
    });

    it('detects value type change', () => {
      const diff = compareStorageLayouts(
        descriptor('v1', [entry('k', 'persistent', 'Uint128')]),
        descriptor('v2', [entry('k', 'persistent', 'Bytes')]),
      );
      expect(diff.modified).toHaveLength(1);
      expect(diff.modified[0].breaking).toBe(true);
      expect(diff.modified[0].reason).toContain('value type changed');
    });

    it('detects both storage and value type changes on same entry', () => {
      const diff = compareStorageLayouts(
        descriptor('v1', [entry('k', 'persistent', 'Uint128')]),
        descriptor('v2', [entry('k', 'temporary', 'Bytes')]),
      );
      expect(diff.modified).toHaveLength(1);
      expect(diff.modified[0].reason).toContain('storage type');
      expect(diff.modified[0].reason).toContain('value type');
    });

    it('does not flag entries with same key, type, and value type', () => {
      const diff = compareStorageLayouts(
        descriptor('v1', [entry('k', 'persistent', 'Uint128')]),
        descriptor('v2', [entry('k', 'persistent', 'Uint128')]),
      );
      expect(diff.modified).toHaveLength(0);
    });
  });

  describe('combined changes', () => {
    it('handles additions, removals, and modifications simultaneously', () => {
      const current = descriptor('v1', [
        entry('keep', 'persistent', 'Uint128'),
        entry('modify', 'persistent', 'Uint128'),
        entry('remove', 'instance', 'Bytes'),
      ]);
      const target = descriptor('v2', [
        entry('keep', 'persistent', 'Uint128'),
        entry('modify', 'persistent', 'Address'),
        entry('added', 'temporary', 'Bytes'),
      ]);

      const diff = compareStorageLayouts(current, target);
      expect(diff.added).toHaveLength(1);
      expect(diff.added[0].entry.key).toBe('added');
      expect(diff.removed).toHaveLength(1);
      expect(diff.removed[0].entry.key).toBe('remove');
      expect(diff.modified).toHaveLength(1);
      expect(diff.modified[0].entry.key).toBe('modify');
    });
  });
});

// ─── buildDriftReport ────────────────────────────────────────────────────────

describe('buildDriftReport', () => {
  it('returns "safe" when no changes exist', () => {
    const d = descriptor('v1', [entry('a')]);
    const report = buildDriftReport(d, { ...d, codeId: 'v2' });
    expect(report.recommendation).toBe('safe');
    expect(report.hasBreakingChanges).toBe(false);
    expect(report.breakingChanges).toHaveLength(0);
    expect(report.currentCodeId).toBe('v1');
    expect(report.targetCodeId).toBe('v2');
  });

  it('returns "review_required" when only additions exist', () => {
    const current = descriptor('v1', []);
    const target = descriptor('v2', [entry('new')]);
    const report = buildDriftReport(current, target);
    expect(report.recommendation).toBe('review_required');
    expect(report.hasBreakingChanges).toBe(false);
    expect(report.diff.added).toHaveLength(1);
  });

  it('returns "blocking" when removals exist', () => {
    const current = descriptor('v1', [entry('a')]);
    const target = descriptor('v2', []);
    const report = buildDriftReport(current, target);
    expect(report.recommendation).toBe('blocking');
    expect(report.hasBreakingChanges).toBe(true);
    expect(report.breakingChanges).toHaveLength(1);
    expect(report.breakingChanges[0]).toContain("Removed storage entry 'a'");
  });

  it('returns "blocking" when modifications exist', () => {
    const current = descriptor('v1', [entry('k', 'persistent', 'Uint128')]);
    const target = descriptor('v2', [entry('k', 'persistent', 'Address')]);
    const report = buildDriftReport(current, target);
    expect(report.recommendation).toBe('blocking');
    expect(report.hasBreakingChanges).toBe(true);
    expect(report.breakingChanges[0]).toContain("Modified entry 'k'");
  });

  it('includes multiple breaking reasons', () => {
    const current = descriptor('v1', [
      entry('a', 'persistent', 'Uint128'),
      entry('b', 'persistent', 'Bytes'),
    ]);
    const target = descriptor('v2', [
      entry('a', 'instance', 'Uint128'),
      entry('b', 'persistent', 'Address'),
    ]);
    const report = buildDriftReport(current, target);
    expect(report.breakingChanges).toHaveLength(2);
  });

  it('sets a valid ISO timestamp', () => {
    const report = buildDriftReport(
      descriptor('v1', []),
      descriptor('v2', []),
    );
    expect(new Date(report.timestamp).toISOString()).toBe(report.timestamp);
  });

  it('prefers blocking over review_required when both exist', () => {
    const current = descriptor('v1', [entry('a')]);
    const target = descriptor('v2', [entry('b')]);
    const report = buildDriftReport(current, target);
    expect(report.recommendation).toBe('blocking');
    expect(report.breakingChanges).toHaveLength(1);
  });
});
