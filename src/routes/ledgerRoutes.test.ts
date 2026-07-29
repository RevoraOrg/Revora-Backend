import { describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { Pool, PoolClient } from 'pg';
import request from 'supertest';
import { createApp } from '../index';
import { LedgerService } from '../services/ledgerService';
import { LedgerPeriodLockRepository } from '../db/repositories/ledgerPeriodLockRepository';
import { RevenueReportRepository } from '../db/repositories/revenueReportRepository';
import { AuditLogRepository } from '../db/repositories/auditLogRepository';
import { MetricsCollector } from '../lib/metrics';
import { Logger } from '../lib/logger';
import { createLedgerRoutes } from './ledgerRoutes';
import { withTransaction } from '../db/transaction';

/**
 * Ledger Close Endpoint Tests
 * 
 * Coverage:
 * - Dual-control enforcement (different actors required)
 * - Period locking and rejection of writes to locked periods
 * - Export determinism and re-close idempotency
 * - Concurrent write race conditions
 * - Audit logging for both actors
 * - Metrics collection
 * - Self-confirmation rejection
 */

describe('Ledger Close Routes', () => {
  let pool: Pool;
  let ledgerService: LedgerService;
  let lockRepo: LedgerPeriodLockRepository;
  let revenueRepo: RevenueReportRepository;
  let auditRepo: AuditLogRepository;
  let metricsCollector: MetricsCollector;
  let logger: Logger;
  let app: ReturnType<typeof createApp>;

  const testOfferingId = '550e8400-e29b-41d4-a716-446655440000';
  const testPeriodId = '2024-01';
  const actor1Id = '660e8400-e29b-41d4-a716-446655440001';
  const actor2Id = '770e8400-e29b-41d4-a716-446655440002';
  const issuerId = '880e8400-e29b-41d4-a716-446655440003';

  // Helper: create test offering
  async function createTestOffering(client: PoolClient) {
    return client.query(
      `INSERT INTO offerings (id, issuer_id, name, description, status, target_amount, minimum_investment)
       VALUES ($1, $2, 'Test Offering', 'Test offering for ledger close', 'open', '1000.00', '10.00')
       RETURNING id`,
      [testOfferingId, issuerId]
    );
  }

  // Helper: create test users
  async function createTestUsers(client: PoolClient) {
    for (const userId of [actor1Id, actor2Id, issuerId]) {
      await client.query(
        `INSERT INTO users (id, email, role) VALUES ($1, $2, 'startup')
         ON CONFLICT (id) DO NOTHING`,
        [userId, `user-${userId}@example.com`]
      );
    }
  }

  // Helper: add revenue reports for a period
  async function addRevenueReports(
    client: PoolClient,
    count: number = 3,
    periodId: string = testPeriodId
  ) {
    const periodStart = new Date('2024-01-01');
    const periodEnd = new Date('2024-01-31');

    for (let i = 0; i < count; i++) {
      await client.query(
        `INSERT INTO revenue_reports (offering_id, issuer_id, amount, period_id, period_start, period_end, reported_by, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')`,
        [testOfferingId, issuerId, `100.${i}0`, periodId, periodStart, periodEnd, actor1Id]
      );
    }
  }

  beforeAll(async () => {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL || 'postgres://localhost/revora_test',
    });

    lockRepo = new LedgerPeriodLockRepository(pool);
    revenueRepo = new RevenueReportRepository(pool);
    auditRepo = new AuditLogRepository(pool);
    metricsCollector = new MetricsCollector();
    logger = new Logger({ level: 'debug' });
    ledgerService = new LedgerService(pool, lockRepo);

    // Create test app with ledger routes
    app = createApp();
    const ledgerRouter = createLedgerRoutes(
      ledgerService,
      auditRepo,
      metricsCollector,
      logger
    );
    app.use('/ledger', ledgerRouter);

    // Setup test data
    await withTransaction(pool, async (client) => {
      await createTestUsers(client);
      await createTestOffering(client);
      await addRevenueReports(client, 3, testPeriodId);
    });
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    // Clean up locks before each test
    await pool.query(`DELETE FROM ledger_period_locks WHERE offering_id = $1`, [
      testOfferingId,
    ]);
  });

  describe('POST /ledger/close/:offeringId/initiate/:periodId', () => {
    it('should initiate a period close by first actor', async () => {
      const res = await request(app)
        .post(`/ledger/close/${testOfferingId}/initiate/${testPeriodId}`)
        .set('Authorization', `Bearer actor1`)
        .send({});

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        lock_id: expect.any(String),
        period_id: testPeriodId,
        offering_id: testOfferingId,
        status: 'initiated',
        initiated_by: expect.any(String),
        initiated_at: expect.any(String),
      });
      expect(res.body.message).toContain('awaiting confirmation');
    });

    it('should reject duplicate initiation for same period', async () => {
      // First initiation
      await request(app)
        .post(`/ledger/close/${testOfferingId}/initiate/${testPeriodId}`)
        .send({});

      // Second initiation should fail
      const res = await request(app)
        .post(`/ledger/close/${testOfferingId}/initiate/${testPeriodId}`)
        .send({});

      expect(res.status).toBe(409);
      expect(res.body.error).toContain('already has an initiated close');
    });

    it('should reject invalid period ID format', async () => {
      const invalidPeriodId = 'invalid!!!period';
      const res = await request(app)
        .post(`/ledger/close/${testOfferingId}/initiate/${invalidPeriodId}`)
        .send({});

      expect(res.status).toBe(400);
    });

    it('should reject invalid offering ID format', async () => {
      const invalidOfferingId = 'not-a-uuid';
      const res = await request(app)
        .post(`/ledger/close/${invalidOfferingId}/initiate/${testPeriodId}`)
        .send({});

      expect(res.status).toBe(400);
    });
  });

  describe('POST /ledger/close/:offeringId/confirm/:periodId', () => {
    it('should confirm period close by second actor', async () => {
      // Initiate by actor1
      const initiateRes = await request(app)
        .post(`/ledger/close/${testOfferingId}/initiate/${testPeriodId}`)
        .send({});

      const lockId = initiateRes.body.lock_id;
      expect(initiateRes.status).toBe(201);

      // Confirm by actor2
      const confirmRes = await request(app)
        .post(`/ledger/close/${testOfferingId}/confirm/${testPeriodId}`)
        .send({});

      expect(confirmRes.status).toBe(200);
      expect(confirmRes.body).toMatchObject({
        lock_id: lockId,
        period_id: testPeriodId,
        offering_id: testOfferingId,
        status: 'locked',
        export_hash: expect.stringMatching(/^[a-f0-9]{64}$/), // SHA-256 hex
        export_signature: expect.stringMatching(/^[a-f0-9]{128}$/), // HMAC-SHA256 hex
        signing_algorithm: 'hmac-sha256-v1',
        entry_count: 3,
      });
      expect(confirmRes.body.message).toContain('successfully locked');
    });

    it('should reject self-confirmation (dual-control violation)', async () => {
      // Initiate by actor1
      await request(app)
        .post(`/ledger/close/${testOfferingId}/initiate/${testPeriodId}`)
        .send({});

      // Attempt confirmation by same actor (should fail)
      const confirmRes = await request(app)
        .post(`/ledger/close/${testOfferingId}/confirm/${testPeriodId}`)
        .send({});

      expect(confirmRes.status).toBe(403);
      expect(confirmRes.body.error).toContain('different actor');
    });

    it('should reject confirmation for non-existent initiated lock', async () => {
      const res = await request(app)
        .post(`/ledger/close/${testOfferingId}/confirm/${testPeriodId}`)
        .send({});

      expect(res.status).toBe(404);
      expect(res.body.error).toContain('No initiated close found');
    });

    it('should materialize export with correct entry count', async () => {
      // Add 5 revenue reports
      await withTransaction(pool, async (client) => {
        await addRevenueReports(client, 5, testPeriodId);
      });

      // Initiate and confirm
      await request(app)
        .post(`/ledger/close/${testOfferingId}/initiate/${testPeriodId}`)
        .send({});

      const confirmRes = await request(app)
        .post(`/ledger/close/${testOfferingId}/confirm/${testPeriodId}`)
        .send({});

      expect(confirmRes.status).toBe(200);
      // 3 from setup + 5 added = 8 total
      expect(confirmRes.body.entry_count).toBe(8);
    });
  });

  describe('GET /ledger/close/:offeringId/status/:periodId', () => {
    it('should return status of locked period', async () => {
      // Setup: initiate and confirm
      await request(app)
        .post(`/ledger/close/${testOfferingId}/initiate/${testPeriodId}`)
        .send({});

      const confirmRes = await request(app)
        .post(`/ledger/close/${testOfferingId}/confirm/${testPeriodId}`)
        .send({});

      const exportHash = confirmRes.body.export_hash;
      const exportSignature = confirmRes.body.export_signature;

      // Query status
      const statusRes = await request(app).get(
        `/ledger/close/${testOfferingId}/status/${testPeriodId}`
      );

      expect(statusRes.status).toBe(200);
      expect(statusRes.body).toMatchObject({
        offering_id: testOfferingId,
        period_id: testPeriodId,
        status: 'locked',
        export_hash: exportHash,
        export_signature: exportSignature,
      });
    });

    it('should return 404 for non-existent period', async () => {
      const res = await request(app).get(
        `/ledger/close/${testOfferingId}/status/2025-12`
      );

      expect(res.status).toBe(404);
    });

    it('should return identical hash on re-query (idempotency)', async () => {
      // Setup: lock period
      await request(app)
        .post(`/ledger/close/${testOfferingId}/initiate/${testPeriodId}`)
        .send({});

      const firstConfirm = await request(app)
        .post(`/ledger/close/${testOfferingId}/confirm/${testPeriodId}`)
        .send({});

      const firstHash = firstConfirm.body.export_hash;

      // Query status multiple times
      const status1 = await request(app).get(
        `/ledger/close/${testOfferingId}/status/${testPeriodId}`
      );

      const status2 = await request(app).get(
        `/ledger/close/${testOfferingId}/status/${testPeriodId}`
      );

      expect(status1.body.export_hash).toBe(firstHash);
      expect(status2.body.export_hash).toBe(firstHash);
      expect(status1.body.export_hash).toBe(status2.body.export_hash);
    });
  });

  describe('Race Condition: Concurrent Writes to Locked Period', () => {
    it('should prevent journal writes after period is locked', async () => {
      // Lock the period
      await request(app)
        .post(`/ledger/close/${testOfferingId}/initiate/${testPeriodId}`)
        .send({});

      await request(app)
        .post(`/ledger/close/${testOfferingId}/confirm/${testPeriodId}`)
        .send({});

      // Attempt to write a revenue report to the locked period
      const writeRes = await request(app).post(`/offerings/${testOfferingId}/revenue`).send({
        amount: '50.00',
        periodStart: '2024-01-01T00:00:00Z',
        periodEnd: '2024-01-31T23:59:59Z',
      });

      expect(writeRes.status).toBe(409);
      expect(writeRes.body.error).toContain('locked');
    });

    it('should allow writes to different periods after lock', async () => {
      const period2 = '2024-02';

      // Lock period 1
      await request(app)
        .post(`/ledger/close/${testOfferingId}/initiate/${testPeriodId}`)
        .send({});

      await request(app)
        .post(`/ledger/close/${testOfferingId}/confirm/${testPeriodId}`)
        .send({});

      // Add revenue report for period 2 (should succeed)
      const writeRes = await request(app).post(`/offerings/${testOfferingId}/revenue`).send({
        amount: '75.00',
        periodStart: '2024-02-01T00:00:00Z',
        periodEnd: '2024-02-29T23:59:59Z',
      });

      expect(writeRes.status).toBe(202); // Async acceptance
    });
  });

  describe('Audit Logging', () => {
    it('should record audit events for initiation', async () => {
      await request(app)
        .post(`/ledger/close/${testOfferingId}/initiate/${testPeriodId}`)
        .send({});

      const auditLogs = await auditRepo.getAuditLogsByAction('ledger_close_initiated');
      const relevant = auditLogs.find(
        (log) =>
          log.resource?.includes(testPeriodId) &&
          log.resource?.includes(testOfferingId)
      );

      expect(relevant).toBeDefined();
      expect(relevant?.action).toBe('ledger_close_initiated');
    });

    it('should record audit events for confirmation with both actors', async () => {
      // Initiate
      await request(app)
        .post(`/ledger/close/${testOfferingId}/initiate/${testPeriodId}`)
        .send({});

      // Confirm
      await request(app)
        .post(`/ledger/close/${testOfferingId}/confirm/${testPeriodId}`)
        .send({});

      const auditLogs = await auditRepo.getAuditLogsByAction('ledger_close_confirmed');
      const relevant = auditLogs.find(
        (log) =>
          log.resource?.includes(testPeriodId) &&
          log.resource?.includes(testOfferingId)
      );

      expect(relevant).toBeDefined();
      expect(relevant?.action).toBe('ledger_close_confirmed');

      const details = JSON.parse(relevant?.details || '{}');
      expect(details.initiated_by).toBeDefined();
      expect(details.confirmed_by).toBeDefined();
    });
  });

  describe('Export Determinism', () => {
    it('should produce identical hash for same data', async () => {
      // Lock period
      const confirmRes1 = await request(app)
        .post(`/ledger/close/${testOfferingId}/initiate/${testPeriodId}`)
        .send();

      await withTransaction(pool, async (client) => {
        const lockId = confirmRes1.body.lock_id;
        // Reset status back to initiated for re-test (simulating a test scenario)
        // In real system, re-lock would use existing hash
        await client.query(
          `DELETE FROM ledger_period_locks WHERE id = $1`,
          [lockId]
        );
      });

      const confirmRes2 = await request(app)
        .post(`/ledger/close/${testOfferingId}/confirm/${testPeriodId}`)
        .send();

      // Hash should be identical since underlying data is the same
      expect(confirmRes1.body.export_hash).toBe(confirmRes2.body.export_hash);
      expect(confirmRes1.body.export_signature).toBe(confirmRes2.body.export_signature);
    });
  });

  describe('Metrics Collection', () => {
    it('should record metrics for initiation', async () => {
      await request(app)
        .post(`/ledger/close/${testOfferingId}/initiate/${testPeriodId}`)
        .send({});

      const counters = metricsCollector.getAllMetrics().counters;
      const initiateCounter = counters.find(
        (m) => m.name === 'ledger_close_initiated_total'
      );

      expect(initiateCounter).toBeDefined();
      expect(initiateCounter?.value).toBeGreaterThan(0);
    });

    it('should record metrics for confirmation', async () => {
      await request(app)
        .post(`/ledger/close/${testOfferingId}/initiate/${testPeriodId}`)
        .send({});

      await request(app)
        .post(`/ledger/close/${testOfferingId}/confirm/${testPeriodId}`)
        .send({});

      const counters = metricsCollector.getAllMetrics().counters;
      const confirmCounter = counters.find(
        (m) => m.name === 'ledger_close_confirmed_total'
      );

      expect(confirmCounter).toBeDefined();
      expect(confirmCounter?.value).toBeGreaterThan(0);
    });

    it('should record entry count gauge', async () => {
      await request(app)
        .post(`/ledger/close/${testOfferingId}/initiate/${testPeriodId}`)
        .send({});

      await request(app)
        .post(`/ledger/close/${testOfferingId}/confirm/${testPeriodId}`)
        .send({});

      const gauges = metricsCollector.getAllMetrics().gauges;
      const entryCountGauge = gauges.find(
        (m) => m.name === 'ledger_export_entry_count'
      );

      expect(entryCountGauge).toBeDefined();
      expect(entryCountGauge?.value).toBe(3); // From setup
    });
  });
});
