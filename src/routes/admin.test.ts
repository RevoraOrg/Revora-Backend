import request from 'supertest';
import { createApp } from '../index';
import { pool } from '../db/pool';
import { AuditLogRepository } from '../db/repositories/auditLogRepository';
import { AuditPurgeService } from '../services/auditPurgeService';
import { MetricsCollector } from '../lib/metrics';
import { Keypair } from '@stellar/stellar-sdk';
import { env } from '../config/env';
import crypto from 'crypto';

// Setup Stellar Server Secret for signing tests
if (!env.STELLAR_SERVER_SECRET) {
  env.STELLAR_SERVER_SECRET = Keypair.random().secret();
}

describe('Audit Log Retention and Export', () => {
  const app = createApp();
  let auditLogRepo: AuditLogRepository;
  let adminToken: string;
  let nonAdminToken: string;
  let adminUser: { id: string };

  beforeAll(async () => {
    // Ensure audit_logs table exists
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS audit_logs (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id UUID,
          action VARCHAR(255) NOT NULL,
          resource VARCHAR(255),
          details TEXT,
          ip_address INET,
          user_agent TEXT,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id ON audit_logs(user_id);
        CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action);
        CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at);
      `);
    } catch (e) {
      // ignore if creation fails
    }
    // Clean audit_logs table if exists
    try {
      await pool.query('DELETE FROM audit_logs');
    } catch (e) {
      // ignore if table does not exist or other errors during test setup
    }

    adminUser = { id: '00000000-0000-0000-0000-000000000000' };

    // Generate valid tokens
    const secret = env.JWT_SECRET || 'testsecret_that_is_at_least_sixteen_chars';
    env.JWT_SECRET = secret;
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    
    // Admin Token
    const adminPayload = Buffer.from(JSON.stringify({ sub: adminUser.id, role: 'admin', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
    const adminSig = crypto.createHmac('sha256', secret).update(`${header}.${adminPayload}`).digest('base64url');
    adminToken = `${header}.${adminPayload}.${adminSig}`;

    // Non-Admin Token
    const nonAdminPayload = Buffer.from(JSON.stringify({ sub: adminUser.id, role: 'investor', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
    const nonAdminSig = crypto.createHmac('sha256', secret).update(`${header}.${nonAdminPayload}`).digest('base64url');
    nonAdminToken = `${header}.${nonAdminPayload}.${nonAdminSig}`;
  });

  beforeEach(async () => {
    // Clean audit_logs table before each test
    try {
      await pool.query('DELETE FROM audit_logs');
    } catch (e) {
      // ignore errors during setup
    }
  });

  afterAll(async () => {
    // Clean audit_logs table after all tests
    try {
      await pool.query('DELETE FROM audit_logs');
    } catch (e) {
      // ignore errors during teardown
    }
  });

  describe('AuditLogRepository - purgeBefore', () => {
    it('should respect retention window and purge older logs', async () => {
      // Create one old log and one new log
      await auditLogRepo.createAuditLog({ action: 'OLD_ACTION' });
      await auditLogRepo.createAuditLog({ action: 'NEW_ACTION' });

      // Manually set created_at for the old log
      const oldDate = new Date();
      oldDate.setDate(oldDate.getDate() - 100);
      await pool.query('UPDATE audit_logs SET created_at = $1 WHERE action = $2', [oldDate, 'OLD_ACTION']);

      // Cutoff 90 days ago
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - 90);

      const deleted = await auditLogRepo.purgeBefore(cutoffDate);
      expect(deleted.deletedCount).toBe(1);
      expect(deleted.skippedHoldCount).toBe(0);

      const remaining = await pool.query('SELECT * FROM audit_logs');
      expect(remaining.rows.length).toBe(1);
      expect(remaining.rows[0].action).toBe('NEW_ACTION');
    });
  });

  describe('AuditPurgeService', () => {
    it('should invoke repository purge and update metrics', async () => {
      const metrics = new MetricsCollector({ enabled: true });
      const service = new AuditPurgeService(auditLogRepo, metrics);

      await auditLogRepo.createAuditLog({ action: 'OLD_ACTION' });
      const oldDate = new Date();
      oldDate.setDate(oldDate.getDate() - 100);
      await pool.query('UPDATE audit_logs SET created_at = $1 WHERE action = $2', [oldDate, 'OLD_ACTION']);

      env.AUDIT_RETENTION_DAYS = 90;

      await service.runPurge();

      const snapshot = await metrics.getSnapshot();
      expect(snapshot.application.audit_logs_purged_total.success).toBe(1);
      expect(snapshot.application.audit_purge_duration_ms.success.count).toBe(1);
    });
  });

  describe('GET /api/v1/admin/audit-log/export.csv', () => {
    it('should return 401 without token', async () => {
      const response = await request(app).get('/api/v1/admin/audit-log/export.csv');
      expect(response.status).toBe(401);
    });

    it('should return 403 for non-admin', async () => {
      const response = await request(app)
        .get('/api/v1/admin/audit-log/export.csv')
        .set('Authorization', `Bearer ${nonAdminToken}`);
      expect(response.status).toBe(403);
    });

    it('should return 200 and signed CSV for admin', async () => {
      await auditLogRepo.createAuditLog({ action: 'TEST_ACTION', details: 'Some "quoted" details' });
      await auditLogRepo.createAuditLog({ action: 'TEST_ACTION_2' });

      const response = await request(app)
        .get('/api/v1/admin/audit-log/export.csv?limit=1')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain('text/csv');
      expect(response.headers['content-disposition']).toBe('attachment; filename="audit-logs.csv"');
      
      const signature = response.headers['x-ed25519-signature'];
      const publicKey = response.headers['x-ed25519-public-key'];
      const manifestBase64 = response.headers['x-audit-manifest'];

      expect(signature).toBeDefined();
      expect(publicKey).toBeDefined();
      expect(manifestBase64).toBeDefined();

      const manifestString = Buffer.from(manifestBase64, 'base64').toString('utf8');
      const manifest = JSON.parse(manifestString);

      expect(manifest.limit).toBe(1);
      
      const payloadToVerify = Buffer.from(`${manifestString}\n${response.text}`, 'utf8');
      
      // Verify signature offline using Ed25519 documented public key
      const kp = Keypair.fromPublicKey(publicKey);
      const isValid = kp.verify(payloadToVerify, Buffer.from(signature, 'base64'));
      expect(isValid).toBe(true);

      // Verify pagination (we limited to 1)
      const rows = response.text.split('\n');
      // 1 header + 1 row = 2 lines
      expect(rows.length).toBe(2);
      expect(rows[0]).toContain('id,user_id,action,resource,details,ip_address,user_agent,created_at');
      expect(rows[1]).toContain('TEST_ACTION_2'); // newest first
    });
  });
});
