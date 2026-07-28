/**
 * Worker Role Configuration
 *
 * Splits the monolithic Revora-Backend process into role-based worker
 * deployments so that hot-path API traffic and batch/background loads
 * can autoscale independently.
 *
 * Roles
 * ─────
 * | Role   | HTTP Server | WebhookQueue | AuditPurge | PayoutDrift |
 * |--------|:-----------:|:------------:|:----------:|:-----------:|
 * | `api`  |     ✓       |      ✓       |            |             |
 * | `batch`|             |              |     ✓      |      ✓      |
 * | `all`  |     ✓       |      ✓       |     ✓      |      ✓      |
 *
 * Selection
 * ─────────
 * Set the `ROLE` environment variable at startup. The value is validated
 * once; dynamic role switching at runtime is not supported.
 *
 * Security assumptions
 * ────────────────────
 * - Unknown or missing ROLE causes an immediate `process.exit(1)` with an
 *   actionable error message — fail-fast, never silently degrade.
 * - In `test` environment, ROLE defaults to `all` to preserve backward
 *   compatibility with existing test suites.
 * - The role is purely additive; it never grants new permissions, it only
 *   controls which background services are launched.
 */

import { z } from 'zod';

export const VALID_ROLES = ['api', 'batch', 'all'] as const;
export type WorkerRole = (typeof VALID_ROLES)[number];

export interface RoleConfig {
  /** Serve HTTP traffic (Express listener). */
  httpServer: boolean;
  /** Resume and process webhook deliveries. */
  webhookQueue: boolean;
  /** Run scheduled audit-log purge jobs. */
  auditPurge: boolean;
  /** Run nightly payout-drift detection. */
  payoutDrift: boolean;
}

/**
 * Role → capability matrix.
 */
export const ROLE_MATRIX: Record<WorkerRole, RoleConfig> = {
  api: {
    httpServer: true,
    webhookQueue: true,
    auditPurge: false,
    payoutDrift: false,
  },
  batch: {
    httpServer: false,
    webhookQueue: false,
    auditPurge: true,
    payoutDrift: true,
  },
  all: {
    httpServer: true,
    webhookQueue: true,
    auditPurge: true,
    payoutDrift: true,
  },
};

/**
 * Validate and parse the ROLE environment variable.
 *
 * @param raw - Value of `process.env.ROLE`
 * @param nodeEnv - Current `NODE_ENV` (defaults to `process.env.NODE_ENV`)
 * @returns Normalized `WorkerRole`
 * @throws Never returns — calls `process.exit(1)` on invalid input.
 */
export function resolveWorkerRole(
  raw: string | undefined,
  nodeEnv?: string,
): WorkerRole {
  const env = nodeEnv ?? process.env.NODE_ENV ?? 'development';

  // In test, default to "all" when ROLE is not set
  if (!raw && env === 'test') {
    return 'all';
  }

  const result = z.enum(VALID_ROLES).safeParse(raw);

  if (!result.success) {
    const provided = raw === undefined || raw === '' ? '(not set)' : `"${raw}"`;
    console.error(
      `[FATAL] Invalid ROLE: ${provided}. ` +
      `Valid roles are: ${VALID_ROLES.join(', ')}. ` +
      `Set ROLE to one of these values and restart.`,
    );
    process.exit(1);
  }

  return result.data;
}

/**
 * Return the role configuration for a given role.
 * Useful for testing without going through the full startup path.
 */
export function getRoleConfig(role: WorkerRole): RoleConfig {
  return { ...ROLE_MATRIX[role] };
}
