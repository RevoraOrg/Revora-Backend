/**
 * Dedicated test suite for src/lib/latency-budgets.ts
 *
 * Covers:
 * - LatencyBudgetConfig shape / contract
 * - HOT_ROUTE_BUDGETS catalogue (all three documented routes)
 * - getLatencyBudget() – success paths, case-insensitive method matching,
 *   path normalisation, and missing-route boundary
 * - getAllBudgetedRoutes() – immutability guarantee
 * - Invalid / boundary inputs
 * - Primary "state transitions" – mutations to the returned objects must not
 *   affect the canonical catalogue (defensive copy semantics)
 *
 * Security Assumptions:
 * - Budget values are compile-time constants; test validates values have not
 *   drifted from the documented SLA targets.
 * - Path lookup is case-insensitive for the HTTP method but case-sensitive
 *   for the path, matching real router behaviour.
 *
 * @module lib/latency-budgets.test
 */

import {
  HOT_ROUTE_BUDGETS,
  LatencyBudgetConfig,
  getLatencyBudget,
  getAllBudgetedRoutes,
} from './latency-budgets';

// ─── LatencyBudgetConfig contract ────────────────────────────────────────────

describe('LatencyBudgetConfig', () => {
  it('every entry in HOT_ROUTE_BUDGETS satisfies the interface shape', () => {
    for (const budget of HOT_ROUTE_BUDGETS) {
      // Required string fields
      expect(typeof budget.name).toBe('string');
      expect(budget.name.length).toBeGreaterThan(0);

      expect(typeof budget.method).toBe('string');
      expect(budget.method.length).toBeGreaterThan(0);

      expect(typeof budget.path).toBe('string');
      expect(budget.path.length).toBeGreaterThan(0);

      // Required numeric field
      expect(typeof budget.p99BudgetMs).toBe('number');
      expect(Number.isFinite(budget.p99BudgetMs)).toBe(true);
      expect(budget.p99BudgetMs).toBeGreaterThan(0);

      // Optional description field – when present must be a non-empty string
      if (budget.description !== undefined) {
        expect(typeof budget.description).toBe('string');
        expect(budget.description.length).toBeGreaterThan(0);
      }
    }
  });

  it('budget values are positive integers (no fractional milliseconds)', () => {
    for (const budget of HOT_ROUTE_BUDGETS) {
      expect(Number.isInteger(budget.p99BudgetMs)).toBe(true);
    }
  });
});

// ─── HOT_ROUTE_BUDGETS catalogue ─────────────────────────────────────────────

describe('HOT_ROUTE_BUDGETS', () => {
  it('contains exactly three entries', () => {
    expect(HOT_ROUTE_BUDGETS).toHaveLength(3);
  });

  it('defines GET /api/v1/health with a 200 ms budget', () => {
    const health = HOT_ROUTE_BUDGETS.find(
      (b) => b.method === 'GET' && b.path === '/api/v1/health',
    );
    expect(health).toBeDefined();
    expect(health!.name).toBe('Health Check');
    expect(health!.p99BudgetMs).toBe(200);
  });

  it('defines POST /api/v1/offerings/validation-matrix with a 250 ms budget', () => {
    const vm = HOT_ROUTE_BUDGETS.find(
      (b) => b.method === 'POST' && b.path === '/api/v1/offerings/validation-matrix',
    );
    expect(vm).toBeDefined();
    expect(vm!.name).toBe('Offering Validation Matrix');
    expect(vm!.p99BudgetMs).toBe(250);
  });

  it('defines POST /api/investments with a 500 ms budget', () => {
    const inv = HOT_ROUTE_BUDGETS.find(
      (b) => b.method === 'POST' && b.path === '/api/investments',
    );
    expect(inv).toBeDefined();
    expect(inv!.name).toBe('Create Investment');
    expect(inv!.p99BudgetMs).toBe(500);
  });

  it('health route has a smaller budget than the investment route', () => {
    const health = HOT_ROUTE_BUDGETS.find((b) => b.path === '/api/v1/health')!;
    const invest = HOT_ROUTE_BUDGETS.find((b) => b.path === '/api/investments')!;
    expect(health.p99BudgetMs).toBeLessThan(invest.p99BudgetMs);
  });

  it('all routes have a description field explaining the rationale', () => {
    for (const budget of HOT_ROUTE_BUDGETS) {
      expect(budget.description).toBeDefined();
      expect((budget.description as string).length).toBeGreaterThan(0);
    }
  });

  it('paths start with a leading slash', () => {
    for (const budget of HOT_ROUTE_BUDGETS) {
      expect(budget.path.startsWith('/')).toBe(true);
    }
  });

  it('methods are uppercase', () => {
    for (const budget of HOT_ROUTE_BUDGETS) {
      expect(budget.method).toBe(budget.method.toUpperCase());
    }
  });
});

// ─── getLatencyBudget – success paths ────────────────────────────────────────

describe('getLatencyBudget()', () => {
  describe('exact matches', () => {
    it('returns the Health Check budget', () => {
      const result = getLatencyBudget('GET', '/api/v1/health');
      expect(result).toBeDefined();
      expect(result!.name).toBe('Health Check');
      expect(result!.p99BudgetMs).toBe(200);
    });

    it('returns the Offering Validation Matrix budget', () => {
      const result = getLatencyBudget('POST', '/api/v1/offerings/validation-matrix');
      expect(result).toBeDefined();
      expect(result!.name).toBe('Offering Validation Matrix');
      expect(result!.p99BudgetMs).toBe(250);
    });

    it('returns the Create Investment budget', () => {
      const result = getLatencyBudget('POST', '/api/investments');
      expect(result).toBeDefined();
      expect(result!.name).toBe('Create Investment');
      expect(result!.p99BudgetMs).toBe(500);
    });
  });

  describe('case-insensitive method matching', () => {
    it('matches lowercase method', () => {
      const result = getLatencyBudget('get', '/api/v1/health');
      expect(result).toBeDefined();
      expect(result!.name).toBe('Health Check');
    });

    it('matches mixed-case method', () => {
      const result = getLatencyBudget('Get', '/api/v1/health');
      expect(result).toBeDefined();
    });

    it('matches uppercase POST as expected', () => {
      const result = getLatencyBudget('POST', '/api/investments');
      expect(result).toBeDefined();
    });

    it('matches lowercase post', () => {
      const result = getLatencyBudget('post', '/api/investments');
      expect(result).toBeDefined();
    });
  });

  describe('path normalisation', () => {
    it('ignores a trailing slash on the requested path', () => {
      // normalizePath strips trailing slashes
      const result = getLatencyBudget('GET', '/api/v1/health/');
      expect(result).toBeDefined();
      expect(result!.name).toBe('Health Check');
    });

    it('matches when the path has multiple leading slashes stripped to one', () => {
      // normalizePath collapses multiple leading slashes to a single one
      const result = getLatencyBudget('GET', '//api/v1/health');
      expect(result).toBeDefined();
      expect(result!.name).toBe('Health Check');
    });

    it('returns the same config regardless of trailing slash presence', () => {
      const withSlash = getLatencyBudget('POST', '/api/investments/');
      const withoutSlash = getLatencyBudget('POST', '/api/investments');
      expect(withSlash).toBeDefined();
      expect(withoutSlash).toBeDefined();
      expect(withSlash!.name).toBe(withoutSlash!.name);
    });
  });

  describe('non-matching / boundary inputs', () => {
    it('returns undefined for a path not in the catalogue', () => {
      expect(getLatencyBudget('GET', '/api/v1/unknown')).toBeUndefined();
    });

    it('returns undefined for a valid path with the wrong method', () => {
      // /api/v1/health is GET-only in the catalogue
      expect(getLatencyBudget('POST', '/api/v1/health')).toBeUndefined();
    });

    it('returns undefined for an empty path', () => {
      expect(getLatencyBudget('GET', '')).toBeUndefined();
    });

    it('returns undefined for an empty method', () => {
      expect(getLatencyBudget('', '/api/v1/health')).toBeUndefined();
    });

    it('returns undefined for both empty method and path', () => {
      expect(getLatencyBudget('', '')).toBeUndefined();
    });

    it('returns undefined for a DELETE against a catalogued path', () => {
      expect(getLatencyBudget('DELETE', '/api/investments')).toBeUndefined();
    });

    it('path matching is case-sensitive', () => {
      // The catalogued path is lowercase; upper-cased variant must not match
      expect(getLatencyBudget('GET', '/API/V1/HEALTH')).toBeUndefined();
    });
  });

  describe('return value contract', () => {
    it('the returned object satisfies LatencyBudgetConfig fully', () => {
      const budget: LatencyBudgetConfig | undefined = getLatencyBudget('GET', '/api/v1/health');
      expect(budget).toBeDefined();
      const b = budget as LatencyBudgetConfig;
      expect(b.name).toEqual(expect.any(String));
      expect(b.method).toEqual(expect.any(String));
      expect(b.path).toEqual(expect.any(String));
      expect(b.p99BudgetMs).toEqual(expect.any(Number));
    });
  });
});

// ─── getAllBudgetedRoutes ─────────────────────────────────────────────────────

describe('getAllBudgetedRoutes()', () => {
  it('returns the same number of entries as HOT_ROUTE_BUDGETS', () => {
    expect(getAllBudgetedRoutes()).toHaveLength(HOT_ROUTE_BUDGETS.length);
  });

  it('contains all three hot routes', () => {
    const routes = getAllBudgetedRoutes();
    const paths = routes.map((r) => `${r.method} ${r.path}`);
    expect(paths).toContain('GET /api/v1/health');
    expect(paths).toContain('POST /api/v1/offerings/validation-matrix');
    expect(paths).toContain('POST /api/investments');
  });

  it('returns a defensive copy – mutating the result does not affect the catalogue', () => {
    const copy1 = getAllBudgetedRoutes();
    const copy2 = getAllBudgetedRoutes();

    // Verify they are different array references
    expect(copy1).not.toBe(copy2);

    // Mutate copy1 and confirm copy2 (and HOT_ROUTE_BUDGETS) are unaffected
    (copy1 as LatencyBudgetConfig[]).push({
      name: 'Injected',
      method: 'DELETE',
      path: '/api/injected',
      p99BudgetMs: 1,
    });

    expect(getAllBudgetedRoutes()).toHaveLength(3);
    expect(HOT_ROUTE_BUDGETS).toHaveLength(3);
  });

  it('each entry carries all required fields', () => {
    for (const budget of getAllBudgetedRoutes()) {
      expect(budget.name).toBeDefined();
      expect(budget.method).toBeDefined();
      expect(budget.path).toBeDefined();
      expect(budget.p99BudgetMs).toBeGreaterThan(0);
    }
  });
});

// ─── State transitions / mutation guard ──────────────────────────────────────

describe('state transitions (mutation safety)', () => {
  it('mutating an object returned by getLatencyBudget does not alter the catalogue', () => {
    const budget = getLatencyBudget('GET', '/api/v1/health') as LatencyBudgetConfig;
    const originalBudgetMs = budget.p99BudgetMs;

    // Attempt to mutate (TypeScript allows this at runtime without readonly)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (budget as any).p99BudgetMs = 1;

    // The catalogue must still report the original value
    const fresh = getLatencyBudget('GET', '/api/v1/health')!;
    expect(fresh.p99BudgetMs).toBe(originalBudgetMs);
  });

  it('adding a property to a returned object does not pollute the catalogue', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const budget = getLatencyBudget('POST', '/api/investments') as any;
    budget.__injected = true;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fresh = getLatencyBudget('POST', '/api/investments') as any;
    expect(fresh.__injected).toBeUndefined();
  });

  it('reassigning a field on an entry from getAllBudgetedRoutes does not mutate the source', () => {
    const [first] = getAllBudgetedRoutes();
    const originalName = first.name;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (first as any).name = 'REPLACED';

    const [freshFirst] = getAllBudgetedRoutes();
    expect(freshFirst.name).toBe(originalName);
  });
});

// ─── Deterministic / observable error behaviour ───────────────────────────────

describe('deterministic boundary behaviour', () => {
  it('getLatencyBudget consistently returns the same object shape across multiple calls', () => {
    const a = getLatencyBudget('GET', '/api/v1/health');
    const b = getLatencyBudget('GET', '/api/v1/health');
    expect(a).toEqual(b);
  });

  it('getLatencyBudget result deep-equals the corresponding HOT_ROUTE_BUDGETS entry', () => {
    const result = getLatencyBudget('POST', '/api/v1/offerings/validation-matrix');
    const canonical = HOT_ROUTE_BUDGETS.find(
      (b) => b.path === '/api/v1/offerings/validation-matrix',
    );
    expect(result).toEqual(canonical);
  });

  it('getAllBudgetedRoutes is idempotent across calls', () => {
    expect(getAllBudgetedRoutes()).toEqual(getAllBudgetedRoutes());
  });

  it('getLatencyBudget with whitespace-padded paths does not match', () => {
    // normalizePath does not trim whitespace – callers are responsible for
    // passing clean paths, just like real routers do
    expect(getLatencyBudget('GET', ' /api/v1/health')).toBeUndefined();
    expect(getLatencyBudget('GET', '/api/v1/health ')).toBeUndefined();
  });

  it('budget values reflect documented SLA targets', () => {
    // These specific values are contractual; a change here is a breaking
    // change to the production SLA and must be deliberate.
    expect(getLatencyBudget('GET', '/api/v1/health')!.p99BudgetMs).toBe(200);
    expect(
      getLatencyBudget('POST', '/api/v1/offerings/validation-matrix')!.p99BudgetMs,
    ).toBe(250);
    expect(getLatencyBudget('POST', '/api/investments')!.p99BudgetMs).toBe(500);
  });
});
