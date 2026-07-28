import { HolidayCalendarService } from './holidayCalendarService';
import { MetricsCollector } from '../lib/metrics';
import { InMemorySecurityAuditRepository } from '../security/audit';

const SECRET = 'super-secret-hmac-key-1234567890';

function createSignedCalendarFile(payload: Record<string, unknown>): string {
  const payloadJson = JSON.stringify(payload);
  const base64Payload = Buffer.from(payloadJson, 'utf8').toString('base64');
  const hmac = require('crypto').createHmac('sha256', SECRET);
  hmac.update(base64Payload);
  const signature = `sha256=${hmac.digest('hex')}`;
  return JSON.stringify({ payload: base64Payload, signature });
}

function createBaseService(overrides?: {
  metrics?: MetricsCollector;
  auditRepo?: InMemorySecurityAuditRepository;
}) {
  const metrics = overrides?.metrics ?? new MetricsCollector({ enabled: true, enablePIIDetection: false });
  const auditRepo = overrides?.auditRepo ?? new InMemorySecurityAuditRepository();
  return new HolidayCalendarService({ metrics, auditRepository: auditRepo });
}

async function writeTempCalendar(content: string): Promise<string> {
  const path = require('path');
  const fs = require('fs');
  const tmpFile = path.join('/tmp', `holiday-calendar-${Date.now()}-${Math.random().toString(36).substr(2, 9)}.json`);
  await fs.promises.writeFile(tmpFile, content);
  return tmpFile;
}

describe('HolidayCalendarService', () => {
  let service: HolidayCalendarService;
  let metrics: MetricsCollector;
  let auditRepo: InMemorySecurityAuditRepository;

  beforeEach(() => {
    metrics = new MetricsCollector({ enabled: true, enablePIIDetection: false });
    auditRepo = new InMemorySecurityAuditRepository();
    service = createBaseService({ metrics, auditRepo });
  });

  // ── Loading and validation ──────────────────────────────────────────────────

  describe('loadCalendar', () => {
    it('loads a valid signed calendar file', async () => {
      const fileContent = createSignedCalendarFile({
        version: '1.0.0',
        jurisdictions: { US: ['2026-01-01'] },
        overrides: {},
        generatedAt: '2026-01-01T00:00:00Z',
      });
      const tmpFile = await writeTempCalendar(fileContent);

      await service.loadCalendar(tmpFile, SECRET);

      expect(service.isLoaded()).toBe(true);
      expect(service.getCalendarHash()).toBeDefined();
      expect(service.getCalendarHash()!.length).toBe(64);
    });

    it('records an audit event on successful load', async () => {
      const fileContent = createSignedCalendarFile({
        version: '1.0.0',
        jurisdictions: { US: ['2026-01-01'] },
        overrides: {},
        generatedAt: '2026-01-01T00:00:00Z',
      });
      const tmpFile = await writeTempCalendar(fileContent);

      await service.loadCalendar(tmpFile, SECRET);

      const events = auditRepo.getAllEvents();
      expect(events).toHaveLength(1);
      expect(events[0].action).toBe('holiday_calendar.load');
      expect(events[0].outcome).toBe('SUCCESS');
      expect(events[0].details.version).toBe('1.0.0');
    });

    it('continues when audit repository throws during load', async () => {
      const badAuditRepo = new InMemorySecurityAuditRepository();
      badAuditRepo.record = async () => {
        throw new Error('Audit DB down');
      };
      const svcWithBadAudit = createBaseService({ auditRepo: badAuditRepo });

      const fileContent = createSignedCalendarFile({
        version: '1.0.0',
        jurisdictions: { US: ['2026-01-01'] },
        overrides: {},
        generatedAt: '2026-01-01T00:00:00Z',
      });
      const tmpFile = await writeTempCalendar(fileContent);

      await expect(svcWithBadAudit.loadCalendar(tmpFile, SECRET)).resolves.toBeUndefined();
      expect(svcWithBadAudit.isLoaded()).toBe(true);
    });

    it('rejects an unreadable file', async () => {
      await expect(service.loadCalendar('/nonexistent/file.json', SECRET)).rejects.toThrow(
        'Failed to read holiday calendar file'
      );
    });

    it('rejects malformed JSON', async () => {
      const fs = require('fs');
      const path = require('path');
      const tmpFile = path.join('/tmp', `bad-calendar-${Date.now()}.json`);
      await fs.promises.writeFile(tmpFile, 'not json');
      try {
        await service.loadCalendar(tmpFile, SECRET);
        fail('Expected loadCalendar to reject');
      } catch (e: any) {
        expect(e.message).toBe('Malformed holiday calendar JSON');
      } finally {
        await fs.promises.unlink(tmpFile).catch(() => {});
      }
    });

    it('rejects file with missing payload or signature', async () => {
      const fs = require('fs');
      const path = require('path');
      const tmpFile = path.join('/tmp', `bad-calendar-${Date.now()}.json`);
      await fs.promises.writeFile(tmpFile, JSON.stringify({ payload: 'abc' }));
      try {
        await service.loadCalendar(tmpFile, SECRET);
        fail('Expected loadCalendar to reject');
      } catch (e: any) {
        expect(e.message).toBe('Holiday calendar file must contain payload and signature');
      } finally {
        await fs.promises.unlink(tmpFile).catch(() => {});
      }
    });

    it('rejects invalid signature', async () => {
      const badSigFile = JSON.stringify({
        payload: Buffer.from(JSON.stringify({
          version: '1.0.0',
          jurisdictions: {},
          overrides: {},
          generatedAt: '2026-01-01T00:00:00Z',
        })).toString('base64'),
        signature: 'sha256=invalid',
      });

      const fs = require('fs');
      const path = require('path');
      const tmpFile = path.join('/tmp', `bad-sig-${Date.now()}.json`);
      await fs.promises.writeFile(tmpFile, badSigFile);
      try {
        await service.loadCalendar(tmpFile, SECRET);
        fail('Expected loadCalendar to reject');
      } catch (e: any) {
        expect(e.message).toBe('Holiday calendar signature verification failed');
      } finally {
        await fs.promises.unlink(tmpFile).catch(() => {});
      }
    });

    it('rejects malformed base64 payload', async () => {
      const payloadStr = 'not-base64!!!';
      const hmac = require('crypto').createHmac('sha256', SECRET);
      hmac.update(payloadStr);
      const signature = `sha256=${hmac.digest('hex')}`;
      const badPayloadFile = JSON.stringify({ payload: payloadStr, signature });

      const fs = require('fs');
      const path = require('path');
      const tmpFile = path.join('/tmp', `bad-payload-${Date.now()}.json`);
      await fs.promises.writeFile(tmpFile, badPayloadFile);
      try {
        await service.loadCalendar(tmpFile, SECRET);
        fail('Expected loadCalendar to reject');
      } catch (e: any) {
        expect(e.message).toBe('Malformed holiday calendar base64 payload');
      } finally {
        await fs.promises.unlink(tmpFile).catch(() => {});
      }
    });

    it('rejects invalid payload structure', async () => {
      const badStructPayload = Buffer.from(JSON.stringify({ bad: true })).toString('base64');
      const hmac = require('crypto').createHmac('sha256', SECRET);
      hmac.update(badStructPayload);
      const signature = `sha256=${hmac.digest('hex')}`;
      const badStructFile = JSON.stringify({ payload: badStructPayload, signature });

      const fs = require('fs');
      const path = require('path');
      const tmpFile = path.join('/tmp', `bad-struct-${Date.now()}.json`);
      await fs.promises.writeFile(tmpFile, badStructFile);
      try {
        await service.loadCalendar(tmpFile, SECRET);
        fail('Expected loadCalendar to reject');
      } catch (e: any) {
        expect(e.message).toBe('Invalid holiday calendar payload structure');
      } finally {
        await fs.promises.unlink(tmpFile).catch(() => {});
      }
    });

    it('rejects empty secret', async () => {
      const fileContent = createSignedCalendarFile({
        version: '1.0.0',
        jurisdictions: {},
        overrides: {},
        generatedAt: '2026-01-01T00:00:00Z',
      });
      const tmpFile = await writeTempCalendar(fileContent);

      await expect(service.loadCalendar(tmpFile, '')).rejects.toThrow(
        'Holiday calendar secret is required'
      );
    });
  });

  // ── Blackout detection ──────────────────────────────────────────────────────

  describe('isBlackout', () => {
    beforeEach(async () => {
      const fileContent = createSignedCalendarFile({
        version: '1.0.0',
        jurisdictions: {
          US: ['2026-01-01', '2026-12-25'],
          GB: ['2026-01-01', '2026-04-02'],
        },
        overrides: {
          'US-NY': ['2026-01-02'],
        },
        generatedAt: '2026-01-01T00:00:00Z',
      });
      const tmpFile = await writeTempCalendar(fileContent);
      await service.loadCalendar(tmpFile, SECRET);
    });

    it('returns false when no holidays match', () => {
      expect(service.isBlackout(new Date('2026-06-15'), ['US'])).toBe(false);
    });

    it('returns true when date matches a jurisdiction holiday', () => {
      expect(service.isBlackout(new Date('2026-01-01'), ['US'])).toBe(true);
      expect(service.isBlackout(new Date('2026-01-01'), ['GB'])).toBe(true);
      expect(service.isBlackout(new Date('2026-12-25'), ['US'])).toBe(true);
    });

    it('returns true for override holidays', () => {
      expect(service.isBlackout(new Date('2026-01-02'), ['US-NY'])).toBe(true);
    });

    it('returns true if any jurisdiction in the list has a holiday', () => {
      expect(service.isBlackout(new Date('2026-04-02'), ['US', 'GB'])).toBe(true);
    });

    it('returns false if no jurisdiction in the list has a holiday', () => {
      expect(service.isBlackout(new Date('2026-04-02'), ['US'])).toBe(false);
    });

    it('throws when calendar is not loaded', () => {
      const unloadedService = createBaseService();
      expect(() => unloadedService.isBlackout(new Date(), ['US'])).toThrow(
        'Holiday calendar has not been loaded'
      );
    });
  });

  // ── Shift computation ───────────────────────────────────────────────────────

  describe('getShiftedDate', () => {
    beforeEach(async () => {
      const fileContent = createSignedCalendarFile({
        version: '1.0.0',
        jurisdictions: {
          US: ['2026-01-31'],
        },
        overrides: {},
        generatedAt: '2026-01-01T00:00:00Z',
      });
      const tmpFile = await writeTempCalendar(fileContent);
      await service.loadCalendar(tmpFile, SECRET);
    });

    it('returns original date when not a blackout', () => {
      const result = service.getShiftedDate(new Date('2026-01-15'), ['US']);
      expect(result.shifted).toBe(false);
      expect(result.shiftedDate.getTime()).toBe(new Date('2026-01-15').getTime());
      expect(result.reason).toBe('No blackout');
    });

    it('shifts to previous business day with previous policy', () => {
      const result = service.getShiftedDate(new Date('2026-01-31'), ['US']);
      expect(result.shifted).toBe(true);
      expect(result.direction).toBe('previous');
      expect(result.reason).toContain('US');
      expect(result.jurisdictions).toEqual(['US']);
      expect(result.shiftedDate.toISOString().slice(0, 10)).toBe('2026-01-30');
    });

    it('shifts across weekends correctly', () => {
      // 2026-01-31 is Saturday and is a holiday in the calendar
      const result = service.getShiftedDate(new Date('2026-01-31'), ['US']);
      expect(result.shifted).toBe(true);
      // Saturday 2026-01-31 -> previous business day is Friday 2026-01-30
      expect(result.shiftedDate.toISOString().slice(0, 10)).toBe('2026-01-30');
    });

    it('returns unchanged for non-blackout date', () => {
      const result = service.getShiftedDate(new Date('2026-06-15'), ['US']);
      expect(result.shifted).toBe(false);
      expect(result.reason).toBe('No blackout');
    });

    it('returns unchanged for truly invalid date input', () => {
      const result = service.getShiftedDate(new Date(NaN), ['US']);
      expect(result.shifted).toBe(false);
      expect(result.reason).toBe('Invalid date');
    });

    it('throws when calendar is not loaded', () => {
      const unloadedService = createBaseService();
      expect(() => unloadedService.getShiftedDate(new Date(), ['US'])).toThrow(
        'Holiday calendar has not been loaded'
      );
    });
  });

  // ── Metric emission ─────────────────────────────────────────────────────────

  describe('metrics emission', () => {
    beforeEach(async () => {
      const fileContent = createSignedCalendarFile({
        version: '1.0.0',
        jurisdictions: {
          US: ['2026-01-31'],
          GB: ['2026-01-31'],
        },
        overrides: {},
        generatedAt: '2026-01-01T00:00:00Z',
      });
      const tmpFile = await writeTempCalendar(fileContent);
      await service.loadCalendar(tmpFile, SECRET);
    });

    it('emits scheduler_blackout_shift metric when shift occurs', async () => {
      service.getShiftedDate(new Date('2026-01-31'), ['US', 'GB']);

      const snapshot = await metrics.getSnapshot();
      const metric = snapshot.custom.find((p: any) => p.name === 'scheduler_blackout_shift_total')!;
      expect(metric.value).toBe(1);
      expect(metric.labels?.direction).toBe('previous');
      expect(metric.labels?.jurisdiction_count).toBe('2');
    });

    it('does not emit metric when no shift occurs', async () => {
      service.getShiftedDate(new Date('2026-06-15'), ['US']);

      const snapshot = await metrics.getSnapshot();
      const metric = snapshot.custom.find((p: any) => p.name === 'scheduler_blackout_shift_total');
      expect(metric).toBeUndefined();
    });
  });

  // ── Overlapping holidays ────────────────────────────────────────────────────

  describe('overlapping holidays across jurisdictions', () => {
    beforeEach(async () => {
      const fileContent = createSignedCalendarFile({
        version: '1.0.0',
        jurisdictions: {
          US: ['2026-01-31'],
          GB: ['2026-01-31'],
          DE: ['2026-01-30'],
        },
        overrides: {},
        generatedAt: '2026-01-01T00:00:00Z',
      });
      const tmpFile = await writeTempCalendar(fileContent);
      await service.loadCalendar(tmpFile, SECRET);
    });

    it('shifts when a single jurisdiction has a holiday', () => {
      const result = service.getShiftedDate(new Date('2026-01-31'), ['US']);
      expect(result.shifted).toBe(true);
      expect(result.jurisdictions).toEqual(['US']);
    });

    it('shifts when multiple jurisdictions have overlapping holidays', () => {
      const result = service.getShiftedDate(new Date('2026-01-31'), ['US', 'GB']);
      expect(result.shifted).toBe(true);
      expect(result.jurisdictions).toContain('US');
      expect(result.jurisdictions).toContain('GB');
    });

    it('does not shift when no holiday matches', () => {
      const result = service.getShiftedDate(new Date('2026-01-31'), ['FR']);
      expect(result.shifted).toBe(false);
    });
  });

  // ── Edge cases ──────────────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('handles empty jurisdictions array', async () => {
      const fileContent = createSignedCalendarFile({
        version: '1.0.0',
        jurisdictions: { US: ['2026-01-31'] },
        overrides: {},
        generatedAt: '2026-01-01T00:00:00Z',
      });
      const tmpFile = await writeTempCalendar(fileContent);
      await service.loadCalendar(tmpFile, SECRET);

      const result = service.getShiftedDate(new Date('2026-01-31'), []);
      expect(result.shifted).toBe(false);
    });

    it('handles leap year dates', async () => {
      const fileContent = createSignedCalendarFile({
        version: '1.0.0',
        jurisdictions: { US: ['2028-02-29'] },
        overrides: {},
        generatedAt: '2026-01-01T00:00:00Z',
      });
      const tmpFile = await writeTempCalendar(fileContent);
      await service.loadCalendar(tmpFile, SECRET);

      const result = service.getShiftedDate(new Date('2028-02-29'), ['US']);
      expect(result.shifted).toBe(true);
      expect(result.shiftedDate.toISOString().slice(0, 10)).toBe('2028-02-28');
    });
  });
});
