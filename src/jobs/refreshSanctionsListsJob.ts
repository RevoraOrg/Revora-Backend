import { OfacSanctionsLoader, OfacLoaderConfig } from '../services/ofacSanctionsLoader';
import { SanctionsListRepository, SanctionsEntry } from '../db/repositories/sanctionsListRepository';
import { globalMetrics } from '../lib/metrics';

export const SANCTIONS_REFRESH_OK = 'sanctions.refresh.ok';
export const SANCTIONS_REFRESH_SKIPPED = 'sanctions.refresh.skipped';
export const SANCTIONS_REFRESH_FAILED = 'sanctions.refresh.failed';
export const SANCTIONS_CHECKSUM_MISMATCH = 'sanctions.refresh.checksum_mismatch';

/** Default nightly run: 02:00 UTC. */
export const DAILY_CRON = '0 2 * * *';
/** Interval in ms when a scheduling library is not available (24h). */
export const DAILY_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface RefreshJobDeps {
  loader: OfacSanctionsLoader;
  repo: SanctionsListRepository;
  /** OFAC list version string (e.g. publication date) used as snapshot version. */
  version: string;
  metrics?: typeof globalMetrics;
  now?: () => Date;
}

export interface RefreshResult {
  ok: boolean;
  source: string;
  version: string;
  entryCount: number;
  checksum: string;
  reason?: string;
}

/**
 * Daily sanctions list refresh.
 *
 * Security assumptions:
 * - The OFAC loader verifies the upstream Ed25519 signature and pinned parse
 *   hash before we trust any entry.
 * - We additionally recompute the canonical checksum of the entries and store
 *   it with the snapshot; `SanctionsListRepository.verifyChecksum` lets an
 *   auditor confirm the on-disk entries match what was loaded.
 * - If loading/verification fails the job records a `failed` metric and throws;
 *   it never promotes a partial or untrusted list.
 */
export class RefreshSanctionsListsJob {
  constructor(private readonly deps: RefreshJobDeps) {}

  async runOnce(): Promise<RefreshResult> {
    const { loader, repo, version, metrics = globalMetrics } = this.deps;
    try {
      const loaded = await loader.loadSanctions(version);

      // Convert loader entries (OfacEntry) to normalized screening entries.
      const entries: SanctionsEntry[] = loaded.entries.map((e) => ({
        uid: e.uid,
        name: e.name,
        programs: e.programs,
      }));

      if (!loaded.hashValid) {
        metrics.incrementCounter(
          SANCTIONS_CHECKSUM_MISMATCH,
          { version },
          1,
          'Pinned parse hash mismatch; refusing to persist suspicious list',
        );
        throw new Error(
          `Refusing to persist OFAC list ${version}: pinned parse hash verification failed (fail-closed).`,
        );
      }

      const snapshot = await repo.saveSnapshot({
        list_source: 'ofac',
        version,
        entries,
      });

      metrics.incrementCounter(
        SANCTIONS_REFRESH_OK,
        { version },
        1,
        'Daily sanctions list refresh succeeded',
      );

      return {
        ok: true,
        source: 'ofac',
        version,
        entryCount: snapshot.entry_count,
        checksum: snapshot.normalized_checksum,
      };
    } catch (err) {
      globalMetrics.incrementCounter(
        SANCTIONS_REFRESH_FAILED,
        { version, error: String((err as Error)?.message ?? err) },
        1,
        'Daily sanctions list refresh failed',
      );
      return {
        ok: false,
        source: 'ofac',
        version,
        entryCount: 0,
        checksum: '',
        reason: (err as Error)?.message ?? String(err),
      };
    }
  }
}

/**
 * Starts a `setInterval` that runs the job every `intervalMs` ms (default 24h).
 * Returns a stop function.
 *
 * Note: `runOnce` already catches loader failures internally, so a thrown
 * schedule callback does not crash the process. The prior result is retained
 * (previous snapshot stays current) when a refresh fails.
 */
export function startSanctionsRefreshJob(
  deps: Omit<RefreshJobDeps, 'now'>,
  intervalMs = DAILY_INTERVAL_MS,
): () => void {
  const job = new RefreshSanctionsListsJob({ ...deps, now: () => new Date() });

  const runAndLog = async (): Promise<void> => {
    const result = await job.runOnce();
    if (result.ok) {
      console.log(
        `[sanctions-refresh] ${result.source} ${result.version}: ${result.entryCount} entries, checksum=${result.checksum}`,
      );
    } else {
      console.error(`[sanctions-refresh] FAILED ${result.source} ${result.version}: ${result.reason}`);
    }
  };

  // Fire immediately then on the interval.
  void runAndLog();
  const timer = setInterval(() => {
    void runAndLog();
  }, intervalMs);
  timer.unref?.();

  return () => clearInterval(timer);
}