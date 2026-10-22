import { Pool } from 'pg';
import { AMLService } from '../aml/amlService';
import { AppError, ErrorCode } from '../lib/errors';
import { createInvestmentServiceWithScreening } from './investmentServiceSetup';

const identity = {
  investor_id: 'investor-123',
  offering_id: 'offering-abc',
  amount: '1000.00',
  asset: 'USDC',
};

const supportedSources = ['ofac', 'eu_consolidated', 'uk_hmt'];

function makeSnapshots(entries: Record<string, unknown>[] = []) {
  return supportedSources.map((list_source) => ({
    id: `${list_source}-snapshot`,
    list_source,
    version: `${list_source}-2026-01-01`,
    entry_count: entries.length,
    normalized_checksum: 'checksum',
    entries,
    created_at: new Date('2026-01-01T00:00:00.000Z'),
  }));
}

function makePool(snapshots = makeSnapshots()) {
  const query = jest.fn(async (sql: string) => {
    if (/FROM offerings/i.test(sql)) {
      return { rows: [{ id: identity.offering_id, status: 'active', target_amount: '1000000' }] };
    }
    if (/FROM users/i.test(sql)) {
      return {
        rows: [{
          id: identity.investor_id,
          email: 'investor@example.com',
          password_hash: 'hash',
          name: 'Jane Doe',
          role: 'investor',
          kyc_risk_tier: 'standard',
        }],
      };
    }
    if (/FROM sanctions_screening_snapshots/i.test(sql)) {
      return { rows: snapshots };
    }
    if (/INSERT INTO investments/i.test(sql)) {
      return {
        rows: [{
          id: 'investment-1',
          ...identity,
          status: 'pending',
          created_at: new Date('2026-01-02T00:00:00.000Z'),
          updated_at: new Date('2026-01-02T00:00:00.000Z'),
        }],
      };
    }
    if (/INSERT INTO audit_logs/i.test(sql)) {
      return { rows: [{ id: 'audit-1', created_at: new Date('2026-01-02T00:00:00.000Z') }] };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  return { query } as unknown as Pool & { query: jest.Mock };
}

function queriesMatching(pool: Pool & { query: jest.Mock }, pattern: RegExp) {
  return pool.query.mock.calls.filter(([sql]) => pattern.test(String(sql)));
}

describe('createInvestmentServiceWithScreening', () => {
  it('screens the investor and persists a passed result before returning the investment', async () => {
    const pool = makePool();
    const amlService = { evaluateTransaction: jest.fn().mockResolvedValue([]) } as unknown as AMLService;
    const service = createInvestmentServiceWithScreening(pool, amlService);

    const result = await service.createInvestment(identity);

    expect(result.id).toBe('investment-1');
    expect(amlService.evaluateTransaction).toHaveBeenCalledWith(expect.objectContaining({
      investment_id: 'investment-1',
      investor_id: identity.investor_id,
      offering_id: identity.offering_id,
    }));
    const investmentInsert = queriesMatching(pool, /INSERT INTO investments/i);
    expect(investmentInsert).toHaveLength(1);
    expect(investmentInsert[0][1]).toEqual(expect.arrayContaining([
      'passed',
      'ofac-2026-01-01',
    ]));
    expect(JSON.parse(investmentInsert[0][1][8])).toEqual(expect.objectContaining({
      complete: true,
      cleared: true,
      matches: [],
    }));
    expect(queriesMatching(pool, /FROM sanctions_screening_snapshots/i)).toHaveLength(1);
  });

  it.each([
    ['invalid amount', { amount: 'not-a-number' }],
    ['empty asset', { asset: '  ' }],
  ])('rejects %s before screening or persistence', async (_caseName, overrides) => {
    const pool = makePool();
    const service = createInvestmentServiceWithScreening(pool);

    await expect(service.createInvestment({ ...identity, ...overrides })).rejects.toBeInstanceOf(AppError);

    expect(queriesMatching(pool, /FROM sanctions_screening_snapshots/i)).toHaveLength(0);
    expect(queriesMatching(pool, /INSERT INTO investments/i)).toHaveLength(0);
  });

  it('rejects a sanctions match, audits the block, and does not persist the investment', async () => {
    const pool = makePool(makeSnapshots([{
      uid: 'entity-1',
      name: 'Jane Doe',
      aliases: [],
    }]));
    const service = createInvestmentServiceWithScreening(pool);

    await expect(service.createInvestment(identity)).rejects.toMatchObject({
      code: ErrorCode.FORBIDDEN,
      statusCode: 403,
    });

    expect(queriesMatching(pool, /INSERT INTO investments/i)).toHaveLength(0);
    const auditInsert = queriesMatching(pool, /INSERT INTO audit_logs/i);
    expect(auditInsert).toHaveLength(1);
    const auditDetails = JSON.parse(auditInsert[0][1][3]);
    expect(auditDetails).toEqual(expect.objectContaining({
      screening_status: 'blocked',
      blocked: true,
      reviewer_queue_link: '/api/v1/aml/ofac-reviews',
    }));
  });

  it('fails closed and audits when the screening lists are incomplete', async () => {
    const pool = makePool(makeSnapshots().slice(0, 1));
    const service = createInvestmentServiceWithScreening(pool);

    await expect(service.createInvestment(identity)).rejects.toMatchObject({
      code: ErrorCode.SERVICE_UNAVAILABLE,
      statusCode: 503,
    });

    expect(queriesMatching(pool, /INSERT INTO investments/i)).toHaveLength(0);
    const auditInsert = queriesMatching(pool, /INSERT INTO audit_logs/i);
    expect(auditInsert).toHaveLength(1);
    expect(JSON.parse(auditInsert[0][1][3])).toEqual(expect.objectContaining({
      screening_status: 'error',
      blocked: false,
    }));
  });

  it('propagates screening repository failures without persisting an investment', async () => {
    const pool = makePool();
    pool.query.mockImplementation(async (sql: string) => {
      if (/FROM offerings/i.test(sql)) {
        return { rows: [{ id: identity.offering_id, status: 'active', target_amount: '1000000' }] };
      }
      if (/FROM users/i.test(sql)) {
        return { rows: [] };
      }
      if (/FROM sanctions_screening_snapshots/i.test(sql)) {
        throw new Error('database unavailable');
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const service = createInvestmentServiceWithScreening(pool);

    await expect(service.createInvestment(identity)).rejects.toThrow('database unavailable');
    expect(queriesMatching(pool, /INSERT INTO investments/i)).toHaveLength(0);
  });
});