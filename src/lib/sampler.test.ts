import { EventLoopSampler, globalSampler } from './sampler';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as perf_hooks from 'perf_hooks';
import * as inspector from 'inspector';
import { globalMetrics } from './metrics';

jest.mock('perf_hooks');
jest.mock('inspector');
jest.mock('./metrics', () => ({
  globalMetrics: {
    incrementCounter: jest.fn(),
  },
}));

describe('EventLoopSampler', () => {
  let sampler: EventLoopSampler;
  const storageDir = path.join(process.cwd(), 'storage', 'profiles', 'test');

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();

    jest.spyOn(fs, 'mkdir').mockResolvedValue(undefined as any);
    jest.spyOn(fs, 'writeFile').mockResolvedValue(undefined);
    jest.spyOn(fs, 'readdir').mockResolvedValue([] as any);
    jest.spyOn(fs, 'stat').mockResolvedValue({ mtimeMs: Date.now() } as any);
    jest.spyOn(fs, 'unlink').mockResolvedValue(undefined);

    sampler = new EventLoopSampler({
      lagThresholdMs: 50,
      cooldownMs: 5000,
      storageDir,
      retentionDays: 7,
    });
  });

  afterEach(() => {
    sampler.stop();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('should start monitoring on start()', () => {
    const mockEnable = jest.fn();
    (perf_hooks.monitorEventLoopDelay as jest.Mock).mockReturnValue({
      enable: mockEnable,
      reset: jest.fn(),
      mean: 0,
    });

    sampler.start();
    expect(perf_hooks.monitorEventLoopDelay).toHaveBeenCalledWith({ resolution: 10 });
    expect(mockEnable).toHaveBeenCalled();
  });

  it('should trigger capture if lag exceeds threshold', async () => {
    const mockReset = jest.fn();
    (perf_hooks.monitorEventLoopDelay as jest.Mock).mockReturnValue({
      enable: jest.fn(),
      reset: mockReset,
      mean: 60 * 1e6, // 60ms in nanoseconds
    });

    // Mock inspector session
    const mockPost = jest.fn((method, callback) => {
      if (callback) callback(null, { profile: { nodes: [] } });
    });
    const mockConnect = jest.fn();
    const mockDisconnect = jest.fn();

    (inspector.Session as jest.Mock).mockImplementation(() => ({
      connect: mockConnect,
      disconnect: mockDisconnect,
      post: mockPost,
    }));

    sampler.start();

    // Fast-forward 10 seconds to trigger interval
    jest.advanceTimersByTime(10000);
    // Let async tasks process
    await Promise.resolve();

    // Fast-forward 5 seconds to finish profile capture
    jest.advanceTimersByTime(5000);
    await Promise.resolve();
    await Promise.resolve(); // Extra ticks for promises

    expect(inspector.Session).toHaveBeenCalled();
    expect(mockConnect).toHaveBeenCalled();
    expect(mockPost).toHaveBeenCalledWith('Profiler.enable', expect.any(Function));
    expect(mockPost).toHaveBeenCalledWith('Profiler.start', expect.any(Function));
    expect(mockPost).toHaveBeenCalledWith('Profiler.stop', expect.any(Function));

    expect(fs.mkdir).toHaveBeenCalledWith(storageDir, { recursive: true });
    expect(fs.writeFile).toHaveBeenCalledWith(expect.stringContaining('profile-'), expect.any(String));
    
    expect(globalMetrics.incrementCounter).toHaveBeenCalledWith('runtime.profile.captured', { reason: 'event_loop_lag' });
  });

  it('should not trigger capture if lag is below threshold', async () => {
    (perf_hooks.monitorEventLoopDelay as jest.Mock).mockReturnValue({
      enable: jest.fn(),
      reset: jest.fn(),
      mean: 40 * 1e6, // 40ms in nanoseconds
    });

    (inspector.Session as jest.Mock).mockClear();

    sampler.start();
    jest.advanceTimersByTime(10000);
    await Promise.resolve();

    expect(inspector.Session).not.toHaveBeenCalled();
  });

  it('should prevent multiple captures during cooldown', async () => {
    (perf_hooks.monitorEventLoopDelay as jest.Mock).mockReturnValue({
      enable: jest.fn(),
      reset: jest.fn(),
      mean: 60 * 1e6, // 60ms
    });

    const mockPost = jest.fn((method, callback) => {
      if (callback) callback(null, { profile: {} });
    });
    (inspector.Session as jest.Mock).mockImplementation(() => ({
      connect: jest.fn(),
      disconnect: jest.fn(),
      post: mockPost,
    }));

    sampler.start();

    jest.advanceTimersByTime(10000);
    await Promise.resolve();
    jest.advanceTimersByTime(5000);
    await Promise.resolve();
    await Promise.resolve();

    // Reset mock to check it doesn't get called again
    (inspector.Session as jest.Mock).mockClear();
    
    // Check lag again but we are still in cooldown
    // Cooldown is 5000ms. Since we last captured at 10000ms.
    // Advance 4000ms (now 19000). Another trigger.
    jest.advanceTimersByTime(4000);
    await Promise.resolve();
    
    expect(inspector.Session).not.toHaveBeenCalled();
  });

  it('should delete old profiles', async () => {
    const now = Date.now();
    jest.spyOn(fs, 'readdir').mockResolvedValue(['profile-old.cpuprofile', 'profile-new.cpuprofile', 'other.txt'] as any);
    
    jest.spyOn(fs, 'stat').mockImplementation(async (filepath) => {
      if ((filepath as string).includes('profile-old.cpuprofile')) {
        return { mtimeMs: now - (8 * 24 * 60 * 60 * 1000) } as any; // 8 days old
      }
      return { mtimeMs: now - (1 * 24 * 60 * 60 * 1000) } as any; // 1 day old
    });

    await (sampler as any).cleanupOldProfiles();

    expect(fs.unlink).toHaveBeenCalledWith(expect.stringContaining('profile-old.cpuprofile'));
    expect(fs.unlink).not.toHaveBeenCalledWith(expect.stringContaining('profile-new.cpuprofile'));
  });
});
