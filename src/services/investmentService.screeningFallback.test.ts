import { Pool, QueryResult } from 'pg';
import { Investment, InvestmentRepository } from '../db/repositories/investmentRepository';
import { OfferingRepository, Offering } from '../db/repositories/offeringRepository';
import { UserRepository, User } from '../db/repositories/userRepository';
import { AuditLogRepository } from '../db/repositories/auditLogRepository';
import {
  InvestmentService,
  CreateInvestmentRequest,
} from './investmentService';
import {
  SanctionsScreenResult,
  SanctionsScreeningService,
} from './sanctionsScreeningService';

/**
 * Regression suite for the `CreateInvestmentRequest` screening fallback in
 * `investmentService.ts` (`if (!this.screeningService) return null;`).
 *
 * The screening step is opt-in: when no `SanctionsScreeningService` is wired in,
 * `screenInvestment` returns `null` and the submission must be persisted exactly
 * as before the screening feature existed — no `screening_status`, no list
 * version, no `screening_result` and no compliance audit entry.  When a service
 * *is* wired in, the identity list handed to `screen()` must contain the
 * investor (resolved name or raw id) plus every non-blank beneficial owner.
 *
 * INSERT parameter positions asserted below come from
 * `InvestmentRepository.create`:
 *   0 investor_id · 1 offering_id · 2 amount · 3 asset · 4 status
 *   5 tx_hash · 6 screening_status · 7 screening_list_version · 8 screening_result
 */
const P = {
  investorId: 0,
  offeringId: 1,
  amount: 2,
  asset: 3,
  status: 4,
  txHash: 5,
  screeningStatus: 6,
  screeningListVersion: 7,
  screeningResult: 8,
} as const;

const BASE_INPUT: CreateInvestmentRequest = {
  investor_id: 'investor-123',
  offering_id: 'offering-abc',
  amount: '1000.00',
  asset: 'USDC',
};

function makeMockPool(): { query: jest.Mock } {
  return { query: jest.fn() };
}

function mockQueryResult(rows: unknown[]): QueryResult<any> {
  return { rows, rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] };
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

function makeInvestmentRow(override: Partial<Investment> = {}): Investment {
  return {
    id: 'inv-1',
    investor_id: 'investor-123',
    offering_id: 'offering-abc',
    amount: '1000.00',
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
    name: 'Jane Doe',
    role: 'investor',
    kyc_risk_tier: 'standard',
    created_at: new Date('2024-01-01'),
    updated_at: new Date('2024-01-01'),
    ...override,
  };
}

interface Harness {
  service: InvestmentService;
  pool: { query: jest.Mock };
  screen: jest.Mock;
  auditCreate: jest.Mock;
}

/**
 * Build a service whose offering lookup and INSERT are served by a mock pool,
 * with the screening service / user repo / audit log supplied as jest fakes.
 */
function buildHarness(opts: {
  /** `null` means "no screening service is configured at all". */
  screenResult?: SanctionsScreenResult | null;
  withScreeningService?: boolean;
  withUserRepo?: boolean;
  user?: User | null;
  insertRow?: Investment;
}): Harness {
  const pool = makeMockPool();
  const investmentRepo = new InvestmentRepository(pool as unknown as Pool);
  const offeringRepo = new OfferingRepository(pool as unknown as Pool);

  const screen = jest.fn().mockResolvedValue(opts.screenResult ?? null);
  const screeningService =
    opts.withScreeningService === false
      ? undefined
      : ({ screen } as unknown as SanctionsScreeningService);

  const userRepo =
    opts.withUserRepo === false
      ? undefined
      : ({
          findById: jest.fn().mockResolvedValue(opts.user === undefined ? makeUser() : opts.user),
        } as unknown as UserRepository);

  const auditCreate = jest.fn().mockResolvedValue(undefined);
  const auditLogRepo = { createAuditLog: auditCreate } as unknown as AuditLogRepository;

  const service = new InvestmentService(
    investmentRepo,
    offeringRepo,
    undefined,
    userRepo,
    screeningService,
    auditLogRepo,
  );

  const insertRow = opts.insertRow ?? makeInvestmentRow();
  pool.query
    .mockResolvedValueOnce(mockQueryResult([makeOfferingRow({ status: 'active' })]))
    .mockResolvedValueOnce({
      rows: [insertRow],
      rowCount: 1,
      command: 'INSERT',
      oid: 0,
      fields: [],
    } as QueryResult<Investment>);

  return { service, pool, screen, auditCreate };
}

function insertCall(pool: { query: jest.Mock }): unknown[] {
  const call = pool.query.mock.calls.find((c) =>
    /INSERT\s+INTO\s+investments/i.test(String(c[0])),
  );
  if (!call) throw new Error('expected an INSERT INTO investments query');
  return call[1] as unknown[];
}

describe('InvestmentService screening fallback', () => {
  it('persists the investment without screening columns when no screening service is configured', async () => {
    const { service, pool, screen, auditCreate } = buildHarness({
      withScreeningService: false,
    });

    const result = await service.createInvestment(BASE_INPUT);

    expect(result).toEqual(makeInvestmentRow());
    expect(screen).not.toHaveBeenCalled();

    const values = insertCall(pool);
    expect(values[P.screeningStatus]).toBeNull();
    expect(values[P.screeningListVersion]).toBeNull();
    expect(values[P.screeningResult]).toBeNull();
    expect(values[P.status]).toBe('pending');
    expect(auditCreate).not.toHaveBeenCalled();
  });

  it('treats a null screen result as "not screened" — no metadata and no audit entry', async () => {
    const { service, pool, screen, auditCreate } = buildHarness({ screenResult: null });

    await service.createInvestment(BASE_INPUT);

    // The service was invoked, so the opt-out path is not what produced this.
    expect(screen).toHaveBeenCalledTimes(1);
    expect(screen).toHaveBeenCalledWith(['Jane Doe']);

    const values = insertCall(pool);
    expect(values[P.screeningStatus]).toBeNull();
    expect(values[P.screeningListVersion]).toBeNull();
    expect(values[P.screeningResult]).toBeNull();
    expect(auditCreate).not.toHaveBeenCalled();
  });

  it('falls back to the raw investor id when the resolved user has no name', async () => {
    const { service, screen } = buildHarness({
      screenResult: {
        complete: true,
        versions: { ofac: '2026-01-01', eu_consolidated: 'x', uk_hmt: 'y' },
        matches: [],
        cleared: true,
      },
      user: makeUser({ name: undefined }),
    });

    await service.createInvestment(BASE_INPUT);

    expect(screen).toHaveBeenCalledWith(['investor-123']);
  });

  it('falls back to the raw investor id when no user repository is configured', async () => {
    const { service, screen } = buildHarness({
      screenResult: {
        complete: true,
        versions: { ofac: '2026-01-01', eu_consolidated: 'x', uk_hmt: 'y' },
        matches: [],
        cleared: true,
      },
      withUserRepo: false,
    });

    await service.createInvestment(BASE_INPUT);

    expect(screen).toHaveBeenCalledWith(['investor-123']);
  });

  it('drops blank and whitespace-only beneficial owners before screening', async () => {
    const { service, screen } = buildHarness({
      screenResult: {
        complete: true,
        versions: { ofac: '2026-01-01', eu_consolidated: 'x', uk_hmt: 'y' },
        matches: [],
        cleared: true,
      },
    });

    await service.createInvestment({
      ...BASE_INPUT,
      beneficial_owners: ['', '   ', 'Eve Adams', '\t'],
    });

    expect(screen).toHaveBeenCalledWith(['Jane Doe', 'Eve Adams']);
  });

  it('records the screening metadata on the row when the identity is cleared', async () => {
    const { service, pool, auditCreate } = buildHarness({
      screenResult: {
        complete: true,
        versions: { ofac: '2026-01-01', eu_consolidated: 'eu-9', uk_hmt: 'uk-3' },
        matches: [],
        cleared: true,
      },
    });

    await service.createInvestment(BASE_INPUT);

    const values = insertCall(pool);
    expect(values[P.screeningStatus]).toBe('passed');
    expect(values[P.screeningListVersion]).toBe('2026-01-01');

    const payload = JSON.parse(values[P.screeningResult] as string);
    expect(payload).toMatchObject({
      complete: true,
      cleared: true,
      matches: [],
      versions: { ofac: '2026-01-01', eu_consolidated: 'eu-9', uk_hmt: 'uk-3' },
    });
    expect(typeof payload.screened_at).toBe('string');
    expect(auditCreate).not.toHaveBeenCalled();
  });

  it('leaves the list version unset when the cleared result carries no OFAC version', async () => {
    const { service, pool } = buildHarness({
      screenResult: {
        complete: true,
        versions: {},
        matches: [],
        cleared: true,
      },
    });

    await service.createInvestment(BASE_INPUT);

    const values = insertCall(pool);
    expect(values[P.screeningStatus]).toBe('passed');
    expect(values[P.screeningListVersion]).toBeNull();
  });

  it('never screens when the offering itself is rejected', async () => {
    const pool = makeMockPool();
    const investmentRepo = new InvestmentRepository(pool as unknown as Pool);
    const offeringRepo = new OfferingRepository(pool as unknown as Pool);
    const screen = jest.fn();
    const service = new InvestmentService(
      investmentRepo,
      offeringRepo,
      undefined,
      undefined,
      { screen } as unknown as SanctionsScreeningService,
      undefined,
    );

    pool.query.mockResolvedValueOnce(mockQueryResult([])); // offering lookup misses

    await expect(service.createInvestment(BASE_INPUT)).rejects.toThrow(
      /Offering offering-abc not found/,
    );
    expect(screen).not.toHaveBeenCalled();
    expect(insertCallSafe(pool)).toBeUndefined();
  });
});

function insertCallSafe(pool: { query: jest.Mock }): unknown[] | undefined {
  const call = pool.query.mock.calls.find((c) =>
    /INSERT\s+INTO\s+investments/i.test(String(c[0])),
  );
  return call ? (call[1] as unknown[]) : undefined;
}
