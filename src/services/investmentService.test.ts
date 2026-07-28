import { Pool, QueryResult } from 'pg';
import { InvestmentRepository, Investment } from '../db/repositories/investmentRepository';
import { OfferingRepository, Offering } from '../db/repositories/offeringRepository';
import { UserRepository, User } from '../db/repositories/userRepository';
import { InvestmentService, CreateInvestmentRequest, createInvestmentService } from './investmentService';
import { AMLService } from '../aml/amlService';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockPool(): { query: jest.Mock } {
  return { query: jest.fn() };
}

function makeInvestmentRow(override: Partial<Investment> = {}): Investment {
  return {
    id: 'inv-1',
    investor_id: 'investor-123',
    offering_id: 'offering-abc',
    amount: '5000.00',
    asset: 'USDC',
    status: 'pending',
    created_at: new Date('2024-01-15'),
    updated_at: new Date('2024-01-15'),
    ...override,
  };
}

function makeOfferingRow(override: Partial<Offering> = {}): Offering {
  return {
    id: 'offering-abc',
    contract_address: 'CA123...',
    status: 'active',
    total_raised: '10000.00',
    target_amount: '1000000.00',
    created_at: new Date('2024-01-01'),
    updated_at: new Date('2024-01-01'),
    ...override,
  };
}

function makeUser(override: Partial<User> = {}): User {
  return {
    id: 'investor-123',
    email: 'inv@example.com',
    password_hash: 'hash',
    role: 'investor',
    kyc_risk_tier: 'standard',
    created_at: new Date('2024-01-01'),
    updated_at: new Date('2024-01-01'),
    ...override,
  };
}

function mockQueryResult(rows: unknown[]): QueryResult<any> {
  return { rows, rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('InvestmentService', () => {
  let mockPool: { query: jest.Mock };
  let investmentRepo: InvestmentRepository;
  let offeringRepo: OfferingRepository;
  let service: InvestmentService;

  beforeEach(() => {
    mockPool = makeMockPool();
    investmentRepo = new InvestmentRepository(mockPool as unknown as Pool);
    offeringRepo = new OfferingRepository(mockPool as unknown as Pool);
    service = new InvestmentService(investmentRepo, offeringRepo);
  });

  describe('createInvestment', () => {
    const baseInput: CreateInvestmentRequest = {
      investor_id: 'investor-123',
      offering_id: 'offering-abc',
      amount: '5000.00',
      asset: 'USDC',
    };

    it('creates an investment when offering exists and is active', async () => {
      const offeringRow = makeOfferingRow({ status: 'active' });
      const investmentRow = makeInvestmentRow();

      mockPool.query
        .mockResolvedValueOnce(mockQueryResult([offeringRow]))
        .mockResolvedValueOnce({ rows: [investmentRow], rowCount: 1, command: 'INSERT', oid: 0, fields: [] } as QueryResult<Investment>);

      const result = await service.createInvestment(baseInput);

      expect(result).toEqual(investmentRow);
      expect(mockPool.query).toHaveBeenCalledTimes(2);
    });

    it('creates an investment when offering status is "open"', async () => {
      const offeringRow = makeOfferingRow({ status: 'open' });
      const investmentRow = makeInvestmentRow();

      mockPool.query
        .mockResolvedValueOnce(mockQueryResult([offeringRow]))
        .mockResolvedValueOnce({ rows: [investmentRow], rowCount: 1, command: 'INSERT', oid: 0, fields: [] } as QueryResult<Investment>);

      const result = await service.createInvestment(baseInput);

      expect(result).toEqual(investmentRow);
    });

    it('throws NOT_FOUND error when offering does not exist', async () => {
      mockPool.query.mockResolvedValueOnce(mockQueryResult([]));

      await expect(service.createInvestment(baseInput)).rejects.toThrow('Offering offering-abc not found');
    });

    it('throws VALIDATION_ERROR when offering is not active', async () => {
      const offeringRow = makeOfferingRow({ status: 'closed' });
      mockPool.query.mockResolvedValueOnce(mockQueryResult([offeringRow]));

      await expect(service.createInvestment(baseInput)).rejects.toThrow('Offering is not active');
    });

    it('throws VALIDATION_ERROR when amount is invalid', async () => {
      const offeringRow = makeOfferingRow({ status: 'active' });
      mockPool.query.mockResolvedValueOnce(mockQueryResult([offeringRow]));

      await expect(service.createInvestment({ ...baseInput, amount: '-100' })).rejects.toThrow(
        'Invalid amount: must be a positive number',
      );
      mockPool.query.mockResolvedValueOnce(mockQueryResult([offeringRow]));
      await expect(service.createInvestment({ ...baseInput, amount: '0' })).rejects.toThrow(
        'Invalid amount: must be a positive number',
      );
      mockPool.query.mockResolvedValueOnce(mockQueryResult([offeringRow]));
      await expect(service.createInvestment({ ...baseInput, amount: 'abc' })).rejects.toThrow(
        'Invalid amount: must be a positive number',
      );
    });

    it('throws VALIDATION_ERROR when asset is empty', async () => {
      const offeringRow = makeOfferingRow({ status: 'active' });
      mockPool.query.mockResolvedValueOnce(mockQueryResult([offeringRow]));

      await expect(service.createInvestment({ ...baseInput, asset: '' })).rejects.toThrow('Asset is required');
    });

    it('creates investment with pending status by default', async () => {
      const offeringRow = makeOfferingRow({ status: 'active' });
      const investmentRow = makeInvestmentRow({ status: 'pending' });

      mockPool.query
        .mockResolvedValueOnce(mockQueryResult([offeringRow]))
        .mockResolvedValueOnce({ rows: [investmentRow], rowCount: 1, command: 'INSERT', oid: 0, fields: [] } as QueryResult<Investment>);

      const result = await service.createInvestment(baseInput);

      expect(result.status).toBe('pending');
    });
  });

  describe('KYC risk-tier cap gating', () => {
    const baseInput: CreateInvestmentRequest = {
      investor_id: 'investor-123',
      offering_id: 'offering-abc',
      amount: '60000.00',
      asset: 'USDC',
    };

    function serviceWithUserRepo(user: User | null): {
      service: InvestmentService;
      mockPool: { query: jest.Mock };
    } {
      const pool = makeMockPool();
      const invRepo = new InvestmentRepository(pool as unknown as Pool);
      const offRepo = new OfferingRepository(pool as unknown as Pool);
      const userRepo = {
        findById: jest.fn().mockResolvedValue(user),
      } as unknown as UserRepository;
      return {
        service: new InvestmentService(invRepo, offRepo, undefined, userRepo),
        mockPool: pool,
      };
    }

    it('blocks high-risk investor when intent exceeds tier-adjusted cap', async () => {
      const { service: svc, mockPool: pool } = serviceWithUserRepo(
        makeUser({ kyc_risk_tier: 'high' }),
      );
      pool.query
        .mockResolvedValueOnce(
          mockQueryResult([
            makeOfferingRow({
              max_investor_share_bps: 1_000,
              target_amount: '1000000',
            }),
          ]),
        )
        .mockResolvedValueOnce(mockQueryResult([{ total: '0' }]));

      await expect(svc.createInvestment(baseInput)).rejects.toThrow(/KYC risk-tier adjusted cap/);
    });

    it('allows the same intent after tier upgrade on the next createInvestment call', async () => {
      const userRepo = {
        findById: jest
          .fn()
          .mockResolvedValueOnce(makeUser({ kyc_risk_tier: 'high' }))
          .mockResolvedValueOnce(makeUser({ kyc_risk_tier: 'standard' })),
      } as unknown as UserRepository;

      const pool = makeMockPool();
      const invRepo = new InvestmentRepository(pool as unknown as Pool);
      const offRepo = new OfferingRepository(pool as unknown as Pool);
      const svc = new InvestmentService(invRepo, offRepo, undefined, userRepo);
      const offering = makeOfferingRow({
        max_investor_share_bps: 1_000,
        target_amount: '1000000',
      });
      const investmentRow = makeInvestmentRow({ amount: '60000.00' });

      pool.query
        .mockResolvedValueOnce(mockQueryResult([offering]))
        .mockResolvedValueOnce(mockQueryResult([{ total: '0' }]));
      await expect(svc.createInvestment(baseInput)).rejects.toThrow(/KYC risk-tier adjusted cap/);

      pool.query
        .mockResolvedValueOnce(mockQueryResult([offering]))
        .mockResolvedValueOnce(mockQueryResult([{ total: '0' }]))
        .mockResolvedValueOnce({
          rows: [investmentRow],
          rowCount: 1,
          command: 'INSERT',
          oid: 0,
          fields: [],
        } as QueryResult<Investment>);

      const created = await svc.createInvestment(baseInput);
      expect(created.amount).toBe('60000.00');
    });

    it('does not invalidate existing over-cap commitments — only rejects additional amount', async () => {
      const { service: svc, mockPool: pool } = serviceWithUserRepo(
        makeUser({ kyc_risk_tier: 'elevated' }),
      );
      pool.query
        .mockResolvedValueOnce(
          mockQueryResult([
            makeOfferingRow({
              max_investor_share_bps: 1_000,
              target_amount: '1000000',
            }),
          ]),
        )
        .mockResolvedValueOnce(mockQueryResult([{ total: '80000' }]));

      await expect(
        svc.createInvestment({ ...baseInput, amount: '1' }),
      ).rejects.toThrow(/KYC risk-tier adjusted cap/);
      const sql = pool.query.mock.calls.map((c) => String(c[0]));
      expect(sql.some((s) => /DELETE\s+FROM\s+investments/i.test(s))).toBe(false);
      expect(sql.some((s) => /INSERT\s+INTO\s+investments/i.test(s))).toBe(false);
    });


    it('invokes AML evaluation when amlService is configured', async () => {
      const amlService = {
        evaluateTransaction: jest.fn().mockResolvedValue([]),
      } as unknown as AMLService;
      const svc = new InvestmentService(investmentRepo, offeringRepo, amlService);
      const offeringRow = makeOfferingRow({ status: 'active' });
      const investmentRow = makeInvestmentRow();

      mockPool.query
        .mockResolvedValueOnce(mockQueryResult([offeringRow]))
        .mockResolvedValueOnce({
          rows: [investmentRow],
          rowCount: 1,
          command: 'INSERT',
          oid: 0,
          fields: [],
        } as QueryResult<Investment>);

      const result = await svc.createInvestment(baseInput);
      expect(result).toEqual(investmentRow);
      expect(amlService.evaluateTransaction).toHaveBeenCalledTimes(1);
      await new Promise((r) => setImmediate(r));
    });

    it('does not fail investment creation when AML evaluation rejects asynchronously', async () => {
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const amlService = {
        evaluateTransaction: jest.fn().mockRejectedValue(new Error('aml failed')),
      } as unknown as AMLService;
      const svc = new InvestmentService(investmentRepo, offeringRepo, amlService);
      const offeringRow = makeOfferingRow({ status: 'active' });
      const investmentRow = makeInvestmentRow();

      mockPool.query
        .mockResolvedValueOnce(mockQueryResult([offeringRow]))
        .mockResolvedValueOnce({
          rows: [investmentRow],
          rowCount: 1,
          command: 'INSERT',
          oid: 0,
          fields: [],
        } as QueryResult<Investment>);

      await expect(svc.createInvestment(baseInput)).resolves.toEqual(investmentRow);
      await new Promise((r) => setImmediate(r));
      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it('does not fail investment creation when AML setup throws synchronously', async () => {
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const amlService = {
        evaluateTransaction: jest.fn(() => {
          throw new Error('sync aml');
        }),
      } as unknown as AMLService;
      const svc = new InvestmentService(investmentRepo, offeringRepo, amlService);
      const offeringRow = makeOfferingRow({ status: 'active' });
      const investmentRow = makeInvestmentRow();

      mockPool.query
        .mockResolvedValueOnce(mockQueryResult([offeringRow]))
        .mockResolvedValueOnce({
          rows: [investmentRow],
          rowCount: 1,
          command: 'INSERT',
          oid: 0,
          fields: [],
        } as QueryResult<Investment>);

      await expect(svc.createInvestment(baseInput)).resolves.toEqual(investmentRow);
      expect(consoleSpy).toHaveBeenCalledWith('AML evaluation setup failed:', expect.any(Error));
      consoleSpy.mockRestore();
    });

    it('blocks restricted tier even when offering has no static cap', async () => {
      const { service: svc, mockPool: pool } = serviceWithUserRepo(
        makeUser({ kyc_risk_tier: 'restricted' }),
      );
      pool.query
        .mockResolvedValueOnce(
          mockQueryResult([
            makeOfferingRow({
              max_investor_share_bps: null,
              target_amount: '1000000',
            }),
          ]),
        )
        .mockResolvedValueOnce(mockQueryResult([{ total: '0' }]));

      await expect(svc.createInvestment(baseInput)).rejects.toThrow(/KYC risk-tier adjusted cap/);
    });
  });
});

describe('createInvestmentService', () => {
  it('creates an InvestmentService instance', () => {
    const mockPool = makeMockPool();
    const service = createInvestmentService(mockPool as unknown as Pool);
    expect(service).toBeInstanceOf(InvestmentService);
  });
});
