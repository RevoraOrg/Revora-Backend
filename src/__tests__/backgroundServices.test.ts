import { readFileSync } from 'fs';
import { join } from 'path';
import { getRoleConfig, VALID_ROLES } from '../config/workerRole';
import type { WorkerRole } from '../config/workerRole';
import {
  startBackgroundServices,
  stopBackgroundServices,
  type BackgroundServiceFactories,
} from '../services/backgroundServices';

type Name = keyof BackgroundServiceFactories;

function spyFactories() {
  const started: Name[] = [];
  const stopped: Name[] = [];
  const factory = (name: Name) =>
    jest.fn(() => ({
      start: jest.fn(() => started.push(name)),
      stop: jest.fn(() => {
        stopped.push(name);
      }),
    }));
  const factories: BackgroundServiceFactories = {
    auditPurge: factory('auditPurge'),
    sessionCompaction: factory('sessionCompaction'),
    payoutDrift: factory('payoutDrift'),
    reconciliation: factory('reconciliation'),
    distributionScheduler: factory('distributionScheduler'),
  };
  return { factories, started, stopped };
}

const quiet = () => {};

describe('startBackgroundServices', () => {
  it('starts no batch services for the api role', () => {
    const { factories, started } = spyFactories();
    const stopFns = startBackgroundServices(getRoleConfig('api'), factories, quiet);

    expect(started).toEqual([]);
    expect(stopFns).toEqual([]);
    for (const create of Object.values(factories)) expect(create).not.toHaveBeenCalled();
  });

  it.each(['batch', 'all'] as WorkerRole[])('starts each batch service exactly once for %s', (role) => {
    const { factories, started } = spyFactories();
    startBackgroundServices(getRoleConfig(role), factories, quiet);

    expect(started).toEqual([
      'auditPurge',
      'sessionCompaction',
      'payoutDrift',
      'reconciliation',
      'distributionScheduler',
    ]);
    expect(started.filter((name) => name === 'payoutDrift')).toHaveLength(1);
  });

  it.each([...VALID_ROLES])('returns a stop function for every service it started (%s)', async (role) => {
    const { factories, started, stopped } = spyFactories();
    const stopFns = startBackgroundServices(getRoleConfig(role), factories, quiet);

    expect(stopFns).toHaveLength(started.length);
    await stopBackgroundServices(stopFns);
    expect(stopped).toEqual(started);
  });

  it('gates session compaction on its own flag, not auditPurge', () => {
    const { factories, started } = spyFactories();
    startBackgroundServices({ ...getRoleConfig('batch'), sessionCompaction: false }, factories, quiet);

    expect(started).toContain('auditPurge');
    expect(started).not.toContain('sessionCompaction');
  });

  it('waits for asynchronous stops', async () => {
    const { factories } = spyFactories();
    let finished = false;
    factories.distributionScheduler = () => ({
      start: () => {},
      stop: () => new Promise<void>((resolve) => setTimeout(() => ((finished = true), resolve()), 10)),
    });
    const stopFns = startBackgroundServices(getRoleConfig('batch'), factories, quiet);

    await stopBackgroundServices(stopFns);
    expect(finished).toBe(true);
  });
});

describe('src/index.ts boot block (regression)', () => {
  // On master the boot block created and started a PayoutDriftDetector before
  // the role checks, then a second one under roleConfig.payoutDrift.
  const source = readFileSync(join(__dirname, '..', 'index.ts'), 'utf8');
  const boot = source.slice(source.indexOf('if (require.main === module'));

  it('creates the drift detector only through startBackgroundServices', () => {
    expect(boot.match(/createPayoutDriftDetector\(/g)).toHaveLength(1);
    expect(boot).not.toMatch(/PayoutDriftDetector[^\n]*\.start\(\)/);
    expect(boot).toMatch(/payoutDrift: \(\) =>\s*createPayoutDriftDetector\(/);
  });
});
