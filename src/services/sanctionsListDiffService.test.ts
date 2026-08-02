/**
 * Unit and integration tests for SanctionsListDiffService.
 *
 * Coverage targets:
 *  - computeDiff: added, removed, modified, no-change, edge cases
 *  - recordLoadWithDiff: first load, no-change reload, with-change reload,
 *    diff details saved with correct version_id
 *  - generateChangelog: delegates to repo
 *  - applyRetentionPolicy: delegates to repo and emits metric
 *  - computeHash / computeParseHash: determinism
 *  - Security: no diff details written with empty version_id
 *
 * All database calls are replaced by in-memory fakes so no real DB is needed.
 */
import { SanctionsListDiffService, SANCTIONS_DIFF_SIZE_METRIC, SANCTIONS_CHANGES_DETECTED_METRIC, SANCTIONS_RETENTION_METRIC, SEVEN_YEAR_MS } from './sanctionsListDiffService';
import { SanctionsListVersionsRepository, SanctionsListVersion, SanctionsListDiffDetail, CreateVersionInput, CreateDiffDetailInput } from '../db/repositories/sanctionsListVersionsRepository';
import { MetricsCollector } from '../lib/metrics';
import { OfacEntry } from './ofacSanctionsLoader';

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeEntry(uid: string, name: string, extra: Partial<OfacEntry> = {}): OfacEntry {
  return {
    uid,
    name,
    sdnType: 'individual',
    programs: ['SDGT'],
    title: undefined,
    remarks: undefined,
    addresses: [],
    ...extra,
  };
}

function makeVersion(overrides: Partial<SanctionsListVersion> = {}): SanctionsListVersion {
  return {
    id: 'ver-1',
    list_source: 'ofac',
    version: '2024-01-01',
    raw_payload_hash: 'abc',
    parse_hash: 'xyz',
    entry_count: 0,
    diff_summary: null,
    diff_size: null,
    previous_version_id: null,
    signature_valid: true,
    loaded_at: new Date('2024-01-01T00:00:00Z'),
    created_at: new Date('2024-01-01T00:00:00Z'),
    ...overrides,
  };
}

// ─── In-memory fake repository ────────────────────────────────────────────────

class FakeSanctionsRepo {
  versions: SanctionsListVersion[] = [];
  diffDetails: SanctionsListDiffDetail[] = [];
  private idCounter = 0;

  private nextId(): string {
    return `id-${++this.idCounter}`;
  }

  async createVersion(input: CreateVersionInput): Promise<SanctionsListVersion> {
    const row: SanctionsListVersion = {
      id: this.nextId(),
      list_source: input.list_source,
      version: input.version,
      raw_payload_hash: input.raw_payload_hash,
      parse_hash: input.parse_hash,
      entry_count: input.entry_count,
      diff_summary: input.diff_summary ?? null,
      diff_size: input.diff_size ?? null,
      previous_version_id: input.previous_version_id ?? null,
      signature_valid: input.signature_valid,
      loaded_at: input.loaded_at ?? new Date(),
      created_at: new Date(),
    };
    this.versions.push(row);
    return row;
  }

  async findLatestVersion(listSource: string): Promise<SanctionsListVersion | null> {
    const matches = this.versions.filter((v) => v.list_source === listSource);
    if (matches.length === 0) return null;
    return matches[matches.length - 1];
  }

  async findVersionById(id: string): Promise<SanctionsListVersion | null> {
    return this.versions.find((v) => v.id === id) ?? null;
  }

  async findVersionsBySource(listSource: string, limit = 100): Promise<SanctionsListVersion[]> {
    return this.versions.filter((v) => v.list_source === listSource).slice(0, limit);
  }

  async findVersionsAfterDate(listSource: string, date: Date): Promise<SanctionsListVersion[]> {
    return this.versions.filter(
      (v) => v.list_source === listSource && v.loaded_at > date,
    );
  }

  async deleteVersionsOlderThan(date: Date): Promise<number> {
    const before = this.versions.length;
    this.versions = this.versions.filter((v) => v.loaded_at >= date);
    return before - this.versions.length;
  }

  async createDiffDetail(input: CreateDiffDetailInput): Promise<SanctionsListDiffDetail> {
    const row: SanctionsListDiffDetail = {
      id: this.nextId(),
      version_id: input.version_id,
      entity_uid: input.entity_uid,
      entity_name: input.entity_name,
      change_type: input.change_type,
      previous_data: input.previous_data ?? null,
      new_data: input.new_data ?? null,
      created_at: new Date(),
    };
    this.diffDetails.push(row);
    return row;
  }

  async findDiffDetailsByVersionId(versionId: string): Promise<SanctionsListDiffDetail[]> {
    return this.diffDetails.filter((d) => d.version_id === versionId);
  }

  async findDiffDetailsByChangeType(versionId: string, changeType: 'added' | 'removed' | 'modified'): Promise<SanctionsListDiffDetail[]> {
    return this.diffDetails.filter((d) => d.version_id === versionId && d.change_type === changeType);
  }

  async findDiffDetailsByEntityUid(uid: string): Promise<SanctionsListDiffDetail[]> {
    return this.diffDetails.filter((d) => d.entity_uid === uid);
  }

  async generateChangelog(versionId: string): Promise<string> {
    const ver = await this.findVersionById(versionId);
    if (!ver) throw new Error(`Version ${versionId} not found`);
    const details = await this.findDiffDetailsByVersionId(versionId);
    const added = details.filter((d) => d.change_type === 'added');
    const removed = details.filter((d) => d.change_type === 'removed');
    const modified = details.filter((d) => d.change_type === 'modified');
    let log = `Sanctions List Changelog\n======================\n`;
    log += `Source: ${ver.list_source}\nVersion: ${ver.version}\n`;
    log += `Total Changes: ${ver.diff_size || 0}\n\n`;
    if (added.length) log += `Added Entities (${added.length}):\n` + added.map((e) => `  - ${e.entity_name} (UID: ${e.entity_uid})\n`).join('');
    if (removed.length) log += `Removed Entities (${removed.length}):\n` + removed.map((e) => `  - ${e.entity_name} (UID: ${e.entity_uid})\n`).join('');
    if (modified.length) log += `Modified Entities (${modified.length}):\n` + modified.map((e) => `  - ${e.entity_name} (UID: ${e.entity_uid})\n`).join('');
    if (!added.length && !removed.length && !modified.length) log += 'No changes detected in this update.\n';
    return log;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeService(repo?: FakeSanctionsRepo, metrics?: MetricsCollector) {
  const r = repo ?? new FakeSanctionsRepo();
  const m = metrics ?? new MetricsCollector({ enabled: true });
  const svc = new SanctionsListDiffService(r as unknown as SanctionsListVersionsRepository, m);
  return { svc, repo: r, metrics: m };
}

const RAW_PAYLOAD = 'ENT_NUM,SDN_NAME\n1,Alice';

// ─── computeDiff ─────────────────────────────────────────────────────────────

describe('SanctionsListDiffService.computeDiff', () => {
  const { svc } = makeService();

  const alice = makeEntry('1', 'Alice');
  const bob = makeEntry('2', 'Bob');
  const charlie = makeEntry('3', 'Charlie');
  const aliceMod = makeEntry('1', 'Alice Modified');

  it('returns all entries as added when previous list is empty', () => {
    const result = svc.computeDiff([], [alice, bob]);
    expect(result.added).toHaveLength(2);
    expect(result.removed).toHaveLength(0);
    expect(result.modified).toHaveLength(0);
    expect(result.summary.total_changes).toBe(2);
  });

  it('returns all entries as removed when current list is empty', () => {
    const result = svc.computeDiff([alice, bob], []);
    expect(result.added).toHaveLength(0);
    expect(result.removed).toHaveLength(2);
    expect(result.modified).toHaveLength(0);
    expect(result.summary.total_changes).toBe(2);
  });

  it('returns empty diff when lists are identical', () => {
    const result = svc.computeDiff([alice, bob], [alice, bob]);
    expect(result.added).toHaveLength(0);
    expect(result.removed).toHaveLength(0);
    expect(result.modified).toHaveLength(0);
    expect(result.summary.total_changes).toBe(0);
  });

  it('detects a new entity added in the current list', () => {
    const result = svc.computeDiff([alice], [alice, charlie]);
    expect(result.added.map((e) => e.uid)).toEqual(['3']);
  });

  it('detects an entity removed from the current list', () => {
    const result = svc.computeDiff([alice, bob], [alice]);
    expect(result.removed.map((e) => e.uid)).toEqual(['2']);
  });

  it('detects a modified entity (name change)', () => {
    const result = svc.computeDiff([alice], [aliceMod]);
    expect(result.modified).toHaveLength(1);
    expect(result.modified[0].previous.name).toBe('Alice');
    expect(result.modified[0].current.name).toBe('Alice Modified');
  });

  it('handles simultaneous additions, removals, and modifications', () => {
    const result = svc.computeDiff([alice, bob], [aliceMod, charlie]);
    expect(result.added.map((e) => e.uid)).toEqual(['3']);
    expect(result.removed.map((e) => e.uid)).toEqual(['2']);
    expect(result.modified).toHaveLength(1);
    expect(result.summary.total_changes).toBe(3);
  });

  it('detects modified when program list changes', () => {
    const prev = makeEntry('1', 'Alice', { programs: ['SDGT'] });
    const curr = makeEntry('1', 'Alice', { programs: ['SDGT', 'NPWMD'] });
    const result = svc.computeDiff([prev], [curr]);
    expect(result.modified).toHaveLength(1);
  });

  it('treats program ordering as irrelevant (sorted before comparison)', () => {
    const prev = makeEntry('1', 'Alice', { programs: ['SDGT', 'NPWMD'] });
    const curr = makeEntry('1', 'Alice', { programs: ['NPWMD', 'SDGT'] });
    const result = svc.computeDiff([prev], [curr]);
    expect(result.modified).toHaveLength(0);
  });

  it('ignores specified fields when ignoreFields option is set', () => {
    const result = svc.computeDiff([alice], [aliceMod], { ignoreFields: ['name'] });
    expect(result.modified).toHaveLength(0);
  });

  it('caseInsensitive option makes name comparison case-insensitive', () => {
    const prev = makeEntry('1', 'Alice');
    const curr = makeEntry('1', 'ALICE');
    const result = svc.computeDiff([prev], [curr], { caseInsensitive: true });
    expect(result.modified).toHaveLength(0);
  });

  it('returns correct summary counts', () => {
    const result = svc.computeDiff([alice, bob], [aliceMod, charlie]);
    expect(result.summary).toEqual({
      total_added: 1,
      total_removed: 1,
      total_modified: 1,
      total_changes: 3,
    });
  });

  it('returns empty diff for two empty lists', () => {
    const result = svc.computeDiff([], []);
    expect(result.summary.total_changes).toBe(0);
  });

  it('detects address change as modified', () => {
    const prev = makeEntry('1', 'Alice', { addresses: [{ country: 'US' }] });
    const curr = makeEntry('1', 'Alice', { addresses: [{ country: 'RU' }] });
    expect(svc.computeDiff([prev], [curr]).modified).toHaveLength(1);
  });

  it('detects sdnType change as modified', () => {
    const prev = makeEntry('1', 'Alice', { sdnType: 'individual' });
    const curr = makeEntry('1', 'Alice', { sdnType: 'entity' });
    expect(svc.computeDiff([prev], [curr]).modified).toHaveLength(1);
  });
});

// ─── computeHash / computeParseHash ──────────────────────────────────────────

describe('SanctionsListDiffService.computeHash', () => {
  const { svc } = makeService();

  it('returns a 64-char hex string (SHA-256)', () => {
    const h = svc.computeHash('hello');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic for the same input', () => {
    expect(svc.computeHash('test')).toBe(svc.computeHash('test'));
  });

  it('differs for different inputs', () => {
    expect(svc.computeHash('a')).not.toBe(svc.computeHash('b'));
  });
});

describe('SanctionsListDiffService.computeParseHash', () => {
  const { svc } = makeService();

  it('returns a 64-char hex string', () => {
    expect(svc.computeParseHash([makeEntry('1', 'Alice')])).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic for identical entry sets', () => {
    const entries = [makeEntry('1', 'Alice'), makeEntry('2', 'Bob')];
    expect(svc.computeParseHash(entries)).toBe(svc.computeParseHash(entries));
  });

  it('is order-independent (sorts by UID before hashing)', () => {
    const e1 = [makeEntry('1', 'Alice'), makeEntry('2', 'Bob')];
    const e2 = [makeEntry('2', 'Bob'), makeEntry('1', 'Alice')];
    expect(svc.computeParseHash(e1)).toBe(svc.computeParseHash(e2));
  });

  it('differs for different entry content', () => {
    expect(svc.computeParseHash([makeEntry('1', 'Alice')])).not.toBe(
      svc.computeParseHash([makeEntry('1', 'Bob')]),
    );
  });

  it('returns a stable hash for an empty entry list', () => {
    const h = svc.computeParseHash([]);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ─── recordLoadWithDiff ───────────────────────────────────────────────────────

describe('SanctionsListDiffService.recordLoadWithDiff', () => {
  it('creates a version row on the very first load (no previous version)', async () => {
    const { svc, repo } = makeService();
    const entries = [makeEntry('1', 'Alice'), makeEntry('2', 'Bob')];
    const ver = await svc.recordLoadWithDiff('ofac', '2024-01-01', RAW_PAYLOAD, entries, true);

    expect(ver.list_source).toBe('ofac');
    expect(ver.version).toBe('2024-01-01');
    expect(ver.entry_count).toBe(2);
    expect(ver.signature_valid).toBe(true);
    expect(ver.previous_version_id).toBeNull();
    expect(repo.versions).toHaveLength(1);
  });

  it('stores a non-empty raw_payload_hash on first load', async () => {
    const { svc } = makeService();
    const ver = await svc.recordLoadWithDiff('ofac', '2024-01-01', RAW_PAYLOAD, [], true);
    expect(ver.raw_payload_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('records a no-change reload without writing diff details', async () => {
    const { svc, repo } = makeService();
    const entries = [makeEntry('1', 'Alice')];
    const first = await svc.recordLoadWithDiff('ofac', '2024-01-01', RAW_PAYLOAD, entries, true);

    // Same parse hash — no changes
    await svc.recordLoadWithDiff('ofac', '2024-01-08', RAW_PAYLOAD, entries, true, first.parse_hash);

    expect(repo.versions).toHaveLength(2);
    expect(repo.diffDetails).toHaveLength(0); // no details for no-change
    expect(repo.versions[1].diff_size).toBe(0);
  });

  it('sets diff_size = 0 on a no-change reload', async () => {
    const { svc, repo } = makeService();
    const entries = [makeEntry('1', 'Alice')];
    const first = await svc.recordLoadWithDiff('ofac', '2024-01-01', RAW_PAYLOAD, entries, true);
    await svc.recordLoadWithDiff('ofac', '2024-01-08', RAW_PAYLOAD, entries, true, first.parse_hash);
    expect(repo.versions[1].diff_size).toBe(0);
  });

  it('links no-change reload to previous_version_id', async () => {
    const { svc, repo } = makeService();
    const entries = [makeEntry('1', 'Alice')];
    const first = await svc.recordLoadWithDiff('ofac', '2024-01-01', RAW_PAYLOAD, entries, true);
    const second = await svc.recordLoadWithDiff('ofac', '2024-01-08', 'new payload', entries, true, first.parse_hash);
    expect(second.previous_version_id).toBe(first.id);
  });

  it('writes diff details with the correct version_id when entries change', async () => {
    const { svc, repo } = makeService();
    const v1 = await svc.recordLoadWithDiff('ofac', '2024-01-01', RAW_PAYLOAD, [], true);

    const entries = [makeEntry('1', 'Alice'), makeEntry('2', 'Bob')];
    const v2 = await svc.recordLoadWithDiff('ofac', '2024-01-08', 'payload2', entries, true);

    const details = repo.diffDetails.filter((d) => d.version_id === v2.id);
    expect(details.length).toBeGreaterThan(0);
    // No detail should have an empty version_id (the pre-fix bug)
    expect(repo.diffDetails.every((d) => d.version_id !== '')).toBe(true);
  });

  it('records added/removed entries as diff details', async () => {
    const { svc, repo } = makeService();
    // First load — empty list establishes a previous version
    await svc.recordLoadWithDiff('ofac', '2024-01-01', RAW_PAYLOAD, [], true);

    const entries = [makeEntry('1', 'Alice'), makeEntry('2', 'Bob')];
    const v2 = await svc.recordLoadWithDiff('ofac', '2024-01-08', 'payload2', entries, true);

    const added = repo.diffDetails.filter(
      (d) => d.version_id === v2.id && d.change_type === 'added',
    );
    expect(added).toHaveLength(2);
    expect(added.map((d) => d.entity_uid).sort()).toEqual(['1', '2']);
  });

  it('emits sanctions.list.diff.size gauge metric on each load', async () => {
    const { svc, metrics } = makeService();
    await svc.recordLoadWithDiff('ofac', '2024-01-01', RAW_PAYLOAD, [makeEntry('1', 'A')], true);
    const snapshot = await metrics.getSnapshot();
    const gauge = snapshot.custom.find((m) => m.name === 'sanctions_list_diff_size');
    expect(gauge).toBeDefined();
  });

  it('emits changes_detected counter when diff_size > 0', async () => {
    const { svc, repo, metrics } = makeService();
    await svc.recordLoadWithDiff('ofac', '2024-01-01', RAW_PAYLOAD, [], true);
    await svc.recordLoadWithDiff('ofac', '2024-01-08', 'payload2', [makeEntry('1', 'Alice')], true);
    const snapshot = await metrics.getSnapshot();
    const counter = snapshot.custom.find((m) => m.name === 'sanctions_list_diff_changes_detected');
    expect(counter).toBeDefined();
    expect(counter?.value).toBeGreaterThanOrEqual(1);
  });

  it('does NOT emit changes_detected counter when diff_size = 0', async () => {
    const { svc, repo, metrics } = makeService();
    const entries = [makeEntry('1', 'Alice')];
    const first = await svc.recordLoadWithDiff('ofac', '2024-01-01', RAW_PAYLOAD, entries, true);
    await svc.recordLoadWithDiff('ofac', '2024-01-08', RAW_PAYLOAD, entries, true, first.parse_hash);
    const snapshot = await metrics.getSnapshot();
    const counter = snapshot.custom.find((m) => m.name === 'sanctions_list_diff_changes_detected');
    // Counter should not exist or should be 0 when no changes detected
    expect(counter?.value ?? 0).toBe(0);
  });

  it('accepts an explicit parseHash to skip re-computation', async () => {
    const { svc, repo } = makeService();
    const entries = [makeEntry('1', 'Alice')];
    const fixedHash = 'a'.repeat(64);
    const ver = await svc.recordLoadWithDiff('ofac', '2024-01-01', RAW_PAYLOAD, entries, true, fixedHash);
    expect(ver.parse_hash).toBe(fixedHash);
  });

  it('records signature_valid = false without throwing', async () => {
    const { svc, repo } = makeService();
    const ver = await svc.recordLoadWithDiff('ofac', '2024-01-01', RAW_PAYLOAD, [], false);
    expect(ver.signature_valid).toBe(false);
  });

  it('handles multiple list sources independently', async () => {
    const { svc, repo } = makeService();
    await svc.recordLoadWithDiff('ofac', '2024-01-01', RAW_PAYLOAD, [makeEntry('1', 'A')], true);
    await svc.recordLoadWithDiff('eu_consolidated', '2024-01-01', RAW_PAYLOAD, [makeEntry('2', 'B')], true);

    const ofacVersions = repo.versions.filter((v) => v.list_source === 'ofac');
    const euVersions = repo.versions.filter((v) => v.list_source === 'eu_consolidated');
    expect(ofacVersions).toHaveLength(1);
    expect(euVersions).toHaveLength(1);
    // Each source has no previous version linking to the other
    expect(ofacVersions[0].previous_version_id).toBeNull();
    expect(euVersions[0].previous_version_id).toBeNull();
  });
});

// ─── generateChangelog ────────────────────────────────────────────────────────

describe('SanctionsListDiffService.generateChangelog', () => {
  it('returns a string containing the version source', async () => {
    const { svc, repo } = makeService();
    const ver = await svc.recordLoadWithDiff('ofac', '2024-01-01', RAW_PAYLOAD, [], true);
    const log = await svc.generateChangelog(ver.id);
    expect(log).toContain('ofac');
  });

  it('includes no-changes message when diff is empty', async () => {
    const { svc, repo } = makeService();
    const ver = await svc.recordLoadWithDiff('ofac', '2024-01-01', RAW_PAYLOAD, [], true);
    const log = await svc.generateChangelog(ver.id);
    expect(log).toContain('No changes detected');
  });

  it('lists added entities by name and UID', async () => {
    const { svc, repo } = makeService();
    // First load creates prev
    await svc.recordLoadWithDiff('ofac', '2024-01-01', RAW_PAYLOAD, [], true);
    const entries = [makeEntry('42', 'Evil Corp')];
    const ver2 = await svc.recordLoadWithDiff('ofac', '2024-01-08', 'payload2', entries, true);
    const log = await svc.generateChangelog(ver2.id);
    expect(log).toContain('Evil Corp');
    expect(log).toContain('42');
  });

  it('throws when the version is not found', async () => {
    const { svc } = makeService();
    await expect(svc.generateChangelog('nonexistent-id')).rejects.toThrow();
  });
});

// ─── applyRetentionPolicy ─────────────────────────────────────────────────────

describe('SanctionsListDiffService.applyRetentionPolicy', () => {
  it('deletes versions older than the cutoff date', async () => {
    const { svc, repo } = makeService();
    const oldDate = new Date(Date.now() - SEVEN_YEAR_MS - 1000);
    repo.versions.push(makeVersion({ id: 'old-ver', loaded_at: oldDate, list_source: 'ofac', version: 'old' }));
    repo.versions.push(makeVersion({ id: 'new-ver', loaded_at: new Date(), list_source: 'ofac', version: 'new' }));

    const deleted = await svc.applyRetentionPolicy(new Date(Date.now() - 1000));
    expect(deleted).toBe(1);
    expect(repo.versions.find((v) => v.id === 'old-ver')).toBeUndefined();
    expect(repo.versions.find((v) => v.id === 'new-ver')).toBeDefined();
  });

  it('returns 0 when no versions are older than the cutoff', async () => {
    const { svc, repo } = makeService();
    repo.versions.push(makeVersion({ id: 'new-ver', loaded_at: new Date(), list_source: 'ofac', version: 'new' }));
    const deleted = await svc.applyRetentionPolicy(new Date(Date.now() - SEVEN_YEAR_MS));
    expect(deleted).toBe(0);
  });

  it('emits the retention metric', async () => {
    const { svc, repo, metrics } = makeService();
    const oldDate = new Date(Date.now() - SEVEN_YEAR_MS - 1000);
    repo.versions.push(makeVersion({ id: 'old', loaded_at: oldDate, list_source: 'ofac', version: 'old' }));
    await svc.applyRetentionPolicy(new Date(Date.now() - 1000));
    const snapshot = await metrics.getSnapshot();
    const counter = snapshot.custom.find((m) => m.name === 'sanctions_list_retention_applied');
    expect(counter?.value).toBeGreaterThanOrEqual(1);
  });

  it('SEVEN_YEAR_MS constant is approximately 7 years', () => {
    const sevenYearsMs = 7 * 365.25 * 24 * 60 * 60 * 1000;
    expect(SEVEN_YEAR_MS).toBeCloseTo(sevenYearsMs, -3);
  });
});

// ─── Security: no empty version_id in diff details ────────────────────────────

describe('SanctionsListDiffService — security: version_id integrity', () => {
  it('never writes a diff detail row with an empty version_id', async () => {
    const { svc, repo } = makeService();
    // Establish a base version
    await svc.recordLoadWithDiff('ofac', 'v1', RAW_PAYLOAD, [], true);
    // Load with changes
    const entries = [makeEntry('1', 'Alice'), makeEntry('2', 'Bob')];
    await svc.recordLoadWithDiff('ofac', 'v2', 'payload2', entries, true);

    for (const detail of repo.diffDetails) {
      expect(detail.version_id).not.toBe('');
      expect(detail.version_id).toBeTruthy();
    }
  });

  it('all diff detail version_ids reference an existing version', async () => {
    const { svc, repo } = makeService();
    await svc.recordLoadWithDiff('ofac', 'v1', RAW_PAYLOAD, [], true);
    await svc.recordLoadWithDiff('ofac', 'v2', 'p2', [makeEntry('1', 'Alice')], true);

    const versionIds = new Set(repo.versions.map((v) => v.id));
    for (const detail of repo.diffDetails) {
      expect(versionIds.has(detail.version_id)).toBe(true);
    }
  });
});
