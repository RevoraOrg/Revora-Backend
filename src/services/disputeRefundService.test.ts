import { Pool } from 'pg';
import { DisputeRefundService } from './disputeRefundService';
import { closePool } from '../db/client';
import { Decimal } from '../lib/decimal';

describe('DisputeRefundService', () => {
  let db: Pool;
  let client: { query: jest.Mock; release: jest.Mock };
  let service: DisputeRefundService;
  const payouts = [
    { investor_id: 'investor-1', amount: '1.0000000000' },
    { investor_id: 'investor-2', amount: '1.0000000000' },
    { investor_id: 'investor-3', amount: '1.0000000000' },
  ];

  beforeEach(() => {
    client = {
      query: jest.fn(async (query: string) => {
        if (query.includes('SELECT total_amount')) return { rows: [{ total_amount: '3.0000000000' }] };
        if (query.includes('SELECT COALESCE(SUM(amount)')) return { rows: [{ total: '0.0000' }] };
        if (query.includes('FROM distribution_payouts')) return { rows: payouts };
        if (query.includes('INSERT INTO dispute_refunds')) {
          return { rows: [{ id: 'refund-1', dispute_id: 'dispute-1', amount: '1.0000' }] };
        }
        if (query.includes('INSERT INTO dispute_ledger_events')) {
          return { rows: [{ id: 'event-1' }, { id: 'event-2' }, { id: 'event-3' }] };
        }
        return { rows: [] };
      }),
      release: jest.fn(),
    };
    db = {
      query: jest.fn(),
      connect: jest.fn().mockResolvedValue(client),
    } as unknown as Pool;
    service = new DisputeRefundService(db);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  afterAll(async () => {
    await closePool();
  });

  const params = {
    disputeId: 'dispute-1',
    distributionId: 'distribution-1',
    amount: '1.0000',
  };

  it('rejects non-positive and over-precision refund amounts', async () => {
    await expect(service.processPartialRefund({ ...params, amount: '0' }))
      .rejects.toThrow('Refund amount must be a positive number');
    await expect(service.processPartialRefund({ ...params, amount: '0.00001' }))
      .rejects.toThrow('Refund amount must not exceed 4 decimal places');
    expect(db.connect).not.toHaveBeenCalled();
  });

  it('rejects refunds exceeding the server-side distribution total', async () => {
    client.query.mockImplementation(async (query: string) => {
      if (query.includes('SELECT total_amount')) return { rows: [{ total_amount: '100.0000000000' }] };
      if (query.includes('SELECT COALESCE(SUM(amount)')) return { rows: [{ total: '90.0000' }] };
      return { rows: [] };
    });

    await expect(service.processPartialRefund({ ...params, amount: '10.0001' }))
      .rejects.toThrow(/cannot exceed original disbursement/);

    expect(client.query).toHaveBeenCalledWith('SELECT pg_advisory_xact_lock(hashtext($1))', ['dispute-1']);
    expect(client.query.mock.calls.some(([query]) => String(query).includes('INSERT INTO dispute_refunds'))).toBe(false);
    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
  });

  it('serializes cap reads inside the transaction and allocates exact reversals with largest remainders', async () => {
    const refund = await service.processPartialRefund({ ...params, amount: '1.0000' });

    expect(refund.id).toBe('refund-1');
    const lockIndex = client.query.mock.calls.findIndex(([query]) =>
      String(query).includes('pg_advisory_xact_lock'));
    const totalIndex = client.query.mock.calls.findIndex(([query]) =>
      String(query).includes('SELECT total_amount'));
    const sumIndex = client.query.mock.calls.findIndex(([query]) =>
      String(query).includes('SELECT COALESCE(SUM(amount)'));
    expect(lockIndex).toBeGreaterThan(0);
    expect(totalIndex).toBeGreaterThan(lockIndex);
    expect(sumIndex).toBeGreaterThan(totalIndex);

    const eventInsert = client.query.mock.calls.find(([query]) =>
      String(query).includes('INSERT INTO dispute_ledger_events'));
    const eventValues = eventInsert[1] as string[];
    const reversals = eventValues.filter((_, index) => index % 4 === 2);
    expect(reversals.filter((value) => value === '-0.3334')).toHaveLength(1);
    expect(reversals.filter((value) => value === '-0.3333')).toHaveLength(2);
    const exactTotal = reversals.reduce((sum, amount) => sum.add(new Decimal(amount)), new Decimal('0'));
    expect(exactTotal.toString()).toBe('-1.0000');
  });

  it('rolls back when there are no payouts to reverse', async () => {
    client.query.mockImplementation(async (query: string) => {
      if (query.includes('SELECT total_amount')) return { rows: [{ total_amount: '3.0000000000' }] };
      if (query.includes('SELECT COALESCE(SUM(amount)')) return { rows: [{ total: '0' }] };
      if (query.includes('FROM distribution_payouts')) return { rows: [] };
      return { rows: [] };
    });

    await expect(service.processPartialRefund(params)).rejects.toThrow('Distribution has no payouts to reverse');
    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
  });
});
