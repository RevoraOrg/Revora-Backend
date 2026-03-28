/**
 * Integration Example: Hardened Milestone Validation System
 * 
 * This file demonstrates how to integrate the hardened milestone validation
 * auth matrix into the main application, replacing the existing basic validation.
 */

import express from 'express';
import { Pool } from 'pg';
import {
  createHardenedMilestoneValidationRouter,
  createSecurityMonitoringRouter,
} from '../vaults/hardenedMilestoneValidation';
import {
  InMemorySecurityAuditRepository,
  DatabaseSecurityAuditRepository,
  createSecurityAuditRepository,
} from '../security/audit';
import {
  createRateLimitStore,
  RedisRateLimitStore,
} from '../security/rateLimit';
import {
  InMemoryValidationLimiter,
} from '../security/validation';
import {
  DEFAULT_SECURITY_CONFIG,
  SecurityConfig,
} from '../security/types';

// Example database repositories (implement these based on your existing schema)
class DatabaseMilestoneRepository {
  constructor(private pool: Pool) {}

  async getByVaultAndId(vaultId: string, milestoneId: string) {
    const query = `
      SELECT id, vault_id, status, validated_at, validated_by 
      FROM milestones 
      WHERE vault_id = $1 AND id = $2
    `;
    const result = await this.pool.query(query, [vaultId, milestoneId]);
    return result.rows[0] || null;
  }

  async markValidated(input: {
    vaultId: string;
    milestoneId: string;
    verifierId: string;
    validatedAt: Date;
  }) {
    const query = `
      UPDATE milestones 
      SET status = 'validated', validated_at = $1, validated_by = $2, updated_at = NOW()
      WHERE vault_id = $3 AND id = $4
      RETURNING *
    `;
    const result = await this.pool.query(query, [
      input.validatedAt,
      input.verifierId,
      input.vaultId,
      input.milestoneId,
    ]);
    return result.rows[0];
  }
}

class DatabaseVerifierAssignmentRepository {
  constructor(private pool: Pool) {}

  async isVerifierAssignedToVault(vaultId: string, verifierId: string): Promise<boolean> {
    const query = `
      SELECT 1 FROM verifier_assignments 
      WHERE vault_id = $1 AND verifier_id = $2 AND active = true
      LIMIT 1
    `;
    const result = await this.pool.query(query, [vaultId, verifierId]);
    return result.rows.length > 0;
  }
}

class DatabaseMilestoneValidationEventRepository {
  constructor(private pool: Pool) {}

  async create(input: {
    vaultId: string;
    milestoneId: string;
    verifierId: string;
    createdAt: Date;
  }) {
    const query = `
      INSERT INTO milestone_validation_events 
      (vault_id, milestone_id, verifier_id, created_at)
      VALUES ($1, $2, $3, $4)
      RETURNING *
    `;
    const result = await this.pool.query(query, [
      input.vaultId,
      input.milestoneId,
      input.verifierId,
      input.createdAt,
    ]);
    return result.rows[0];
  }
}

class DatabaseDomainEventPublisher {
  constructor(private pool: Pool) {}

  async publish(eventName: string, payload: Record<string, unknown>): Promise<void> {
    const query = `
      INSERT INTO domain_events (event_name, payload, created_at)
      VALUES ($1, $2, NOW())
    `;
    await this.pool.query(query, [eventName, JSON.stringify(payload)]);
  }
}

/**
 * Create hardened milestone validation dependencies
 */
export const createHardenedMilestoneValidationDeps = (
  pool: Pool,
  redis?: any,
  environment = process.env.NODE_ENV
) => {
  // Create repositories
  const milestoneRepository = new DatabaseMilestoneRepository(pool);
  const verifierAssignmentRepository = new DatabaseVerifierAssignmentRepository(pool);
  const milestoneValidationEventRepository = new DatabaseMilestoneValidationEventRepository(pool);
  const domainEventPublisher = new DatabaseDomainEventPublisher(pool);

  // Create security components
  const auditRepository = createSecurityAuditRepository(pool, environment);
  const rateLimitStore = redis 
    ? new RedisRateLimitStore(redis)
    : createRateLimitStore();
  const validationLimiter = new InMemoryValidationLimiter(
    DEFAULT_SECURITY_CONFIG.maxConcurrentValidations
  );

  // Production security configuration
  const securityConfig: SecurityConfig = {
    ...DEFAULT_SECURITY_CONFIG,
    rateLimits: {
      'validation': {
        windowMs: 60 * 1000,
        maxRequests: environment === 'production' ? 10 : 100,
        skipSuccessfulRequests: false,
        skipFailedRequests: false,
      },
      'auth': {
        windowMs: 15 * 60 * 1000,
        maxRequests: environment === 'production' ? 100 : 1000,
        skipSuccessfulRequests: true,
        skipFailedRequests: false,
      },
      'audit': {
        windowMs: 60 * 1000,
        maxRequests: environment === 'production' ? 1000 : 10000,
      },
    },
    maxConcurrentValidations: environment === 'production' ? 5 : 20,
    validationTimeoutMs: 30 * 1000,
    requireCsrfToken: environment === 'production',
  };

  return {
    milestoneRepository,
    verifierAssignmentRepository,
    milestoneValidationEventRepository,
    domainEventPublisher,
    auditRepository,
    validationLimiter,
    securityConfig,
  };
};

/**
 * Integration example for main application
 */
export const integrateHardenedMilestoneValidation = (
  app: express.Application,
  pool: Pool,
  redis?: any
) => {
  const deps = createHardenedMilestoneValidationDeps(pool, redis);

  // Replace the existing milestone validation router
  const hardenedValidationRouter = createHardenedMilestoneValidationRouter(deps);
  const securityMonitoringRouter = createSecurityMonitoringRouter(
    deps.auditRepository,
    deps.securityConfig
  );

  // Mount the hardened routers
  app.use('/api/v1', hardenedValidationRouter);
  app.use('/api/v1/security', securityMonitoringRouter);

  // Health check for security components
  app.get('/api/v1/health/security', async (req, res) => {
    try {
      // For in-memory repo, we can get count; for database repo, we'll just show status
      const auditRepo = deps.auditRepository as any;
      const auditCount = auditRepo instanceof InMemorySecurityAuditRepository 
        ? auditRepo.getEventCount()
        : 'database-backed';
      
      res.json({
        status: 'healthy',
        security: {
          auditEvents: auditCount,
          rateLimitStore: redis ? 'redis' : 'memory',
          validationLimiter: 'active',
          environment: process.env.NODE_ENV,
        },
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      res.status(500).json({
        status: 'unhealthy',
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  return deps;
};

/**
 * Database migration for security components
 */
export const SECURITY_MIGRATIONS = `
-- Security audit events table
CREATE TABLE IF NOT EXISTS security_audit_events (
  id VARCHAR(255) PRIMARY KEY,
  type VARCHAR(50) NOT NULL CHECK (type IN ('AUTHENTICATION', 'AUTHORIZATION', 'VALIDATION', 'SECURITY_VIOLATION')),
  user_id VARCHAR(255),
  session_id VARCHAR(255),
  action VARCHAR(255) NOT NULL,
  resource VARCHAR(255) NOT NULL,
  outcome VARCHAR(20) NOT NULL CHECK (outcome IN ('SUCCESS', 'FAILURE', 'BLOCKED')),
  details JSONB,
  security_context JSONB NOT NULL,
  timestamp TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Indexes for security audit events
CREATE INDEX IF NOT EXISTS idx_audit_user_id ON security_audit_events(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_session_id ON security_audit_events(session_id);
CREATE INDEX IF NOT EXISTS idx_audit_type ON security_audit_events(type);
CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON security_audit_events(timestamp);
CREATE INDEX IF NOT EXISTS idx_audit_security_violations ON security_audit_events(type, timestamp) 
WHERE type = 'SECURITY_VIOLATION';

-- Domain events table for milestone validation
CREATE TABLE IF NOT EXISTS domain_events (
  id SERIAL PRIMARY KEY,
  event_name VARCHAR(255) NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_domain_events_name ON domain_events(event_name);
CREATE INDEX IF NOT EXISTS idx_domain_events_created_at ON domain_events(created_at);

-- Milestone validation events table (if not exists)
CREATE TABLE IF NOT EXISTS milestone_validation_events (
  id SERIAL PRIMARY KEY,
  vault_id VARCHAR(255) NOT NULL,
  milestone_id VARCHAR(255) NOT NULL,
  verifier_id VARCHAR(255) NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  UNIQUE(vault_id, milestone_id, verifier_id)
);

CREATE INDEX IF NOT EXISTS idx_validation_events_vault ON milestone_validation_events(vault_id);
CREATE INDEX IF NOT EXISTS idx_validation_events_verifier ON milestone_validation_events(verifier_id);

-- Verifier assignments table (if not exists)
CREATE TABLE IF NOT EXISTS verifier_assignments (
  id SERIAL PRIMARY KEY,
  vault_id VARCHAR(255) NOT NULL,
  verifier_id VARCHAR(255) NOT NULL,
  assigned_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  assigned_by VARCHAR(255) NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  UNIQUE(vault_id, verifier_id, active)
);

CREATE INDEX IF NOT EXISTS idx_verifier_assignments_vault ON verifier_assignments(vault_id, active);
CREATE INDEX IF NOT EXISTS idx_verifier_assignments_verifier ON verifier_assignments(verifier_id, active);
`;

/**
 * Example usage in main application
 */
export const exampleUsage = `
import express from 'express';
import { Pool } from 'pg';
import Redis from 'redis';
import { integrateHardenedMilestoneValidation } from './hardenedMilestoneValidation.integration';

const app = express();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const redis = process.env.REDIS_URL ? Redis.createClient(process.env.REDIS_URL) : undefined;

// Basic middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Integrate hardened milestone validation
const securityDeps = integrateHardenedMilestoneValidation(app, pool, redis);

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(\`Server running on port \${PORT}\`);
  console.log('Hardened milestone validation system active');
  console.log('Security monitoring available at /api/v1/security/*');
  console.log('Security health check at /api/v1/health/security');
});
`;

export default integrateHardenedMilestoneValidation;
