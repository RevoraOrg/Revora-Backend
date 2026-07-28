import { EmailDeliverabilityService } from '../emailDeliverabilityService';
import { EmailDeliverabilityRepository } from '../../db/repositories/emailDeliverabilityRepository';
import { MetricsCollector } from '../../lib/metrics';
import type { DomainDeliverability, BounceEvent } from '../../db/repositories/emailDeliverabilityRepository';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

function createMockRepo(): jest.Mocked<EmailDeliverabilityRepository> {
  const mock: Partial<jest.Mocked<EmailDeliverabilityRepository>> = {};

  mock.upsertDomain = jest.fn().mockResolvedValue({
    id: 'dom-1',
    domain: 'example.com',
    provider: 'sendgrid',
    dkim_status: null,
    spf_status: null,
    dmarc_status: null,
    dmarc_policy: null,
    aligned: false,
    sent_count: 0,
    bounce_count: 0,
    complaint_count: 0,
    block_count: 0,
    bounce_ratio: 0,
    last_sent_at: null,
    last_bounce_at: null,
    last_alarm_at: null,
    created_at: new Date(),
    updated_at: new Date(),
  } as DomainDeliverability);

  mock.recordSend = jest.fn().mockResolvedValue(undefined);
  mock.recordBounce = jest.fn().mockResolvedValue(undefined);
  mock.recordComplaint = jest.fn().mockResolvedValue(undefined);
  mock.recordBlock = jest.fn().mockResolvedValue(undefined);
  mock.addSuppression = jest.fn().mockResolvedValue({
    id: 'sup-1',
    email: 'bounce@example.com',
    reason: 'hard_bounce',
    bounce_event_id: null,
    created_at: new Date(),
    expires_at: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
  });
  mock.removeSuppression = jest.fn().mockResolvedValue(undefined);
  mock.isSuppressed = jest.fn().mockResolvedValue(false);
  mock.insertBounceEvent = jest.fn().mockResolvedValue({
    id: 'bev-1',
    email: 'bounce@example.com',
    domain: 'example.com',
    provider: 'sendgrid',
    bounce_type: 'hard_bounce',
    status_code: null,
    provider_event_id: null,
    raw_payload: null,
    ingested_at: new Date(),
  } as BounceEvent);
  mock.findByDomain = jest.fn().mockResolvedValue({
    id: 'dom-1',
    domain: 'example.com',
    provider: 'sendgrid',
    dkim_status: 'pass',
    spf_status: 'pass',
    dmarc_status: 'pass',
    dmarc_policy: 'reject',
    aligned: true,
    sent_count: 100,
    bounce_count: 5,
    complaint_count: 1,
    block_count: 0,
    bounce_ratio: 0.05,
    last_sent_at: new Date(),
    last_bounce_at: new Date(),
    last_alarm_at: null,
    created_at: new Date(),
    updated_at: new Date(),
  } as DomainDeliverability);
  mock.listAlignmentFailures = jest.fn().mockResolvedValue([]);
  mock.listHighBounceRatioDomains = jest.fn().mockResolvedValue([]);
  mock.markAlarmRaised = jest.fn().mockResolvedValue(undefined);

  return mock as jest.Mocked<EmailDeliverabilityRepository>;
}

describe('EmailDeliverabilityService', () => {
  let repo: jest.Mocked<EmailDeliverabilityRepository>;
  let metrics: MetricsCollector;
  let service: EmailDeliverabilityService;

  beforeEach(() => {
    repo = createMockRepo();
    metrics = new MetricsCollector({ enabled: true });
    metrics.reset();
    service = new EmailDeliverabilityService(repo, metrics, {
      enabled: true,
      suppressionAutoExpireDays: 365,
      bounceRatioAlarmThreshold: 0.05,
      alarmCooldownHours: 24,
    });
  });

  // -----------------------------------------------------------------------
  // Constructor / enabled
  // -----------------------------------------------------------------------
  describe('constructor and enabled', () => {
    it('should be enabled by default', () => {
      const s = new EmailDeliverabilityService(repo, metrics, { enabled: true });
      expect(s.enabled).toBe(true);
    });

    it('should be disabled when explicitly set', () => {
      const s = new EmailDeliverabilityService(repo, metrics, { enabled: false });
      expect(s.enabled).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // recordSend
  // -----------------------------------------------------------------------
  describe('recordSend', () => {
    it('should upsert domain and increment send counter', async () => {
      await service.recordSend('user@example.com', 'example.com', 'sendgrid');

      expect(repo.upsertDomain).toHaveBeenCalledWith('example.com', 'sendgrid');
      expect(repo.recordSend).toHaveBeenCalledWith('example.com');
    });

    it('should not call repo when disabled', async () => {
      const s = new EmailDeliverabilityService(repo, metrics, { enabled: false });
      await s.recordSend('user@example.com', 'example.com', 'sendgrid');

      expect(repo.upsertDomain).not.toHaveBeenCalled();
      expect(repo.recordSend).not.toHaveBeenCalled();
    });

    it('should emit a counter metric', async () => {
      const spy = jest.spyOn(metrics, 'incrementCounter');
      await service.recordSend('user@example.com', 'example.com', 'sendgrid');

      expect(spy).toHaveBeenCalledWith(
        'email_sent_total',
        { domain: 'example.com', provider: 'sendgrid' },
        1,
        expect.any(String),
      );
    });
  });

  // -----------------------------------------------------------------------
  // recordBounce
  // -----------------------------------------------------------------------
  describe('recordBounce', () => {
    it('should insert bounce event and update domain counters for hard bounce', async () => {
      await service.recordBounce({
        email: 'bounce@example.com',
        domain: 'example.com',
        provider: 'sendgrid',
        bounce_type: 'hard_bounce',
        autoSuppress: true,
      });

      expect(repo.insertBounceEvent).toHaveBeenCalled();
      expect(repo.recordBounce).toHaveBeenCalledWith('example.com');
      expect(repo.addSuppression).toHaveBeenCalled();
    });

    it('should auto-suppress spam complaints', async () => {
      await service.recordBounce({
        email: 'spam@example.com',
        domain: 'example.com',
        provider: 'sendgrid',
        bounce_type: 'spam_complaint',
        autoSuppress: true,
      });

      expect(repo.addSuppression).toHaveBeenCalled();
      expect(repo.recordComplaint).toHaveBeenCalledWith('example.com');
    });

    it('should record blocks separately', async () => {
      await service.recordBounce({
        email: 'blocked@example.com',
        domain: 'example.com',
        provider: 'smtp',
        bounce_type: 'block',
        autoSuppress: true,
      });

      expect(repo.recordBlock).toHaveBeenCalledWith('example.com');
    });

    it('should not auto-suppress soft bounces', async () => {
      await service.recordBounce({
        email: 'soft@example.com',
        domain: 'example.com',
        provider: 'sendgrid',
        bounce_type: 'soft_bounce',
        autoSuppress: false,
      });

      expect(repo.addSuppression).not.toHaveBeenCalled();
    });

    it('should not insert bounce when disabled', async () => {
      const s = new EmailDeliverabilityService(repo, metrics, { enabled: false });
      await s.recordBounce({
        email: 'bounce@example.com',
        domain: 'example.com',
        provider: 'sendgrid',
        bounce_type: 'hard_bounce',
      });

      expect(repo.insertBounceEvent).not.toHaveBeenCalled();
    });

    it('should emit bounce counter and ratio metrics', async () => {
      const incSpy = jest.spyOn(metrics, 'incrementCounter');
      const setSpy = jest.spyOn(metrics, 'setGauge');

      await service.recordBounce({
        email: 'bounce@example.com',
        domain: 'example.com',
        provider: 'sendgrid',
        bounce_type: 'hard_bounce',
      });

      expect(incSpy).toHaveBeenCalledWith(
        'email_bounce_total',
        { domain: 'example.com', provider: 'sendgrid', bounce_type: 'hard_bounce' },
        1,
        expect.any(String),
      );
      expect(setSpy).toHaveBeenCalledWith(
        'email_bounce_ratio',
        expect.any(Number),
        { domain: 'example.com' },
        expect.any(String),
      );
    });
  });

  // -----------------------------------------------------------------------
  // recordAlignmentResult
  // -----------------------------------------------------------------------
  describe('recordAlignmentResult', () => {
    it('should upsert domain with alignment data when aligned', async () => {
      await service.recordAlignmentResult('example.com', 'sendgrid', {
        dkim_status: 'pass',
        spf_status: 'pass',
        dmarc_status: 'pass',
        dmarc_policy: 'reject',
        aligned: true,
      });

      expect(repo.upsertDomain).toHaveBeenCalledWith('example.com', 'sendgrid', {
        dkim_status: 'pass',
        spf_status: 'pass',
        dmarc_status: 'pass',
        dmarc_policy: 'reject',
        aligned: true,
      });
    });

    it('should set gauge to 0 and increment failure counter when not aligned', async () => {
      const setSpy = jest.spyOn(metrics, 'setGauge');
      const incSpy = jest.spyOn(metrics, 'incrementCounter');

      await service.recordAlignmentResult('example.com', 'sendgrid', {
        dkim_status: 'fail',
        spf_status: 'fail',
        dmarc_status: 'fail',
        dmarc_policy: 'none',
        aligned: false,
      });

      expect(setSpy).toHaveBeenCalledWith(
        'email_alignment_status',
        0,
        { domain: 'example.com', check: 'dkim_dmarc_spf' },
        expect.any(String),
      );
      expect(incSpy).toHaveBeenCalledWith(
        'email_alignment_failure_total',
        { domain: 'example.com' },
        1,
        expect.any(String),
      );
    });

    it('should not call repo when disabled', async () => {
      const s = new EmailDeliverabilityService(repo, metrics, { enabled: false });
      await s.recordAlignmentResult('example.com', 'sendgrid', { aligned: true });

      expect(repo.upsertDomain).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // Suppression management
  // -----------------------------------------------------------------------
  describe('suppression management', () => {
    it('isSuppressed should delegate to repo', async () => {
      repo.isSuppressed.mockResolvedValue(true);
      const result = await service.isSuppressed('bounce@example.com');

      expect(repo.isSuppressed).toHaveBeenCalledWith('bounce@example.com');
      expect(result).toBe(true);
    });

    it('isSuppressed should return false when disabled', async () => {
      const s = new EmailDeliverabilityService(repo, metrics, { enabled: false });
      const result = await s.isSuppressed('bounce@example.com');

      expect(repo.isSuppressed).not.toHaveBeenCalled();
      expect(result).toBe(false);
    });

    it('addSuppression should delegate to repo', async () => {
      await service.addSuppression('spam@example.com', 'spam_complaint');
      expect(repo.addSuppression).toHaveBeenCalledWith({
        email: 'spam@example.com',
        reason: 'spam_complaint',
        expires_at: undefined,
      });
    });

    it('removeSuppression should delegate to repo', async () => {
      await service.removeSuppression('unsub@example.com');
      expect(repo.removeSuppression).toHaveBeenCalledWith('unsub@example.com');
    });
  });

  // -----------------------------------------------------------------------
  // Query methods
  // -----------------------------------------------------------------------
  describe('query methods', () => {
    it('getBounceRatio should return ratio from domain record', async () => {
      const ratio = await service.getBounceRatio('example.com');
      expect(repo.findByDomain).toHaveBeenCalledWith('example.com');
      expect(ratio).toBe(0.05);
    });

    it('getBounceRatio should return 0 when domain not found', async () => {
      repo.findByDomain.mockResolvedValue(null);
      const ratio = await service.getBounceRatio('nonexistent.com');
      expect(ratio).toBe(0);
    });

    it('getDomainMetrics should return domain record', async () => {
      const result = await service.getDomainMetrics('example.com');
      expect(result).not.toBeNull();
      expect(result!.domain).toBe('example.com');
    });
  });

  // -----------------------------------------------------------------------
  // Alarm checks
  // -----------------------------------------------------------------------
  describe('alarms', () => {
    it('checkAlignmentAlarms should emit alarm for failed domains', async () => {
      const failedDomain: DomainDeliverability = {
        id: 'dom-fail',
        domain: 'fail.com',
        provider: 'sendgrid',
        dkim_status: 'fail',
        spf_status: 'fail',
        dmarc_status: 'fail',
        dmarc_policy: 'none',
        aligned: false,
        sent_count: 50,
        bounce_count: 10,
        complaint_count: 0,
        block_count: 0,
        bounce_ratio: 0.2,
        last_sent_at: new Date(),
        last_bounce_at: new Date(),
        last_alarm_at: null,
        created_at: new Date(),
        updated_at: new Date(),
      };
      repo.listAlignmentFailures.mockResolvedValue([failedDomain]);

      const incSpy = jest.spyOn(metrics, 'incrementCounter');
      const result = await service.checkAlignmentAlarms();

      expect(result).toHaveLength(1);
      expect(result[0].domain).toBe('fail.com');
      expect(incSpy).toHaveBeenCalledWith(
        'email_alarm_alignment_failure',
        { domain: 'fail.com' },
        1,
        expect.any(String),
      );
      expect(repo.markAlarmRaised).toHaveBeenCalledWith('fail.com');
    });

    it('checkHighBounceRatioAlarms should emit alarm for high bounce ratio domains', async () => {
      const highBounce: DomainDeliverability = {
        id: 'dom-high',
        domain: 'bouncy.com',
        provider: 'sendgrid',
        dkim_status: 'pass',
        spf_status: 'pass',
        dmarc_status: 'pass',
        dmarc_policy: 'reject',
        aligned: true,
        sent_count: 100,
        bounce_count: 20,
        complaint_count: 0,
        block_count: 0,
        bounce_ratio: 0.2,
        last_sent_at: new Date(),
        last_bounce_at: new Date(),
        last_alarm_at: null,
        created_at: new Date(),
        updated_at: new Date(),
      };
      repo.listHighBounceRatioDomains.mockResolvedValue([highBounce]);

      const incSpy = jest.spyOn(metrics, 'incrementCounter');
      const result = await service.checkHighBounceRatioAlarms();

      expect(result).toHaveLength(1);
      expect(result[0].domain).toBe('bouncy.com');
      expect(incSpy).toHaveBeenCalledWith(
        'email_alarm_high_bounce_ratio',
        { domain: 'bouncy.com', ratio: '0.2000' },
        1,
        expect.any(String),
      );
    });

    it('should not check alarms when disabled', async () => {
      const s = new EmailDeliverabilityService(repo, metrics, { enabled: false });

      const alignment = await s.checkAlignmentAlarms();
      expect(alignment).toEqual([]);
      expect(repo.listAlignmentFailures).not.toHaveBeenCalled();

      const highBounce = await s.checkHighBounceRatioAlarms();
      expect(highBounce).toEqual([]);
      expect(repo.listHighBounceRatioDomains).not.toHaveBeenCalled();
    });
  });
});

