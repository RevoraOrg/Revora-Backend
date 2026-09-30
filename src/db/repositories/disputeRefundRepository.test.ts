import type { Pool, QueryResult } from 'pg';

import {
  DisputeRefund,
  DisputeRefundRepository,
} from './disputeRefundRepository';

function queryResult<T>(rows: T[]): QueryResult<T> {
  return {
    command: 'SELECT',
    rowCount: rows.length,
    oid: 0,
    fields: [],
    rows,
  };
}

describe('DisputeRefundRepository', () => {
  const createdAt = new Date('2026-09-30T00:00:00.000Z');
  const refund: DisputeRefund = {
    id: 'refund-1',
    dispute_id: 'dispute-1',
    amount: '125.50',
    reason: 'Duplicate debit',
    ledger_event_id: 'ledger-event-1',
    created_at: createdAt,
  };

  let query: jest.MockedFunction<Pool['query']>;
  let repository: DisputeRefundRepository;

  beforeEach(() => {
    query = jest.fn();
    repository = new DisputeRefundRepository({ query } as unknown as Pool);
  });

  describe('create', () => {
    it('inserts the refund and returns the persisted row', async () => {
      query.mockResolvedValue(queryResult([refund]));

      const result = await repository.create({
        dispute_id: refund.dispute_id,
        amount: refund.amount,
        reason: refund.reason,
        ledger_event_id: refund.ledger_event_id,
      });

      expect(result).toEqual(refund);
      expect(query).toHaveBeenCalledWith(
        expect.stringMatching(/INSERT INTO dispute_refunds/),
        ['dispute-1', '125.50', 'Duplicate debit', 'ledger-event-1'],
      );
    });

    it('preserves nullable reason and ledger event values', async () => {
      const nullableRefund = { ...refund, reason: null, ledger_event_id: null };
      query.mockResolvedValue(queryResult([nullableRefund]));

      await expect(
        repository.create({
          dispute_id: 'dispute-1',
          amount: '0.01',
          reason: null,
          ledger_event_id: null,
        }),
      ).resolves.toEqual(nullableRefund);
      expect(query).toHaveBeenCalledWith(expect.any(String), [
        'dispute-1',
        '0.01',
        null,
        null,
      ]);
    });

    it('propagates database rejection of an invalid amount without masking it', async () => {
      const constraintError = new Error('invalid input syntax for type numeric');
      query.mockRejectedValue(constraintError);

      await expect(
        repository.create({
          dispute_id: 'dispute-1',
          amount: 'not-a-number',
          reason: null,
          ledger_event_id: null,
        }),
      ).rejects.toBe(constraintError);
    });
  });

  describe('sumRefundsForDispute', () => {
    it('converts the PostgreSQL numeric total to a number', async () => {
      query.mockResolvedValue(queryResult([{ total: '150.75' }]));

      await expect(repository.sumRefundsForDispute('dispute-1')).resolves.toBe(150.75);
      expect(query).toHaveBeenCalledWith(
        expect.stringMatching(/COALESCE\(SUM\(amount\), 0\)/),
        ['dispute-1'],
      );
    });

    it('returns zero when the dispute has no refunds', async () => {
      query.mockResolvedValue(queryResult([{ total: '0' }]));

      await expect(repository.sumRefundsForDispute('missing-dispute')).resolves.toBe(0);
    });

    it('propagates query failures', async () => {
      const error = new Error('database unavailable');
      query.mockRejectedValue(error);

      await expect(repository.sumRefundsForDispute('dispute-1')).rejects.toBe(error);
    });
  });

  describe('listByDispute', () => {
    it('returns every refund in the database-provided chronological order', async () => {
      const second = {
        ...refund,
        id: 'refund-2',
        created_at: new Date('2026-09-30T00:01:00.000Z'),
      };
      query.mockResolvedValue(queryResult([refund, second]));

      await expect(repository.listByDispute('dispute-1')).resolves.toEqual([refund, second]);
      expect(query).toHaveBeenCalledWith(
        expect.stringMatching(/ORDER BY created_at ASC/),
        ['dispute-1'],
      );
    });

    it('returns an empty list for an unknown dispute', async () => {
      query.mockResolvedValue(queryResult([]));

      await expect(repository.listByDispute('missing-dispute')).resolves.toEqual([]);
    });

    it('propagates query failures without returning partial state', async () => {
      const error = new Error('read failed');
      query.mockRejectedValue(error);

      await expect(repository.listByDispute('dispute-1')).rejects.toBe(error);
    });
  });
});
