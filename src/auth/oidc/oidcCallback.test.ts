import express from 'express';
import request from 'supertest';
import { createOidcRouter } from './oidcRoute';

describe('GET /api/auth/oidc/callback', () => {
  it('maps groups to roles and updates user', async () => {
    const oidcAdapter = {
      consumeFlowState: jest.fn().mockReturnValue({ tenantId: 'tenant-1', nonce: 'n1' }),
      getDiscovery: jest.fn().mockResolvedValue({}),
      exchangeCode: jest.fn().mockResolvedValue({ id_token: 'id_tok' }),
      validateIdToken: jest.fn().mockResolvedValue({
        sub: 'sub-1',
        email: 'test@example.com',
        groups: ['admin-group'],
        iss: 'iss-1'
      }),
    } as any;

    const oidcProviderRepo = {
      findByTenantId: jest.fn().mockResolvedValue({ tenant_id: 'tenant-1', issuer_url: 'iss-1' }),
    } as any;

    const oidcGroupMappingRepo = {
      findByTenantId: jest.fn().mockResolvedValue([
        { claim_group: 'admin-group', revora_role: 'investor' }
      ]),
    } as any;

    const userRepo = {
      findByEmail: jest.fn().mockResolvedValue({
        id: 'user-1',
        email: 'test@example.com',
        last_oidc_groups: ['old-group']
      }),
      updateUser: jest.fn().mockResolvedValue({}),
    } as any;

    const auditLogRepo = {
      createAuditLog: jest.fn().mockResolvedValue({}),
    } as any;

    const app = express();
    app.use(express.json());
    app.use(createOidcRouter({ 
      oidcAdapter, 
      oidcProviderRepo, 
      userRepo, 
      oidcGroupMappingRepo, 
      auditLogRepo,
      requireAdmin: jest.fn() 
    }));

    const res = await request(app).get('/api/auth/oidc/callback?code=abc&state=xyz');
    
    expect(res.status).toBe(200);
    expect(res.body.mappedRole).toBe('investor');

    expect(auditLogRepo.createAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      action: 'oidc.claim.changed',
      details: expect.stringContaining('admin-group')
    }));

    expect(userRepo.updateUser).toHaveBeenCalledWith({
      id: 'user-1',
      last_oidc_groups: ['admin-group'],
      role: 'investor'
    });
  });

  it('ignores missing groups claim and does not remove role', async () => {
    const oidcAdapter = {
      consumeFlowState: jest.fn().mockReturnValue({ tenantId: 'tenant-1', nonce: 'n1' }),
      getDiscovery: jest.fn().mockResolvedValue({}),
      exchangeCode: jest.fn().mockResolvedValue({ id_token: 'id_tok' }),
      validateIdToken: jest.fn().mockResolvedValue({
        sub: 'sub-2',
        email: 'test2@example.com',
        // missing groups
        iss: 'iss-1'
      }),
    } as any;

    const oidcProviderRepo = {
      findByTenantId: jest.fn().mockResolvedValue({ tenant_id: 'tenant-1', issuer_url: 'iss-1' }),
    } as any;

    const oidcGroupMappingRepo = {
      findByTenantId: jest.fn().mockResolvedValue([]),
    } as any;

    const userRepo = {
      findByEmail: jest.fn().mockResolvedValue({
        id: 'user-2',
        email: 'test2@example.com',
        last_oidc_groups: ['admin-group'],
        role: 'investor'
      }),
      updateUser: jest.fn().mockResolvedValue({}),
    } as any;

    const auditLogRepo = {
      createAuditLog: jest.fn().mockResolvedValue({}),
    } as any;

    const app = express();
    app.use(express.json());
    app.use(createOidcRouter({ 
      oidcAdapter, 
      oidcProviderRepo, 
      userRepo, 
      oidcGroupMappingRepo, 
      auditLogRepo,
      requireAdmin: jest.fn() 
    }));

    const res = await request(app).get('/api/auth/oidc/callback?code=abc&state=xyz');
    
    expect(res.status).toBe(200);
    
    // User update should be called with empty array for groups
    expect(auditLogRepo.createAuditLog).toHaveBeenCalled();
    expect(userRepo.updateUser).toHaveBeenCalledWith({
      id: 'user-2',
      last_oidc_groups: [],
      // role is NOT included, so it is not overwritten
    });
  });
});
