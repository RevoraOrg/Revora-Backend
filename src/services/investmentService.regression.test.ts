/**
 * Regression suite for `InvestmentService` failure handling (issue #1030).
 *
 * `investmentService.test.ts` covers the happy paths and asserts on human
 * readable message strings. This suite additionally pins the *machine-readable*
 * contract of each failure path — `AppError.code`, the HTTP `statusCode`, and the
 * `expose` flag — plus deterministic boundary behaviour, so that a silent change
 * to how a failure is surfaced is caught immediately.
 *
 * Evidence parity with `src/db/transaction.integration.example.ts`:
 *   - "Offering not found"     -> `createInvestment`: NOT_FOUND (404)
 *   - "Offering is not active" -> `createInvestment`: VALIDATION_ERROR (400)
 */
import { Pool, QueryResult } from 'pg';
import { InvestmentRepository, Investment } from '../db/repositories/investmentRepository';
import { OfferingRepository, Offering } from '../db/repositories/offeringRepository';
import { UserRepository, User } from '../db/repositories/userRepository';
import { AuditLogRepository } from '../db/repositories/auditLogRepository';
import { InvestmentService, CreateInvestmentRequest } from './investmentService';
import { SanctionsScreeningService, SanctionsScreenResult } from './sanctionsScreeningService';
import { AppError, ErrorCode } from '../lib/errors';
import { KycRiskTier } from '../lib/kycRiskTierCaps';

// ---------------------------------------------------------------------------
// Fixtures & helpers
// ---------------------------------------------------------------------------

type MockPool = { query: jest.Mock };

const baseInput: CreateInvestmentRequest = {
  investor_id: 'investor-123',
  offering_id: 'offering-abc',
  amount: '5000.00',
  asset: 'USDC',
};

function makePool(): MockPool {
  return { query: jest.fn() };
}

function ok(rows: unknown[]): QueryResult<Record<string, unknown>> {
  return {
    rows: rows as Record<string, unknown>[],
    rowCount: rows.length,
    command: 'SELECT',
    oid: 0,
    fields: [],
  };
}

function makeOffering(override: Partial<Offering> = {}): Offering {
  return {
    id: 'offering-abc',
    status: 'active',
    total_raised: '10000.00',
    target_amount: '1000000.00',
    created_at: new Date('2024-01-01'),
    updated_at: new Date('2024-01-01'),
    ...override,
  };
}

function makeInvestment(override: Partial<Investment> = {}): Investment {
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

function makeService(): { service: InvestmentService; pool: MockPool } {
  const pool = makePool();
  const investmentRepo = new InvestmentRepository(pool as unknown as Pool);
  const offeringRepo = new OfferingRepository(pool as unknown as Pool);
  return { service: new InvestmentService(investmentRepo, offeringRepo), pool };
}

/** Await a promise that must reject and return the thrown value. */
async function captureError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected the promise to reject but it resolved');
}

/** All `INSERT INTO investments` calls as `[sql, values]` tuples. */
function investmentInserts(pool: MockPool): Array<[string, unknown[]]> {
  return pool.query.mock.calls.filter((call) =>
    /INSERT\s+INTO\s+investments/i.test(String(call[0])),
  ) as Array<[string, unknown[]]>;
}

// ---------------------------------------------------------------------------
// Offering failure contract
// ---------------------------------------------------------------------------

describe('InvestmentService failure contract (#1030)', () => {
  describe('offering lookup', () => {
    it('rejects with NOT_FOUND / 404 when the offering does not exist', async () => {
      const { service, pool } = makeService();
      pool.query.mockResolvedValueOnce(ok([]));

      const error = await captureError(service.createInvestment(baseInput));

      expect(error).toBeInstanceOf(AppError);
      const appError = error as AppError;
      expect(appError.code).toBe(ErrorCode.NOT_FOUND);
      expect(appError.statusCode).toBe(404);
      expect(appError.message).toBe('Offering offering-abc not found');
      expect(appError.expose).toBe(true);

      // Fail-closed: a missing offering must never reach the insert.
      expect(pool.query).toHaveBeenCalledTimes(1);
      expect(investmentInserts(pool)).toHaveLength(0);
    });
  });

  describe('offering status', () => {
    it.each(['draft', 'paused', 'cancelled', 'closed', 'completed'])(
      'rejects offering status "%s" with VALIDATION_ERROR / 400',
      async (status) => {
        const { service, pool } = makeService();
        pool.query.mockResolvedValueOnce(ok([makeOffering({ status })]));

        const error = await captureError(service.createInvestment(baseInput));

        expect(error).toBeInstanceOf(AppError);
        const appError = error as AppError;
        expect(appError.code).toBe(ErrorCode.VALIDATION_ERROR);
        expect(appError.statusCode).toBe(400);
        expect(appError.message).toBe(`Offering is not active. Current status: ${status}`);
        expect(investmentInserts(pool)).toHaveLength(0);
      },
    );

    it('rejects an offering with a missing status deterministically', async () => {
      const { service, pool } = makeService();
      const offering = makeOffering();
      delete (offering as Record<string, unknown>)['status'];
      pool.query.mockResolvedValueOnce(ok([offering]));

      const error = await captureError(service.createInvestment(baseInput));

      expect((error as AppError).code).toBe(ErrorCode.VALIDATION_ERROR);
      expect((error as AppError).message).toBe(
        'Offering is not active. Current status: undefined',
      );
    });
  });

  // -------------------------------------------------------------------------
  // Amount / asset boundary inputs
  // -------------------------------------------------------------------------

  describe('amount validation', () => {
    it.each([
      ['zero', '0'],
      ['negative integer', '-1'],
      ['negative fraction', '-0.01'],
      ['non-numeric', 'abc'],
      ['empty string', ''],
      ['whitespace only', '   '],
      ['hex literal (parses to 0)', '0x10'],
      ['NaN literal', 'NaN'],
    ])('rejects invalid amount (%s)', async (_label, amount) => {
      const { service, pool } = makeService();
      pool.query.mockResolvedValueOnce(ok([makeOffering({ status: 'active' })]));

      const error = await captureError(service.createInvestment({ ...baseInput, amount }));

      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe(ErrorCode.VALIDATION_ERROR);
      expect((error as AppError).statusCode).toBe(400);
      expect((error as AppError).message).toBe('Invalid amount: must be a positive number');
      expect(investmentInserts(pool)).toHaveLength(0);
    });

    it.each([
      ['smallest positive fraction', '0.0001'],
      ['scientific notation', '1e3'],
      ['large integer', '1000000000000'],
    ])('accepts valid amount (%s)', async (_label, amount) => {
      const { service, pool } = makeService();
      const row = makeInvestment({ amount });
      pool.query
        .mockResolvedValueOnce(ok([makeOffering({ status: 'active' })]))
        .mockResolvedValueOnce(ok([row]));

      await expect(service.createInvestment({ ...baseInput, amount })).resolves.toEqual(row);
    });

    it('documents that a non-finite "Infinity" amount is currently accepted (known gap)', async () => {
      // KNOWN GAP: `parseFloat('Infinity') === Infinity` satisfies the `> 0`
      // guard, so a non-finite amount is persisted today. This is pinned only to
      // make the behaviour observable; tightening the guard is tracked as a
      // follow-up so the contract change is reviewed on its own.
      const { service, pool } = makeService();
      const row = makeInvestment({ amount: 'Infinity' });
      pool.query
        .mockResolvedValueOnce(ok([makeOffering({ status: 'active' })]))
        .mockResolvedValueOnce(ok([row]));

      await expect(
        service.createInvestment({ ...baseInput, amount: 'Infinity' }),
      ).resolves.toEqual(row);
    });
  });

  describe('asset validation', () => {
    it.each([
      ['empty string', ''],
      ['spaces only', '   '],
      ['tab/newline only', '\t\n'],
    ])('rejects blank asset (%s)', async (_label, asset) => {
      const { service, pool } = makeService();
      pool.query.mockResolvedValueOnce(ok([makeOffering({ status: 'active' })]));

      const error = await captureError(service.createInvestment({ ...baseInput, asset }));

      expect((error as AppError).code).toBe(ErrorCode.VALIDATION_ERROR);
      expect((error as AppError).statusCode).toBe(400);
      expect((error as AppError).message).toBe('Asset is required');
      expect(investmentInserts(pool)).toHaveLength(0);
    });

    it('passes a padded asset through verbatim (no silent trimming or mutation)', async () => {
      const { service, pool } = makeService();
      const row = makeInvestment({ asset: ' USDC ' });
      pool.query
        .mockResolvedValueOnce(ok([makeOffering({ status: 'active' })]))
        .mockResolvedValueOnce(ok([row]));

      await service.createInvestment({ ...baseInput, asset: ' USDC ' });

      const values = investmentInserts(pool)[0][1];
      expect(values[3]).toBe(' USDC ');
    });
  });

  // -------------------------------------------------------------------------
  // Neighbouring normal path
  // -------------------------------------------------------------------------

  describe('normal path', () => {
    it('returns the persisted investment and defaults status to pending', async () => {
      const { service, pool } = makeService();
      const row = makeInvestment({ status: 'pending' });
      pool.query
        .mockResolvedValueOnce(ok([makeOffering({ status: 'active' })]))
        .mockResolvedValueOnce(ok([row]));

      await expect(service.createInvestment(baseInput)).resolves.toEqual(row);

      const values = investmentInserts(pool)[0][1];
      expect(values[4]).toBe('pending');
    });

    it('accepts an "open" offering', async () => {
      const { service, pool } = makeService();
      const row = makeInvestment();
      pool.query
        .mockResolvedValueOnce(ok([makeOffering({ status: 'open' })]))
        .mockResolvedValueOnce(ok([row]));

      await expect(service.createInvestment(baseInput)).resolves.toEqual(row);
    });

    it('skips the commitment lookup entirely when the offering has no static cap', async () => {
      const { service, pool } = makeService();
      pool.query
        .mockResolvedValueOnce(
          ok([makeOffering({ status: 'active', max_investor_share_bps: null })]),
        )
        .mockResolvedValueOnce(ok([makeInvestment()]));

      await service.createInvestment(baseInput);

      // Exactly: offering lookup + insert. No SUM(amount) round trip.
      expect(pool.query).toHaveBeenCalledTimes(2);
      expect(
        pool.query.mock.calls.some((c) => /SUM\s*\(\s*amount/i.test(String(c[0]))),
      ).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Empty-result persistence failure
  // -------------------------------------------------------------------------

  describe('empty-result persistence failure', () => {
    it('propagates the repository failure when the INSERT returns no rows', async () => {
      const { service, pool } = makeService();
      pool.query
        .mockResolvedValueOnce(ok([makeOffering({ status: 'active' })]))
        .mockResolvedValueOnce(ok([]));

      const error = await captureError(service.createInvestment(baseInput));

      expect(error).toBeInstanceOf(Error);
      // A failed insert is an unexpected infrastructure error, not an operational
      // AppError — the HTTP layer maps it to a 500 rather than leaking a 4xx.
      expect(error).not.toBeInstanceOf(AppError);
      expect((error as Error).message).toBe('Failed to create investment');
    });
  });

  // -------------------------------------------------------------------------
  // KYC risk-tier cap boundary
  // -------------------------------------------------------------------------

  describe('KYC risk-tier cap boundary', () => {
    /** standard/elevated/high/restricted tiers over a 1000 bps offering cap. */
    function makeCapService(tier: KycRiskTier, existingTotal: string) {
      const pool = makePool();
      const investmentRepo = new InvestmentRepository(pool as unknown as Pool);
      const offeringRepo = new OfferingRepository(pool as unknown as Pool);
      const userRepo = {
        findById: jest.fn().mockResolvedValue(makeUser({ kyc_risk_tier: tier })),
      } as unknown as UserRepository;
      const service = new InvestmentService(investmentRepo, offeringRepo, undefined, userRepo);
      pool.query
        .mockResolvedValueOnce(
          ok([
            makeOffering({
              status: 'active',
              max_investor_share_bps: 1_000,
              target_amount: '1000000',
            }),
          ]),
        )
        .mockResolvedValueOnce(ok([{ total: existingTotal }]));
      return { service, pool };
    }

    // standard tier: 1000 bps * 1.0 = 1000 bps -> 10% of 1,000,000 = 100,000
    it('allows an intent exactly equal to the effective cap', async () => {
      const { service, pool } = makeCapService('standard', '0');
      pool.query.mockResolvedValueOnce(ok([makeInvestment({ amount: '100000' })]));

      await expect(
        service.createInvestment({ ...baseInput, amount: '100000' }),
      ).resolves.toEqual(expect.objectContaining({ amount: '100000' }));
    });

    it('rejects one unit over the effective cap with FORBIDDEN / 403 and cap details', async () => {
      const { service } = makeCapService('standard', '0');

      const error = await captureError(
        service.createInvestment({ ...baseInput, amount: '100000.01' }),
      );

      expect(error).toBeInstanceOf(AppError);
      const appError = error as AppError;
      expect(appError.code).toBe(ErrorCode.FORBIDDEN);
      expect(appError.statusCode).toBe(403);
      expect(appError.details).toMatchObject({
        kyc_risk_tier: 'standard',
        effective_cap_bps: 1000,
        offering_cap_bps: 1000,
        existing_total: 0,
        attempted_amount: 100000.01,
        cap_amount: 100000,
      });
    });

    it('rejects when existing commitments plus the new intent exceed the cap', async () => {
      const { service } = makeCapService('standard', '90000');

      await expect(
        service.createInvestment({ ...baseInput, amount: '20000' }),
      ).rejects.toThrow(/KYC risk-tier adjusted cap/);
    });

    it('scales the cap by tier (high quarters it) — the boundary is tier-specific', async () => {
      // high tier: 1000 bps * 0.25 = 250 bps -> 2.5% of 1,000,000 = 25,000
      const allowed = makeCapService('high', '0');
      allowed.pool.query.mockResolvedValueOnce(ok([makeInvestment({ amount: '25000' })]));
      await expect(
        allowed.service.createInvestment({ ...baseInput, amount: '25000' }),
      ).resolves.toEqual(expect.objectContaining({ amount: '25000' }));

      const rejected = makeCapService('high', '0');
      await expect(
        rejected.service.createInvestment({ ...baseInput, amount: '25000.01' }),
      ).rejects.toThrow(/KYC risk-tier adjusted cap/);
    });

    it('blocks a restricted tier with a zero cap even when the offering has no static cap', async () => {
      const pool = makePool();
      const investmentRepo = new InvestmentRepository(pool as unknown as Pool);
      const offeringRepo = new OfferingRepository(pool as unknown as Pool);
      const userRepo = {
        findById: jest.fn().mockResolvedValue(makeUser({ kyc_risk_tier: 'restricted' })),
      } as unknown as UserRepository;
      const service = new InvestmentService(investmentRepo, offeringRepo, undefined, userRepo);
      pool.query
        .mockResolvedValueOnce(
          ok([makeOffering({ status: 'active', max_investor_share_bps: null })]),
        )
        .mockResolvedValueOnce(ok([{ total: '0' }]));

      const error = await captureError(service.createInvestment(baseInput));
      expect((error as AppError).code).toBe(ErrorCode.FORBIDDEN);
    });
  });

  // -------------------------------------------------------------------------
  // Sanctions screening failure contract
  // -------------------------------------------------------------------------

  describe('sanctions screening failure contract', () => {
    function makeScreenedService(screenResult: SanctionsScreenResult) {
      const pool = makePool();
      const investmentRepo = new InvestmentRepository(pool as unknown as Pool);
      const offeringRepo = new OfferingRepository(pool as unknown as Pool);
      const userRepo = {
        findById: jest.fn().mockResolvedValue(makeUser({ name: 'Jane Doe' })),
      } as unknown as UserRepository;
      const screening = {
        screen: jest.fn().mockResolvedValue(screenResult),
      } as unknown as SanctionsScreeningService;
      const audit = {
        createAuditLog: jest.fn().mockResolvedValue(undefined),
      } as unknown as AuditLogRepository;
      const service = new InvestmentService(
        investmentRepo,
        offeringRepo,
        undefined,
        userRepo,
        screening,
        audit,
      );
      pool.query.mockResolvedValueOnce(ok([makeOffering({ status: 'active' })]));
      return { service, pool, audit };
    }

    it('fails closed with FORBIDDEN / 403 on a confirmed list match', async () => {
      const { service, pool, audit } = makeScreenedService({
        complete: true,
        versions: { ofac: '2026-01-01' },
        matches: [
          {
            source: 'ofac',
            version: '2026-01-01',
            listName: 'Eve',
            matchType: 'exact',
            matchedName: 'Eve',
          },
        ],
        cleared: false,
      });

      const error = await captureError(service.createInvestment(baseInput));
      expect((error as AppError).code).toBe(ErrorCode.FORBIDDEN);
      expect((error as AppError).statusCode).toBe(403);
      expect(investmentInserts(pool)).toHaveLength(0);
      expect(audit.createAuditLog).toHaveBeenCalledTimes(1);
    });

    it('fails closed with SERVICE_UNAVAILABLE / 503 when the lists are unavailable', async () => {
      const { service, pool, audit } = makeScreenedService({
        complete: false,
        versions: { ofac: '2026-01-01' },
        matches: [],
        cleared: false,
      });

      const error = await captureError(service.createInvestment(baseInput));
      expect((error as AppError).code).toBe(ErrorCode.SERVICE_UNAVAILABLE);
      expect((error as AppError).statusCode).toBe(503);
      expect(investmentInserts(pool)).toHaveLength(0);
      expect(audit.createAuditLog).toHaveBeenCalledTimes(1);
    });
  });
});
