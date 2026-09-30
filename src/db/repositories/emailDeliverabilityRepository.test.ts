import { Pool } from 'pg';
import {
  BounceEvent,
  DomainDeliverability,
  EmailDeliverabilityRepository,
  EmailSuppression,
} from './emailDeliverabilityRepository';

const createRepository = (query: jest.Mock) =>
  new EmailDeliverabilityRepository({ query } as unknown as Pool);

const domainRecord: DomainDeliverability = {
  id: 'domain-1',
  domain: 'example.com',
  provider: 'mailgun',
  dkim_status: 'pass',
  spf_status: 'pass',
  dmarc_status: 'pass',
  dmarc_policy: 'reject',
  aligned: true,
  sent_count: 20,
  bounce_count: 2,
  complaint_count: 1,
  block_count: 0,
  bounce_ratio: 0.1,
  last_sent_at: new Date('2026-01-01T00:00:00.000Z'),
  last_bounce_at: null,
  last_alarm_at: null,
  created_at: new Date('2026-01-01T00:00:00.000Z'),
  updated_at: new Date('2026-01-01T00:00:00.000Z'),
};

const suppressionRecord: EmailSuppression = {
  id: 'suppression-1',
  email: 'person@example.com',
  reason: 'hard_bounce',
  bounce_event_id: 'bounce-1',
  created_at: new Date('2026-01-01T00:00:00.000Z'),
  expires_at: null,
};

const bounceRecord: BounceEvent = {
  id: 'bounce-1',
  email: 'person@example.com',
  domain: 'example.com',
  provider: 'mailgun',
  bounce_type: 'hard_bounce',
  status_code: '550',
  provider_event_id: 'provider-event-1',
  raw_payload: { reason: 'mailbox unavailable' },
  ingested_at: new Date('2026-01-01T00:00:00.000Z'),
};

describe('EmailDeliverabilityRepository', () => {
  describe('domain deliverability', () => {
    it('upserts a domain and applies null/false defaults for omitted alignment', async () => {
      const query = jest.fn().mockResolvedValue({ rows: [domainRecord] });
      const repository = createRepository(query);

      await expect(repository.upsertDomain('example.com', 'mailgun')).resolves.toBe(domainRecord);

      expect(query.mock.calls[0][0]).toContain('ON CONFLICT (domain) DO UPDATE');
      expect(query.mock.calls[0][1]).toEqual([
        'example.com',
        'mailgun',
        null,
        null,
        null,
        null,
        false,
      ]);
    });

    it('preserves explicit alignment fields, including false', async () => {
      const query = jest.fn().mockResolvedValue({ rows: [domainRecord] });
      const repository = createRepository(query);

      await repository.upsertDomain('example.com', 'mailgun', {
        dkim_status: 'fail',
        aligned: false,
      });

      expect(query.mock.calls[0][1]).toEqual([
        'example.com',
        'mailgun',
        'fail',
        null,
        null,
        null,
        false,
      ]);
    });

    it('returns a matching domain or null when no row exists', async () => {
      const query = jest.fn().mockResolvedValueOnce({ rows: [domainRecord] }).mockResolvedValueOnce({ rows: [] });
      const repository = createRepository(query);

      await expect(repository.findByDomain('example.com')).resolves.toBe(domainRecord);
      await expect(repository.findByDomain('missing.example')).resolves.toBeNull();
    });

    it.each([
      ['recordSend', 'sent_count = sent_count + 1'],
      ['recordBounce', 'bounce_count = bounce_count + 1'],
      ['recordComplaint', 'complaint_count = complaint_count + 1'],
      ['recordBlock', 'block_count = block_count + 1'],
    ] as const)('records %s as a domain state transition', async (method, expectedUpdate) => {
      const query = jest.fn().mockResolvedValue({ rows: [] });
      const repository = createRepository(query);

      await repository[method]('example.com');

      expect(query.mock.calls[0][0]).toContain(expectedUpdate);
      expect(query.mock.calls[0][1]).toEqual(['example.com']);
    });

    it('updates alignment and records alarm time', async () => {
      const query = jest.fn().mockResolvedValue({ rows: [] });
      const repository = createRepository(query);

      await repository.recordAlignment('example.com', { dkim_status: 'fail', aligned: false });
      await repository.markAlarmRaised('example.com');

      expect(query.mock.calls[0][0]).toContain('aligned = $6');
      expect(query.mock.calls[0][1]).toEqual(['example.com', 'fail', null, null, null, false]);
      expect(query.mock.calls[1][0]).toContain('last_alarm_at = NOW()');
      expect(query.mock.calls[1][1]).toEqual(['example.com']);
    });

    it('lists alignment failures using the default cooldown and high-bounce domains by threshold', async () => {
      const query = jest.fn().mockResolvedValue({ rows: [domainRecord] });
      const repository = createRepository(query);

      await expect(repository.listAlignmentFailures()).resolves.toEqual([domainRecord]);
      await expect(repository.listHighBounceRatioDomains(0.08)).resolves.toEqual([domainRecord]);

      expect(query.mock.calls[0][1]).toEqual(['24 hours']);
      expect(query.mock.calls[1][0]).toContain('sent_count > 0 AND bounce_ratio >= $1');
      expect(query.mock.calls[1][1]).toEqual([0.08]);
    });
  });

  describe('suppressions', () => {
    it('reports active suppression state based on rowCount', async () => {
      const query = jest.fn().mockResolvedValueOnce({ rowCount: 1 }).mockResolvedValueOnce({ rowCount: 0 });
      const repository = createRepository(query);

      await expect(repository.isSuppressed('person@example.com')).resolves.toBe(true);
      await expect(repository.isSuppressed('clear@example.com')).resolves.toBe(false);

      expect(query.mock.calls[0][0]).toContain('expires_at > NOW()');
      expect(query.mock.calls[0][1]).toEqual(['person@example.com']);
    });

    it('binds malformed email input as a value rather than SQL text', async () => {
      const malformedEmail = "x@example.com' OR 1=1 --";
      const query = jest.fn().mockResolvedValue({ rowCount: 0 });
      const repository = createRepository(query);

      await repository.isSuppressed(malformedEmail);

      expect(query.mock.calls[0][0]).not.toContain(malformedEmail);
      expect(query.mock.calls[0][1]).toEqual([malformedEmail]);
    });

    it('adds a suppression with optional values defaulted to null', async () => {
      const query = jest.fn().mockResolvedValue({ rows: [suppressionRecord] });
      const repository = createRepository(query);

      await expect(
        repository.addSuppression({ email: 'person@example.com', reason: 'hard_bounce' }),
      ).resolves.toBe(suppressionRecord);

      expect(query.mock.calls[0][0]).toContain('ON CONFLICT (email, reason) DO NOTHING');
      expect(query.mock.calls[0][1]).toEqual(['person@example.com', 'hard_bounce', null, null]);
    });

    it('makes a duplicate suppression no-op observable as no returned row', async () => {
      const query = jest.fn().mockResolvedValue({ rows: [] });
      const repository = createRepository(query);

      await expect(
        repository.addSuppression({ email: 'person@example.com', reason: 'hard_bounce' }),
      ).resolves.toBeUndefined();
    });

    it('removes suppressions and lists active entries newest first', async () => {
      const query = jest.fn().mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [suppressionRecord] });
      const repository = createRepository(query);

      await repository.removeSuppression('person@example.com');
      await expect(repository.listSuppressions('person@example.com')).resolves.toEqual([suppressionRecord]);

      expect(query.mock.calls[0][0]).toContain('DELETE FROM email_suppressions');
      expect(query.mock.calls[1][0]).toContain('ORDER BY created_at DESC');
      expect(query.mock.calls[1][1]).toEqual(['person@example.com']);
    });
  });

  describe('bounce events', () => {
    it('inserts a bounce event, serializing payload and defaulting optional fields', async () => {
      const query = jest.fn().mockResolvedValue({ rows: [bounceRecord] });
      const repository = createRepository(query);
      const payload = { reason: 'mailbox unavailable' };

      await expect(
        repository.insertBounceEvent({
          email: 'person@example.com',
          domain: 'example.com',
          provider: 'mailgun',
          bounce_type: 'hard_bounce',
          raw_payload: payload,
        }),
      ).resolves.toBe(bounceRecord);

      expect(query.mock.calls[0][0]).toContain('ON CONFLICT (provider, provider_event_id)');
      expect(query.mock.calls[0][1]).toEqual([
        'person@example.com',
        'example.com',
        'mailgun',
        'hard_bounce',
        null,
        null,
        JSON.stringify(payload),
      ]);
    });

    it('makes duplicate provider events no-op when the insert returns no row', async () => {
      const query = jest.fn().mockResolvedValue({ rows: [] });
      const repository = createRepository(query);

      await expect(
        repository.insertBounceEvent({
          email: 'person@example.com',
          domain: 'example.com',
          provider: 'mailgun',
          bounce_type: 'hard_bounce',
          provider_event_id: 'provider-event-1',
        }),
      ).resolves.toBeUndefined();

      expect(query.mock.calls[0][1]).toEqual([
        'person@example.com',
        'example.com',
        'mailgun',
        'hard_bounce',
        null,
        'provider-event-1',
        null,
      ]);
    });

    it('lists events newest first with default and caller-provided limits', async () => {
      const query = jest.fn().mockResolvedValue({ rows: [bounceRecord] });
      const repository = createRepository(query);

      await expect(repository.listBounceEvents('person@example.com')).resolves.toEqual([bounceRecord]);
      await repository.listBounceEvents('person@example.com', 10);

      expect(query.mock.calls[0][0]).toContain('ORDER BY ingested_at DESC');
      expect(query.mock.calls[0][1]).toEqual(['person@example.com', 50]);
      expect(query.mock.calls[1][1]).toEqual(['person@example.com', 10]);
    });

    it('passes invalid limits as bound values without interpolating them into SQL', async () => {
      const query = jest.fn().mockResolvedValue({ rows: [] });
      const repository = createRepository(query);

      await repository.listBounceEvents('person@example.com', -1);

      expect(query.mock.calls[0][0]).toContain('LIMIT $2');
      expect(query.mock.calls[0][1]).toEqual(['person@example.com', -1]);
    });

    it('propagates database failures unchanged', async () => {
      const databaseError = new Error('database unavailable');
      const query = jest.fn().mockRejectedValue(databaseError);
      const repository = createRepository(query);

      await expect(repository.findByDomain('example.com')).rejects.toBe(databaseError);
    });
  });
});