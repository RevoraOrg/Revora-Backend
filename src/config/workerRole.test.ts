/* eslint-disable @typescript-eslint/no-unsafe-argument */
import {
  resolveWorkerRole,
  getRoleConfig,
  VALID_ROLES,
  ROLE_MATRIX,
} from './workerRole';

// ─── resolveWorkerRole ────────────────────────────────────────────────────────

describe('resolveWorkerRole', () => {
  let exitSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    exitSpy = jest.spyOn(process, 'exit').mockReturnValue(undefined as never);
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    exitSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  describe('valid roles', () => {
    it('returns "api" when ROLE=api', () => {
      expect(resolveWorkerRole('api')).toBe('api');
    });

    it('returns "batch" when ROLE=batch', () => {
      expect(resolveWorkerRole('batch')).toBe('batch');
    });

    it('returns "all" when ROLE=all', () => {
      expect(resolveWorkerRole('all')).toBe('all');
    });
  });

  describe('test environment defaults', () => {
    it('defaults to "all" when ROLE is undefined in test env', () => {
      expect(resolveWorkerRole(undefined, 'test')).toBe('all');
    });

    it('defaults to "all" when ROLE is empty string in test env', () => {
      expect(resolveWorkerRole('', 'test')).toBe('all');
    });

    it('falls back to "development" when nodeEnv and NODE_ENV are both undefined', () => {
      const saved = process.env.NODE_ENV;
      try {
        delete (process.env as Record<string, string | undefined>).NODE_ENV;
        resolveWorkerRole(undefined, undefined);
        expect(exitSpy).toHaveBeenCalledWith(1);
      } finally {
        process.env.NODE_ENV = saved;
      }
    });
  });

  describe('invalid roles', () => {
    it('exits with code 1 for unknown role string', () => {
      resolveWorkerRole('web', 'production');
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('exits with code 1 for empty string in non-test env', () => {
      resolveWorkerRole('', 'production');
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('exits with code 1 for undefined in non-test env', () => {
      resolveWorkerRole(undefined, 'production');
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('prints actionable error message for unknown role', () => {
      resolveWorkerRole('worker', 'production');
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('"worker"'),
      );
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Valid roles are: api, batch, all'),
      );
    });

    it('prints (not set) when role is undefined', () => {
      resolveWorkerRole(undefined, 'production');
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('(not set)'),
      );
    });

    it('exits for case-sensitive misspelling', () => {
      resolveWorkerRole('API', 'production');
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('exits for role with whitespace', () => {
      resolveWorkerRole(' api ', 'production');
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });
});

// ─── getRoleConfig ────────────────────────────────────────────────────────────

describe('getRoleConfig', () => {
  it('api role enables httpServer and webhookQueue only', () => {
    const config = getRoleConfig('api');
    expect(config.httpServer).toBe(true);
    expect(config.webhookQueue).toBe(true);
    expect(config.auditPurge).toBe(false);
    expect(config.payoutDrift).toBe(false);
  });

  it('batch role enables auditPurge and payoutDrift only', () => {
    const config = getRoleConfig('batch');
    expect(config.httpServer).toBe(false);
    expect(config.webhookQueue).toBe(false);
    expect(config.auditPurge).toBe(true);
    expect(config.payoutDrift).toBe(true);
  });

  it('all role enables everything', () => {
    const config = getRoleConfig('all');
    expect(config.httpServer).toBe(true);
    expect(config.webhookQueue).toBe(true);
    expect(config.auditPurge).toBe(true);
    expect(config.payoutDrift).toBe(true);
  });

  it('returns a copy (not a reference to the matrix)', () => {
    const config1 = getRoleConfig('api');
    const config2 = getRoleConfig('api');
    expect(config1).not.toBe(config2);
    expect(config1).toEqual(config2);
  });
});

// ─── ROLE_MATRIX ──────────────────────────────────────────────────────────────

describe('ROLE_MATRIX', () => {
  it('covers all valid roles', () => {
    for (const role of VALID_ROLES) {
      expect(ROLE_MATRIX).toHaveProperty(role);
    }
  });

  it('has exactly the roles in VALID_ROLES', () => {
    const matrixKeys = Object.keys(ROLE_MATRIX);
    expect(matrixKeys.sort()).toEqual([...VALID_ROLES].sort());
  });

  it('api does not start batch services', () => {
    expect(ROLE_MATRIX.api.auditPurge).toBe(false);
    expect(ROLE_MATRIX.api.payoutDrift).toBe(false);
  });

  it('batch does not start hot-path services', () => {
    expect(ROLE_MATRIX.batch.httpServer).toBe(false);
    expect(ROLE_MATRIX.batch.webhookQueue).toBe(false);
  });

  it('all overlaps api + batch', () => {
    const all = ROLE_MATRIX.all;
    const api = ROLE_MATRIX.api;
    const batch = ROLE_MATRIX.batch;
    expect(all.httpServer).toBe(api.httpServer || batch.httpServer);
    expect(all.webhookQueue).toBe(api.webhookQueue || batch.webhookQueue);
    expect(all.auditPurge).toBe(api.auditPurge || batch.auditPurge);
    expect(all.payoutDrift).toBe(api.payoutDrift || batch.payoutDrift);
  });
});

// ─── VALID_ROLES ──────────────────────────────────────────────────────────────

describe('VALID_ROLES', () => {
  it('contains exactly three entries', () => {
    expect(VALID_ROLES).toHaveLength(3);
  });

  it('includes api, batch, all', () => {
    expect(VALID_ROLES).toContain('api');
    expect(VALID_ROLES).toContain('batch');
    expect(VALID_ROLES).toContain('all');
  });
});
