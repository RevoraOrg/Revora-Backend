import { Pool } from 'pg';
import { NotificationRepository } from './notificationRepository';

/**
 * Regression coverage for the failure/empty-result path of
 * `NotificationRepository` (`src/db/repositories/notificationRepository.ts`).
 *
 * `create()` issues an `INSERT ... RETURNING *` and then refuses to invent a
 * notification if the driver hands back no rows:
 *
 * ```ts
 * if (result.rows.length === 0) throw new Error('Failed to create notification');
 * ```
 *
 * The existing suite only exercises the happy path, so the guard, the query
 * contract it depends on, and the empty-result behaviour of the sibling methods
 * are pinned here.
 */

const sampleRow = {
  id: 'n1',
  user_id: 'u1',
  type: 'info',
  title: 'Test Notification',
  body: 'This is a test notification',
  read_at: null as Date | null,
  created_at: new Date('2024-05-01T10:00:00Z'),
};

const input = {
  user_id: 'u1',
  type: 'info',
  title: 'Test Notification',
  body: 'This is a test notification',
};

const makeSubject = () => {
  const query = jest.fn();
  const repository = new NotificationRepository({ query } as unknown as Pool);
  return { query, repository };
};

describe('NotificationRepository.create - failure and boundary paths', () => {
  it('rejects when the driver returns no rows for the INSERT', async () => {
    const { query, repository } = makeSubject();
    query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await expect(repository.create(input)).rejects.toThrow('Failed to create notification');
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('rejects even when rowCount claims a row was written but no row came back', async () => {
    const { query, repository } = makeSubject();
    // The guard reads `rows`, not `rowCount`: an inconsistent driver result must
    // still fail loudly rather than return a half-built notification.
    query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    await expect(repository.create(input)).rejects.toThrow('Failed to create notification');
  });

  it('propagates (does not translate) a rejected query', async () => {
    const { query, repository } = makeSubject();
    const failure = new Error('connection terminated unexpectedly');
    query.mockRejectedValueOnce(failure);

    await expect(repository.create(input)).rejects.toBe(failure);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('sends the INSERT ... RETURNING * contract with positional values', async () => {
    const { query, repository } = makeSubject();
    query.mockResolvedValueOnce({ rows: [sampleRow], rowCount: 1 });

    await repository.create(input);

    const [sql, values] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('INSERT INTO notifications');
    expect(sql).toContain('RETURNING *');
    expect(values).toEqual(['u1', 'info', 'Test Notification', 'This is a test notification']);
  });

  it('maps the returned row onto the notification contract', async () => {
    const { query, repository } = makeSubject();
    query.mockResolvedValueOnce({ rows: [sampleRow], rowCount: 1 });

    const created = await repository.create(input);

    expect(created).toEqual({
      id: 'n1',
      user_id: 'u1',
      type: 'info',
      title: 'Test Notification',
      body: 'This is a test notification',
      read_at: null,
      created_at: sampleRow.created_at,
    });
  });

  it('does not leak extra columns from the driver row', async () => {
    const { query, repository } = makeSubject();
    query.mockResolvedValueOnce({
      rows: [{ ...sampleRow, password_hash: 'secret', internal_note: 'do not expose' }],
      rowCount: 1,
    });

    const created = await repository.create(input);

    expect(Object.keys(created).sort()).toEqual(
      ['body', 'created_at', 'id', 'read_at', 'title', 'type', 'user_id'].sort()
    );
    expect(created).not.toHaveProperty('password_hash');
    expect(created).not.toHaveProperty('internal_note');
  });

  it('preserves falsy and long field values verbatim', async () => {
    const { query, repository } = makeSubject();
    const longTitle = 'x'.repeat(5000);
    query.mockResolvedValueOnce({
      rows: [{ ...sampleRow, title: '', body: longTitle, read_at: new Date('2024-05-02T00:00:00Z') }],
      rowCount: 1,
    });

    const created = await repository.create({ ...input, title: '', body: longTitle });

    expect(created.title).toBe('');
    expect(created.body).toBe(longTitle);
    expect(created.read_at).toEqual(new Date('2024-05-02T00:00:00Z'));
  });

  it('takes the first row when the driver returns more than one', async () => {
    const { query, repository } = makeSubject();
    query.mockResolvedValueOnce({
      rows: [sampleRow, { ...sampleRow, id: 'n2' }],
      rowCount: 2,
    });

    const created = await repository.create(input);

    expect(created.id).toBe('n1');
  });
});

describe('NotificationRepository.listByUser - empty and boundary results', () => {
  it('returns an empty array when the user has no notifications', async () => {
    const { query, repository } = makeSubject();
    query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await expect(repository.listByUser('u1')).resolves.toEqual([]);
    const [sql, values] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('WHERE user_id = $1');
    expect(sql).toContain('ORDER BY created_at DESC');
    expect(values).toEqual(['u1']);
  });

  it('maps every row in order', async () => {
    const { query, repository } = makeSubject();
    query.mockResolvedValueOnce({
      rows: [sampleRow, { ...sampleRow, id: 'n2', title: 'Second' }],
      rowCount: 2,
    });

    const notifications = await repository.listByUser('u1');

    expect(notifications.map((n) => n.id)).toEqual(['n1', 'n2']);
    expect(notifications[1].title).toBe('Second');
  });
});

describe('NotificationRepository.markRead / markReadBulk - empty-result paths', () => {
  it('returns false when no row was updated (unknown id or already read)', async () => {
    const { query, repository } = makeSubject();
    query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await expect(repository.markRead('missing', 'u1')).resolves.toBe(false);
    const [sql, values] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('read_at IS NULL');
    expect(values).toEqual(['missing', 'u1']);
  });

  it('returns true when a row was updated', async () => {
    const { query, repository } = makeSubject();
    query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    await expect(repository.markRead('n1', 'u1')).resolves.toBe(true);
  });

  it('returns 0 for an empty id list without touching the database', async () => {
    const { query, repository } = makeSubject();

    await expect(repository.markReadBulk([], 'u1')).resolves.toBe(0);
    expect(query).not.toHaveBeenCalled();
  });

  it('de-duplicates ids before querying and reports the driver rowCount', async () => {
    const { query, repository } = makeSubject();
    query.mockResolvedValueOnce({ rows: [], rowCount: 2 });

    await expect(repository.markReadBulk(['n1', 'n2', 'n1', 'n2'], 'u1')).resolves.toBe(2);

    const [sql, values] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('id = ANY($1)');
    expect(values).toEqual([['n1', 'n2'], 'u1']);
  });

  it('returns 0 when the bulk update matches no rows', async () => {
    const { query, repository } = makeSubject();
    query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await expect(repository.markReadBulk(['n1'], 'u1')).resolves.toBe(0);
  });

  it('propagates bulk update failures', async () => {
    const { query, repository } = makeSubject();
    const failure = new Error('deadlock detected');
    query.mockRejectedValueOnce(failure);

    await expect(repository.markReadBulk(['n1'], 'u1')).rejects.toBe(failure);
  });
});
