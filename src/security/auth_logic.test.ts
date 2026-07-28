import { Request, Response, NextFunction } from 'express';
import { 
    extractAuthenticatedUser, 
    createSecurityContext, 
    createAuthenticationMiddleware,
    createAuthorizationMiddleware 
} from './auth';
import { SecurityAuditRepository, SecurityConfig, UserRole } from './types';
import { AuthenticationError } from './types';

describe('Security Auth Logic', () => {
    let mockAuditRepository: jest.Mocked<SecurityAuditRepository>;
    let mockReq: any;
    let mockRes: Partial<Response>;
    let mockNext: jest.Mock;

    beforeEach(() => {
        mockAuditRepository = {
            record: jest.fn().mockResolvedValue(undefined),
        } as any;
        mockReq = {
            method: 'GET',
            path: '/test',
            headers: {
                'x-forwarded-for': '1.2.3.4',
                'user-agent': 'test-agent'
            },
            requestId: 'test-request-id',
            connection: { remoteAddress: '127.0.0.1' }
        };
        mockRes = {
            status: jest.fn().mockReturnThis(),
            json: jest.fn().mockReturnThis(),
        };
        mockNext = jest.fn();
        jest.clearAllMocks();
    });

    describe('extractAuthenticatedUser', () => {
        it('should extract user from req.user', () => {
            mockReq.user = { id: 'user-1', role: 'admin' };
            const user = extractAuthenticatedUser(mockReq);
            expect(user.id).toBe('user-1');
            expect(user.role).toBe('admin');
        });

        it('should extract user from req.auth', () => {
            mockReq.auth = { userId: 'user-2', role: 'investor', sessionId: 'sess-1' };
            const user = extractAuthenticatedUser(mockReq);
            expect(user.id).toBe('user-2');
            expect(user.role).toBe('investor');
            expect(user.sessionId).toBe('sess-1');
        });

        it('should throw AuthenticationError if no user found', () => {
            expect(() => extractAuthenticatedUser(mockReq)).toThrow(AuthenticationError);
        });

        it('should throw AuthenticationError for invalid role', () => {
            mockReq.user = { id: 'user-1', role: 'invalid-role' };
            expect(() => extractAuthenticatedUser(mockReq)).toThrow('Invalid user role');
        });
    });

    describe('createSecurityContext', () => {
        it('should create context with correct metadata', () => {
            const user = { id: 'u1', role: 'admin' as UserRole, sessionId: 's1', permissions: [], authenticatedAt: new Date() };
            const context = createSecurityContext(mockReq, user);
            expect(context.ipAddress).toBe('1.2.3.4');
            expect(context.userAgent).toBe('test-agent');
            expect(context.requestId).toBe('test-request-id');
        });

        it('should fallback to remoteAddress if x-forwarded-for is missing', () => {
            delete mockReq.headers['x-forwarded-for'];
            const user = { id: 'u1', role: 'admin' as UserRole, sessionId: 's1', permissions: [], authenticatedAt: new Date() };
            const context = createSecurityContext(mockReq, user);
            expect(context.ipAddress).toBe('127.0.0.1');
        });
    });

    describe('createAuthenticationMiddleware', () => {
        it('should log success and proceed if user is valid', async () => {
            mockReq.user = { id: 'user-1', role: 'admin' };
            const middleware = createAuthenticationMiddleware({ auditRepository: mockAuditRepository });
            
            await middleware(mockReq as Request, mockRes as Response, mockNext);

            expect(mockNext).toHaveBeenCalled();
            expect(mockAuditRepository.record).toHaveBeenCalledWith(expect.objectContaining({
                outcome: 'SUCCESS',
                action: 'user_authenticated'
            }));
            expect(mockReq.securityContext).toBeDefined();
        });

        it('should log failure and return 401 if authentication fails', async () => {
            const middleware = createAuthenticationMiddleware({ auditRepository: mockAuditRepository });
            
            await middleware(mockReq as Request, mockRes as Response, mockNext);

            expect(mockRes.status).toHaveBeenCalledWith(401);
            expect(mockAuditRepository.record).toHaveBeenCalledWith(expect.objectContaining({
                outcome: 'FAILURE',
                action: 'user_authentication_failed'
            }));
        });

        it('should return 500 for non-AuthenticationError', async () => {
            mockReq.user = { id: 'user-1', role: 'admin' };
            const middleware = createAuthenticationMiddleware({ auditRepository: mockAuditRepository });
            
            // Force an unexpected error by mocking recordAuditEvent or similar if possible, 
            // but here let's just mock record to throw an error that is NOT caught inside the try block
            // Actually, the catch block catches everything.
            
            // To trigger 500, we need extractAuthenticatedUser to throw something else
            jest.spyOn(require('./auth'), 'extractAuthenticatedUser').mockImplementationOnce(() => {
                throw new Error('Unexpected');
            });

            await middleware(mockReq as Request, mockRes as Response, mockNext);
            expect(mockRes.status).toHaveBeenCalledWith(500);
        });
    });
});
