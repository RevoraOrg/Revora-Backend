import { RefreshSanctionsListsJob, startSanctionsRefreshJob, SANCTIONS_REFRESH_OK, SANCTIONS_REFRESH_FAILED } from './refreshSanctionsListsJob';
import { OfacSanctionsLoader } from '../services/ofacSanctionsLoader';
import { SanctionsListRepository, SanctionsSnapshot } from '../db/repositories/sanctionsListRepository';

function makeLoader(overrides: Partial<OfacSanctionsLoader> = {}): OfacSanctionsLoader {
  return {
    loadSanctions: jest.fn(),
    ...overrides,
  } as unknown as OfacSanctionsLoader;
}

function makeRepo(overrides: Partial<SanctionsListRepository> = {}): SanctionsListRepository {
  const snapshots: Record<string, SanctionsSnapshot> = {};
  return {
    saveSnapshot: jest.fn().mockImplementation(async (input) => {
      const snap: SanctionsSnapshot = {
        id: 'snap',
        list_source: input.list_source,
        version: input.version,
        entry_count: input.entries.length,
        normalized_checksum: 'sum',
        entries: input.entries,
        created_at: new Date(),
      };
      snapshots[`${input.list_source}:${input.version}`] = snap;
      return snap;
    }),
    calculateChecksum: () => 'sum',
    ...overrides,
  } as unknown as SanctionsListRepository;
}

function makeMetrics() {
  return {
    incrementCounter: jest.fn(),
    setGauge: jest.fn(),
  };
}

describe('RefreshSanctionsListsJob', () => {
  it('persists a valid signed+hashed list as a snapshot', async () => {
    const loader = makeLoader({
      loadSanctions: jest.fn().mockResolvedValue({
        version: '2026-01-01',
        entries: [{ uid: '1', name: 'Alice', programs: ['SDGT'] }],
        parseHash: 'h',
        fetchedAt: new Date(),
        signatureValid: true,
        hashValid: true,
      }),
    });
    const repo = makeRepo();
    const job = new RefreshSanctionsListsJob({ loader, repo, version: '2026-01-01' });
    const result = await job.runOnce();
    expect(result.ok).toBe(true);
    expect(result.entryCount).toBe(1);
    expect(repo.saveSnapshot).toHaveBeenCalledTimes(1);
  });

  it('fails closed and records a failed metric when hash verification fails', async () => {
    const loader = makeLoader({
      loadSanctions: jest.fn().mockResolvedValue({
        version: '2026-01-01',
        entries: [{ uid: '1', name: 'Alice' }],
        parseHash: 'h',
        fetchedAt: new Date(),
        signatureValid: true,
        hashValid: false,
      }),
    });
    const repo = makeRepo();
    const metrics = makeMetrics();
    const job = new RefreshSanctionsListsJob({ loader, repo, version: '2026-01-01', metrics: metrics as never });
    const result = await job.runOnce();
    expect(result.ok).toBe(false);
    expect(metrics.incrementCounter).toHaveBeenCalled();
    expect(repo.saveSnapshot).not.toHaveBeenCalled(); // never promotes untrusted list
  });

  it('returns ok=false when the loader throws (e.g. network/signature)', async () => {
    const loader = makeLoader({
      loadSanctions: jest.fn().mockRejectedValue(new Error('Signature verification failed')),
    });
    const job = new RefreshSanctionsListsJob({ loader, repo: makeRepo(), version: 'v' });
    const result = await job.runOnce();
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/Signature/);
  });

  it('exposes success metric constants used by tests', () => {
    expect(SANCTIONS_REFRESH_OK).toBe('sanctions.refresh.ok');
    expect(SANCTIONS_REFRESH_FAILED).toBe('sanctions.refresh.failed');
  });
});

describe('startSanctionsRefreshJob', () => {
  function makeOkLoader(): OfacSanctionsLoader {
    return makeLoader({
      loadSanctions: jest.fn().mockResolvedValue({
        version: '2026-01-01',
        entries: [{ uid: '1', name: 'Alice' }],
        parseHash: 'h',
        fetchedAt: new Date(),
        signatureValid: true,
        hashValid: true,
      }),
    });
  }

  it('logs on success and returns a stop function that clears the interval', async () => {
    jest.useFakeTimers();
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const stop = startSanctionsRefreshJob({
      loader: makeOkLoader(),
      repo: makeRepo(),
      version: '2026-01-01',
    }, 1_000_000);

    await jest.advanceTimersByTimeAsync(0);
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('[sanctions-refresh] ofac 2026-01-01: 1 entries'),
    );

    // Advance past the interval to also cover the recurring timer callback.
    await jest.advanceTimersByTimeAsync(1_000_000);
    expect(logSpy.mock.calls.length).toBeGreaterThanOrEqual(2);

    stop();
    logSpy.mockRestore();
    errSpy.mockRestore();
    jest.useRealTimers();
  });

  it('logs an error when the immediate run fails and still stops cleanly', async () => {
    jest.useFakeTimers();
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const failLoader = makeLoader({
      loadSanctions: jest.fn().mockRejectedValue(new Error('boom')),
    });
    const stop = startSanctionsRefreshJob({
      loader: failLoader,
      repo: makeRepo(),
      version: '2026-01-01',
    });

    await jest.advanceTimersByTimeAsync(0);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('[sanctions-refresh] FAILED ofac'));

    stop();
    logSpy.mockRestore();
    errSpy.mockRestore();
    jest.useRealTimers();
  });
});