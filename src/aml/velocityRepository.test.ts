import { PgVelocityRepository } from './velocityRepository';

describe('PgVelocityRepository', () => {
  it('upserts an aggregate with JSON fields and maps the returned row', async () => {
    const row = {
      id: 'vel-1',
      investor_id: 'investor-1',
      window_start: '2026-01-01T00:00:00.000Z',
      window_end: '2026-01-01T01:00:00.000Z',
      window_minutes: 60,
      tx_count: 3,
      total_amount: '450.25',
      investment_ids: ['a', 'b', 'c'],
      amount_exceeded: false,
      count_exceeded: true,
      threshold_amount: '1000',
      threshold_count: 2,
      rule_id: 'rule-1',
      rule_version: { major: 1, minor: 0, patch: 0 },
      created_at: '2026-01-01T01:00:00.000Z',
      updated_at: '2026-01-01T01:00:00.000Z',
    };
    const query = jest.fn().mockResolvedValue({ rows: [row] });
    const repository = new PgVelocityRepository({ query } as any);

    const result = await repository.upsert({
      investor_id: 'investor-1',
      window_start: new Date(row.window_start),
      window_end: new Date(row.window_end),
      window_minutes: 60,
      tx_count: 3,
      total_amount: 450.25,
      investment_ids: ['a', 'b', 'c'],
      amount_exceeded: false,
      count_exceeded: true,
      threshold_amount: 1000,
      threshold_count: 2,
      rule_id: 'rule-1',
      rule_version: row.rule_version,
    });

    expect(query.mock.calls[0][1][6]).toBe('["a","b","c"]');
    expect(query.mock.calls[0][0]).toContain('ON CONFLICT (investor_id, window_start, window_end, rule_id)');
    expect(result.total_amount).toBe(450.25);
    expect(result.window_end).toEqual(new Date(row.window_end));
  });

  it('queries investor windows in descending order and maps JSON strings', async () => {
    const row = {
      id: 'vel-1', investor_id: 'investor-1',
      window_start: '2026-01-01T00:00:00.000Z', window_end: '2026-01-01T01:00:00.000Z',
      window_minutes: 60, tx_count: 1, total_amount: '10', investment_ids: '["a"]',
      amount_exceeded: false, count_exceeded: false, threshold_amount: null, threshold_count: null,
      rule_id: 'rule-1', rule_version: '{"major":1,"minor":0,"patch":0}',
      created_at: '2026-01-01T01:00:00.000Z', updated_at: '2026-01-01T01:00:00.000Z',
    };
    const query = jest.fn().mockResolvedValue({ rows: [row] });
    const repository = new PgVelocityRepository({ query } as any);

    const results = await repository.findByInvestor('investor-1', new Date('2026-01-01T00:00:00Z'), new Date('2026-01-02T00:00:00Z'));

    expect(query.mock.calls[0][1]).toEqual([
      'investor-1', new Date('2026-01-01T00:00:00Z'), new Date('2026-01-02T00:00:00Z'),
    ]);
    expect(query.mock.calls[0][0]).toContain('ORDER BY window_end DESC');
    expect(results[0].investment_ids).toEqual(['a']);
    expect(results[0].rule_version.major).toBe(1);
  });
});