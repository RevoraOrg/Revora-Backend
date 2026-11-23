/**
 * Focused behavior coverage for `EmailDeliverabilityConfig` (#1091).
 *
 * Evidence: `src/services/emailDeliverabilityService.ts` exports
 * `EmailDeliverabilityConfig` and `EmailDeliverabilityService` without a
 * directly associated config-level test fixture. The broad service suite passes
 * fully-populated configs everywhere, so the config contract itself — defaults,
 * partial-override merging, boundary values, and the `enabled: false`
 * short-circuit — was unverified. This suite pins exactly those paths.
 */
import { EmailDeliverabilityService } from '../emailDeliverabilityService';
import { EmailDeliverabilityRepository } from '../../db/repositories/emailDeliverabilityRepository';
import type { DomainDeliverability } from '../../db/repositories/emailDeliverabilityRepository';
import { MetricsCollector } from '../../lib/metrics';

const DAY_MS = 24 * 60 * 60 * 1000;

function createMockRepo(): jest.Mocked<EmailDeliverabilityRepository> {
  const mock: Partial<jest.Mocked<EmailDeliverabilityRepository>> = {};
  mock.upsertDomain = jest.fn().mockResolvedValue({} as DomainDeliverability);
  mock.recordSend = jest.fn().mockResolvedValue(undefined);
  mock.recordBounce = jest.fn().mockResolvedValue(undefined);
  mock.recordComplaint = jest.fn().mockResolvedValue(undefined);
  mock.recordBlock = jest.fn().mockResolvedValue(undefined);
  mock.addSuppression = jest.fn().mockResolvedValue({ id: 'sup-1' } as any);
  mock.removeSuppression = jest.fn().mockResolvedValue(undefined);
  mock.isSuppressed = jest.fn().mockResolvedValue(false);
  mock.insertBounceEvent = jest.fn().mockResolvedValue({ id: 'bev-1' } as any);
  mock.findByDomain = jest.fn().mockResolvedValue(null);
  mock.listAlignmentFailures = jest.fn().mockResolvedValue([]);
  mock.listHighBounceRatioDomains = jest.fn().mockResolvedValue([]);
  mock.markAlarmRaised = jest.fn().mockResolvedValue(undefined);
  return mock as jest.Mocked<EmailDeliverabilityRepository>;
}

function suppressionExpiry(repo: jest.Mocked<EmailDeliverabilityRepository>): Date {
  const call = repo.addSuppression.mock.calls[0][0] as { expires_at?: Date };
  expect(call.expires_at).toBeInstanceOf(Date);
  return call.expires_at as Date;
}

const HARD_BOUNCE = {
  email: 'bounce@example.com',
  domain: 'example.com',
  provider: 'sendgrid',
  bounce_type: 'hard_bounce' as const,
  autoSuppress: true,
};

describe('EmailDeliverabilityConfig defaults', () => {
  let repo: jest.Mocked<EmailDeliverabilityRepository>;
  let metrics: MetricsCollector;

  beforeEach(() => {
    repo = createMockRepo();
    metrics = new MetricsCollector({ enabled: true });
    metrics.reset();
  });

  it('enables tracking by default when no config is supplied', () => {
    const service = new EmailDeliverabilityService(repo, metrics);
    expect(service.enabled).toBe(true);
  });

  it('applies the 365-day default suppression window', async () => {
    const service = new EmailDeliverabilityService(repo, metrics);

    const before = Date.now();
    await service.recordBounce(HARD_BOUNCE);
    const after = Date.now();

    const expiresAt = suppressionExpiry(repo).getTime();
    expect(expiresAt).toBeGreaterThanOrEqual(before + 365 * DAY_MS - 2_000);
    expect(expiresAt).toBeLessThanOrEqual(after + 365 * DAY_MS + 2_000);
  });

  it('forwards the default alarm cooldown and bounce-ratio threshold to the repository', async () => {
    const service = new EmailDeliverabilityService(repo, metrics);

    await service.checkAlignmentAlarms();
    expect(repo.listAlignmentFailures).toHaveBeenCalledWith(24);

    await service.checkHighBounceRatioAlarms();
    expect(repo.listHighBounceRatioDomains).toHaveBeenCalledWith(0.05);
  });
});

describe('EmailDeliverabilityConfig partial overrides', () => {
  let repo: jest.Mocked<EmailDeliverabilityRepository>;
  let metrics: MetricsCollector;

  beforeEach(() => {
    repo = createMockRepo();
    metrics = new MetricsCollector({ enabled: true });
    metrics.reset();
  });

  it('merges a single override with the remaining defaults', async () => {
    const service = new EmailDeliverabilityService(repo, metrics, {
      suppressionAutoExpireDays: 7,
    });

    expect(service.enabled).toBe(true);

    const before = Date.now();
    await service.recordBounce(HARD_BOUNCE);
    const after = Date.now();

    const expiresAt = suppressionExpiry(repo).getTime();
    expect(expiresAt).toBeGreaterThanOrEqual(before + 7 * DAY_MS - 2_000);
    expect(expiresAt).toBeLessThanOrEqual(after + 7 * DAY_MS + 2_000);

    // Untouched fields keep their defaults.
    await service.checkAlignmentAlarms();
    expect(repo.listAlignmentFailures).toHaveBeenCalledWith(24);
    await service.checkHighBounceRatioAlarms();
    expect(repo.listHighBounceRatioDomains).toHaveBeenCalledWith(0.05);
  });

  it('honours custom alarm cooldown and bounce-ratio threshold values', async () => {
    const service = new EmailDeliverabilityService(repo, metrics, {
      alarmCooldownHours: 48,
      bounceRatioAlarmThreshold: 0.2,
    });

    await service.checkAlignmentAlarms();
    expect(repo.listAlignmentFailures).toHaveBeenCalledWith(48);

    await service.checkHighBounceRatioAlarms();
    expect(repo.listHighBounceRatioDomains).toHaveBeenCalledWith(0.2);
  });

  it('never suppresses transient soft bounces, whatever the expiry window', async () => {
    const service = new EmailDeliverabilityService(repo, metrics, {
      suppressionAutoExpireDays: 1,
    });

    await service.recordBounce({ ...HARD_BOUNCE, bounce_type: 'soft_bounce' });

    expect(repo.recordBounce).toHaveBeenCalledWith('example.com');
    expect(repo.addSuppression).not.toHaveBeenCalled();
  });
});

describe('EmailDeliverabilityConfig boundary values', () => {
  let repo: jest.Mocked<EmailDeliverabilityRepository>;
  let metrics: MetricsCollector;

  beforeEach(() => {
    repo = createMockRepo();
    metrics = new MetricsCollector({ enabled: true });
    metrics.reset();
  });

  it('suppressionAutoExpireDays: 0 yields an immediately-expired suppression (no clamping)', async () => {
    const service = new EmailDeliverabilityService(repo, metrics, {
      suppressionAutoExpireDays: 0,
    });

    const before = Date.now();
    await service.recordBounce(HARD_BOUNCE);
    const after = Date.now();

    const expiresAt = suppressionExpiry(repo).getTime();
    expect(expiresAt).toBeGreaterThanOrEqual(before - 2_000);
    expect(expiresAt).toBeLessThanOrEqual(after + 2_000);
  });

  it('passes a zero bounce-ratio threshold through unchanged', async () => {
    const service = new EmailDeliverabilityService(repo, metrics, {
      bounceRatioAlarmThreshold: 0,
    });

    await service.checkHighBounceRatioAlarms();

    expect(repo.listHighBounceRatioDomains).toHaveBeenCalledWith(0);
  });

  it('passes a zero alarm cooldown through unchanged', async () => {
    const service = new EmailDeliverabilityService(repo, metrics, {
      alarmCooldownHours: 0,
    });

    await service.checkAlignmentAlarms();

    expect(repo.listAlignmentFailures).toHaveBeenCalledWith(0);
  });
});

describe('EmailDeliverabilityConfig enabled=false short-circuit', () => {
  let repo: jest.Mocked<EmailDeliverabilityRepository>;
  let metrics: MetricsCollector;
  let service: EmailDeliverabilityService;

  beforeEach(() => {
    repo = createMockRepo();
    metrics = new MetricsCollector({ enabled: true });
    metrics.reset();
    service = new EmailDeliverabilityService(repo, metrics, { enabled: false });
  });

  it('performs no repository writes across every state transition', async () => {
    expect(service.enabled).toBe(false);

    await service.recordSend('user@example.com', 'example.com', 'sendgrid');
    await service.recordBounce(HARD_BOUNCE);
    await service.recordAlignmentResult('example.com', 'sendgrid', { aligned: false });
    await service.addSuppression('user@example.com', 'manual');
    await service.removeSuppression('user@example.com');

    expect(repo.upsertDomain).not.toHaveBeenCalled();
    expect(repo.recordSend).not.toHaveBeenCalled();
    expect(repo.insertBounceEvent).not.toHaveBeenCalled();
    expect(repo.recordBounce).not.toHaveBeenCalled();
    expect(repo.recordComplaint).not.toHaveBeenCalled();
    expect(repo.recordBlock).not.toHaveBeenCalled();
    expect(repo.addSuppression).not.toHaveBeenCalled();
    expect(repo.removeSuppression).not.toHaveBeenCalled();
  });

  it('reports inert suppression state and skips alarm scans', async () => {
    await expect(service.isSuppressed('user@example.com')).resolves.toBe(false);

    await expect(service.checkAlignmentAlarms()).resolves.toEqual([]);
    await expect(service.checkHighBounceRatioAlarms()).resolves.toEqual([]);

    expect(repo.isSuppressed).not.toHaveBeenCalled();
    expect(repo.listAlignmentFailures).not.toHaveBeenCalled();
    expect(repo.listHighBounceRatioDomains).not.toHaveBeenCalled();
  });

  it('emits no metrics while disabled', async () => {
    const counterSpy = jest.spyOn(metrics, 'incrementCounter');
    const gaugeSpy = jest.spyOn(metrics, 'setGauge');

    await service.recordSend('user@example.com', 'example.com', 'sendgrid');
    await service.recordBounce(HARD_BOUNCE);
    await service.recordAlignmentResult('example.com', 'sendgrid', { aligned: false });
    await service.checkAlignmentAlarms();
    await service.checkHighBounceRatioAlarms();

    expect(counterSpy).not.toHaveBeenCalled();
    expect(gaugeSpy).not.toHaveBeenCalled();
  });
});
