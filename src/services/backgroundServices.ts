/**
 * Starts the role-gated background services for a worker process.
 *
 * Each service is created and started at most once, only when its role flag
 * is on, and every started service contributes a stop function. Keeping this
 * out of `src/index.ts`'s boot block makes the role matrix unit-testable:
 * previously an extra PayoutDriftDetector was started unconditionally there,
 * so `api` replicas ran drift detection and `batch`/`all` ran it twice.
 */
import type { RoleConfig } from '../config/workerRole';

/** Anything with a start/stop lifecycle; `stop` may finish asynchronously. */
export interface BackgroundService {
  start(): void;
  stop(): void | Promise<void>;
}

/** One factory per role-gated service. Factories only build; this module starts. */
export interface BackgroundServiceFactories {
  auditPurge: () => BackgroundService;
  sessionCompaction: () => BackgroundService;
  payoutDrift: () => BackgroundService;
  reconciliation: () => BackgroundService;
  distributionScheduler: () => BackgroundService;
}

export type StopFn = () => void | Promise<void>;

type ServiceName = keyof BackgroundServiceFactories;

/** Start order; mirrors the order the boot block used before extraction. */
const SERVICES: ServiceName[] = [
  'auditPurge',
  'sessionCompaction',
  'payoutDrift',
  'reconciliation',
  'distributionScheduler',
];

/**
 * Starts every service whose role flag is enabled and returns their stop
 * functions, in start order.
 */
export function startBackgroundServices(
  roleConfig: RoleConfig,
  factories: BackgroundServiceFactories,
  log: (message: string) => void = console.log,
): StopFn[] {
  const stopFns: StopFn[] = [];
  for (const name of SERVICES) {
    if (!roleConfig[name]) continue;
    const service = factories[name]();
    service.start();
    stopFns.push(() => service.stop());
    log(`[server] ${name} started`);
  }
  return stopFns;
}

/** Runs every stop function, waiting for the asynchronous ones. */
export async function stopBackgroundServices(stopFns: StopFn[]): Promise<void> {
  await Promise.all(stopFns.map((stop) => stop()));
}
