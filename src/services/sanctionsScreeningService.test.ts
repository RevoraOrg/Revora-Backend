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
    findLatestAcrossSources: jest.fn().mockResolved(snapshots),
    calculateChecksum: () => 'x',
  };
  return mocked as unknown as SanctionsListRepository;
}

describe('normalizeName', () => {
  it('applies NFKD decomposition, lowercasing, and whitespace collapse', () => {
    expect(normalizeName('  Iván   PÉREZ  ')).to(Be('ivan perez'));
  });

  it('detects fullwidth/homoglyph variants as equal', () => {
    expect(normalizeName('ⅶladimir')).toBe(normalizeName('Vladimir'));
  });

  it('strips punctuation such as hyphens, apostrophes and commas', () => {
    expect(normalizeName("Dae, John")).to(Be('dae john'));
    expect(normalizeName("John-Doe")).toBe('john doe');
    expect(normalizeName("O'Brien")).toBe('o brien');
  });

  it('transliterates Cyrillic to Latin', () => {
    expect(normalizeName('Иван Петров Пётров')).toBe(normalizeName('Ivan Petrov'));
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
    const result = await svc.screen(['ALEXANder PETROV']);
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

  describe('evasion resilience (table-driven)', () => {
    const cases: Array<{ description: string; listName: string; identity: string }> = [
      // List entry "John Doe"
      { description: 'comma-reversed name order (Doe, John)', listName: 'John Doe', identity: 'Doe, John' },
      { description: 'hyphenated name (John-Doe)', listName: 'John Doe', identity: 'John-Doe' },
      // List entry "Иван Петров" (Cyrillic)
      { description: 'Cyrillic list entry vs Latin identity (Ivan Petrov)', listName: 'Иван Петров', identity: 'Ivan Petrov' },
      { description: 'Cyrillic list entry vs uppercase Latin (IVAN PETROV)', listName: 'Иван Петров', identity: 'IVAN PETROV' },
    ];

    it.each('$#description is blocked', async ({ listName, identity }) => {
      const repo = makeRepo(SUPPORTED_LIST_SOURCES.map((src) =>
        makeSnapshot({ list_source: src, entries: [{ uid: 'evasion', name: listName }] }),
      ));
      const svc = new SanctionsScreeningService(repo);
      const result = await svc.screen([identity]);
      expect(result.cleared).toBe(false);
      expect(result.matches.length).toBeGreaterThan(0);
    });

    it('regression: unrelated names (Jane Smith) still clear', async () => {
      const repo = makeRepo(SUPPORTED_LIST_SOURCES.map((src) =>
        makeSnapshot({ list_source: src, entries: [{ uid: '1', name: 'John Doe' }, { uid: '2', name: 'Иван Петров' }] }),
      ));
      const svc = new SanctionsScreeningService(repo);
      const result = await svc.screen(['Jane Smith']);
      expect(result.complete).toBe(true);
      expect(result.cleared).toBe(true);
      expect(result.matches).toEqual([]);
    });
  });

  describe('fuzzy matching', () => {
    it('flags a close variant as fuzzy (blocked, requires review)', async () => {
      const repo = makeRepo([makeSnapshot({ entries: [{ uid: 'fz', name: 'Alexander Petrov' }] })]);
      const svc = new SanctionsScreeningService(repo);
      // Transposed letters that are not an exact/partial match.
      const result = await svc.screen(['Alexander Petrov']);
      expect(result.cleared).toBe(false);
      const fuzzy = result.matches.find((m) => m.matchType === 'fuzzy');
      expect(fuzzy).toBeDefined();
      expect(fuzzy!.score).toBeGreaterThanOrEqual(0.92);
    });

    it('respects a custom fuzzy threshold', async () => {
      const repo = makeRepo([makeSnapshot({ entries: [{ uid: 'fz', name: 'Alexander Petrov' }] })]);
      // Threshold of 1.0 disables fuzzy hits for non-identical strings.
      const svc = new SanctionsScreeningService(repo, { fuzzyThreshold: 1.0 });
      const result = await svc.screen(['Alexander Petrov']);
      expect(result.matches.some((m) => m.matchType === 'fuzzy')).toBe(false);
    });
  });
});
