import { Pool } from 'pg';
import { DisputeRefundService } from './disputeRefundService';
import { Errors } from '../lib/errors';
import { closePool } from '../db/client';

describe('DisputeRefundService', () => {
  let db: Pool;
  let service: DisputeRefundService;
  let mockClient: any;

  beforeAll(async () => {
    mockClient = {
      query: jest.fn(),
      release: jest.fn(),
    };
    db = {
      query: jest.fn(),
      connect: jest.fn().mockResolvedValue(mockClient),
    } as unknown as Pool;
    
    service = new DisputeRefundService(db);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  afterAll(async () => {
    await closePool();
  });

  it('rejects refund if amount is not positive', async () => {
    await expect(service.processPartialRefund({
      disputeId: 'dispute-1',
      amount: '-50.00',
      originalDisbursement: '100.00'
    })).rejects.toThrow('Refund amount must be a positive number');
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
  });

  it('processes the refund and performs proportional ledger reversal', async () => {
    (db.query as jest.Mock)
      .mockResolvedValueOnce({ rows: [{ total: '40.00' }] }) // sumRefundsForDispute
      .mockResolvedValueOnce({ rows: [ // distributionRepo.getPayoutsForRun
        { investor_id: 'inv-1', amount: '50.00' },
        { investor_id: 'inv-2', amount: '50.00' }
      ]});
      
    // Mock for transaction start
    mockClient.query
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 'refund-1', amount: '60.00' }] }) // INSERT refund
      .mockResolvedValueOnce({ rows: [{ id: 'reversal-1' }, { id: 'reversal-2' }] }) // INSERT ledger events
      .mockResolvedValueOnce({}); // COMMIT

    const refund = await service.processPartialRefund({
      disputeId: 'dispute-1',
      amount: '60.00',
      originalDisbursement: '100.00',
      distributionId: 'dist-1'
    });

    expect(refund.id).toBe('refund-1');
    expect(mockClient.query).toHaveBeenCalledTimes(4); // BEGIN, INSERT refund, INSERT events, COMMIT
    
    // Check the batch insert values
    const insertEventsCall = mockClient.query.mock.calls[2];
    expect(insertEventsCall[0]).toContain('INSERT INTO dispute_ledger_events');
    // Inv-1 originally got 50 out of 100 (50%). Refund is 60. So reversal should be -30.
    expect(insertEventsCall[1]).toContain('-30');
  });
});
