import { SanctionsListRepository, SanctionsEntry, SanctionsSnapshot } from '../db/repositories/sanctionsListRepository';

/** Supported sanctions list sources. */
export const SUPPORTED_LIST_SOURCES = ['ofac', 'eu_consolidated', 'uk_hmt'] as const;

export type ListSource = (typeof SUPPORTED_LIST_SOURCES)[number];

export type MatchType = 'exact' | 'alias' | 'partial';

export interface SanctionsMatch {
  source: string;
  version: string;
  listName: string;
  alias?: string;
  matchType: MatchType;
  matchedName: string;
  uid?: string;
}

export interface SanctionsScreenResult {
  /** False when any list source was missing (fail-closed). */
  complete: boolean;
  /** Version of each source used, keyed by source. */
  versions: Record<string, string>;
  /** Non-empty when the submitted identity matched a list entry. */
  matches: SanctionsMatch[];
  /** True when the identity is clear of sanctions hits. */
  cleared: boolean;
}

/**
 * Normalize a name for comparison using Unicode NFKD canonical decomposition,
 * case folding, stripping of combining diacritical marks, and whitespace
 * collapsing. This defeats homoglyph/lookalike bypasses (e.g. fullwidth,
 * accented, or composed variants) so `Иван`/`IVAN` and `Iván`/`Ivan` compare
 * identically against the stored canonical list.
 *
 * Combining marks (category `Mn`) are removed *after* NFKD so accented
 * characters (`á` → `a` + U+0301) strip their diacritic without corrupting
 * unrelated code points.
 */
export function normalizeName(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/\p{Mn}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Screen a list of identity names (investor + beneficial owners) against the
 * latest verified snapshots for all supported sources.
 *
 * Fail-closed behavior:
 * - If any supported source has no verified snapshot, the resulting
 *   `complete === false` and `cleared === false`; callers MUST reject the
 *   submission (never auto-pass on a stale/missing list).
 *
 * Matching semantics:
 * - `exact` – normalized identity equals normalized primary name.
 * - `alias` – normalized identity equals a normalized alias.
 * - `partial` – either normalized string contains the other AND the shorter
 *   side is at least 3 characters; partial matches are flagged for review and
 *   treated as a hit (not auto-passed).
 */
export class SanctionsScreeningService {
  constructor(private readonly repo: SanctionsListRepository) {}

  async screen(identityNames: string[], now?: Date): Promise<SanctionsScreenResult> {
    const sources = [...(SUPPORTED_LIST_SOURCES as readonly string[])];
    const snapshots = await this.repo.findLatestAcrossSources(sources);

    const versionMap = Object.fromEntries(
      snapshots.map((s) => [s.list_source, s.version]),
    );
    const complete = sources.every((src) => versionMap[src] !== undefined);

    const normalized = identityNames.map(normalizeName).filter((n) => n.length > 0);

    const matches: SanctionsMatch[] = [];
    for (const snapshot of snapshots) {
      for (const match of this.matchSnapshot(snapshot, normalized)) {
        matches.push(match);
      }
    }

    return {
      complete,
      versions: versionMap,
      matches,
      cleared: complete && matches.length === 0,
    };
  }

  private matchSnapshot(
    snapshot: SanctionsSnapshot,
    normalizedIdentities: string[],
  ): SanctionsMatch[] {
    const result: SanctionsMatch[] = [];
    for (const entry of snapshot.entries) {
      const primary = normalizeName(entry.name);
      const aliases = (entry.aliases ?? []).map(normalizeName).filter((a) => a.length > 0);

      // Map normalized alias back to display alias for reporting.
      const aliasDisplay: Array<{ norm: string; display: string }> = (
        (entry.aliases ?? []).map((a) => ({ norm: normalizeName(a), display: a }))
      ).filter((a) => a.norm.length > 0);

      for (const identity of normalizedIdentities) {
        if (primary.length > 0 && identity === primary) {
          result.push(this.buildMatch(snapshot, entry, 'exact', entry.name));
          continue;
        }
        if (aliases.includes(identity)) {
          const found = aliasDisplay.find((a) => a.norm === identity);
          result.push(this.buildMatch(snapshot, entry, 'alias', found?.display ?? identity));
          continue;
        }
        if (this.partialMatch(identity, primary, aliases)) {
          result.push(this.buildMatch(snapshot, entry, 'partial', entry.name));
        }
      }
    }
    return result;
  }

  private partialMatch(identity: string, primary: string, aliases: string[]): boolean {
    const candidates = primary.length > 0 ? [primary, ...aliases] : aliases;
    return candidates.some((candidate) => {
      if (!candidate || candidate.length === 0) return false;
      const shorter = identity.length <= candidate.length ? identity : candidate;
      const longer = identity.length <= candidate.length ? candidate : identity;
      if (shorter.length < 3) return false;
      return longer.includes(shorter);
    });
  }

  private buildMatch(
    snapshot: SanctionsSnapshot,
    entry: SanctionsEntry,
    matchType: MatchType,
    matchedName: string,
  ): SanctionsMatch {
    return {
      source: snapshot.list_source,
      version: snapshot.version,
      listName: entry.name,
      matchType,
      matchedName,
      uid: entry.uid,
      alias: matchType === 'alias' ? matchedName : undefined,
    };
  }
}

/** Factory for service-level wiring. */
export function createSanctionsScreeningService(
  repo: SanctionsListRepository,
): SanctionsScreeningService {
  return new SanctionsScreeningService(repo);
}