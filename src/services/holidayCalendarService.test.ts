/**
 * Tests for HolidayCalendarService (issue #664).
 *
 * Coverage:
 *   - Signed-file loading: valid, unreadable, malformed JSON, missing
 *     payload/signature, tampered signature, malformed base64, invalid payload
 *     structure, empty secret
 *   - Audit: load event persisted with calendar hash; audit failure does not
 *     break loading
 *   - Blackout detection: base holidays, overrides, multiple jurisdictions,
 *     unknown jurisdiction, unloaded calendar
 *   - Shift computation: previous/next policy, weekend handling, strictest
 *     shift when the adjacent business day is itself a holiday, overlapping
 *     holidays across jurisdictions, empty jurisdiction list, leap years
 *   - Metrics: `scheduler.blackout.shift` emitted on shift only
 */

import { HolidayCalendarService, ShiftDirection } from './holidayCalendarService';
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
  fallbackShiftPolicy?: ShiftDirection;
}) {
  const metrics = overrides?.metrics ?? new MetricsCollector({ enabled: true, enablePIIDetection: false });
  const auditRepo = overrides?.auditRepo ?? new InMemorySecurityAuditRepository();
  return new HolidayCalendarService({
    metrics,
    auditRepository: auditRepo,
    fallbackShiftPolicy: overrides?.fallbackShiftPolicy,
  });
}

async function writeTempCalendar(content: string): Promise<string> {
  const path = require('path');
  const fs = require('fs');
  const tmpFile = path.join(
    '/tmp',
    `holiday-calendar-${Date.now()}-${Math.random().toString(36).substr(2, 9)}.json`,
  );
  await fs.promises.writeFile(tmpFile, content);
  return tmpFile;
}

const baseCalendar = (extra: Record<string, unknown> = {}) => ({
  version: '1.0.0',
  jurisdictions: {},
  overrides: {},
  generatedAt: '2026-01-01T00:00:00Z',
  ...extra,
});

describe('HolidayCalendarService', () => {
  let service: HolidayCalendarService;
  let metrics: MetricsCollector;
  let auditRepo: InMemorySecurityAuditRepository;

  beforeEach(() => {
    metrics = new MetricsCollector({ enabled: true, enablePIIDetection: false });
    auditRepo = new InMemorySecurityAuditRepository();
    service = createBaseService({ metrics, auditRepo });
  });

  // ── Loading and validation ─────────────────────────────────────────────────

  describe('loadCalendar', () => {
    it('loads a valid signed calendar file', async () => {
      const fileContent = createSignedCalendarFile(baseCalendar({ jurisdictions: { US: ['2026-01-01'] } }));
      const tmpFile = await writeTempCalendar(fileContent);

      await service.loadCalendar(tmpFile, SECRET);

      expect(service.isLoaded()).toBe(true);
      expect(service.getCalendarHash()).toBeDefined();
      expect(service.getCalendarHash()!.length).toBe(64);
    });

    it('records an audit event with the calendar hash on successful load', async () => {
      const fileContent = createSignedCalendarFile(baseCalendar({ jurisdictions: { US: ['2026-01-01'] } }));
      const tmpFile = await writeTempCalendar(fileContent);

      await service.loadCalendar(tmpFile, SECRET);

      const events = auditRepo.getAllEvents();
      expect(events).toHaveLength(1);
      expect(events[0].action).toBe('holiday_calendar.load');
      expect(events[0].outcome).toBe('SUCCESS');
      expect(events[0].details.version).toBe('1.0.0');
      expect(events[0].details.calendarHash).toBe(service.getCalendarHash());
    });

    it('continues loading when the audit repository throws', async () => {
      const badAuditRepo = new InMemorySecurityAuditRepository();
      badAuditRepo.record = async () => {
        throw new Error('Audit DB down');
      };
      const svcWithBadAudit = createBaseService({ auditRepo: badAuditRepo });

      const fileContent = createSignedCalendarFile(baseCalendar());
      const tmpFile = await writeTempCalendar(fileContent);

      await expect(svcWithBadAudit.loadCalendar(tmpFile, SECRET)).resolves.toBeUndefined();
      expect(svcWithBadAudit.isLoaded()).toBe(true);
    });

    it('rejects an unreadable file', async () => {
      await expect(service.loadCalendar('/nonexistent/file.json', SECRET)).rejects.toThrow(
        'Failed to read holiday calendar file',
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

    it('rejects a file missing payload or signature', async () => {
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

    it('rejects a tampered signature', async () => {
      const badSigFile = JSON.stringify({
        payload: Buffer.from(JSON.stringify(baseCalendar())).toString('base64'),
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

    it('rejects a signature produced with a different secret', async () => {
      const otherHmac = require('crypto').createHmac('sha256', 'a-different-secret');
      otherHmac.update(Buffer.from(JSON.stringify(baseCalendar())).toString('base64'));
      const sigFile = JSON.stringify({
        payload: Buffer.from(JSON.stringify(baseCalendar())).toString('base64'),
        signature: `sha256=${otherHmac.digest('hex')}`,
      });
      const fs = require('fs');
      const path = require('path');
      const tmpFile = path.join('/tmp', `other-sig-${Date.now()}.json`);
      await fs.promises.writeFile(tmpFile, sigFile);
      try {
        await service.loadCalendar(tmpFile, SECRET);
        fail('Expected loadCalendar to reject');
      } catch (e: any) {
        expect(e.message).toBe('Holiday calendar signature verification failed');
      } finally {
        await fs.promises.unlink(tmpFile).catch(() => {});
      }
    });

    it('rejects a malformed base64 payload', async () => {
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

    it('rejects a payload with an invalid structure', async () => {
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

    it('rejects a payload with non-array jurisdiction values', async () => {
      const badPayload = Buffer.from(
        JSON.stringify({
          version: '1.0.0',
          jurisdictions: { US: '2026-01-01' },
          overrides: {},
          generatedAt: '2026-01-01T00:00:00Z',
        }),
      ).toString('base64');
      const hmac = require('crypto').createHmac('sha256', SECRET);
      hmac.update(badPayload);
      const fileContent = JSON.stringify({ payload: badPayload, signature: `sha256=${hmac.digest('hex')}` });
      const tmpFile = await writeTempCalendar(fileContent);

      await expect(service.loadCalendar(tmpFile, SECRET)).rejects.toThrow(
        'Invalid holiday calendar payload structure',
      );
    });

    it('rejects an empty secret', async () => {
      const fileContent = createSignedCalendarFile(baseCalendar());
      const tmpFile = await writeTempCalendar(fileContent);

      await expect(service.loadCalendar(tmpFile, '')).rejects.toThrow(
        'Holiday calendar secret is required',
      );
    });
  });

  // ── Blackout detection ─────────────────────────────────────────────────────

  describe('isBlackout', () => {
    beforeEach(async () => {
      const fileContent = createSignedCalendarFile(
        baseCalendar({
          jurisdictions: {
            US: ['2026-01-01', '2026-12-25'],
            GB: ['2026-01-01', '2026-04-02'],
          },
          overrides: { 'US-NY': ['2026-01-02'] },
        }),
      );
      const tmpFile = await writeTempCalendar(fileContent);
      await service.loadCalendar(tmpFile, SECRET);
    });

    it('returns false when no holidays match', () => {
      expect(service.isBlackout(new Date('2026-06-15'), ['US'])).toBe(false);
    });

    it('returns true when the date matches a jurisdiction holiday', () => {
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

    it('returns false for an unknown jurisdiction', () => {
      expect(service.isBlackout(new Date('2026-01-01'), ['XX'])).toBe(false);
    });

    it('throws when the calendar is not loaded', () => {
      const unloadedService = createBaseService();
      expect(() => unloadedService.isBlackout(new Date(), ['US'])).toThrow(
        'Holiday calendar has not been loaded',
      );
    });
  });

  // ── Shift computation ──────────────────────────────────────────────────────

  describe('getShiftedDate', () => {
    beforeEach(async () => {
      const fileContent = createSignedCalendarFile(
        baseCalendar({ jurisdictions: { US: ['2026-01-31'] } }),
      );
      const tmpFile = await writeTempCalendar(fileContent);
      await service.loadCalendar(tmpFile, SECRET);
    });

    it('returns the original date when not a blackout', () => {
      const result = service.getShiftedDate(new Date('2026-01-15'), ['US']);
      expect(result.shifted).toBe(false);
      expect(result.shiftedDate.getTime()).toBe(new Date('2026-01-15').getTime());
      expect(result.reason).toBe('No blackout');
    });

    it('shifts to the previous business day with the previous policy', () => {
      const result = service.getShiftedDate(new Date('2026-01-31'), ['US']);
      expect(result.shifted).toBe(true);
      expect(result.direction).toBe('previous');
      expect(result.reason).toContain('US');
      expect(result.jurisdictions).toEqual(['US']);
      expect(result.shiftedDate.toISOString().slice(0, 10)).toBe('2026-01-30');
    });

    it('shifts across weekends correctly', () => {
      // 2026-01-31 is a Saturday and a holiday in the calendar.
      const result = service.getShiftedDate(new Date('2026-01-31'), ['US']);
      expect(result.shifted).toBe(true);
      // Saturday 2026-01-31 -> previous business day Friday 2026-01-30
      expect(result.shiftedDate.toISOString().slice(0, 10)).toBe('2026-01-30');
    });

    it('keeps shifting when the adjacent business day is itself a holiday (strictest shift)', async () => {
      // US: 2026-01-31 (Sat) blackout; 2026-01-30 (Fri) ALSO a blackout.
      const fileContent = createSignedCalendarFile(
        baseCalendar({ jurisdictions: { US: ['2026-01-31', '2026-01-30'] } }),
      );
      const tmpFile = await writeTempCalendar(fileContent);
      await service.loadCalendar(tmpFile, SECRET);

      const result = service.getShiftedDate(new Date('2026-01-31'), ['US']);
      expect(result.shifted).toBe(true);
      // Previous settleable weekday before 2026-01-30 is Thursday 2026-01-29.
      expect(result.shiftedDate.toISOString().slice(0, 10)).toBe('2026-01-29');
    });

    it('supports the next-day shift policy', async () => {
      const nextService = createBaseService({ fallbackShiftPolicy: 'next' });
      const fileContent = createSignedCalendarFile(
        baseCalendar({ jurisdictions: { US: ['2026-01-31'] } }),
      );
      const tmpFile = await writeTempCalendar(fileContent);
      await nextService.loadCalendar(tmpFile, SECRET);

      const result = nextService.getShiftedDate(new Date('2026-01-31'), ['US']);
      expect(result.shifted).toBe(true);
      expect(result.direction).toBe('next');
      // Saturday 2026-01-31 -> next business day Monday 2026-02-02.
      expect(result.shiftedDate.toISOString().slice(0, 10)).toBe('2026-02-02');
    });

    it('returns unchanged for a truly invalid date input', () => {
      const result = service.getShiftedDate(new Date(NaN), ['US']);
      expect(result.shifted).toBe(false);
      expect(result.reason).toBe('Invalid date');
    });

    it('throws when the calendar is not loaded', () => {
      const unloadedService = createBaseService();
      expect(() => unloadedService.getShiftedDate(new Date(), ['US'])).toThrow(
        'Holiday calendar has not been loaded',
      );
    });
  });

  // ── Overlapping holidays across jurisdictions ──────────────────────────────

  describe('overlapping holidays across jurisdictions', () => {
    beforeEach(async () => {
      const fileContent = createSignedCalendarFile(
        baseCalendar({
          jurisdictions: {
            US: ['2026-01-31'],
            GB: ['2026-01-31'],
            DE: ['2026-01-30'],
          },
        }),
      );
      const tmpFile = await writeTempCalendar(fileContent);
      await service.loadCalendar(tmpFile, SECRET);
    });

    it('shifts when a single jurisdiction has a holiday', () => {
      const result = service.getShiftedDate(new Date('2026-01-31'), ['US']);
      expect(result.shifted).toBe(true);
      expect(result.jurisdictions).toEqual(['US']);
    });

    it('shifts when multiple jurisdictions share an overlapping holiday', () => {
      const result = service.getShiftedDate(new Date('2026-01-31'), ['US', 'GB']);
      expect(result.shifted).toBe(true);
      expect(result.jurisdictions).toContain('US');
      expect(result.jurisdictions).toContain('GB');
    });

    it('applies the strictest shift when the first candidate day is blacked out in another jurisdiction', () => {
      // US+GB blackout on 2026-01-31 (Sat). Previous business day 2026-01-30 is
      // a blackout in DE — but DE was not a party to this distribution, so the
      // shift should still land on 2026-01-30.
      const result = service.getShiftedDate(new Date('2026-01-31'), ['US', 'GB']);
      expect(result.shifted).toBe(true);
      expect(result.shiftedDate.toISOString().slice(0, 10)).toBe('2026-01-30');
    });

    it('keeps shifting when the candidate day is blacked out for an affected jurisdiction', () => {
      // US blackout on 2026-01-31 (Sat). Previous business day 2026-01-30 is a
      // blackout for DE AND DE is part of this distribution -> keep shifting to
      // 2026-01-29 (Thu).
      const result = service.getShiftedDate(new Date('2026-01-31'), ['US', 'DE']);
      expect(result.shifted).toBe(true);
      expect(result.shiftedDate.toISOString().slice(0, 10)).toBe('2026-01-29');
    });

    it('does not shift when no jurisdiction matches', () => {
      const result = service.getShiftedDate(new Date('2026-01-31'), ['FR']);
      expect(result.shifted).toBe(false);
    });
  });

  // ── Metrics ────────────────────────────────────────────────────────────────

  describe('metrics emission', () => {
    beforeEach(async () => {
      const fileContent = createSignedCalendarFile(
        baseCalendar({ jurisdictions: { US: ['2026-01-31'], GB: ['2026-01-31'] } }),
      );
      const tmpFile = await writeTempCalendar(fileContent);
      await service.loadCalendar(tmpFile, SECRET);
    });

    it('emits scheduler.blackout.shift when a shift occurs', async () => {
      service.getShiftedDate(new Date('2026-01-31'), ['US', 'GB']);

      const snapshot = await metrics.getSnapshot();
      // sanitizeName replaces '.' with '_' → scheduler_blackout_shift
      const metric = snapshot.custom.find((p: any) => p.name === 'scheduler_blackout_shift')!;
      expect(metric).toBeDefined();
      expect(metric.value).toBe(1);
      expect(metric.labels?.direction).toBe('previous');
      expect(metric.labels?.jurisdiction_count).toBe('2');
    });

    it('does not emit the metric when no shift occurs', async () => {
      service.getShiftedDate(new Date('2026-06-15'), ['US']);

      const snapshot = await metrics.getSnapshot();
      const metric = snapshot.custom.find((p: any) => p.name === 'scheduler_blackout_shift');
      expect(metric).toBeUndefined();
    });
  });

  // ── Edge cases ─────────────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('handles an empty jurisdictions array', async () => {
      const fileContent = createSignedCalendarFile(
        baseCalendar({ jurisdictions: { US: ['2026-01-31'] } }),
      );
      const tmpFile = await writeTempCalendar(fileContent);
      await service.loadCalendar(tmpFile, SECRET);

      const result = service.getShiftedDate(new Date('2026-01-31'), []);
      expect(result.shifted).toBe(false);
    });

    it('handles leap year dates', async () => {
      const fileContent = createSignedCalendarFile(
        baseCalendar({ jurisdictions: { US: ['2028-02-29'] } }),
      );
      const tmpFile = await writeTempCalendar(fileContent);
      await service.loadCalendar(tmpFile, SECRET);

      const result = service.getShiftedDate(new Date('2028-02-29'), ['US']);
      expect(result.shifted).toBe(true);
      expect(result.shiftedDate.toISOString().slice(0, 10)).toBe('2028-02-28');
    });

    it('handles holidays spanning a long weekend by skipping consecutive blackout days', async () => {
      // UK Easter 2026: Good Friday 2026-04-03, Easter Monday 2026-04-06.
      const fileContent = createSignedCalendarFile(
        baseCalendar({ jurisdictions: { GB: ['2026-04-03', '2026-04-06'] } }),
      );
      const tmpFile = await writeTempCalendar(fileContent);
      await service.loadCalendar(tmpFile, SECRET);

      const result = service.getShiftedDate(new Date('2026-04-06'), ['GB']);
      expect(result.shifted).toBe(true);
      // Previous settleable day: 2026-04-03 (Fri) is blacked out, weekend skipped,
      // so Tuesday 2026-04-07? No — previous direction from 04-06 (Mon):
      //   04-05 Sun (skip), 04-04 Sat (skip), 04-03 Fri blackout (skip),
      //   04-02 Thu -> settleable.
      expect(result.shiftedDate.toISOString().slice(0, 10)).toBe('2026-04-02');
    });
  });
});
