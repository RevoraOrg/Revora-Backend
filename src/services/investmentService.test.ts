import { Pool, QueryResult } from 'pg';
import { InvestmentRepository, Investment } from '../db/repositories/investmentRepository';
import { OfferingRepository, Offering } from '../db/repositories/offeringRepository';
import { UserRepository, User } from '../db/repositories/userRepository';
import { InvestmentService, CreateInvestmentRequest, createInvestmentService } from './investmentService';
import { AMLService } from '../aml/amlService';
import { SanctionsScreeningService, SanctionsScreenResult } from './sanctionsScreeningService';
import { AuditLogRepository } from '../db/repositories/auditLogRepository';

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

describe('InvestmentService sanctions screening', () => {
  const baseInput: CreateInvestmentRequest = {
    investor_id: 'investor-123',
    offering_id: 'offering-abc',
    amount: '1000.00',
    asset: 'USDC',
  };

  function buildService(opts: {
    screenResult: SanctionsScreenResult | null;
    repoMatches?: boolean;
    auditCalls?: jest.Mock;
  }) {
    const pool = makeMockPool();
    const invRepo = new InvestmentRepository(pool as unknown as Pool);
    const offRepo = new OfferingRepository(pool as unknown as Pool);
    const screening = {
      screen: jest.fn().mockResolvedValue(opts.screenResult),
    } as unknown as SanctionsScreeningService;
    const auditLogFn = opts.auditCalls ?? jest.fn().mockResolvedValue(undefined);
    const audit = {
      createAuditLog: auditLogFn,
    } as unknown as AuditLogRepository;
    const userRepo = {
      findById: jest.fn().mockResolvedValue(makeUser({ name: 'Jane Doe' })),
    } as unknown as UserRepository;
    const svc = new InvestmentService(invRepo, offRepo, undefined, userRepo, screening, audit);

    const offeringRow = makeOfferingRow({ status: 'active' });
    if (opts.repoMatches) {
      const investmentRow = makeInvestmentRow();
      pool.query
        .mockResolvedValueOnce(mockQueryResult([offeringRow]))
        .mockResolvedValueOnce({
          rows: [investmentRow], rowCount: 1, command: 'INSERT', oid: 0, fields: [],
        } as QueryResult<Investment>);
    } else {
      pool.query.mockResolvedValueOnce(mockQueryResult([offeringRow]));
    }
    return { svc, pool, screening, audit };
  }

  const blockedResult: SanctionsScreenResult = {
    complete: true,
    versions: { ofac: '2026-01-01', eu_consolidated: 'x', uk_hmt: 'y' },
    matches: [{ source: 'ofac', version: '2026-01-01', listName: 'Eve', matchType: 'exact', matchedName: 'Eve' }],
    cleared: false,
  };

  it('rejects and blocks when a sanctions hit is found (no insert)', async () => {
    const { svc, pool, audit } = buildService({ screenResult: blockedResult });
    await expect(svc.createInvestment(baseInput)).rejects.toThrow(/sanctions list entry/);
    const sqls = pool.query.mock.calls.map((c) => String(c[0]));
    expect(sqls.some((s) => /INSERT\s+INTO\s+investments/i.test(s))).toBe(false);
    expect(audit.createAuditLog).toHaveBeenCalledTimes(1);
    const details = JSON.parse((audit.createAuditLog as jest.Mock).mock.calls[0][0].details as string);
    expect(details.screening_status).toBe('blocked');
    expect(details.reviewer_queue_link).toBe('/api/v1/aml/ofac-reviews');
    expect(details.blocked).toBe(true);
  });

  it('fail-closes (503 path) when list is incomplete — logs audit with error status', async () => {
    const incomplete: SanctionsScreenResult = {
      complete: false,
      versions: { ofac: '2026-01-01' },
      matches: [],
      cleared: false,
    };
    const { svc, pool, audit } = buildService({ screenResult: incomplete });
    await expect(svc.createInvestment(baseInput)).rejects.toThrow(/fail-closed/);
    expect(pool.query).toHaveBeenCalledTimes(1); // only offering lookup, no insert
    expect(audit.createAuditLog).toHaveBeenCalledTimes(1);
    const details = JSON.parse((audit.createAuditLog as jest.Mock).mock.calls[0][0].details as string);
    expect(details.screening_status).toBe('error');
  });

  it('persists a passed investment with screening metadata on the row', async () => {
    const passed: SanctionsScreenResult = {
      complete: true,
      versions: { ofac: '2026-01-01', eu_consolidated: 'a', uk_hmt: 'b' },
      matches: [],
      cleared: true,
    };
    const { svc, pool, screening, audit } = buildService({ screenResult: passed, repoMatches: true });
    const result = await svc.createInvestment(baseInput);
    expect(result).toBeDefined();
    expect(screening.screen).toHaveBeenCalledWith(['Jane Doe']);
    // Verify insert carried screening columns.
    const insertCall = pool.query.mock.calls.find((c) => /INSERT\s+INTO\s+investments/i.test(String(c[0])));
    expect(insertCall).toBeDefined();
    const values = insertCall[1];
    expect(values).toContain('passed');
    expect(values).toContain('2026-01-01');
    expect(audit.createAuditLog).not.toHaveBeenCalled();
  });

  it('screens beneficial owners alongside the investor, blocking on an owner hit', async () => {
    const { svc, pool, audit } = buildService({ screenResult: blockedResult });
    await expect(
      svc.createInvestment({ ...baseInput, beneficial_owners: ['Eve'] }),
    ).rejects.toThrow(/sanctions list entry/);
    expect(pool.query.mock.calls.filter((c) => /INSERT\s+INTO\s+investments/i.test(String(c[0])))).toHaveLength(0);
    expect(audit.createAuditLog).toHaveBeenCalledTimes(1);
  });

  it('skips screening entirely when no screening service is configured', async () => {
    const pool = makeMockPool();
    const invRepo = new InvestmentRepository(pool as unknown as Pool);
    const offRepo = new OfferingRepository(pool as unknown as Pool);
    const svc = new InvestmentService(invRepo, offRepo);
    const offeringRow = makeOfferingRow({ status: 'active' });
    const investmentRow = makeInvestmentRow();
    pool.query
      .mockResolvedValueOnce(mockQueryResult([offeringRow]))
      .mockResolvedValueOnce({
        rows: [investmentRow], rowCount: 1, command: 'INSERT', oid: 0, fields: [],
      } as QueryResult<Investment>);
    const result = await svc.createInvestment(baseInput);
    expect(result).toEqual(investmentRow);
  });
});

describe('createInvestmentService', () => {
  it('creates an InvestmentService instance', () => {
    const mockPool = makeMockPool();
    const service = createInvestmentService(mockPool as unknown as Pool);
    expect(service).toBeInstanceOf(InvestmentService);
  });
});
