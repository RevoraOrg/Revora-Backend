/**
 * Security Types and Interfaces for Milestone Validation Auth Matrix
 * 
 * Provides production-grade security primitives with explicit type safety
 * and comprehensive audit capabilities.
 */

export type UserRole = 'admin' | 'verifier' | 'issuer' | 'investor';

export type Permission = 
  | 'milestone:validate'
  | 'milestone:view'
  | 'vault:manage'
  | 'audit:read';

export interface AuthenticatedUser {
  id: string;
  role: UserRole;
  permissions: Permission[];
  sessionId: string;
  authenticatedAt: Date;
}

export interface SecurityContext {
  user: AuthenticatedUser;
  requestId: string;
  ipAddress: string;
  userAgent: string;
  timestamp: Date;
}

export interface AuditEvent {
  id: string;
  type: 'AUTHENTICATION' | 'AUTHORIZATION' | 'VALIDATION' | 'SECURITY_VIOLATION';
  userId?: string;
  sessionId?: string;
  action: string;
  resource: string;
  outcome: 'SUCCESS' | 'FAILURE' | 'BLOCKED';
  details: Record<string, unknown>;
  securityContext: Omit<SecurityContext, 'user'>;
  timestamp: Date;
}

export interface SecurityAuditRepository {
  record(event: AuditEvent): Promise<void>;
  findByUserId(userId: string, limit?: number): Promise<AuditEvent[]>;
  findBySessionId(sessionId: string, limit?: number): Promise<AuditEvent[]>;
  findSecurityViolations(since: Date, limit?: number): Promise<AuditEvent[]>;
}

export interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
  skipSuccessfulRequests?: boolean;
  skipFailedRequests?: boolean;
}

export interface SecurityConfig {
  rateLimits: Record<string, RateLimitConfig>;
  maxConcurrentValidations: number;
  validationTimeoutMs: number;
  requireCsrfToken: boolean;
  enabledPermissions: Record<UserRole, Permission[]>;
}

/**
 * Default security configuration with production-grade defaults
 */
export const DEFAULT_SECURITY_CONFIG: SecurityConfig = {
  rateLimits: {
    'validation': {
      windowMs: 60 * 1000, // 1 minute
      maxRequests: 10,
      skipSuccessfulRequests: false,
      skipFailedRequests: false,
    },
    'auth': {
      windowMs: 15 * 60 * 1000, // 15 minutes
      maxRequests: 100,
    },
    'audit': {
      windowMs: 60 * 1000, // 1 minute
      maxRequests: 1000,
    },
  },
  maxConcurrentValidations: 5,
  validationTimeoutMs: 30 * 1000, // 30 seconds
  requireCsrfToken: true,
  enabledPermissions: {
    'admin': ['milestone:validate', 'milestone:view', 'vault:manage', 'audit:read'],
    'verifier': ['milestone:validate', 'milestone:view'],
    'issuer': ['milestone:view'],
    'investor': ['milestone:view'],
  },
};

/**
 * Security error types for explicit error handling
 */
export class SecurityError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'SecurityError';
  }
}

export class AuthenticationError extends SecurityError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'AUTHENTICATION_FAILED', details);
  }
}

export class AuthorizationError extends SecurityError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'AUTHORIZATION_FAILED', details);
  }
}

export class RateLimitError extends SecurityError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'RATE_LIMIT_EXCEEDED', details);
  }
}

export class ValidationError extends SecurityError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'VALIDATION_FAILED', details);
  }
}
