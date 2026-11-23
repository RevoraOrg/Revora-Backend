/**
 * Regression coverage for the failure and empty-result branches of
 * `OfferingRepository` (OfferingStatus handling).
 *
 * The repository deliberately encodes three observable outcomes:
 *
 *  1. `create()` with no defined fields   → throws before touching the database.
 *  2. `create()` / `updateStatus()` when the write returns no rows
 *                                          → throws / returns `null`.
 *  3. `getById()` / `findByContractAddress()` / `update()` when nothing matches
 *                                          → returns `null` (never `undefined`).
 *
 * These tests pin that contract, plus the neighbouring happy paths and the
 * boundary inputs (empty strings, `null` vs `undefined`, oversized strings), so
 * a silent behaviour change fails CI instead of shipping.
 */

import { Pool, QueryResult } from 'pg';
import { Offering, OfferingRepository } from './offeringRepository';

function emptyResult(command = 'SELECT'): QueryResult<Offering> {
  return {
    rows: [],
    rowCount: 0,
    command,
    oid: 0,
    fields: [],
  } as unknown as QueryResult<Offering>;
}

function rowsResult(rows: Partial<Offering>[], command = 'SELECT'): QueryResult<Offering> {
  return {
    rows: rows as Offering[],
    rowCount: rows.length,
    command,
    oid: 0,
    fields: [],
  } as unknown as QueryResult<Offering>;
}

describe('OfferingRepository — failure and empty-result handling', () => {
  let repository: OfferingRepository;
  let mockPool: { query: jest.Mock };

  beforeEach(() => {
    mockPool = { query: jest.fn() };
    repository = new OfferingRepository(mockPool as unknown as Pool);
  });

  describe('create() — rejected and empty writes', () => {
    it('rejects a payload with no defined fields without querying the database', async () => {
      await expect(repository.create({})).rejects.toThrow(
        'create requires at least one offering field'
      );
      expect(mockPool.query).not.toHaveBeenCalled();
    });

    it('treats undefined-valued fields as absent (boundary: undefined vs null)', async () => {
      await expect(repository.create({ name: undefined })).rejects.toThrow(
        'create requires at least one offering field'
      );
      expect(mockPool.query).not.toHaveBeenCalled();
    });

    it('still sends deliberately empty strings to the database', async () => {
      mockPool.query.mockResolvedValueOnce(rowsResult([{ id: 'off-empty' }], 'INSERT'));

      const created = await repository.create({ title: '' });

      expect(mockPool.query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO offerings'), [
        '',
      ]);
      expect(created.id).toBe('off-empty');
    });

    it('throws when INSERT ... RETURNING produces no row', async () => {
      mockPool.query.mockResolvedValueOnce(emptyResult('INSERT'));

      await expect(repository.create({ title: 'Revenue Share' })).rejects.toThrow(
        'Failed to create offering'
      );
      expect(mockPool.query).toHaveBeenCalledTimes(1);
    });

    it('propagates the driver error verbatim instead of swallowing it', async () => {
      const uniqueViolation = Object.assign(
        new Error('duplicate key value violates unique constraint "offerings_pkey"'),
        { code: '23505' }
      );
      mockPool.query.mockRejectedValueOnce(uniqueViolation);

      await expect(repository.create({ title: 'Dup' })).rejects.toBe(uniqueViolation);
    });

    it('applies the sanitizer contract it advertises (trim + length cap)', async () => {
      mockPool.query.mockResolvedValueOnce(rowsResult([{ id: 'off-trim' }], 'INSERT'));

      await repository.create({ title: `  ${'x'.repeat(2000)}  ` });

      const passedValues = mockPool.query.mock.calls[0][1] as unknown[];
      expect(passedValues).toHaveLength(1);
      expect(passedValues[0]).toHaveLength(1000);
    });
  });

  describe('getById()/findById() — misses and failures', () => {
    it('returns null (not undefined) when the row is missing', async () => {
      mockPool.query.mockResolvedValue(emptyResult());

      await expect(repository.getById('missing')).resolves.toBeNull();
      await expect(repository.findById('missing')).resolves.toBeNull();
      await expect(repository.listAll()).resolves.toEqual([]);
    });

    it('propagates a connection error rather than reporting a miss', async () => {
      const connectionError = new Error('Connection terminated unexpectedly');
      mockPool.query.mockRejectedValue(connectionError);

      await expect(repository.getById('off-1')).rejects.toBe(connectionError);
    });
  });

  describe('findByContractAddress()', () => {
    it('returns null when the contract address is unknown', async () => {
      mockPool.query.mockResolvedValueOnce(emptyResult());

      await expect(repository.findByContractAddress('CUNKNOWN')).resolves.toBeNull();
    });

    it('returns the mapped offering when the address matches', async () => {
      mockPool.query.mockResolvedValueOnce(
        rowsResult([{ id: 'off-7', issuer_user_id: 'issuer-7', status: 'open' }])
      );

      const found = await repository.findByContractAddress('CABC');

      expect(found?.id).toBe('off-7');
      expect(found?.issuer_id).toBe('issuer-7');
    });
  });

  describe('update()/updateStatus() — empty and rejected writes', () => {
    it('returns the current row for an empty payload (documented no-op)', async () => {
      mockPool.query.mockResolvedValueOnce(rowsResult([{ id: 'off-4', status: 'draft' }]));

      const updated = await repository.update('off-4', {});

      expect(updated?.id).toBe('off-4');
      expect(mockPool.query).toHaveBeenCalledTimes(1);
    });

    it('returns null for an empty payload when the row has since disappeared', async () => {
      mockPool.query.mockResolvedValueOnce(emptyResult());

      await expect(repository.update('gone', {})).resolves.toBeNull();
      expect(mockPool.query).toHaveBeenCalledTimes(1);
    });

    it('returns null when UPDATE matches no rows', async () => {
      mockPool.query.mockResolvedValueOnce(emptyResult('UPDATE'));

      await expect(repository.update('gone', { title: 'Nope' })).resolves.toBeNull();
    });

    it('returns null when updateStatus matches no rows', async () => {
      mockPool.query.mockResolvedValueOnce(emptyResult('UPDATE'));

      await expect(repository.updateStatus('gone', 'closed')).resolves.toBeNull();
    });

    it('propagates an UPDATE failure from either entrypoint', async () => {
      const writeError = new Error('could not serialize access due to concurrent update');
      mockPool.query.mockRejectedValueOnce(writeError);
      await expect(repository.update('off-1', { title: 'x' })).rejects.toBe(writeError);

      mockPool.query.mockRejectedValueOnce(writeError);
      await expect(repository.updateStatus('off-1', 'closed')).rejects.toBe(writeError);
    });

    it('treats a null cap as an explicit write rather than an absent field', async () => {
      mockPool.query.mockResolvedValueOnce(rowsResult([{ id: 'off-5' }], 'UPDATE'));

      await repository.updateState('off-5', { max_investor_share_bps: null });

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('max_investor_share_bps = $1'),
        [null, 'off-5']
      );
    });

    it('delegates an empty updateState payload to the no-op read path', async () => {
      mockPool.query.mockResolvedValueOnce(rowsResult([{ id: 'off-5', status: 'open' }]));

      const updated = await repository.updateState('off-5', {});

      expect(updated?.id).toBe('off-5');
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('WHERE id = $1'),
        ['off-5']
      );
    });
  });

  describe('isOwner() — missing rows never throw', () => {
    it('returns false when the offering does not exist', async () => {
      mockPool.query.mockResolvedValueOnce(emptyResult());

      await expect(repository.isOwner('gone', 'issuer-1')).resolves.toBe(false);
    });

    it('falls back to issuer_user_id when issuer_id is absent', async () => {
      mockPool.query.mockResolvedValueOnce(rowsResult([{ id: 'off-9', issuer_user_id: 'issuer-9' }]));

      await expect(repository.isOwner('off-9', 'issuer-9')).resolves.toBe(true);
      await expect(repository.isOwner('off-9', 'someone-else')).resolves.toBe(false);
    });

    it('prefers the explicit issuer_id when both columns are present', async () => {
      mockPool.query.mockResolvedValue(
        rowsResult([{ id: 'off-10', issuer_id: 'issuer-a', issuer_user_id: 'issuer-b' }])
      );

      await expect(repository.isOwner('off-10', 'issuer-a')).resolves.toBe(true);
      await expect(repository.isOwner('off-10', 'issuer-b')).resolves.toBe(false);
    });
  });

  describe('listCatalog() — boundaries', () => {
    it('short-circuits an empty status list without querying', async () => {
      await expect(repository.listCatalog({ statuses: [] })).resolves.toEqual([]);
      expect(mockPool.query).not.toHaveBeenCalled();
    });

    it('defaults to active + completed with a bounded page', async () => {
      mockPool.query.mockResolvedValueOnce(rowsResult([]));

      await repository.listCatalog();

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('WHERE status IN ($1, $2)'),
        ['active', 'completed', 10, 0]
      );
    });

    it('preserves caller-supplied statuses, limit and offset', async () => {
      mockPool.query.mockResolvedValueOnce(rowsResult([]));

      await repository.listCatalog({ statuses: ['draft'], limit: 5, offset: 20 });

      expect(mockPool.query).toHaveBeenCalledWith(expect.stringContaining('LIMIT $2 OFFSET $3'), [
        'draft',
        5,
        20,
      ]);
    });
  });

  describe('listByIssuer() — optional filters', () => {
    it('omits LIMIT/OFFSET when no filters are supplied', async () => {
      mockPool.query.mockResolvedValueOnce(rowsResult([]));

      await repository.listByIssuer('issuer-1');

      const [query, values] = mockPool.query.mock.calls[0] as [string, unknown[]];
      expect(query).not.toContain('LIMIT');
      expect(query).not.toContain('OFFSET');
      expect(values).toEqual(['issuer-1']);
    });

    it('appends status, limit and offset in that order', async () => {
      mockPool.query.mockResolvedValueOnce(rowsResult([]));

      await repository.listByIssuer('issuer-1', { status: 'open', limit: 3, offset: 6 });

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('AND status = $2'),
        ['issuer-1', 'open', 3, 6]
      );
    });
  });
});
