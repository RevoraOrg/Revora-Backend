/**
 * @dev Deterministic RBAC policy matrix serializer and diff utility.
 *
 * Produces canonical string representations of role→permission matrices and
 * computes added/removed grants between two revisions.  Used by the CI policy-
 * diff gate and by tests.
 */

export interface PolicyMatrix {
  [role: string]: string[];
}

export interface PolicyGrants {
  role: string;
  permission: string;
}

export interface PolicyDiff {
  added: PolicyGrants[];
  removed: PolicyGrants[];
}

/**
 * Normalizes a policy matrix by sorting each role's permissions and sorting
 * the roles themselves, then serializes to a canonical JSON string.
 *
 * Security note: the output is deterministic so identical inputs always
 * produce identical fingerprints.
 */
export function serializePolicy(matrix: PolicyMatrix): string {
  const normalized: PolicyMatrix = {};
  for (const role of Object.keys(matrix).sort()) {
    normalized[role] = [...matrix[role]].sort();
  }
  return JSON.stringify(normalized);
}

/**
 * Computes the diff between a base policy matrix and a head policy matrix.
 *
 * @returns An object describing every newly added and removed (role, permission)
 *          grant.  Grants that exist in both matrices are omitted.
 */
export function computePolicyDiff(
  base: PolicyMatrix,
  head: PolicyMatrix,
): PolicyDiff {
  const added: PolicyGrants[] = [];
  const removed: PolicyGrants[] = [];

  for (const [role, permissions] of Object.entries(head)) {
    for (const permission of permissions) {
      if (!base[role]?.includes(permission)) {
        added.push({ role, permission });
      }
    }
  }

  for (const [role, permissions] of Object.entries(base)) {
    for (const permission of permissions) {
      if (!head[role]?.includes(permission)) {
        removed.push({ role, permission });
      }
    }
  }

  return { added, removed };
}

/**
 * Formats a PolicyDiff as a human-readable markdown string suitable for PR
 * comments and CI logs.
 */
export function formatPolicyDiff(diff: PolicyDiff): string {
  const lines: string[] = [];

  if (diff.added.length === 0 && diff.removed.length === 0) {
    lines.push('No RBAC permission changes detected.');
    return lines.join('\n');
  }

  if (diff.added.length > 0) {
    lines.push('### Added Grants');
    for (const grant of diff.added) {
      lines.push(`- **${grant.role}**: \`${grant.permission}\``);
    }
  }

  if (diff.removed.length > 0) {
    lines.push('### Removed Grants');
    for (const grant of diff.removed) {
      lines.push(`- **${grant.role}**: \`${grant.permission}\``);
    }
  }

  return lines.join('\n');
}

/**
 * Extracts the enabledPermissions block from a `src/security/types.ts` source
 * string and returns it as a normalized PolicyMatrix.
 *
 * The parser is intentionally simple because the input format is controlled by
 * the project's TypeScript style conventions.
 */
export function extractPolicyFromSource(source: string): PolicyMatrix {
  const matrix: PolicyMatrix = {};

  const blockMatch = source.match(/enabledPermissions:\s*\{([\s\S]*?)\n?\s*\}/);
  if (!blockMatch) {
    return matrix;
  }

  const block = blockMatch[1];
  const lineRegex = /'([^']+)':\s*\[([^\]]*)\]/g;
  let m: RegExpExecArray | null;

  while ((m = lineRegex.exec(block)) !== null) {
    const role = m[1];
    const rawPerms = m[2]
      .split(',')
      .map((p) => p.trim().replace(/['"]/g, ''))
      .filter((p) => p.length > 0);
    matrix[role] = rawPerms;
  }

  return matrix;
}
