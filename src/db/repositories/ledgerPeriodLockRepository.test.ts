import { Pool, QueryResult } from 'pg';
import {
  ConfirmLedgerPeriodLockInput,
  LedgerPeriodLock,
  LedgerPeriodLockRepository,
} from './ledgerPeriodLockRepository';

/**
 * Regression coverage for the failure/empty-result paths of
 * LedgerPeriodLockRepository (issue: LedgerPeriodLock failure handling).
 *
 * The repository enforces dual-control period close. The failure branches
 * (empty INSERT ... RETURNING, unique-constraint violation, missing lock,
 * same-actor confirmation, wrong status, empty UPDATE ... RETURNING, empty
 * metadata read) must stay observable and deterministic so a silent change
 * cannot turn a rejected close into a "locked" period.
 */
describe('LedgerPeriodLockRepository', () => {
  let repository: LedgerPeriodLockRepository;
  let mockPool: { query: jest.Mock };

  const lockRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 'lock-1',
    period_id: 'period-1',
    offering_id: 'offering-1',
    status: 'initiated',
    initiated_by: 'initiator-1',
    initiated_at: new Date('2026-01-01T00:00:00.000Z'),
    confirmed_by: null,
    confirmed_at: null,
    locked_at: null,
    export_format: 'jsonl',
    export_reference: null,
    export_hash: null,
    export_signature: null,
    signing_algorithm: 'ed25519',
    signing_key_version: 1,
    entry_count: null,
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    updated_at: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  });

  const result = (rows: Record<string, unknown>[]): QueryResult<LedgerPeriodLock> =>
    ({ rows, rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] }) as unknown as QueryResult<LedgerPeriodLock>;

  const confirmInput = (
    overrides: Partial<ConfirmLedgerPeriodLockInput> = {},
  ): ConfirmLedgerPeriodLockInput => ({
    export_reference: 'ref-1',
    export_hash: 'hash-1',
    export_signature: 'sig-1',
    signing_algorithm: 'ed25519',
    signing_key_version: 1,
    entry_count: 3,
    confirmed_by: 'confirmer-1',
    ...overrides,
  });

  beforeEach(() => {
    mockPool = { query: jest.fn() };
    repository = new LedgerPeriodLockRepository(mockPool as unknown as Pool);
  });

  describe('initiatePeriodClose', () => {
    it('defaults the export format to jsonl and returns the initiated lock', async () => {
      mockPool.query.mockResolvedValueOnce(result([lockRow()]));

      const lock = await repository.initiatePeriodClose({
        period_id: 'period-1',
        offering_id: 'offering-1',
        initiated_by: 'initiator-1',
      });

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO ledger_period_locks'),
        ['period-1', 'offering-1', 'initiator-1', 'jsonl'],
      );
      expect(lock.status).toBe('initiated');
      expect(lock.id).toBe('lock-1');
    });

    it('honours an explicit export format', async () => {
      mockPool.query.mockResolvedValueOnce(result([lockRow({ export_format: 'csv' })]));

      await repository.initiatePeriodClose({
        period_id: 'period-1',
        offering_id: 'offering-1',
        initiated_by: 'initiator-1',
        export_format: 'csv',
      });

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.any(String),
        ['period-1', 'offering-1', 'initiator-1', 'csv'],
      );
    });

    it('throws when the INSERT returns no row', async () => {
      mockPool.query.mockResolvedValueOnce(result([]));

      await expect(
        repository.initiatePeriodClose({
          period_id: 'period-1',
          offering_id: 'offering-1',
          initiated_by: 'initiator-1',
        }),
      ).rejects.toThrow('Failed to initiate period close');
    });

    it('translates a unique-constraint violation into an already-locked error', async () => {
      mockPool.query.mockRejectedValueOnce(
        Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' }),
      );

      await expect(
        repository.initiatePeriodClose({
          period_id: 'period-1',
          offering_id: 'offering-1',
          initiated_by: 'initiator-1',
        }),
      ).rejects.toThrow(
        'Period period-1 for offering offering-1 is already locked or has a pending close',
      );
    });

    it('re-throws unexpected database errors unchanged', async () => {
      mockPool.query.mockRejectedValueOnce(new Error('connection reset'));

      await expect(
        repository.initiatePeriodClose({
          period_id: 'period-1',
          offering_id: 'offering-1',
          initiated_by: 'initiator-1',
        }),
      ).rejects.toThrow('connection reset');
    });

    it('executes against a provided transaction client when supplied', async () => {
      const client = { query: jest.fn().mockResolvedValueOnce(result([lockRow()])) };

      await repository.initiatePeriodClose(
        { period_id: 'period-1', offering_id: 'offering-1', initiated_by: 'initiator-1' },
        client as unknown as Pool,
      );

      expect(client.query).toHaveBeenCalledTimes(1);
      expect(mockPool.query).not.toHaveBeenCalled();
    });
  });

  describe('getInitiatedLock', () => {
    it('returns null when there is no initiated lock', async () => {
      mockPool.query.mockResolvedValueOnce(result([]));

      await expect(repository.getInitiatedLock('offering-1', 'period-1')).resolves.toBeNull();
    });

    it('returns the mapped lock when found', async () => {
      mockPool.query.mockResolvedValueOnce(result([lockRow({ status: 'initiated' })]));

      const lock = await repository.getInitiatedLock('offering-1', 'period-1');

      expect(lock?.id).toBe('lock-1');
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining("status = 'initiated'"),
        ['offering-1', 'period-1'],
      );
    });
  });

  describe('getLock', () => {
    it('returns null when the lock is absent', async () => {
      mockPool.query.mockResolvedValueOnce(result([]));

      await expect(repository.getLock('offering-1', 'period-1')).resolves.toBeNull();
    });

    it('returns the mapped lock regardless of status', async () => {
      mockPool.query.mockResolvedValueOnce(result([lockRow({ status: 'locked' })]));

      const lock = await repository.getLock('offering-1', 'period-1');

      expect(lock?.status).toBe('locked');
    });
  });

  describe('confirmPeriodClose', () => {
    it('throws when the lock cannot be found', async () => {
      mockPool.query.mockResolvedValueOnce(result([]));

      await expect(
        repository.confirmPeriodClose('lock-missing', confirmInput()),
      ).rejects.toThrow('Lock lock-missing not found');
    });

    it('rejects confirmation by the initiating actor (dual-control)', async () => {
      mockPool.query.mockResolvedValueOnce(
        result([lockRow({ initiated_by: 'initiator-1', status: 'initiated' })]),
      );

      await expect(
        repository.confirmPeriodClose('lock-1', confirmInput({ confirmed_by: 'initiator-1' })),
      ).rejects.toThrow(
        'Dual-control violation: Lock cannot be confirmed by the same actor who initiated it',
      );
    });

    it('rejects confirmation of a lock that is not in the initiated state', async () => {
      mockPool.query.mockResolvedValueOnce(result([lockRow({ status: 'locked' })]));

      await expect(
        repository.confirmPeriodClose('lock-1', confirmInput({ confirmed_by: 'confirmer-2' })),
      ).rejects.toThrow("Cannot confirm lock in 'locked' status");
    });

    it('throws when the confirmation UPDATE returns no row', async () => {
      mockPool.query
        .mockResolvedValueOnce(result([lockRow({ status: 'initiated' })]))
        .mockResolvedValueOnce(result([]));

      await expect(
        repository.confirmPeriodClose('lock-1', confirmInput()),
      ).rejects.toThrow('Failed to confirm period close');
    });

    it('returns the locked row on a successful confirmation', async () => {
      mockPool.query
        .mockResolvedValueOnce(result([lockRow({ status: 'initiated' })]))
        .mockResolvedValueOnce(
          result([
            lockRow({
              status: 'locked',
              confirmed_by: 'confirmer-1',
              export_reference: 'ref-1',
              export_hash: 'hash-1',
              entry_count: 3,
            }),
          ]),
        );

      const locked = await repository.confirmPeriodClose('lock-1', confirmInput());

      expect(locked.status).toBe('locked');
      expect(locked.confirmed_by).toBe('confirmer-1');
      expect(locked.export_hash).toBe('hash-1');
    });
  });

  describe('isPeriodLocked', () => {
    it('returns false when the period is not locked', async () => {
      mockPool.query.mockResolvedValueOnce(result([]));

      await expect(repository.isPeriodLocked('offering-1', 'period-1')).resolves.toBe(false);
    });

    it('returns true when a locked row exists', async () => {
      mockPool.query.mockResolvedValueOnce(result([lockRow({ status: 'locked' })]));

      await expect(repository.isPeriodLocked('offering-1', 'period-1')).resolves.toBe(true);
    });
  });

  describe('getLockedExportMetadata', () => {
    it('returns null when no locked export exists', async () => {
      mockPool.query.mockResolvedValueOnce(result([]));

      await expect(
        repository.getLockedExportMetadata('offering-1', 'period-1'),
      ).resolves.toBeNull();
    });

    it('returns the export metadata for a locked period', async () => {
      const lockedAt = new Date('2026-05-06T07:08:09.000Z');
      mockPool.query.mockResolvedValueOnce(
        result([
          {
            export_hash: 'hash-9',
            export_signature: 'sig-9',
            signing_algorithm: 'ed25519',
            signing_key_version: 2,
            locked_at: lockedAt,
            entry_count: 42,
          },
        ]),
      );

      const metadata = await repository.getLockedExportMetadata('offering-1', 'period-1');

      expect(metadata).toEqual({
        export_hash: 'hash-9',
        export_signature: 'sig-9',
        signing_algorithm: 'ed25519',
        signing_key_version: 2,
        locked_at: lockedAt,
        entry_count: 42,
      });
    });
  });

  describe('listLockedPeriods', () => {
    it('returns an empty list when nothing is locked', async () => {
      mockPool.query.mockResolvedValueOnce(result([]));

      await expect(repository.listLockedPeriods('offering-1')).resolves.toEqual([]);
    });

    it('maps every locked period row', async () => {
      mockPool.query.mockResolvedValueOnce(
        result([lockRow({ id: 'a', status: 'locked' }), lockRow({ id: 'b', status: 'locked' })]),
      );

      const locks = await repository.listLockedPeriods('offering-1');

      expect(locks.map((l) => l.id)).toEqual(['a', 'b']);
    });
  });
});
