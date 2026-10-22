import request from 'supertest';
import express from 'express';
import { createAdminRouter } from '../admin';
import { errorHandler } from '../../middleware/errorHandler';
import { TenantSettingsRepository } from '../../db/repositories/tenantSettingsRepository';
import { SessionPolicyValidator } from '../../services/sessionPolicyValidator';
import { AuditLogRepository } from '../../db/repositories/auditLogRepository';

import { Request, Response, NextFunction } from 'express';

jest.mock('../../middleware/auth', () => {
  const actual = jest.requireActual('../../middleware/auth');
  return {
    ...actual,
    requireAdmin: (req: Request, _res: Response, next: NextFunction) => {
      (req as unknown as { user: { id: string; role: string } }).user = { id: 'admin-1', role: 'admin' };
      next();
    },
  };
});

describe('POST /admin/tenant-settings/:tenantId/session-policy', () => {
  let app: express.Express;
  let mockAuditLogRepo: jest.Mocked<Partial<AuditLogRepository>>;
  let mockTenantSettingsRepo: jest.Mocked<Partial<TenantSettingsRepository>>;
  let mockSessionPolicyValidator: jest.Mocked<Partial<SessionPolicyValidator>>;

  beforeEach(() => {
    mockAuditLogRepo = {
      getAuditLogsForExport: jest.fn().mockResolvedValue([]),
    };
    mockTenantSettingsRepo = {
      findByTenantId: jest.fn(),
      setSessionPolicy: jest.fn(),
      updateSettings: jest.fn(),
    };
    mockSessionPolicyValidator = {
      validateStrictOptIn: jest.fn().mockResolvedValue(undefined),
    };

    app = express();
    app.use(express.json());
    app.use(
      '/admin',
      createAdminRouter(
        mockAuditLogRepo as AuditLogRepository,
        undefined,
        mockTenantSettingsRepo as TenantSettingsRepository,
        mockSessionPolicyValidator as SessionPolicyValidator,
      ),
    );
    app.use(errorHandler);
  });

  it('updates session policy to strict using setSessionPolicy', async () => {
    (mockTenantSettingsRepo.setSessionPolicy as jest.Mock).mockResolvedValueOnce({
      tenant_id: 'tenant-1',
      settings: { theme: 'dark' },
      session_policy: 'strict',
      created_at: new Date(),
      updated_at: new Date(),
    });

    const response = await request(app)
      .post('/admin/tenant-settings/tenant-1/session-policy')
      .send({ policy: 'strict' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ session_policy: 'strict' });
    expect(mockSessionPolicyValidator.validateStrictOptIn).toHaveBeenCalledWith('tenant-1');
    expect(mockTenantSettingsRepo.setSessionPolicy).toHaveBeenCalledWith('tenant-1', 'strict');
    // Ensure updateSettings / findByTenantId were not invoked
    expect(mockTenantSettingsRepo.updateSettings).not.toHaveBeenCalled();
    expect(mockTenantSettingsRepo.findByTenantId).not.toHaveBeenCalled();
  });

  it('updates session policy to lax without calling validateStrictOptIn', async () => {
    (mockTenantSettingsRepo.setSessionPolicy as jest.Mock).mockResolvedValueOnce({
      tenant_id: 'tenant-1',
      settings: { theme: 'dark' },
      session_policy: 'lax',
      created_at: new Date(),
      updated_at: new Date(),
    });

    const response = await request(app)
      .post('/admin/tenant-settings/tenant-1/session-policy')
      .send({ policy: 'lax' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ session_policy: 'lax' });
    expect(mockSessionPolicyValidator.validateStrictOptIn).not.toHaveBeenCalled();
    expect(mockTenantSettingsRepo.setSessionPolicy).toHaveBeenCalledWith('tenant-1', 'lax');
  });

  it('rejects invalid policy values with 400 Bad Request', async () => {
    const response = await request(app)
      .post('/admin/tenant-settings/tenant-1/session-policy')
      .send({ policy: 'invalid-policy' });

    expect(response.status).toBe(400);
    expect(mockTenantSettingsRepo.setSessionPolicy).not.toHaveBeenCalled();
  });

  it('propagates validation errors when strict opt-in fails', async () => {
    (mockSessionPolicyValidator.validateStrictOptIn as jest.Mock).mockRejectedValueOnce(
      new Error('Cannot opt-in to Strict mode: configured cross-site redirect URI found'),
    );

    const response = await request(app)
      .post('/admin/tenant-settings/tenant-1/session-policy')
      .send({ policy: 'strict' });

    expect(response.status).toBe(500);
    expect(mockTenantSettingsRepo.setSessionPolicy).not.toHaveBeenCalled();
  });
});
