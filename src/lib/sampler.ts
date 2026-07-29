import { monitorEventLoopDelay, EventLoopMonitor } from 'perf_hooks';
import * as inspector from 'inspector';
import * as fs from 'fs/promises';
import * as path from 'path';
import { globalMetrics } from './metrics';

export interface SamplerConfig {
  /** Event loop lag threshold in milliseconds that triggers a capture. Default: 50ms */
  lagThresholdMs?: number;
  /** Cooldown between captures in milliseconds. Default: 5 minutes */
  cooldownMs?: number;
  /** Directory to store CPU profiles. Default: ./storage/profiles */
  storageDir?: string;
  /** How many days to keep the profiles. Default: 7 */
  retentionDays?: number;
}

/**
 * EventLoopSampler monitors the event loop and automatically captures a CPU profile
 * when lag exceeds the configured threshold. It guards against runaway captures using
 * a cooldown period and cleans up old profiles based on a retention policy.
 */
export class EventLoopSampler {
  private config: Required<SamplerConfig>;
  private monitor: EventLoopMonitor | null = null;
  private checkInterval: NodeJS.Timeout | null = null;
  private lastCaptureTime: number = 0;
  private isCapturing: boolean = false;
  private session: inspector.Session | null = null;

  constructor(config: SamplerConfig = {}) {
    this.config = {
      lagThresholdMs: config.lagThresholdMs ?? 50,
      cooldownMs: config.cooldownMs ?? 5 * 60 * 1000,
      storageDir: config.storageDir ?? path.join(process.cwd(), 'storage', 'profiles'),
      retentionDays: config.retentionDays ?? 7,
    };
  }

  /**
   * Starts monitoring the event loop.
   */
  public start(): void {
    if (this.monitor) {
      return; // Already started
    }

    this.monitor = monitorEventLoopDelay({ resolution: 10 });
    this.monitor.enable();

    // Check lag every 10 seconds
    this.checkInterval = setInterval(() => this.checkLag(), 10000);
    this.checkInterval.unref(); // Don't block process exit
    
    // Also run retention cleanup on start
    this.cleanupOldProfiles().catch(console.error);
  }

  /**
   * Stops monitoring the event loop.
   */
  public stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }

    if (this.monitor) {
      this.monitor.disable();
      this.monitor = null;
    }
  }

  private async checkLag(): Promise<void> {
    if (!this.monitor) return;
    
    // Convert nanoseconds to milliseconds
    const meanLagMs = this.monitor.mean / 1e6;
    
    // Reset monitor stats for the next interval
    this.monitor.reset();

    if (meanLagMs > this.config.lagThresholdMs) {
      await this.triggerCapture(meanLagMs);
    }
  }

  private async triggerCapture(lagMs: number): Promise<void> {
    const now = Date.now();
    if (this.isCapturing || (now - this.lastCaptureTime < this.config.cooldownMs)) {
      return; // Cooldown or currently capturing
    }

    this.isCapturing = true;
    try {
      this.lastCaptureTime = now;
      await this.captureProfile(now, lagMs);
    } finally {
      this.isCapturing = false;
    }
  }

  private async captureProfile(timestamp: number, lagMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.session = new inspector.Session();
      this.session.connect();

      this.session.post('Profiler.enable', () => {
        this.session!.post('Profiler.start', () => {
          // Capture for 5 seconds
          setTimeout(() => {
            this.session!.post('Profiler.stop', async (err, result) => {
              if (err) {
                this.cleanupSession();
                return reject(err);
              }

              try {
                await this.saveProfile(result.profile, timestamp, lagMs);
                globalMetrics.incrementCounter('runtime.profile.captured', { reason: 'event_loop_lag' });
                this.cleanupSession();
                resolve();
              } catch (saveErr) {
                this.cleanupSession();
                reject(saveErr);
              }
            });
          }, 5000);
        });
      });
    });
  }

  private cleanupSession(): void {
    if (this.session) {
      try {
        this.session.post('Profiler.disable', () => {});
        this.session.disconnect();
      } catch (e) {
        // Ignore disconnect errors
      }
      this.session = null;
    }
  }

  private async saveProfile(profile: inspector.Profiler.Profile, timestamp: number, lagMs: number): Promise<void> {
    await fs.mkdir(this.config.storageDir, { recursive: true });
    
    const isoString = new Date(timestamp).toISOString().replace(/[:.]/g, '-');
    const filename = `profile-${isoString}-lag-${Math.round(lagMs)}ms.cpuprofile`;
    const filepath = path.join(this.config.storageDir, filename);

    await fs.writeFile(filepath, JSON.stringify(profile));
    
    // Asynchronously run cleanup after a successful save
    this.cleanupOldProfiles().catch(console.error);
  }

  private async cleanupOldProfiles(): Promise<void> {
    try {
      const files = await fs.readdir(this.config.storageDir);
      const now = Date.now();
      const retentionMs = this.config.retentionDays * 24 * 60 * 60 * 1000;

      for (const file of files) {
        if (!file.endsWith('.cpuprofile')) continue;

        const filepath = path.join(this.config.storageDir, file);
        const stats = await fs.stat(filepath);

        if (now - stats.mtimeMs > retentionMs) {
          await fs.unlink(filepath);
        }
      }
    } catch (err: any) {
      // Ignore if directory doesn't exist yet
      if (err.code !== 'ENOENT') {
        throw err;
      }
    }
  }
}

export const globalSampler = new EventLoopSampler();
