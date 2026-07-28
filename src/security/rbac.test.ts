import { Request, Response, NextFunction } from 'express';
import { createAuthorizationMiddleware } from './auth';
import { SecurityAuditRepository, SecurityConfig, UserRole, Permission } from './types';
import { Errors } from '../lib/errors';
import { globalLogger } from '../lib/logger';

jest.mock('../lib/logger');

describe('RBAC Middleware', () => {
    let mockAuditRepository: jest.Mocked<SecurityAuditRepository>;
    let mockReq: any;
    let mockRes: Partial<Response>;
    let mockNext: jest.Mock;
    let config: SecurityConfig;

    beforeEach(() => {
        mockAuditRepository = {
            record: jest.fn().mockResolvedValue(undefined),
        } as any;
        mockReq = {
            method: 'GET',
            path: '/test',
            headers: {},
            requestId: 'test-request-id',
            ip: '127.0.0.1',
        };
        mockRes = {
            status: jest.fn().mockReturnThis(),
            json: jest.fn().mockReturnThis(),
        };
        mockNext = jest.fn();
        config = {
            enabledPermissions: {
                admin: ['milestone:validate', 'milestone:view', 'vault:manage', 'audit:read'],
                verifier: ['milestone:validate', 'milestone:view'],
                issuer: ['milestone:view'],
                investor: ['milestone:view'],
            },
        } as any;
        jest.clearAllMocks();
    });

    it('should fail if securityContext is missing', async () => {
        const middleware = createAuthorizationMiddleware(['milestone:validate'], { auditRepository: mockAuditRepository, config });
        
        await middleware(mockReq as Request, mockRes as Response, mockNext);

        expect(mockRes.status).toHaveBeenCalledWith(401);
        expect(mockAuditRepository.record).toHaveBeenCalledWith(expect.objectContaining({
            outcome: 'FAILURE',
            action: 'authorization_attempt_without_context'
        }));
    });

    it('should allow access if user has required permissions', async () => {
        mockReq.securityContext = {
            user: { id: 'user-1', role: 'verifier', permissions: [], sessionId: 'sess-1' },
            requestId: 'test-request-id',
            timestamp: new Date(),
        };
        const middleware = createAuthorizationMiddleware(['milestone:validate'], { auditRepository: mockAuditRepository, config });

        await middleware(mockReq as Request, mockRes as Response, mockNext);

        expect(mockNext).toHaveBeenCalled();
        expect(mockReq.securityContext.user.permissions).toContain('milestone:validate');
        expect(mockAuditRepository.record).toHaveBeenCalledWith(expect.objectContaining({
            outcome: 'SUCCESS',
            action: 'permission_granted'
        }));
    });

    it('should deny access if user lacks required permissions', async () => {
        mockReq.securityContext = {
            user: { id: 'user-1', role: 'investor', permissions: [], sessionId: 'sess-1' },
            requestId: 'test-request-id',
            timestamp: new Date(),
        };
        const middleware = createAuthorizationMiddleware(['milestone:validate'], { auditRepository: mockAuditRepository, config });

        await middleware(mockReq as Request, mockRes as Response, mockNext);

        expect(mockRes.status).toHaveBeenCalledWith(403);
        expect(mockAuditRepository.record).toHaveBeenCalledWith(expect.objectContaining({
            outcome: 'FAILURE',
            action: 'permission_denied'
        }));
    });

    it('should handle admin having all permissions', async () => {
        mockReq.securityContext = {
            user: { id: 'user-1', role: 'admin', permissions: [], sessionId: 'sess-1' },
            requestId: 'test-request-id',
            timestamp: new Date(),
        };
        const middleware = createAuthorizationMiddleware(['vault:manage', 'audit:read'], { auditRepository: mockAuditRepository, config });

        await middleware(mockReq as Request, mockRes as Response, mockNext);

        expect(mockNext).toHaveBeenCalled();
        expect(mockReq.securityContext.user.permissions).toContain('vault:manage');
        expect(mockReq.securityContext.user.permissions).toContain('audit:read');
    });

    it('should deny guest/anonymous role', async () => {
        mockReq.securityContext = {
            user: { id: 'user-1', role: 'anonymous' as UserRole, permissions: [], sessionId: 'sess-1' },
            requestId: 'test-request-id',
            timestamp: new Date(),
        };
        const middleware = createAuthorizationMiddleware(['milestone:view'], { auditRepository: mockAuditRepository, config });

        await middleware(mockReq as Request, mockRes as Response, mockNext);

        expect(mockRes.status).toHaveBeenCalledWith(403);
    });
});
