import { Pool } from 'pg';
import { DisputeRefundService } from './disputeRefundService';
import { Errors, ErrorCode } from '../lib/errors';
import { closePool } from '../db/client';

describe('DisputeRefundService', () => {
  let db: Pool;
  let service: DisputeRefundService;

  beforeAll(async () => {
    // For test purposes, mock the pool
    db = {
      query: jest.fn(),
    } as unknown as Pool;
    service = new DisputeRefundService(db);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  afterAll(async () => {
    // Cleanup if real db was used
    await closePool();
  });

  it('rejects refund if amount is not positive', async () => {
    await expect(service.processPartialRefund({
      disputeId: 'dispute-1',
      amount: '-50.00',
      originalDisbursement: '100.00'
    })).rejects.toThrow('Refund amount must be a positive number');

    await expect(service.processPartialRefund({
      disputeId: 'dispute-1',
      amount: '0',
      originalDisbursement: '100.00'
    })).rejects.toThrow('Refund amount must be a positive number');
  });

  it('rejects refund if original disbursement is not positive', async () => {
    await expect(service.processPartialRefund({
      disputeId: 'dispute-1',
      amount: '50.00',
      originalDisbursement: '0'
    })).rejects.toThrow('Original disbursement must be a positive number');
  });

  it('enforces the sum invariant and rejects if refund exceeds original disbursement', async () => {
    // Mock sumRefundsForDispute to return 60
    (db.query as jest.Mock).mockResolvedValueOnce({ rows: [{ total: '60.00' }] });

    const promise = service.processPartialRefund({
      disputeId: 'dispute-1',
      amount: '50.00', // 60 + 50 = 110 > 100
      originalDisbursement: '100.00'
    });

    await expect(promise).rejects.toThrow(/Sum of partial refunds \\(110\\) cannot exceed original disbursement \\(100\\)/);
    
    // Verify db query for sum was called
    expect(db.query).toHaveBeenCalledTimes(1);
    expect((db.query as jest.Mock).mock.calls[0][0]).toContain('SUM(amount)');
  });

  it('processes the refund successfully if the sum is within bounds', async () => {
    // Mock sumRefundsForDispute to return 40
    (db.query as jest.Mock).mockResolvedValueOnce({ rows: [{ total: '40.00' }] });
    // Mock create refund
    (db.query as jest.Mock).mockResolvedValueOnce({ 
      rows: [{ 
        id: 'refund-1', 
        dispute_id: 'dispute-1', 
        amount: '60.0000', 
        reason: 'partial return', 
        ledger_event_id: 'ledg-123', 
        created_at: new Date() 
      }] 
    });

    const refund = await service.processPartialRefund({
      disputeId: 'dispute-1',
      amount: '60.00', // 40 + 60 = 100 <= 100
      originalDisbursement: '100.00',
      reason: 'partial return',
      ledgerEventId: 'ledg-123'
    });

    expect(refund.id).toBe('refund-1');
    expect(refund.amount).toBe('60.0000');
    expect(db.query).toHaveBeenCalledTimes(2); // One for sum, one for insert
  });
});
