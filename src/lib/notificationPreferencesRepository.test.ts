/**
 * Tests for InMemoryNotificationPreferencesRepository, covering the upsert
 * create/update branches, quiet-hours persistence, delete, and clear.
 */

import {
  InMemoryNotificationPreferencesRepository,
  DEFAULT_QUIET_HOURS,
} from './notificationPreferencesRepository';

describe('InMemoryNotificationPreferencesRepository', () => {
  let repo: InMemoryNotificationPreferencesRepository;

  beforeEach(() => {
    repo = new InMemoryNotificationPreferencesRepository();
  });

  it('returns undefined for an unknown user', async () => {
    expect(await repo.findByUserId('missing')).toBeUndefined();
  });

  it('creates preferences on first upsert with a generated id', async () => {
    const created = await repo.upsert('u1', { smsNotifications: true });
    expect(created.id).toEqual(expect.any(String));
    expect(created.id).not.toHaveLength(0);
    expect(created.userId).toBe('u1');
    expect(created.smsNotifications).toBe(true);
    expect(created.createdAt).toBeInstanceOf(Date);
  });

  it('updates existing preferences in place, preserving id and createdAt', async () => {
    const created = await repo.upsert('u1', { smsNotifications: true });
    const updated = await repo.upsert('u1', {
      emailNotifications: true,
      quietHours: { ...DEFAULT_QUIET_HOURS, timezone: 'Europe/London' },
    });

    expect(updated.id).toBe(created.id);
    expect(updated.createdAt).toEqual(created.createdAt);
    expect(updated.smsNotifications).toBe(true); // preserved
    expect(updated.emailNotifications).toBe(true); // merged
    expect(updated.quietHours?.timezone).toBe('Europe/London');
    expect(await repo.findByUserId('u1')).toEqual(updated);
  });

  it('deletes existing preferences and reports success', async () => {
    await repo.upsert('u1', { smsNotifications: true });
    expect(await repo.deleteByUserId('u1')).toBe(true);
    expect(await repo.findByUserId('u1')).toBeUndefined();
  });

  it('returns false when deleting a non-existent user', async () => {
    expect(await repo.deleteByUserId('missing')).toBe(false);
  });

  it('clears all stored preferences', async () => {
    await repo.upsert('u1', { smsNotifications: true });
    await repo.upsert('u2', { emailNotifications: true });
    await repo.clear();
    expect(await repo.findByUserId('u1')).toBeUndefined();
    expect(await repo.findByUserId('u2')).toBeUndefined();
  });
});
