import { SanctionsListRepository, SanctionsEntry, SanctionsSnapshot } from '../db/repositories/sanctionsListRepository';
import { normalizeName as normalizeWithTransliteration, jaroWinkler } from '../lib/jaroWinkler';

/** Supported sanctions list sources. */
export const SUPPORTED_LIST_SOURCES = ['ofac', 'eu_consolidated', 'uk_hmt'] as const;

export type ListSource = (typeof SUPPORTED_LIST_SOURCES)[number];

export type MatchType = 'exact' | 'alias' | 'partial' | 'fuzzy';

export interface SanctionsMatch {
  source: string;
  version: string;
  listName: string;
  alias?: string;
  matchType: MatchType;
  matchedName: string;
  uid?: string;
  /** Jaro-Winkler similarity score for fuzzy matches. */
  score?: number;
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

export interface SanctionsScreenOptions {
  /** Jaro-Winkler threshold for the fuzzy match type (default 0.92). */
  fuzzyThreshold?: number;
}

const DEFAULT_FUZZY_THRESHOLD = 0.92;

/**
 * Normalize a name for comparison by transliterating Cyrillic to Latin,
 * Unicode NFD canonical decomposition, case folding, stripping of combining
 * diacritical marks, stipping of punctuation (hyphens, apostrophes, commas,
 * etc.), and whitespace collapsing. This defeats homoglyph/lookalike
 * bypasses (e.g. fullwidth, accented, or composed variants) and
 * transliteration bypasses so `Иван`/`IVAN` and `Iván`/`Ivan` compare identically.
 *
 * This delegates to the shared transliterating normalizer in `src/lib/jaroWinkler`,
 * so the sanctions gate and the AML rule path agree on normalization.
 */
export function normalizeName(input: string): string {
  return normalizeWithTransliteration(input);
}

/**
 * Sort the tokens of a normalized name so that token order is irrelevant
 * (e.g. `doe john` == `john doe`).
 */
export function sortTokens(normalized: string): string {
  if (!normalized) return '';
  return normalized.split(' ').filter((t) => t.length > 0).sort().join(' ');
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
 * Matching semantics (all names are transliterated, punctuation-stripped,
 * case-folded, and token-sorted before comparison):
 * - `exact` – normalized identity equals normalized primary name.
 * - `alias` – normalized identity equals a normalized alias.
 * - `partial` – either normalized string contains the other AND the shorter
 *   side is at least 3 characters; partial matches are flagged for review and
 *   treated as a hit (not auto-passed).
 * - `fuzzy` – Jaro-Winkler similarity at or above the configured
 *   threshold (default 0.92); fuzzy matches are flagged for review and
 *   treated as a hit (blocked, same as `partial`).
 */
export class SanctionsScreeningService {
  private readonly fuzzyThreshold: number;

  constructor(
    private readonly repo: SanctionsListRepository,
    options?: SanctionsScreenOptions,
  ) {
    const threshold = options?.fuzzyThreshold ?? DEFAULT_FUZZY_THRESHOLD;
    this.fuzzyThreshold = Math.min(1, Math.max(0, threshold));
  }

  async screen(identityNames: string[], now?: Date): Promise<SanctionsScreenResult> {
    const sources = [...(SUPPORTED_LIST_SOURCES as readonly string[])];
    const snapshots = await this.repo.findLatestAcrossSources(sources);

    const versionMap = Object.fromEntries(
      snapshots.map((s) => [s.list_source, s.version]),
    );
    const complete = sources.every((src) => versionMap[src] !== undefined);

    const normalized = identityNames
      .map(normalizeName)
      .map(sortTokens)
      .filter((n) => n.length > 0);

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
      const primary = sortTokens(normalizeName(entry.name));
      const aliasDisplay: Array<{ norm: string; display: string }> = (
        (entry.aliases ?? []).map((a) => ({ norm: sortTokens(normalizeName(a)), display: a }))
      ).filter((a) => a.norm.length > 0);
      const aliases = aliasDisplay.map((a) => a.norm);

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
          continue;
        }
        const fuzzy = this.fuzzyMatch(identity, primary, aliasDisplay);
        if (fuzzy) {
          result.push(this.buildMatch(snapshot, entry, 'fuzzy', fuzzy.matchedName, fuzzy.score));
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

  private fuzzyMatch(
    identity: string,
    primary: string,
    aliases: Array<{ norm: string; display: string }>,
  ): { matchedName: string; score: number } | null {
    let best: { matchedName: string; score: number } | null = null;
    const consider = (candidate: string, display: string) => {
      if (!candidate || candidate.length < 3) {
        // Still allow fuzzy matching on shorter candidates only via exact/partial.
        return;
      }
      // Already normalized/token-sorted; disable re-normalization inside jaroWinkler.
      const score = jaroWinkler(identity, candidate, { transliterate: false });
      if (score >= this.fuzzyThreshold && (!best || score > best.score)) {
        best = { matchedName: display, score };
      }
    };
    if (primary.length > 0) consider(primary, '');
    for (const alias of aliases) consider(alias.norm, alias.display);
    return best;
  }

  private buildMatch(
    snapshot: SanctionsSnapshot,
    entry: SanctionsEntry,
    matchType: MatchType,
    matchedName: string,
    score?: number,
  ): SanctionsMatch {
    return {
      source: snapshot.list_source,
      version: snapshot.version,
      listName: entry.name,
      matchType,
      matchedName: matchType === 'fuzzy' ? entry.name : matchedName,
      uid: entry.uid,
      alias: matchType === 'alias' ? matchedName : undefined,
      score,
    };
  }
}

/** Factory for service-level wiring. */
export function createSanctionsScreeningService(
  repo: SanctionsListRepository,
  options?: SanctionsScreenOptions,
): SanctionsScreeningService {
  return new SanctionsScreeningService(repo, options);
}
