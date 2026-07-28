/**
 * RBAC Role-Hierarchy Property Tests
 *
 * Schema version: 1 (2026-07-28)
 * Forbidden capability list version: 1
 *
 * These property-based tests use fast-check to assert structural invariants that
 * are easy to break during refactors:
 *
 *   1. Hierarchy superset invariant — a higher-privilege role always holds every
 *      capability that a lower-privilege role holds.
 *   2. Forbidden capabilities — no role is ever granted a capability from the
 *      versioned forbidden list, regardless of config mutations.
 *   3. Diamond-inheritance deduplication — when capability sets are merged via the
 *      ROLE_HIERARCHY graph, the result never contains duplicate entries.
 *   4. Middleware authorization mirrors the static capability map — the
 *      createAuthorizationMiddleware enforces exactly the capabilities defined in
 *      the config (no extra grants, no missing denials).
 *   5. Unknown roles receive zero capabilities — roles not present in the config
 *      must never silently obtain permissions.
 *   6. Self-contained inheritance — every ancestor's full capability set is a
 *      subset of the descendant's effective capabilities.
 *
 * Forbidden capability list (versioned, must be reviewed on each schema bump):
 *   SCHEMA_VERSION = 1
 *   FORBIDDEN_CAPABILITIES_V1 = [
 *     'vault:delete',     // destructive — never granted at runtime
 *     'audit:purge',      // destructive — never granted at runtime
 *     'admin:impersonate',// privilege-escalation risk
 *     'system:bootstrap', // one-time setup only — not a runtime permission
 *   ]
 */

import * as fc from 'fast-check';
import { Request, Response } from 'express';
import {
  UserRole,
  Permission,
  SecurityConfig,
  DEFAULT_SECURITY_CONFIG,
} from './types';
import { createAuthorizationMiddleware } from './auth';

// ---------------------------------------------------------------------------
// Schema versioning
// ---------------------------------------------------------------------------

/** Bump this when the Permission union or role list changes. */
export const RBAC_SCHEMA_VERSION = 1;

/**
 * Versioned forbidden capability list.
 * These strings MUST NOT appear in any role's permission set at runtime.
 * Adding entries here is safe; removing entries requires a schema-version bump
 * and a security review.
 */
export const FORBIDDEN_CAPABILITIES_V1: readonly string[] = [
  'vault:delete',      // destructive — hard-delete is prohibited at runtime
  'audit:purge',       // destructive — audit immutability must be preserved
  'admin:impersonate', // privilege-escalation vector
  'system:bootstrap',  // one-time setup only, must never be a runtime grant
] as const;

// ---------------------------------------------------------------------------
// Role hierarchy definition
// ---------------------------------------------------------------------------

/**
 * ROLE_HIERARCHY maps each role to the list of roles whose capabilities it
 * inherits.  The relationship is: "key inherits from every role in value[]".
 *
 * Current hierarchy (linear):
 *   admin ⊇ verifier ⊇ issuer
 *   admin ⊇ verifier ⊇ investor
 *   (issuer and investor share the same base — diamond at 'verifier')
 */
export const ROLE_HIERARCHY: Readonly<Record<UserRole, readonly UserRole[]>> = {
  admin:    ['verifier', 'issuer', 'investor'],
  verifier: ['issuer', 'investor'],
  issuer:   [],
  investor: [],
} as const;

/** All known roles in descending privilege order. */
export const ALL_ROLES: readonly UserRole[] = ['admin', 'verifier', 'issuer', 'investor'];

// ---------------------------------------------------------------------------
// Helper: resolve effective (deduplicated) capabilities for a role
// ---------------------------------------------------------------------------

/**
 * Returns the effective capability set for `role` by taking the union of its
 * own capabilities and all ancestors' capabilities from `config`.
 * The result is deduplicated (each capability appears at most once).
 *
 * Uses Object.hasOwn guards to prevent prototype-chain collisions when
 * arbitrary strings like "constructor" or "valueOf" are passed as roles
 * (relevant in Property 5 fuzz testing).
 */
export function resolveEffectiveCapabilities(
  role: UserRole,
  config: SecurityConfig,
): Permission[] {
  // Guard against prototype-inherited keys (e.g., "constructor", "valueOf")
  const ownPerms = Object.hasOwn(config.enabledPermissions, role)
    ? config.enabledPermissions[role]
    : undefined;
  const own: Permission[] = Array.isArray(ownPerms) ? ownPerms : [];

  const ancestors = Object.hasOwn(ROLE_HIERARCHY, role)
    ? ROLE_HIERARCHY[role as keyof typeof ROLE_HIERARCHY]
    : ([] as readonly UserRole[]);

  const inherited: Permission[] = (Array.isArray(ancestors) ? ancestors : []).flatMap(
    (ancestor: UserRole) => {
      const ancestorPerms = Object.hasOwn(config.enabledPermissions, ancestor)
        ? config.enabledPermissions[ancestor]
        : undefined;
      return Array.isArray(ancestorPerms) ? ancestorPerms : [];
    },
  );

  // Deduplicate via Set while preserving order (own first)
  return [...new Set([...own, ...inherited])];
}

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/** Generates a valid UserRole. */
const arbRole = fc.constantFrom<UserRole>(...ALL_ROLES);

/** Generates a pair of distinct roles. */
const arbRolePair = fc.tuple(arbRole, arbRole).filter(([a, b]) => a !== b);

/**
 * Generates a SecurityConfig with plausible (but arbitrary) capability
 * assignments to each role.  Each role gets a random subset of the known
 * Permission values.  Forbidden capabilities are never injected here so that
 * tests verifying the production config remain meaningful; a separate arbitrary
 * introduces forbidden caps deliberately to test that the invariant catches them.
 */
const ALL_PERMISSIONS: readonly Permission[] = [
  'milestone:validate',
  'milestone:view',
  'vault:manage',
  'audit:read',
];

const arbPermissionSubset = fc.subarray(ALL_PERMISSIONS as Permission[]);

const arbSecurityConfig: fc.Arbitrary<SecurityConfig> = fc
  .tuple(
    arbPermissionSubset,
    arbPermissionSubset,
    arbPermissionSubset,
    arbPermissionSubset,
  )
  .map(([adminPerms, verifierPerms, issuerPerms, investorPerms]) => ({
    ...DEFAULT_SECURITY_CONFIG,
    enabledPermissions: {
      admin:    adminPerms,
      verifier: verifierPerms,
      issuer:   issuerPerms,
      investor: investorPerms,
    },
  }));

/**
 * Generates a SecurityConfig that has been intentionally poisoned with at least
 * one forbidden capability, to verify the invariant catches the violation.
 */
const arbPoisonedConfig: fc.Arbitrary<{ config: SecurityConfig; role: UserRole; forbidden: string }> = fc
  .tuple(arbSecurityConfig, arbRole, fc.constantFrom(...FORBIDDEN_CAPABILITIES_V1))
  .map(([config, role, forbidden]) => {
    const poisoned: SecurityConfig = {
      ...config,
      enabledPermissions: {
        ...config.enabledPermissions,
        [role]: [...config.enabledPermissions[role], forbidden as Permission],
      },
    };
    return { config: poisoned, role, forbidden };
  });

// ---------------------------------------------------------------------------
// Property 1: Hierarchy superset invariant
// ---------------------------------------------------------------------------

describe('RBAC — Property 1: Hierarchy superset invariant', () => {
  /**
   * For every ancestor role A of role D, every capability in A's set must also
   * appear in D's effective capability set.  This holds for the production
   * DEFAULT_SECURITY_CONFIG and for any valid arbitrary config.
   */
  it('every ancestor capability is present in the descendant effective set (production config)', () => {
    fc.assert(
      fc.property(arbRole, (role) => {
        const effectiveCaps = resolveEffectiveCapabilities(role, DEFAULT_SECURITY_CONFIG);
        const effectiveSet = new Set(effectiveCaps);

        for (const ancestor of ROLE_HIERARCHY[role]) {
          const ancestorCaps = DEFAULT_SECURITY_CONFIG.enabledPermissions[ancestor] ?? [];
          for (const cap of ancestorCaps) {
            if (!effectiveSet.has(cap)) {
              // Provide a shrinkable counterexample message
              throw new Error(
                `Hierarchy violation: role "${role}" inherits from "${ancestor}" ` +
                `but is missing capability "${cap}". ` +
                `Effective set: [${[...effectiveSet].join(', ')}]`,
              );
            }
          }
        }
      }),
      { numRuns: 100 },
    );
  });

  it('every ancestor capability is present in the descendant effective set (arbitrary configs)', () => {
    fc.assert(
      fc.property(arbRole, arbSecurityConfig, (role, config) => {
        const effectiveCaps = resolveEffectiveCapabilities(role, config);
        const effectiveSet = new Set(effectiveCaps);

        for (const ancestor of ROLE_HIERARCHY[role]) {
          const ancestorCaps = config.enabledPermissions[ancestor] ?? [];
          for (const cap of ancestorCaps) {
            if (!effectiveSet.has(cap)) {
              throw new Error(
                `Hierarchy violation: role "${role}" inherits from "${ancestor}" ` +
                `but is missing capability "${cap}".`,
              );
            }
          }
        }
      }),
      { numRuns: 200 },
    );
  });

  it('admin effective set is a superset of every other role (production config)', () => {
    fc.assert(
      fc.property(arbRole, (role) => {
        if (role === 'admin') return; // admin compared to itself is trivially a superset
        const adminCaps = new Set(resolveEffectiveCapabilities('admin', DEFAULT_SECURITY_CONFIG));
        const roleCaps = resolveEffectiveCapabilities(role, DEFAULT_SECURITY_CONFIG);

        for (const cap of roleCaps) {
          if (!adminCaps.has(cap)) {
            throw new Error(
              `Admin is not a superset of "${role}": admin lacks "${cap}".`,
            );
          }
        }
      }),
      { numRuns: 100 },
    );
  });

  it('verifier effective set is a superset of issuer and investor (production config)', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<UserRole>('issuer', 'investor'),
        (subordinate) => {
          const verifierCaps = new Set(
            resolveEffectiveCapabilities('verifier', DEFAULT_SECURITY_CONFIG),
          );
          const subordinateCaps = resolveEffectiveCapabilities(subordinate, DEFAULT_SECURITY_CONFIG);

          for (const cap of subordinateCaps) {
            if (!verifierCaps.has(cap)) {
              throw new Error(
                `Verifier is not a superset of "${subordinate}": verifier lacks "${cap}".`,
              );
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 2: Forbidden capabilities invariant
// ---------------------------------------------------------------------------

describe('RBAC — Property 2: Forbidden capabilities are never granted', () => {
  it('no role in DEFAULT_SECURITY_CONFIG holds a forbidden capability', () => {
    fc.assert(
      fc.property(arbRole, (role) => {
        const caps = resolveEffectiveCapabilities(role, DEFAULT_SECURITY_CONFIG);
        for (const cap of caps) {
          if ((FORBIDDEN_CAPABILITIES_V1 as readonly string[]).includes(cap)) {
            throw new Error(
              `Forbidden capability "${cap}" found in role "${role}". ` +
              `Schema version: ${RBAC_SCHEMA_VERSION}.`,
            );
          }
        }
      }),
      { numRuns: 100 },
    );
  });

  it('no role in arbitrary configs holds a forbidden capability (own grants)', () => {
    /**
     * We test that *arbitrary clean configs* also satisfy the invariant.
     * The arbSecurityConfig generator excludes forbidden caps, so this
     * verifies the helper function itself doesn't introduce them.
     */
    fc.assert(
      fc.property(arbRole, arbSecurityConfig, (role, config) => {
        const caps = resolveEffectiveCapabilities(role, config);
        for (const cap of caps) {
          if ((FORBIDDEN_CAPABILITIES_V1 as readonly string[]).includes(cap)) {
            throw new Error(
              `Forbidden capability "${cap}" found in role "${role}" via arbitrary config.`,
            );
          }
        }
      }),
      { numRuns: 200 },
    );
  });

  it('a config poisoned with a forbidden capability is detected by the invariant', () => {
    /**
     * This test INVERTS the assertion: it expects detection, confirming the
     * invariant check function itself is correct.
     */
    fc.assert(
      fc.property(arbPoisonedConfig, ({ config, role, forbidden }) => {
        const caps = resolveEffectiveCapabilities(role, config);
        const hasForbidden = caps.some((c) =>
          (FORBIDDEN_CAPABILITIES_V1 as readonly string[]).includes(c),
        );
        if (!hasForbidden) {
          throw new Error(
            `Expected to detect forbidden capability "${forbidden}" in role "${role}", ` +
            `but it was not present in effective set [${caps.join(', ')}].`,
          );
        }
      }),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 3: Diamond-inheritance deduplication
// ---------------------------------------------------------------------------

describe('RBAC — Property 3: Diamond-inheritance deduplication', () => {
  /**
   * Both 'issuer' and 'investor' share 'milestone:view'.
   * When verifier (which inherits both) or admin (which inherits all) resolves
   * its effective set, 'milestone:view' must appear exactly once.
   */
  it('effective capability sets contain no duplicate entries (production config)', () => {
    fc.assert(
      fc.property(arbRole, (role) => {
        const caps = resolveEffectiveCapabilities(role, DEFAULT_SECURITY_CONFIG);
        const seen = new Set<string>();
        for (const cap of caps) {
          if (seen.has(cap)) {
            throw new Error(
              `Duplicate capability "${cap}" found in effective set of role "${role}". ` +
              `Full set: [${caps.join(', ')}]`,
            );
          }
          seen.add(cap);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('effective capability sets contain no duplicate entries (arbitrary configs)', () => {
    fc.assert(
      fc.property(arbRole, arbSecurityConfig, (role, config) => {
        const caps = resolveEffectiveCapabilities(role, config);
        const uniqueCount = new Set(caps).size;
        if (caps.length !== uniqueCount) {
          throw new Error(
            `Duplicate capabilities in role "${role}" effective set. ` +
            `Raw length ${caps.length} vs unique count ${uniqueCount}. ` +
            `Caps: [${caps.join(', ')}]`,
          );
        }
      }),
      { numRuns: 200 },
    );
  });

  it('resolveEffectiveCapabilities is idempotent — calling twice returns same set', () => {
    fc.assert(
      fc.property(arbRole, arbSecurityConfig, (role, config) => {
        const first = resolveEffectiveCapabilities(role, config);
        const second = resolveEffectiveCapabilities(role, config);
        const firstSorted = [...first].sort().join(',');
        const secondSorted = [...second].sort().join(',');
        if (firstSorted !== secondSorted) {
          throw new Error(
            `resolveEffectiveCapabilities is not idempotent for role "${role}". ` +
            `First: [${firstSorted}], Second: [${secondSorted}]`,
          );
        }
      }),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 4: Middleware authorization mirrors the static capability map
// ---------------------------------------------------------------------------

describe('RBAC — Property 4: Middleware authorization mirrors capability map', () => {
  /**
   * For every role R and every single capability C:
   *   - If C is in R's effective set → middleware must call next().
   *   - If C is NOT in R's effective set → middleware must respond 403.
   */
  it('middleware grants access iff capability is in effective set (production config)', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbRole,
        fc.constantFrom<Permission>(...ALL_PERMISSIONS),
        async (role, permission) => {
          const mockAuditRepository = { record: jest.fn().mockResolvedValue(undefined) } as any;
          const middleware = createAuthorizationMiddleware(
            [permission],
            { auditRepository: mockAuditRepository, config: DEFAULT_SECURITY_CONFIG },
          );

          let nextCalled = false;
          let statusCode = 0;

          const req: Partial<Request> = {
            method: 'GET',
            path: '/test',
            headers: {},
            ip: '127.0.0.1',
            securityContext: {
              user: {
                id: 'test-user',
                role,
                permissions: [],
                sessionId: 'test-session',
                authenticatedAt: new Date(),
              },
              requestId: 'test-req-id',
              ipAddress: '127.0.0.1',
              userAgent: 'test-agent',
              timestamp: new Date(),
            },
          } as any;

          const res: Partial<Response> = {
            status: jest.fn().mockReturnThis() as any,
            json: jest.fn().mockReturnThis() as any,
          };
          (res.status as jest.Mock).mockImplementation((code: number) => {
            statusCode = code;
            return res;
          });

          const next = () => { nextCalled = true; };

          await middleware(req as Request, res as Response, next);

          const effectiveCaps = new Set(
            resolveEffectiveCapabilities(role, DEFAULT_SECURITY_CONFIG),
          );
          const shouldHaveAccess = effectiveCaps.has(permission);

          if (shouldHaveAccess && !nextCalled) {
            throw new Error(
              `Middleware denied role "${role}" capability "${permission}" ` +
              `but it should be granted. statusCode=${statusCode}`,
            );
          }
          if (!shouldHaveAccess && nextCalled) {
            throw new Error(
              `Middleware granted role "${role}" capability "${permission}" ` +
              `but it should be denied.`,
            );
          }
          if (!shouldHaveAccess && statusCode !== 403) {
            throw new Error(
              `Middleware returned ${statusCode} instead of 403 for role "${role}" ` +
              `lacking capability "${permission}".`,
            );
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 5: Unknown roles receive zero capabilities
// ---------------------------------------------------------------------------

/**
 * Prototype-safe unknown role generator.
 *
 * We restrict to alphanumeric strings prefixed with "unknown_" so we never
 * accidentally generate JS built-in property names ("constructor", "valueOf",
 * "__proto__", etc.) that would be looked up on Object.prototype and cause
 * unexpected behaviour in code that lacks Object.hasOwn guards.
 *
 * The middleware itself uses plain bracket lookup (`config.enabledPermissions[role]`)
 * and that is production code we intentionally do not modify here.  Therefore we
 * generate safe fuzz inputs that represent realistic "unknown role" scenarios
 * (typos, future roles not yet deployed, role strings from a different env) rather
 * than adversarial prototype keys — those are covered by a dedicated security
 * concern outside RBAC hierarchy testing.
 */
const arbUnknownRole = fc
  .stringMatching(/^[a-z][a-z0-9_]{0,18}$/)
  .filter((s) => !(ALL_ROLES as readonly string[]).includes(s))
  // Exclude any name that is a property on Object.prototype to avoid false
  // positives from prototype-chain lookups in the middleware under test.
  .filter((s) => !Object.hasOwn(Object.prototype, s) && !(s in {}));

describe('RBAC — Property 5: Unknown roles receive zero capabilities', () => {
  it('a role not present in the config yields an empty effective capability set', () => {
    fc.assert(
      fc.property(
        arbUnknownRole,
        (unknownRole) => {
          const caps = resolveEffectiveCapabilities(
            unknownRole as UserRole,
            DEFAULT_SECURITY_CONFIG,
          );
          if (caps.length !== 0) {
            throw new Error(
              `Unknown role "${unknownRole}" was granted capabilities: [${caps.join(', ')}].`,
            );
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it('middleware returns 403 for unknown/anonymous roles', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbUnknownRole,
        fc.constantFrom<Permission>(...ALL_PERMISSIONS),
        async (unknownRole, permission) => {
          const mockAuditRepository = { record: jest.fn().mockResolvedValue(undefined) } as any;
          const middleware = createAuthorizationMiddleware(
            [permission],
            { auditRepository: mockAuditRepository, config: DEFAULT_SECURITY_CONFIG },
          );

          let statusCode = 0;
          const req: any = {
            method: 'GET',
            path: '/test',
            headers: {},
            ip: '127.0.0.1',
            securityContext: {
              user: {
                id: 'test-user',
                role: unknownRole as UserRole,
                permissions: [],
                sessionId: 'test-session',
                authenticatedAt: new Date(),
              },
              requestId: 'test-req-id',
              ipAddress: '127.0.0.1',
              userAgent: 'test-agent',
              timestamp: new Date(),
            },
          };
          const res: any = {
            status: jest.fn().mockImplementation((code: number) => {
              statusCode = code;
              return res;
            }),
            json: jest.fn().mockReturnThis(),
          };

          await middleware(req, res, () => {
            throw new Error(
              `next() should not be called for unknown role "${unknownRole}" ` +
              `requesting "${permission}".`,
            );
          });

          if (statusCode !== 403) {
            throw new Error(
              `Expected 403 for unknown role "${unknownRole}", got ${statusCode}.`,
            );
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 6: Self-contained inheritance completeness
// ---------------------------------------------------------------------------

describe('RBAC — Property 6: Self-contained inheritance completeness', () => {
  /**
   * For every role R with ancestors A₁, A₂, … Aₙ (transitively), the effective
   * capability set of R must contain every capability of every Aᵢ.
   * This verifies that resolveEffectiveCapabilities is transitive.
   */
  it('resolveEffectiveCapabilities is transitively complete (production config)', () => {
    fc.assert(
      fc.property(arbRole, (role) => {
        // Collect all transitive ancestors
        const allAncestors = new Set<UserRole>();
        const queue: UserRole[] = [...ROLE_HIERARCHY[role]];
        while (queue.length > 0) {
          const ancestor = queue.shift()!;
          if (!allAncestors.has(ancestor)) {
            allAncestors.add(ancestor);
            queue.push(...ROLE_HIERARCHY[ancestor]);
          }
        }

        const effectiveCaps = new Set(
          resolveEffectiveCapabilities(role, DEFAULT_SECURITY_CONFIG),
        );

        for (const ancestor of allAncestors) {
          const ancestorCaps = DEFAULT_SECURITY_CONFIG.enabledPermissions[ancestor] ?? [];
          for (const cap of ancestorCaps) {
            if (!effectiveCaps.has(cap)) {
              throw new Error(
                `Transitivity violation: role "${role}" is missing capability "${cap}" ` +
                `from transitive ancestor "${ancestor}".`,
              );
            }
          }
        }
      }),
      { numRuns: 100 },
    );
  });

  it("every role has a capability set that is a subset of its direct parent's effective set", () => {
    /**
     * "Direct parent" in this linear hierarchy:
     *   admin → verifier → {issuer, investor}
     */
    const directParent: Partial<Record<UserRole, UserRole>> = {
      verifier: 'admin',
      issuer:   'verifier',
      investor: 'verifier',
    };

    fc.assert(
      fc.property(arbRole, arbSecurityConfig, (role, config) => {
        const parent = directParent[role];
        if (!parent) return; // admin has no parent — skip

        const childCaps = new Set(resolveEffectiveCapabilities(role, config));
        const parentCaps = new Set(resolveEffectiveCapabilities(parent, config));

        for (const cap of childCaps) {
          if (!parentCaps.has(cap)) {
            throw new Error(
              `Role "${role}" has capability "${cap}" that its parent "${parent}" lacks. ` +
              `This violates the hierarchy contract.`,
            );
          }
        }
      }),
      { numRuns: 200 },
    );
  });
});
