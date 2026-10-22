import { SanctionsScreeningService, normalizeName, SUPPORTED_LIST_SOURCES } from './sanctionsScreeningService';
import { SanctionsListRepository, SanctionsSnapshot } from '../db/repositories/sanctionsListRepository';

function makeSnapshot(overrides?: Partial<SanctionsSnapshot>): SanctionsSnapshot {
  return {
    id: 'snap-1',
    list_source: 'ofac',
    version: '2026-01-01',
    entry_count: 1,
    normalized_checksum: 'checksum',
    entries: [],
    created_at: new Date(),
    ...overrides,
  };
}

function makeRepo(snapshots: SanctionsSnapshot[]): SanctionsListRepository {
  const mocked = {
    findLatestAcrossSources: jest.fn().mockResolvedValue(snapshots),
    calculateChecksum: () => 'x',
  };
  return mocked as unknown as SanctionsListRepository;
}

describe('normalizeName', () => {
  it('applies NFKD decomposition, lowercasing, and whitespace collapse', () => {
    expect(normalizeName('  Iván   PÉREZ  ')).toBe('ivan perez');
  });

  it('detects fullwidth/homoglyph variants as equal', () => {
    expect(normalizeName('Ⅴladimir')).toBe(normalizeName('Vladimir'));
  });
});

describe('SanctionsScreeningService', () => {
  it('marks complete+cleared when all sources have snapshots and no matches', async () => {
    const repo = makeRepo(SUPPORTED_LIST_SOURCES.map((src) =>
      makeSnapshot({ list_source: src, entries: [{ uid: '1', name: 'Not You' }] }),
    ));
    const svc = new SanctionsScreeningService(repo);
    const result = await svc.screen(['Jane Doe']);
    expect(result.complete).toBe(true);
    expect(result.cleared).toBe(true);
    expect(result.matches).toEqual([]);
  });

  it('flags fail-closed when any source is missing (incomplete)', async () => {
    // Only OFAC present; EU and UK missing.
    const repo = makeRepo([makeSnapshot({ list_source: 'ofac' })]);
    const svc = new SanctionsScreeningService(repo);
    const result = await svc.screen(['Jane Doe']);
    expect(result.complete).toBe(false);
    expect(result.cleared).toBe(false);
  });

  it('detects an exact primary-name match', async () => {
    const repo = makeRepo([makeSnapshot({ entries: [{ uid: '9', name: 'Alexander Petrov' }] })]);
    const svc = new SanctionsScreeningService(repo);
    const result = await svc.screen(['ALEXANDer PETROV']);
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].matchType).toBe('exact');
    expect(result.matches[0].uid).toBe('9');
    expect(result.cleared).toBe(false);
  });

  it('detects an alias match', async () => {
    const repo = makeRepo([
      makeSnapshot({
        entries: [{ uid: '7', name: 'Primary Name', aliases: ['Johnny Smith'] }],
      }),
    ]);
    const svc = new SanctionsScreeningService(repo);
    const result = await svc.screen(['johnny smith']);
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].matchType).toBe('alias');
    expect(result.matches[0].alias).toBe('Johnny Smith');
  });

  it('flags a partial-match alias for review (not auto-passed)', async () => {
    const repo = makeRepo([makeSnapshot({ entries: [{ uid: '3', name: 'Maria Gonzalez' }] })]);
    const svc = new SanctionsScreeningService(repo);
    const result = await svc.screen(['Maria']);
    expect(result.cleared).toBe(false);
    expect(result.matches.some((m) => m.matchType === 'partial')).toBe(true);
  });

  it('does not partial-match very short names (< 3 chars)', async () => {
    const repo = makeRepo([makeSnapshot({ entries: [{ uid: '4', name: 'Abe' }] })]);
    const svc = new SanctionsScreeningService(repo);
    const result = await svc.screen(['A']);
    expect(result.matches.filter((m) => m.matchType === 'partial')).toHaveLength(0);
  });

  it('screens beneficial owners in addition to the investor', async () => {
    const repo = makeRepo([
      makeSnapshot({ entries: [{ uid: '5', name: 'Beneficial Owner' }] }),
    ]);
    const svc = new SanctionsScreeningService(repo);
    const result = await svc.screen(['Clean Investor', 'BENEFICIAL owner']);
    expect(result.matches.some((m) => m.matchType === 'exact')).toBe(true);
  });
});