import { Pool, QueryResult } from 'pg';
import {
  RetentionLabel,
  RetentionLabelRepository,
} from './retentionLabelRepository';

/**
 * Regression coverage for the failure/empty-result paths of
 * RetentionLabelRepository (issue: RetentionPendingAction failure handling).
 *
 * The repository is deliberately thin: it maps rows and turns "no row returned"
 * into either `null` (reads) or a thrown Error (state transitions). Silent
 * behaviour changes here would let legal holds be proposed/approved/released
 * against a period that does not exist, so the error contract is pinned.
 */
describe('RetentionLabelRepository', () => {
  let repository: RetentionLabelRepository;
  let mockPool: { query: jest.Mock };

  const dbRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    period_id: 'period-1',
    legal_hold: false,
    reason: null,
    pending_action: null,
    pending_proposed_by: null,
    pending_proposed_at: null,
    activated_by: null,
    activated_at: null,
    released_by: null,
    released_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-02T00:00:00.000Z',
    ...overrides,
  });

  const result = (rows: Record<string, unknown>[]): QueryResult<RetentionLabel> =>
    ({ rows, rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] }) as unknown as QueryResult<RetentionLabel>;

  beforeEach(() => {
    mockPool = { query: jest.fn() };
    repository = new RetentionLabelRepository(mockPool as unknown as Pool);
  });

  describe('findByPeriodId', () => {
    it('returns null when no retention label exists for the period', async () => {
      mockPool.query.mockResolvedValueOnce(result([]));

      const found = await repository.findByPeriodId('missing-period');

      expect(found).toBeNull();
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('FROM retention_labels WHERE period_id = $1'),
        ['missing-period'],
      );
    });

    it('maps a found row, coercing timestamps and preserving nulls', async () => {
      mockPool.query.mockResolvedValueOnce(
        result([
          dbRow({
            legal_hold: true,
            reason: 'audit hold',
            pending_action: 'remove',
            activated_at: '2026-02-03T04:05:06.000Z',
          }),
        ]),
      );

      const found = await repository.findByPeriodId('period-1');

      expect(found).not.toBeNull();
      expect(found).toMatchObject({
        period_id: 'period-1',
        legal_hold: true,
        reason: 'audit hold',
        pending_action: 'remove',
        activated_at: new Date('2026-02-03T04:05:06.000Z'),
        created_at: new Date('2026-01-01T00:00:00.000Z'),
      });
      expect(found!.pending_proposed_at).toBeNull();
      expect(found!.released_at).toBeNull();
    });
  });

  describe('listActiveHolds', () => {
    it('returns an empty array when no holds are active', async () => {
      mockPool.query.mockResolvedValueOnce(result([]));

      await expect(repository.listActiveHolds()).resolves.toEqual([]);
    });

    it('maps every active hold row', async () => {
      mockPool.query.mockResolvedValueOnce(
        result([
          dbRow({ period_id: 'a', legal_hold: true }),
          dbRow({ period_id: 'b', legal_hold: true }),
        ]),
      );

      const holds = await repository.listActiveHolds();

      expect(holds.map((h) => h.period_id)).toEqual(['a', 'b']);
      expect(holds.every((h) => h.legal_hold === true)).toBe(true);
    });
  });

  describe('upsertProposeAdd', () => {
    it('defaults a missing reason to null and returns the proposed row', async () => {
      mockPool.query.mockResolvedValueOnce(
        result([dbRow({ pending_action: 'add', pending_proposed_by: 'actor-1' })]),
      );

      const proposed = await repository.upsertProposeAdd({
        periodId: 'period-1',
        actorId: 'actor-1',
      });

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO retention_labels'),
        ['period-1', null, 'actor-1'],
      );
      expect(proposed.pending_action).toBe('add');
      expect(proposed.pending_proposed_by).toBe('actor-1');
    });

    it('forwards an explicit reason', async () => {
      mockPool.query.mockResolvedValueOnce(
        result([dbRow({ pending_action: 'add', reason: 'regulator request' })]),
      );

      await repository.upsertProposeAdd({
        periodId: 'period-1',
        actorId: 'actor-1',
        reason: 'regulator request',
      });

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO retention_labels'),
        ['period-1', 'regulator request', 'actor-1'],
      );
    });
  });

  describe('approveAdd', () => {
    it('throws the not-found error contract when no row is updated', async () => {
      mockPool.query.mockResolvedValueOnce(result([]));

      await expect(
        repository.approveAdd({ periodId: 'period-x', actorId: 'actor-1' }),
      ).rejects.toThrow('Retention label not found for period period-x');
    });

    it('returns the activated row on success', async () => {
      mockPool.query.mockResolvedValueOnce(
        result([dbRow({ legal_hold: true, activated_by: 'actor-1' })]),
      );

      const activated = await repository.approveAdd({
        periodId: 'period-1',
        actorId: 'actor-1',
      });

      expect(activated.legal_hold).toBe(true);
      expect(activated.activated_by).toBe('actor-1');
    });
  });

  describe('proposeRemove', () => {
    it('throws the not-found error contract when no row is updated', async () => {
      mockPool.query.mockResolvedValueOnce(result([]));

      await expect(
        repository.proposeRemove({ periodId: 'period-x', actorId: 'actor-1' }),
      ).rejects.toThrow('Retention label not found for period period-x');
    });

    it('returns the row marked for removal', async () => {
      mockPool.query.mockResolvedValueOnce(
        result([dbRow({ legal_hold: true, pending_action: 'remove' })]),
      );

      const proposed = await repository.proposeRemove({
        periodId: 'period-1',
        actorId: 'actor-1',
      });

      expect(proposed.pending_action).toBe('remove');
    });
  });

  describe('approveRemove', () => {
    it('throws the not-found error contract when no row is updated', async () => {
      mockPool.query.mockResolvedValueOnce(result([]));

      await expect(
        repository.approveRemove({ periodId: 'period-x', actorId: 'actor-1' }),
      ).rejects.toThrow('Retention label not found for period period-x');
    });

    it('returns the released row on success', async () => {
      mockPool.query.mockResolvedValueOnce(
        result([
          dbRow({
            legal_hold: false,
            released_by: 'actor-2',
            released_at: '2026-03-04T05:06:07.000Z',
          }),
        ]),
      );

      const released = await repository.approveRemove({
        periodId: 'period-1',
        actorId: 'actor-2',
      });

      expect(released.legal_hold).toBe(false);
      expect(released.released_by).toBe('actor-2');
      expect(released.released_at).toEqual(new Date('2026-03-04T05:06:07.000Z'));
    });
  });
});
