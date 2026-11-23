/**
 * Failure-handling regression suite for InvestmentLotRepository.
 *
 * The happy paths are covered in `investmentLotRepository.test.ts`. This file
 * pins the *failure* contract the tax/cost-basis flow depends on:
 *
 * - `create`                 -> `throw new Error('Failed to create investment lot')`   (line 68)
 * - `createWithClient`       -> `throw new Error('Failed to create investment lot')`   (line 106)
 * - `updateLotAfterDisposal` -> `throw new Error('Failed to update lot ...')`          (line 222)
 *
 * ...plus the neighbouring behaviour those branches rely on: driver errors must
 * propagate with their identity intact (no swallowing, no wrapping, no retry),
 * a failing write must not take transaction-control actions on the caller-owned
 * client, and the parameter array must still be correct on the failing call.
 */

import { Pool, PoolClient } from 'pg';
import { InvestmentLotRepository } from './investmentLotRepository';

type MockClient = PoolClient & { query: jest.Mock; release: jest.Mock };

function makeRepository(queryMock: jest.Mock): InvestmentLotRepository {
  return new InvestmentLotRepository({ query: queryMock } as unknown as Pool);
}

function makeClient(queryMock: jest.Mock): MockClient {
  return { query: queryMock, release: jest.fn() } as unknown as MockClient;
}

function result(rows: unknown[]): { rows: unknown[]; rowCount: number; command: string; oid: number; fields: never[] } {
  return { rows, rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] };
}

function makeInput(override: Record<string, unknown> = {}) {
  return {
    investor_id: 'inv-1',
    offering_id: 'off-1',
    investment_id: 'invst-1',
    asset: 'USDC',
    quantity: 12.5,
    cost_basis_per_unit: 4,
    acquired_at: new Date('2024-01-01T00:00:00.000Z'),
    ...override,
  } as Parameters<InvestmentLotRepository['create']>[0];
}

function makeLotRow(override: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'lot-1',
    investor_id: 'inv-1',
    offering_id: 'off-1',
    investment_id: 'invst-1',
    asset: 'USDC',
    quantity: '12.5',
    cost_basis_per_unit: '4',
    total_cost_basis: '50',
    remaining_quantity: '12.5',
    cost_currency: 'USD',
    acquired_at: new Date('2024-01-01T00:00:00.000Z'),
    jurisdiction: 'US',
    status: 'open',
    created_at: new Date('2024-01-01T00:00:00.000Z'),
    updated_at: new Date('2024-01-01T00:00:00.000Z'),
    ...override,
  };
}

describe('InvestmentLotRepository failure handling', () => {
  describe('create', () => {
    it('throws the exact contract error when the insert returns no rows', async () => {
      const query = jest.fn().mockResolvedValue(result([]));
      const repo = makeRepository(query);

      await expect(repo.create(makeInput())).rejects.toThrow(
        new Error('Failed to create investment lot'),
      );
      expect(query).toHaveBeenCalledTimes(1);
    });

    it('propagates the driver error unchanged and never retries', async () => {
      const driverError = new Error('connection terminated unexpectedly');
      const query = jest.fn().mockRejectedValue(driverError);
      const repo = makeRepository(query);

      await expect(repo.create(makeInput())).rejects.toBe(driverError);
      expect(query).toHaveBeenCalledTimes(1);
    });

    it('sends the full parameter array even on the failing call', async () => {
      const driverError = new Error('deadlock detected');
      const query = jest.fn().mockRejectedValue(driverError);
      const repo = makeRepository(query);

      await expect(repo.create(makeInput())).rejects.toBe(driverError);

      const [sql, params] = query.mock.calls[0];
      expect(sql).toContain('INSERT INTO investment_lots');
      expect(params).toHaveLength(11);
      expect(params[0]).toBe('inv-1');
      expect(params[1]).toBe('off-1');
      expect(params[2]).toBe('invst-1');
      expect(params[3]).toBe('USDC');
      expect(params[4]).toBe('12.5');
      expect(params[5]).toBe('4');
      expect(params[6]).toBe('50'); // quantity * cost_basis_per_unit
      expect(params[7]).toBe('12.5'); // remaining_quantity mirrors quantity
      expect(params[8]).toBe('USD');
      expect(params[9]).toEqual(new Date('2024-01-01T00:00:00.000Z'));
      expect(params[10]).toBe('US');
    });

    it('handles zero-quantity boundary input before failing on an empty insert', async () => {
      const query = jest.fn().mockResolvedValue(result([]));
      const repo = makeRepository(query);

      await expect(
        repo.create(makeInput({ quantity: 0, cost_basis_per_unit: 0 })),
      ).rejects.toThrow('Failed to create investment lot');

      const [, params] = query.mock.calls[0];
      expect(params[4]).toBe('0');
      expect(params[6]).toBe('0');
      expect(params[7]).toBe('0');
    });

    it('falls back to the USD/US defaults on the timeout path', async () => {
      const driverError = new Error('query read timeout');
      const query = jest.fn().mockRejectedValue(driverError);
      const repo = makeRepository(query);

      await expect(
        repo.create(makeInput({ cost_currency: undefined, jurisdiction: undefined })),
      ).rejects.toBe(driverError);

      const [, params] = query.mock.calls[0];
      expect(params[8]).toBe('USD');
      expect(params[10]).toBe('US');
    });
  });

  describe('createWithClient', () => {
    it('throws the exact contract error when the transactional insert returns no rows', async () => {
      // The second `throw new Error('Failed to create investment lot')` branch
      // (line 106), which the existing suite never reaches.
      const client = makeClient(jest.fn().mockResolvedValue(result([])));
      const repo = makeRepository(jest.fn());

      await expect(repo.createWithClient(client, makeInput())).rejects.toThrow(
        new Error('Failed to create investment lot'),
      );
      expect(client.query).toHaveBeenCalledTimes(1);
    });

    it('propagates the driver error unchanged', async () => {
      const driverError = new Error('current transaction is aborted');
      const client = makeClient(jest.fn().mockRejectedValue(driverError));
      const repo = makeRepository(jest.fn());

      await expect(repo.createWithClient(client, makeInput())).rejects.toBe(driverError);
    });

    it('never releases or rolls back the caller-owned client on failure', async () => {
      const client = makeClient(jest.fn().mockResolvedValue(result([])));
      const repo = makeRepository(jest.fn());

      await expect(repo.createWithClient(client, makeInput())).rejects.toThrow();

      expect(client.query.mock.calls[0][0]).toContain('INSERT INTO investment_lots');
      expect(client.query.mock.calls[0][0]).not.toMatch(/ROLLBACK|COMMIT/i);
      expect(client.release).not.toHaveBeenCalled();
    });

    it('uses the same 11-parameter contract as the pooled create', async () => {
      const driverError = new Error('could not serialize access');
      const client = makeClient(jest.fn().mockRejectedValue(driverError));
      const repo = makeRepository(jest.fn());

      await expect(
        repo.createWithClient(client, makeInput({ quantity: 2, cost_basis_per_unit: 3 })),
      ).rejects.toBe(driverError);

      const [, params] = client.query.mock.calls[0];
      expect(params).toHaveLength(11);
      expect(params[6]).toBe('6');
      expect(params[8]).toBe('USD');
      expect(params[10]).toBe('US');
    });
  });

  describe('updateLotAfterDisposal', () => {
    it('throws the exact contract error naming the missing lot', async () => {
      const client = makeClient(jest.fn().mockResolvedValue(result([])));
      const repo = makeRepository(jest.fn());

      await expect(
        repo.updateLotAfterDisposal(client, 'lot-missing', 0),
      ).rejects.toThrow(new Error('Failed to update lot lot-missing after disposal'));
      expect(client.release).not.toHaveBeenCalled();
    });

    it('propagates the driver error unchanged and never retries', async () => {
      const driverError = new Error('deadlock detected');
      const client = makeClient(jest.fn().mockRejectedValue(driverError));
      const repo = makeRepository(jest.fn());

      await expect(repo.updateLotAfterDisposal(client, 'lot-1', 5)).rejects.toBe(
        driverError,
      );
      expect(client.query).toHaveBeenCalledTimes(1);
    });

    it('sends the status and quantity parameters even when the update fails', async () => {
      const driverError = new Error('lock timeout');
      const client = makeClient(jest.fn().mockRejectedValue(driverError));
      const repo = makeRepository(jest.fn());

      await expect(repo.updateLotAfterDisposal(client, 'lot-9', 0)).rejects.toBe(
        driverError,
      );

      const [sql, params] = client.query.mock.calls[0];
      expect(sql).toContain('UPDATE investment_lots');
      expect(params).toEqual(['0', 'exhausted', 'lot-9']);
    });

    it('treats an over-consumed (negative) remainder as exhausted', async () => {
      const client = makeClient(jest.fn().mockResolvedValue(result([{ id: 'lot-1' }])));
      const repo = makeRepository(jest.fn());

      await repo.updateLotAfterDisposal(client, 'lot-1', -3);

      const [, params] = client.query.mock.calls[0];
      expect(params[0]).toBe('-3');
      expect(params[1]).toBe('exhausted');
    });

    it('keeps a positive remainder as partially_used', async () => {
      const client = makeClient(jest.fn().mockResolvedValue(result([{ id: 'lot-1' }])));
      const repo = makeRepository(jest.fn());

      await repo.updateLotAfterDisposal(client, 'lot-1', 0.5);

      const [, params] = client.query.mock.calls[0];
      expect(params[0]).toBe('0.5');
      expect(params[1]).toBe('partially_used');
    });
  });

  describe('findByInvestorOfferingAndDateRange', () => {
    it('maps rows and forwards the window parameters in order', async () => {
      const client = makeClient(
        jest
          .fn()
          .mockResolvedValue(result([makeLotRow({ id: 'lot-a' }), makeLotRow({ id: 'lot-b' })])),
      );
      const repo = makeRepository(jest.fn());
      const start = new Date('2024-01-01T00:00:00.000Z');
      const end = new Date('2024-02-01T00:00:00.000Z');

      const lots = await repo.findByInvestorOfferingAndDateRange(
        client,
        'inv-1',
        'off-1',
        start,
        end,
      );

      expect(lots.map((lot) => lot.id)).toEqual(['lot-a', 'lot-b']);
      const [sql, params] = client.query.mock.calls[0];
      expect(sql).toContain('acquired_at >=');
      expect(params).toEqual(['inv-1', 'off-1', start, end]);
    });

    it('returns an empty array when the window contains no lots', async () => {
      const client = makeClient(jest.fn().mockResolvedValue(result([])));
      const repo = makeRepository(jest.fn());

      await expect(
        repo.findByInvestorOfferingAndDateRange(
          client,
          'inv-1',
          'off-1',
          new Date('2024-01-01T00:00:00.000Z'),
          new Date('2024-02-01T00:00:00.000Z'),
        ),
      ).resolves.toEqual([]);
    });

    it('propagates driver errors unchanged', async () => {
      const driverError = new Error('read replica unavailable');
      const client = makeClient(jest.fn().mockRejectedValue(driverError));
      const repo = makeRepository(jest.fn());

      await expect(
        repo.findByInvestorOfferingAndDateRange(
          client,
          'inv-1',
          'off-1',
          new Date('2024-01-01T00:00:00.000Z'),
          new Date('2024-02-01T00:00:00.000Z'),
        ),
      ).rejects.toBe(driverError);
    });
  });

  describe('read paths', () => {
    it('findAvailableLots propagates driver errors unchanged', async () => {
      const driverError = new Error('relation "investment_lots" does not exist');
      const query = jest.fn().mockRejectedValue(driverError);
      const repo = makeRepository(query);

      await expect(repo.findAvailableLots('inv-1', 'off-1')).rejects.toBe(driverError);
      expect(query).toHaveBeenCalledTimes(1);
    });

    it('findAvailableLotsForUpdate propagates driver errors without releasing the client', async () => {
      const driverError = new Error('could not obtain lock');
      const client = makeClient(jest.fn().mockRejectedValue(driverError));
      const repo = makeRepository(jest.fn());

      await expect(
        repo.findAvailableLotsForUpdate(client, 'inv-1', 'off-1'),
      ).rejects.toBe(driverError);
      expect(client.release).not.toHaveBeenCalled();
    });

    it('listByInvestor propagates driver errors unchanged', async () => {
      const driverError = new Error('statement timeout');
      const query = jest.fn().mockRejectedValue(driverError);
      const repo = makeRepository(query);

      await expect(repo.listByInvestor('inv-1')).rejects.toBe(driverError);
    });

    it('getTotalRemainingQuantity returns 0 when the aggregate returns no rows', async () => {
      const query = jest.fn().mockResolvedValue(result([]));
      const repo = makeRepository(query);

      await expect(repo.getTotalRemainingQuantity('inv-1', 'off-1')).resolves.toBe(0);
    });

    it('getTotalRemainingQuantity propagates driver errors unchanged', async () => {
      const driverError = new Error('connection closed');
      const query = jest.fn().mockRejectedValue(driverError);
      const repo = makeRepository(query);

      await expect(repo.getTotalRemainingQuantity('inv-1', 'off-1')).rejects.toBe(
        driverError,
      );
    });

    it('findById propagates driver errors instead of reporting "not found"', async () => {
      const driverError = new Error('too many connections');
      const query = jest.fn().mockRejectedValue(driverError);
      const repo = makeRepository(query);

      // A database outage must not be silently converted into `null`.
      await expect(repo.findById('lot-1')).rejects.toBe(driverError);
    });
  });
});
