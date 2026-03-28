/**
 * Production-grade authentication and authorization middleware
 * 
 * Provides secure user authentication with comprehensive audit logging
 * and role-based access control (RBAC) with explicit permission checking.
 */

import { Request, Response, NextFunction } from 'express';
import { 
  AuthenticatedUser, 
  SecurityContext, 
  AuditEvent, 
  SecurityAuditRepository,
  UserRole,
  Permission,
  AuthenticationError,
  AuthorizationError,
  SecurityConfig,
  DEFAULT_SECURITY_CONFIG
} from './types';

export interface AuthMiddlewareDependencies {
  auditRepository: SecurityAuditRepository;
  config?: SecurityConfig;
}

/**
 * Extracts and validates authenticated user from request
 * Uses multiple extraction methods with fallback validation
 */
export const extractAuthenticatedUser = (req: Request): AuthenticatedUser => {
  // Try different authentication patterns used in the codebase
  const userFromToken = (req as any).user;
  const userFromAuth = (req as any).auth?.userId ? {
    id: (req as any).auth.userId,
    role: (req as any).auth.role,
    sessionId: (req as any).auth.sessionId,
  } : null;

  const user = userFromToken || userFromAuth;

  if (!user || !user.id || !user.role) {
    throw new AuthenticationError('No valid authentication found', {
      hasUser: !!userFromToken,
      hasAuth: !!userFromAuth,
      requestId: (req as any).requestId,
    });
  }

  // Validate role is from allowed set
  const validRoles: UserRole[] = ['admin', 'verifier', 'issuer', 'investor'];
  if (!validRoles.includes(user.role as UserRole)) {
    throw new AuthenticationError('Invalid user role', {
      userId: user.id,
      role: user.role,
      validRoles,
    });
  }

  // Extract session ID with fallback
  const sessionId = user.sessionId || (req as any).user?.sessionToken || 'unknown';

  return {
    id: user.id,
    role: user.role as UserRole,
    sessionId,
    permissions: [], // Will be populated by authorization middleware
    authenticatedAt: new Date(),
  };
};

/**
 * Creates security context from request for audit logging
 */
export const createSecurityContext = (req: Request, user: AuthenticatedUser): SecurityContext => {
  const xForwardedFor = req.headers['x-forwarded-for'] as string;
  const ipAddress = xForwardedFor?.split(',')[0] || 
                   req.connection?.remoteAddress || 
                   req.socket?.remoteAddress || 
                   'unknown';

  return {
    user,
    requestId: (req as any).requestId || 'unknown',
    ipAddress,
    userAgent: req.headers['user-agent'] || 'unknown',
    timestamp: new Date(),
  };
};

/**
 * Records audit events asynchronously to avoid blocking requests
 */
export const recordAuditEvent = async (
  auditRepository: SecurityAuditRepository,
  type: AuditEvent['type'],
  action: string,
  resource: string,
  outcome: AuditEvent['outcome'],
  securityContext: SecurityContext,
  details: Record<string, unknown> = {}
): Promise<void> => {
  try {
    const event: AuditEvent = {
      id: `audit-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      type,
      userId: securityContext.user.id,
      sessionId: securityContext.user.sessionId,
      action,
      resource,
      outcome,
      details,
      securityContext: {
        requestId: securityContext.requestId,
        ipAddress: securityContext.ipAddress,
        userAgent: securityContext.userAgent,
        timestamp: securityContext.timestamp,
      },
      timestamp: new Date(),
    };

    // Fire and forget - don't block the request
    auditRepository.record(event).catch(error => {
      console.error('Failed to record audit event:', error);
    });
  } catch (error) {
    console.error('Error creating audit event:', error);
  }
};

/**
 * Enhanced authentication middleware with comprehensive audit logging
 */
export const createAuthenticationMiddleware = ({
  auditRepository,
  config = DEFAULT_SECURITY_CONFIG,
}: AuthMiddlewareDependencies) => {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const startTime = Date.now();
    
    try {
      const user = extractAuthenticatedUser(req);
      const securityContext = createSecurityContext(req, user);

      // Record successful authentication
      await recordAuditEvent(
        auditRepository,
        'AUTHENTICATION',
        'user_authenticated',
        'auth_system',
        'SUCCESS',
        securityContext,
        { 
          authenticationTime: Date.now() - startTime,
          role: user.role,
        }
      );

      // Attach security context to request for downstream use
      (req as any).securityContext = securityContext;
      
      next();
    } catch (error) {
      const securityContext = {
        user: { id: 'anonymous', role: 'anonymous' as UserRole, sessionId: 'unknown', permissions: [], authenticatedAt: new Date() },
        requestId: (req as any).requestId || 'unknown',
        ipAddress: req.ip || 'unknown',
        userAgent: req.headers['user-agent'] || 'unknown',
        timestamp: new Date(),
      };

      // Record failed authentication
      if (error instanceof AuthenticationError) {
        await recordAuditEvent(
          auditRepository,
          'AUTHENTICATION',
          'user_authentication_failed',
          'auth_system',
          'FAILURE',
          securityContext,
          { 
            error: error.message,
            code: error.code,
            details: error.details,
            authenticationTime: Date.now() - startTime,
          }
        );
      }

      if (error instanceof AuthenticationError) {
        res.status(401).json({ 
          error: 'Authentication failed',
          code: error.code,
          requestId: securityContext.requestId,
        });
      } else {
        res.status(500).json({ 
          error: 'Internal authentication error',
          requestId: securityContext.requestId,
        });
      }
    }
  };
};

/**
 * Authorization middleware with role-based access control (RBAC)
 */
export const createAuthorizationMiddleware = (
  requiredPermissions: Permission[],
  { auditRepository, config = DEFAULT_SECURITY_CONFIG }: AuthMiddlewareDependencies
) => {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const securityContext = (req as any).securityContext as SecurityContext;
    
    if (!securityContext) {
      await recordAuditEvent(
        auditRepository,
        'AUTHORIZATION',
        'authorization_attempt_without_context',
        'auth_system',
        'FAILURE',
        {
          user: { id: 'unknown', role: 'unknown' as UserRole, sessionId: 'unknown', permissions: [], authenticatedAt: new Date() },
          requestId: (req as any).requestId || 'unknown',
          ipAddress: req.ip || 'unknown',
          userAgent: req.headers['user-agent'] || 'unknown',
          timestamp: new Date(),
        },
        { requiredPermissions }
      );

      res.status(401).json({ 
        error: 'Authentication required',
        requestId: (req as any).requestId,
      });
      return;
    }

    try {
      // Populate user permissions based on role and config
      const userPermissions = config.enabledPermissions[securityContext.user.role] || [];
      
      // Check if user has all required permissions
      const hasAllPermissions = requiredPermissions.every(permission => 
        userPermissions.includes(permission)
      );

      if (!hasAllPermissions) {
        await recordAuditEvent(
          auditRepository,
          'AUTHORIZATION',
          'permission_denied',
          'auth_system',
          'FAILURE',
          securityContext,
          {
            userRole: securityContext.user.role,
            userPermissions,
            requiredPermissions,
            resource: `${req.method} ${req.path}`,
          }
        );

        throw new AuthorizationError('Insufficient permissions', {
          userRole: securityContext.user.role,
          userPermissions,
          requiredPermissions,
        });
      }

      // Update user permissions in security context
      securityContext.user.permissions = userPermissions;

      // Record successful authorization
      await recordAuditEvent(
        auditRepository,
        'AUTHORIZATION',
        'permission_granted',
        'auth_system',
        'SUCCESS',
        securityContext,
        {
          userRole: securityContext.user.role,
          userPermissions,
          requiredPermissions,
          resource: `${req.method} ${req.path}`,
        }
      );

      next();
    } catch (error) {
      if (error instanceof AuthorizationError) {
        res.status(403).json({ 
          error: 'Authorization failed',
          code: error.code,
          requestId: securityContext.requestId,
        });
      } else {
        res.status(500).json({ 
          error: 'Internal authorization error',
          requestId: securityContext.requestId,
        });
      }
    }
  };
};
