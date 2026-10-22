import { Pool } from 'pg';
import {
  NotificationPreference,
  NotificationPreferencesRepository,
} from './notificationPreferencesRepository';

describe('NotificationPreferencesRepository.upsertPreference', () => {
  const preference: NotificationPreference = {
    id: 'preference-1',
    user_id: 'user-1',
    channel: 'email',
    type: 'payout',
    enabled: true,
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    updated_at: new Date('2026-01-01T00:00:00.000Z'),
  };

  const createRepository = (query: jest.Mock) =>
    new NotificationPreferencesRepository({ query } as unknown as Pool);

  it('returns the upserted row and defaults enabled to true when omitted', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [preference] });
    const repository = createRepository(query);

    await expect(
      repository.upsertPreference({ user_id: 'user-1', channel: 'email', type: 'payout' })
    ).resolves.toBe(preference);
    expect(query.mock.calls[0][1]).toEqual(['user-1', 'email', 'payout', true]);
  });

  it('preserves an explicit false enabled value', async () => {
    const disabledPreference = { ...preference, enabled: false };
    const query = jest.fn().mockResolvedValue({ rows: [disabledPreference] });
    const repository = createRepository(query);

    await expect(
      repository.upsertPreference({
        user_id: 'user-1',
        channel: 'email',
        type: 'payout',
        enabled: false,
      })
    ).resolves.toBe(disabledPreference);
    expect(query.mock.calls[0][1]).toEqual(['user-1', 'email', 'payout', false]);
  });

  it('throws the documented error when the upsert returns no rows', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });
    const repository = createRepository(query);

    await expect(
      repository.upsertPreference({ user_id: 'user-1', channel: 'email', type: 'payout' })
    ).rejects.toThrow('Failed to upsert notification preference');
  });

  it('propagates database errors unchanged', async () => {
    const databaseError = new Error('database unavailable');
    const query = jest.fn().mockRejectedValue(databaseError);
    const repository = createRepository(query);

    await expect(
      repository.upsertPreference({ user_id: 'user-1', channel: 'email', type: 'payout' })
    ).rejects.toBe(databaseError);
  });
});