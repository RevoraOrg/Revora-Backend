/**
 * Tests for NotificationPreferencesService, focused on the quiet-hours
 * validation branches added for the push quiet-hours feature, plus the
 * existing get/update/delete behavior they build on.
 */

import { NotificationPreferencesService } from './notificationPreferencesService';
import {
  InMemoryNotificationPreferencesRepository,
  DEFAULT_QUIET_HOURS,
  QuietHoursConfig,
} from '../lib/notificationPreferencesRepository';
import { BadRequestError, NotFoundError } from '../lib/errors';

function validConfig(overrides: Partial<QuietHoursConfig> = {}): QuietHoursConfig {
  return { ...DEFAULT_QUIET_HOURS, ...overrides };
}

describe('NotificationPreferencesService quiet-hours validation', () => {
  let repo: InMemoryNotificationPreferencesRepository;
  let svc: NotificationPreferencesService;

  beforeEach(() => {
    repo = new InMemoryNotificationPreferencesRepository();
    svc = new NotificationPreferencesService(repo);
  });

  it('persists a valid quiet-hours config', async () => {
    const prefs = await svc.updatePreferences('u1', {
      quietHours: validConfig({ timezone: 'America/New_York' }),
    });
    expect(prefs.quietHours).toEqual(validConfig({ timezone: 'America/New_York' }));
  });

  it('accepts an update with no quietHours field', async () => {
    const prefs = await svc.updatePreferences('u1', { emailNotifications: true });
    expect(prefs.quietHours).toBeUndefined();
  });

  it.each([
    ['startHour below range', { startHour: -1 }],
    ['startHour above range', { startHour: 24 }],
    ['endHour above range', { endHour: 99 }],
    ['non-integer hour', { startHour: 22.5 }],
  ])('rejects %s', async (_label, overrides) => {
    await expect(
      svc.updatePreferences('u1', { quietHours: validConfig(overrides) }),
    ).rejects.toThrow(BadRequestError);
  });

  it('rejects a non-boolean enabled flag', async () => {
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      svc.updatePreferences('u1', { quietHours: validConfig({ enabled: 'yes' as any }) }),
    ).rejects.toThrow(BadRequestError);
  });

  it('rejects an empty timezone', async () => {
    await expect(
      svc.updatePreferences('u1', { quietHours: validConfig({ timezone: '' }) }),
    ).rejects.toThrow(BadRequestError);
  });

  it('rejects an invalid IANA timezone', async () => {
    await expect(
      svc.updatePreferences('u1', { quietHours: validConfig({ timezone: 'Not/AZone' }) }),
    ).rejects.toThrow(/not a valid IANA timezone/);
  });

  it('still rejects an invalid email address', async () => {
    await expect(
      svc.updatePreferences('u1', { emailAddress: 'not-an-email' }),
    ).rejects.toThrow(BadRequestError);
  });
});

describe('NotificationPreferencesService get/delete', () => {
  let repo: InMemoryNotificationPreferencesRepository;
  let svc: NotificationPreferencesService;

  beforeEach(() => {
    repo = new InMemoryNotificationPreferencesRepository();
    svc = new NotificationPreferencesService(repo);
  });

  it('throws NotFoundError getting preferences for an unknown user', async () => {
    await expect(svc.getPreferences('missing')).rejects.toThrow(NotFoundError);
  });

  it('gets preferences after an update', async () => {
    await svc.updatePreferences('u1', { smsNotifications: true });
    const prefs = await svc.getPreferences('u1');
    expect(prefs.smsNotifications).toBe(true);
  });

  it('deletes existing preferences', async () => {
    await svc.updatePreferences('u1', { smsNotifications: true });
    await expect(svc.deletePreferences('u1')).resolves.toBeUndefined();
    await expect(svc.getPreferences('u1')).rejects.toThrow(NotFoundError);
  });

  it('throws NotFoundError deleting preferences for an unknown user', async () => {
    await expect(svc.deletePreferences('missing')).rejects.toThrow(NotFoundError);
  });
});
