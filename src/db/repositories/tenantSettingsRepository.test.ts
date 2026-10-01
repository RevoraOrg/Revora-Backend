import { QueryResult } from 'pg';
import { TenantSettingsRepository } from './tenantSettingsRepository';

/**
 * Regression suite for `src/db/repositories/tenantSettingsRepository.ts`.
 *
 * Branch evidence: `findByTenantId` returns `null` when the tenant has no row
 * (`src/db/repositories/tenantSettingsRepository.ts:24`) — a missing tenant is a
 * legitimate "no settings yet" answer, not an error. These tests pin that
 * contract plus the neighbouring paths: the parameterized `LIMIT 1` lookup, the
 * `settings ?? {}` default in `mapRow`, and the idempotent upsert that
 * re-serializes settings and writes the session policy as a bound parameter.
 */

function mockResult(rows: unknown[]): QueryResult<any> {
  return { rows, rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] };
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    tenant_id: 'tenant-1',
    settings: { theme: 'dark' },
    session_policy: 'strict',
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    updated_at: new Date('2026-01-02T00:00:00.000Z'),
    ...overrides,
  };
}

describe('TenantSettingsRepository', () => {
  let pool: { query: jest.Mock };
  let repo: TenantSettingsRepository;

  beforeEach(() => {
    pool = { query: jest.fn() };
    repo = new TenantSettingsRepository(pool as never);
  });

  describe('findByTenantId', () => {
    it('returns null when the tenant has no settings row', async () => {
      pool.query.mockResolvedValueOnce(mockResult([]));

      await expect(repo.findByTenantId('tenant-missing')).resolves.toBeNull();
    });

    it('reads a single row by parameterized tenant id', async () => {
      pool.query.mockResolvedValueOnce(mockResult([row()]));

      const settings = await repo.findByTenantId('tenant-1');

      expect(settings).toEqual({
        tenant_id: 'tenant-1',
        settings: { theme: 'dark' },
        session_policy: 'strict',
        created_at: new Date('2026-01-01T00:00:00.000Z'),
        updated_at: new Date('2026-01-02T00:00:00.000Z'),
      });
      const [sql, params] = pool.query.mock.calls[0];
      expect(sql).toContain('FROM tenant_settings');
      expect(sql).toContain('WHERE tenant_id = $1');
      expect(sql).toContain('LIMIT 1');
      expect(params).toEqual(['tenant-1']);
    });

    it('does not interpolate the tenant id into the SQL string', async () => {
      pool.query.mockResolvedValueOnce(mockResult([]));
      const injection = "' OR 1=1 --";

      await repo.findByTenantId(injection);

      const [sql, params] = pool.query.mock.calls[0];
      expect(sql).not.toContain('OR 1=1');
      expect(params).toEqual([injection]);
    });

    it('propagates database errors rather than reporting them as "no settings"', async () => {
      pool.query.mockRejectedValueOnce(new Error('connection terminated'));

      await expect(repo.findByTenantId('tenant-1')).rejects.toThrow('connection terminated');
    });

    it.each([
      ['null', null],
      ['undefined', undefined],
    ])('defaults a %s settings column to an empty object', async (_label, settings) => {
      pool.query.mockResolvedValueOnce(mockResult([row({ settings })]));

      const result = await repo.findByTenantId('tenant-1');

      expect(result?.settings).toEqual({});
    });

    it('preserves an explicitly empty settings object', async () => {
      pool.query.mockResolvedValueOnce(mockResult([row({ settings: {} })]));

      const result = await repo.findByTenantId('tenant-1');

      expect(result?.settings).toEqual({});
    });
  });

  describe('upsertSettings', () => {
    it('inserts with the default lax session policy and returns the stored row', async () => {
      pool.query.mockResolvedValueOnce(mockResult([row({ session_policy: 'lax' })]));

      const saved = await repo.upsertSettings('tenant-1', { theme: 'dark' });

      expect(saved.session_policy).toBe('lax');
      const [sql, params] = pool.query.mock.calls[0];
      expect(sql).toContain('INSERT INTO tenant_settings');
      expect(sql).toContain('ON CONFLICT (tenant_id)');
      expect(sql).toContain('DO UPDATE SET settings = $2, session_policy = $3, updated_at = NOW()');
      expect(sql).toContain('RETURNING tenant_id, settings, session_policy, created_at, updated_at');
      expect(params).toEqual(['tenant-1', JSON.stringify({ theme: 'dark' }), 'lax']);
    });

    it('honours an explicit strict session policy', async () => {
      pool.query.mockResolvedValueOnce(mockResult([row({ session_policy: 'strict' })]));

      await repo.upsertSettings('tenant-1', { theme: 'dark' }, 'strict');

      expect(pool.query.mock.calls[0][1][2]).toBe('strict');
    });

    it('serializes nested settings instead of passing a raw object to pg', async () => {
      pool.query.mockResolvedValueOnce(mockResult([row()]));
      const settings = { limits: { seats: 25, tiers: ['a', 'b'] }, flags: { beta: true } };

      await repo.upsertSettings('tenant-1', settings);

      const params = pool.query.mock.calls[0][1];
      expect(params[1]).toBe(JSON.stringify(settings));
      expect(typeof params[1]).toBe('string');
    });

    it('serializes an empty settings object as "{}"', async () => {
      pool.query.mockResolvedValueOnce(mockResult([row({ settings: {} })]));

      await repo.upsertSettings('tenant-1', {});

      expect(pool.query.mock.calls[0][1][1]).toBe('{}');
    });

    it('propagates upsert failures', async () => {
      pool.query.mockRejectedValueOnce(new Error('deadlock detected'));

      await expect(repo.upsertSettings('tenant-1', {})).rejects.toThrow('deadlock detected');
    });

    it('maps a returned row with a null settings column to an empty object', async () => {
      pool.query.mockResolvedValueOnce(mockResult([row({ settings: null })]));

      const saved = await repo.upsertSettings('tenant-1', { theme: 'dark' });

      expect(saved.settings).toEqual({});
    });
  });
});
