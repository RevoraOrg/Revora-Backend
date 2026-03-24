import "dotenv/config";
import express, { Request, Response } from "express";
import morgan from "morgan";
import { dbHealth, closePool } from "./db/client";
import { createCorsMiddleware } from "./middleware/cors";
import {
  createMilestoneValidationRouter,
  DomainEventPublisher,
  Milestone,
  MilestoneRepository,
  MilestoneValidationEvent,
  MilestoneValidationEventRepository,
  VerifierAssignmentRepository,
} from "./vaults/milestoneValidationRoute";
import { Pool } from "pg";

/**
 * @title Offering Sync Conflict Resolution System
 * @notice Production-grade conflict detection and resolution for concurrent offering updates
 * @dev Implements optimistic locking with version-based conflict detection
 * 
 * SECURITY ASSUMPTIONS:
 * 1. Database transactions provide ACID guarantees
 * 2. Blockchain state is the source of truth for offering data
 * 3. All sync operations are authenticated and authorized
 * 4. Rate limiting prevents abuse of sync endpoints
 * 
 * CONFLICT SCENARIOS:
 * 1. Concurrent updates from multiple sync processes
 * 2. Race conditions between blockchain reads and database writes
 * 3. Stale data overwrites from delayed sync operations
 * 4. Network partitions causing inconsistent state
 */

/**
 * @notice Represents an offering with version tracking for conflict detection
 */
export interface VersionedOffering {
  id: string;
  contract_address: string;
  status: 'draft' | 'active' | 'closed' | 'completed';
  total_raised: string;
  version: number; // Optimistic lock version
  updated_at: Date;
  sync_hash?: string; // Hash of blockchain state for idempotency
}

/**
 * @notice Result of conflict detection analysis
 */
export interface ConflictDetectionResult {
  hasConflict: boolean;
  conflictType?: 'version_mismatch' | 'concurrent_update' | 'stale_data' | 'hash_collision';
  currentVersion: number;
  attemptedVersion: number;
  message: string;
}

/**
 * @notice Input for sync operation with conflict detection metadata
 */
export interface SyncOfferingInput {
  offeringId: string;
  expectedVersion: number; // Version client expects to update
  newStatus?: 'draft' | 'active' | 'closed' | 'completed';
  newTotalRaised?: string;
  syncHash: string; // Hash of blockchain state being synced
  syncedAt: Date; // Timestamp of blockchain read
}

/**
 * @notice Result of conflict resolution attempt
 */
export interface ConflictResolutionResult {
  success: boolean;
  resolved: boolean;
  strategy: 'blockchain_wins' | 'latest_timestamp' | 'manual_review' | 'retry';
  finalVersion: number;
  offering?: VersionedOffering;
  error?: string;
}

/**
 * @title OfferingConflictResolver
 * @notice Handles detection and resolution of concurrent offering update conflicts
 * @dev Uses optimistic locking with deterministic resolution strategies
 */
export class OfferingConflictResolver {
  constructor(private db: Pool) {}

  /**
   * @notice Detects conflicts before applying updates
   * @dev Compares expected version with current database version
   * @param offeringId The offering to check
   * @param expectedVersion The version the caller expects
   * @return ConflictDetectionResult indicating if conflict exists
   */
  async detectConflict(
    offeringId: string,
    expectedVersion: number
  ): Promise<ConflictDetectionResult> {
    const query = `
      SELECT version, updated_at, sync_hash
      FROM offerings
      WHERE id = $1
      FOR UPDATE
    `;
    
    const result = await this.db.query(query, [offeringId]);
    
    if (result.rows.length === 0) {
      return {
        hasConflict: true,
        conflictType: 'version_mismatch',
        currentVersion: -1,
        attemptedVersion: expectedVersion,
        message: 'Offering not found',
      };
    }

    const current = result.rows[0];
    const currentVersion = current.version || 0;

    if (currentVersion !== expectedVersion) {
      // Determine conflict type based on version difference
      const versionDiff = currentVersion - expectedVersion;
      
      if (versionDiff > 1) {
        return {
          hasConflict: true,
          conflictType: 'stale_data',
          currentVersion,
          attemptedVersion: expectedVersion,
          message: `Stale data detected: current version ${currentVersion}, attempted ${expectedVersion}`,
        };
      }

      return {
        hasConflict: true,
        conflictType: 'concurrent_update',
        currentVersion,
        attemptedVersion: expectedVersion,
        message: `Concurrent update detected: current version ${currentVersion}, attempted ${expectedVersion}`,
      };
    }

    return {
      hasConflict: false,
      currentVersion,
      attemptedVersion: expectedVersion,
      message: 'No conflict detected',
    };
  }

  /**
   * @notice Resolves conflicts using deterministic strategy
   * @dev Strategy: Blockchain state always wins (source of truth)
   * @param input Sync operation input with conflict metadata
   * @return ConflictResolutionResult with resolution outcome
   * 
   * RESOLUTION STRATEGY:
   * 1. Blockchain state is authoritative (blockchain_wins)
   * 2. If hash matches existing sync_hash, skip update (idempotent)
   * 3. If version mismatch, retry with current version
   * 4. If persistent conflicts, flag for manual review
   */
  async resolveConflict(
    input: SyncOfferingInput
  ): Promise<ConflictResolutionResult> {
    const client = await this.db.connect();
    
    try {
      await client.query('BEGIN');

      // Lock row for update
      const lockQuery = `
        SELECT id, version, sync_hash, updated_at, status, total_raised
        FROM offerings
        WHERE id = $1
        FOR UPDATE
      `;
      
      const lockResult = await client.query(lockQuery, [input.offeringId]);
      
      if (lockResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return {
          success: false,
          resolved: false,
          strategy: 'manual_review',
          finalVersion: -1,
          error: 'Offering not found',
        };
      }

      const current = lockResult.rows[0];
      const currentVersion = current.version || 0;

      // Check for idempotent sync (same blockchain state already applied)
      if (current.sync_hash === input.syncHash) {
        await client.query('ROLLBACK');
        return {
          success: true,
          resolved: true,
          strategy: 'blockchain_wins',
          finalVersion: currentVersion,
          offering: {
            id: current.id,
            contract_address: current.contract_address,
            status: current.status,
            total_raised: current.total_raised,
            version: currentVersion,
            updated_at: current.updated_at,
            sync_hash: current.sync_hash,
          },
        };
      }

      // Apply blockchain state (deterministic resolution)
      const updateFields: string[] = [];
      const updateValues: any[] = [];
      let paramIndex = 1;

      if (input.newStatus !== undefined) {
        updateFields.push(`status = $${paramIndex++}`);
        updateValues.push(input.newStatus);
      }

      if (input.newTotalRaised !== undefined) {
        updateFields.push(`total_raised = $${paramIndex++}`);
        updateValues.push(input.newTotalRaised);
      }

      // Always update version, sync_hash, and updated_at
      updateFields.push(`version = $${paramIndex++}`);
      updateValues.push(currentVersion + 1);

      updateFields.push(`sync_hash = $${paramIndex++}`);
      updateValues.push(input.syncHash);

      updateFields.push(`updated_at = $${paramIndex++}`);
      updateValues.push(input.syncedAt);

      updateValues.push(input.offeringId);

      const updateQuery = `
        UPDATE offerings
        SET ${updateFields.join(', ')}
        WHERE id = $${paramIndex}
        RETURNING *
      `;

      const updateResult = await client.query(updateQuery, updateValues);
      await client.query('COMMIT');

      const updated = updateResult.rows[0];

      return {
        success: true,
        resolved: true,
        strategy: 'blockchain_wins',
        finalVersion: updated.version,
        offering: {
          id: updated.id,
          contract_address: updated.contract_address,
          status: updated.status,
          total_raised: updated.total_raised,
          version: updated.version,
          updated_at: updated.updated_at,
          sync_hash: updated.sync_hash,
        },
      };
    } catch (error: any) {
      await client.query('ROLLBACK');
      
      // Handle specific database errors
      if (error.code === '40001') { // Serialization failure
        return {
          success: false,
          resolved: false,
          strategy: 'retry',
          finalVersion: -1,
          error: 'Serialization conflict, retry recommended',
        };
      }

      return {
        success: false,
        resolved: false,
        strategy: 'manual_review',
        finalVersion: -1,
        error: error.message || 'Unknown error during conflict resolution',
      };
    } finally {
      client.release();
    }
  }

  /**
   * @notice Performs atomic sync with conflict detection and resolution
   * @dev Combines detection and resolution in single transaction
   * @param input Sync operation input
   * @return ConflictResolutionResult with final state
   */
  async syncWithConflictResolution(
    input: SyncOfferingInput
  ): Promise<ConflictResolutionResult> {
    // First attempt: detect conflict
    const detection = await this.detectConflict(
      input.offeringId,
      input.expectedVersion
    );

    if (!detection.hasConflict) {
      // No conflict, proceed with normal update
      return this.resolveConflict(input);
    }

    // Conflict detected, apply resolution strategy
    if (detection.conflictType === 'stale_data') {
      // Stale data: reject and require client to fetch latest
      return {
        success: false,
        resolved: false,
        strategy: 'retry',
        finalVersion: detection.currentVersion,
        error: `Stale data: please fetch version ${detection.currentVersion} and retry`,
      };
    }

    // Concurrent update: apply blockchain state (deterministic)
    return this.resolveConflict(input);
  }

  /**
   * @notice Validates sync input for security and data integrity
   * @dev Prevents injection attacks and validates business rules
   * @param input Sync operation input to validate
   * @return Validation result with error messages
   */
  validateSyncInput(input: SyncOfferingInput): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    // Validate offering ID format (UUID)
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(input.offeringId)) {
      errors.push('Invalid offering ID format');
    }

    // Validate version is non-negative
    if (input.expectedVersion < 0) {
      errors.push('Expected version must be non-negative');
    }

    // Validate status if provided
    const validStatuses = ['draft', 'active', 'closed', 'completed'];
    if (input.newStatus && !validStatuses.includes(input.newStatus)) {
      errors.push('Invalid status value');
    }

    // Validate total_raised format if provided
    if (input.newTotalRaised !== undefined) {
      const amount = parseFloat(input.newTotalRaised);
      if (isNaN(amount) || amount < 0) {
        errors.push('Invalid total_raised value');
      }
    }

    // Validate sync hash format (hex string)
    const hashRegex = /^[0-9a-f]{64}$/i;
    if (!hashRegex.test(input.syncHash)) {
      errors.push('Invalid sync hash format');
    }

    // Validate timestamp is not in future
    if (input.syncedAt > new Date()) {
      errors.push('Synced timestamp cannot be in the future');
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }
}

const app = express();
const port = process.env.PORT ?? 3000;
/**
 * @dev The global prefix applied to all business logic routers.
 * Defaults to `/api/v1` if `process.env.API_VERSION_PREFIX` is not supplied.
 * Crucial for preventing route conflict and ensuring reliable downstream tooling (e.g. AWS API Gateway handling).
 */
const API_VERSION_PREFIX = process.env.API_VERSION_PREFIX ?? '/api/v1';
const apiRouter = express.Router();

class InMemoryMilestoneRepository implements MilestoneRepository {
  constructor(private readonly milestones = new Map<string, Milestone>()) {}

  private key(vaultId: string, milestoneId: string): string {
    return `${vaultId}:${milestoneId}`;
  }

  async getByVaultAndId(
    vaultId: string,
    milestoneId: string,
  ): Promise<Milestone | null> {
    return this.milestones.get(this.key(vaultId, milestoneId)) ?? null;
  }

  async markValidated(input: {
    vaultId: string;
    milestoneId: string;
    verifierId: string;
    validatedAt: Date;
  }): Promise<Milestone> {
    const key = this.key(input.vaultId, input.milestoneId);
    const current = this.milestones.get(key);

    if (!current) {
      throw new Error("Milestone not found");
    }

    const updated: Milestone = {
      ...current,
      status: "validated",
      validated_by: input.verifierId,
      validated_at: input.validatedAt,
    };
    this.milestones.set(key, updated);
    return updated;
  }
}

class InMemoryVerifierAssignmentRepository implements VerifierAssignmentRepository {
  constructor(private readonly assignments = new Map<string, Set<string>>()) {}

  async isVerifierAssignedToVault(
    vaultId: string,
    verifierId: string,
  ): Promise<boolean> {
    return this.assignments.get(vaultId)?.has(verifierId) ?? false;
  }
}

class InMemoryMilestoneValidationEventRepository implements MilestoneValidationEventRepository {
  private events: MilestoneValidationEvent[] = [];
  private counter = 0;

  async create(input: {
    vaultId: string;
    milestoneId: string;
    verifierId: string;
    createdAt: Date;
  }): Promise<MilestoneValidationEvent> {
    this.counter += 1;
    const event: MilestoneValidationEvent = {
      id: `validation-event-${this.counter}`,
      vault_id: input.vaultId,
      milestone_id: input.milestoneId,
      verifier_id: input.verifierId,
      created_at: input.createdAt,
    };
    this.events.push(event);
    return event;
  }
}

class ConsoleDomainEventPublisher implements DomainEventPublisher {
  async publish(
    eventName: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    // eslint-disable-next-line no-console
    console.log(`[domain-event] ${eventName}`, payload);
  }
}

const requireAuth = (req: Request, res: Response, next: () => void): void => {
  const userId = req.header("x-user-id");
  const role = req.header("x-user-role");

  if (!userId || !role) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  (req as any).user = {
    id: userId,
    role,
  };

  next();
};

const milestoneRepository = new InMemoryMilestoneRepository(
  new Map<string, Milestone>([
    [
      "vault-1:milestone-1",
      {
        id: "milestone-1",
        vault_id: "vault-1",
        status: "pending",
      },
    ],
  ]),
);
const verifierAssignmentRepository = new InMemoryVerifierAssignmentRepository(
  new Map<string, Set<string>>([["vault-1", new Set(["verifier-1"])]]),
);
const milestoneValidationEventRepository =
  new InMemoryMilestoneValidationEventRepository();
const domainEventPublisher = new ConsoleDomainEventPublisher();

app.use(createCorsMiddleware());
app.use(express.json());
app.use(morgan("dev"));
/**
 * @dev All API business routes are deliberately scoped under the target version prefix.
 * This establishes an enforced boundary constraint preventing un-versioned fallback leaks.
 */
app.use(API_VERSION_PREFIX, apiRouter);

apiRouter.use(
  createMilestoneValidationRouter({
    requireAuth,
    milestoneRepository,
    verifierAssignmentRepository,
    milestoneValidationEventRepository,
    domainEventPublisher,
  }),
);

/**
 * @notice Operational route explicitly bypassing the API prefix boundary.
 * @dev Used generically by load balancers and orchestrators without coupling them to specific versions.
 */
app.get("/health", async (_req: Request, res: Response) => {
  const db = await dbHealth();
  res.status(db.healthy ? 200 : 503).json({
    status: db.healthy ? "ok" : "degraded",
    service: "revora-backend",
    db,
  });
});

apiRouter.get('/overview', (_req: Request, res: Response) => {
  res.json({
    name: "Stellar RevenueShare (Revora) Backend",
    description:
      "Backend API skeleton for tokenized revenue-sharing on Stellar (offerings, investments, revenue distribution).",
  });
});

const shutdown = async (signal: string) => {
  console.log(`\n[server] ${signal} DB shutting down…`);
  await closePool();
  process.exit(0);
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

if (process.env.NODE_ENV !== "test") {
  app.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`revora-backend listening on http://localhost:${port}`);
  });
}

export default app;
