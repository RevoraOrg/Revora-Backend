import {
  serializePolicy,
  computePolicyDiff,
  formatPolicyDiff,
  extractPolicyFromSource,
  PolicyMatrix,
  PolicyDiff,
} from './rbacPolicySerializer';

describe('serializePolicy', () => {
  it('sorts roles and permissions deterministically', () => {
    const input: PolicyMatrix = {
      verifier: ['milestone:view', 'milestone:validate'],
      admin: ['audit:read', 'milestone:validate'],
    };
    const output = serializePolicy(input);
    const parsed = JSON.parse(output);
    expect(Object.keys(parsed)).toEqual(['admin', 'verifier']);
    expect(parsed.admin).toEqual(['audit:read', 'milestone:validate']);
    expect(parsed.verifier).toEqual(['milestone:validate', 'milestone:view']);
  });

  it('always produces identical output for identical input', () => {
    const matrix: PolicyMatrix = {
      investor: ['milestone:view'],
      issuer: ['milestone:view'],
      admin: ['milestone:validate', 'vault:manage'],
    };
    expect(serializePolicy(matrix)).toBe(serializePolicy(matrix));
  });

  it('handles empty permission arrays', () => {
    const input: PolicyMatrix = { anonymous: [] };
    const output = serializePolicy(input);
    expect(JSON.parse(output)).toEqual({ anonymous: [] });
  });

  it('handles empty matrix', () => {
    expect(serializePolicy({})).toBe('{}');
  });

  it('sorts single-element permission arrays correctly', () => {
    const input: PolicyMatrix = { investor: ['milestone:view'] };
    expect(serializePolicy(input)).toBe(JSON.stringify({ investor: ['milestone:view'] }));
  });
});

describe('computePolicyDiff', () => {
  it('returns empty diff for identical matrices', () => {
    const base: PolicyMatrix = { admin: ['vault:manage'], investor: ['milestone:view'] };
    const head = { ...base };
    expect(computePolicyDiff(base, head)).toEqual({ added: [], removed: [] });
  });

  it('detects newly added grants', () => {
    const base: PolicyMatrix = { admin: ['milestone:validate'] };
    const head: PolicyMatrix = { admin: ['milestone:validate', 'audit:read'] };
    expect(computePolicyDiff(base, head)).toEqual({
      added: [{ role: 'admin', permission: 'audit:read' }],
      removed: [],
    });
  });

  it('detects newly removed grants', () => {
    const base: PolicyMatrix = { verifier: ['milestone:validate', 'audit:read'] };
    const head: PolicyMatrix = { verifier: ['milestone:validate'] };
    expect(computePolicyDiff(base, head)).toEqual({
      added: [],
      removed: [{ role: 'verifier', permission: 'audit:read' }],
    });
  });

  it('detects role additions and removals', () => {
    const base: PolicyMatrix = { admin: ['audit:read'] };
    const head: PolicyMatrix = {
      admin: ['audit:read'],
      auditor: ['audit:read'],
    };
    expect(computePolicyDiff(base, head)).toEqual({
      added: [{ role: 'auditor', permission: 'audit:read' }],
      removed: [],
    });
  });

  it('handles multiple changes across multiple roles', () => {
    const base: PolicyMatrix = {
      admin: ['milestone:validate', 'audit:read'],
      verifier: ['milestone:validate'],
      investor: ['milestone:view'],
    };
    const head: PolicyMatrix = {
      admin: ['milestone:validate', 'vault:manage'],
      verifier: ['milestone:validate'],
      investor: ['milestone:view', 'audit:read'],
    };
    expect(computePolicyDiff(base, head)).toEqual({
      added: [
        { role: 'admin', permission: 'vault:manage' },
        { role: 'investor', permission: 'audit:read' },
      ],
      removed: [{ role: 'admin', permission: 'audit:read' }],
    });
  });

  it('is order-independent', () => {
    const base: PolicyMatrix = { admin: ['c', 'a', 'b'] };
    const head: PolicyMatrix = { admin: ['b', 'c', 'a', 'd'] };
    expect(computePolicyDiff(base, head)).toEqual({
      added: [{ role: 'admin', permission: 'd' }],
      removed: [],
    });
  });
});

describe('formatPolicyDiff', () => {
  it('returns "no changes" message for empty diff', () => {
    const diff: PolicyDiff = { added: [], removed: [] };
    expect(formatPolicyDiff(diff)).toBe('No RBAC permission changes detected.');
  });

  it('formats added grants', () => {
    const diff: PolicyDiff = {
      added: [{ role: 'admin', permission: 'vault:manage' }],
      removed: [],
    };
    const output = formatPolicyDiff(diff);
    expect(output).toContain('### Added Grants');
    expect(output).toContain('**admin**: `vault:manage`');
  });

  it('formats removed grants', () => {
    const diff: PolicyDiff = {
      added: [],
      removed: [{ role: 'verifier', permission: 'audit:read' }],
    };
    const output = formatPolicyDiff(diff);
    expect(output).toContain('### Removed Grants');
    expect(output).toContain('**verifier**: `audit:read`');
  });

  it('formats both added and removed grants', () => {
    const diff: PolicyDiff = {
      added: [{ role: 'investor', permission: 'milestone:view' }],
      removed: [{ role: 'admin', permission: 'vault:manage' }],
    };
    const output = formatPolicyDiff(diff);
    expect(output).toContain('### Added Grants');
    expect(output).toContain('### Removed Grants');
  });
});

describe('extractPolicyFromSource', () => {
  const sampleSource = `
    export type UserRole = 'admin' | 'verifier' | 'issuer' | 'investor';
    export type Permission = 'milestone:validate' | 'milestone:view' | 'vault:manage' | 'audit:read';

    export const DEFAULT_SECURITY_CONFIG: SecurityConfig = {
      rateLimits: {},
      maxConcurrentValidations: 5,
      validationTimeoutMs: 30_000,
      requireCsrfToken: true,
      enabledPermissions: {
        'admin': ['milestone:validate', 'milestone:view', 'vault:manage', 'audit:read'],
        'verifier': ['milestone:validate', 'milestone:view'],
        'issuer': ['milestone:view'],
        'investor': ['milestone:view'],
      },
    };
  `;

  it('extracts a correctly normalized matrix from source', () => {
    const matrix = extractPolicyFromSource(sampleSource);
    expect(matrix).toEqual({
      admin: ['milestone:validate', 'milestone:view', 'vault:manage', 'audit:read'],
      verifier: ['milestone:validate', 'milestone:view'],
      issuer: ['milestone:view'],
      investor: ['milestone:view'],
    });
  });

  it('returns empty object when enabledPermissions block is missing', () => {
    expect(extractPolicyFromSource('export const x = 1;')).toEqual({});
  });

  it('handles extra whitespace and comments in the block', () => {
    const source = `
      enabledPermissions: {
        // admin gets everything
        'admin': [  'milestone:validate' , 'milestone:view'  ],
        'verifier': ['milestone:validate'],
      },
    `;
    const matrix = extractPolicyFromSource(source);
    expect(matrix).toEqual({
      admin: ['milestone:validate', 'milestone:view'],
      verifier: ['milestone:validate'],
    });
  });

  it('handles empty permission arrays', () => {
    const source = `enabledPermissions: { 'guest': [] }`;
    const matrix = extractPolicyFromSource(source);
    expect(matrix).toEqual({ guest: [] });
  });
});
