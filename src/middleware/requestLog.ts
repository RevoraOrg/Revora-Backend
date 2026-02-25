import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';
import { AuditLogRepository } from '../db/repositories/auditLogRepository';

interface RequestLog {
  requestId: string;
  method: string;
  path: string;
  userId?: string;
  status: number;
  duration: number; // in milliseconds
  timestamp: string;
}

interface AuditLog {
  requestId: string;
  userId?: string;
  action: string;
  resource?: string;
  ipAddress?: string;
  userAgent?: string;
  timestamp: string;
}

// Sensitive actions that should be audited
const SENSITIVE_ACTIONS = [
  { method: 'POST', pathPattern: /^\/auth\/login$/ },
  { method: 'POST', pathPattern: /^\/offerings$/ },
  { method: 'POST', pathPattern: /^\/invest$/ },
  { method: 'POST', pathPattern: /^\/revenue$/ },
];

/**
 * Middleware for logging API requests and auditing sensitive actions
 * @param auditRepository Optional repository for persisting audit logs
 */
export function requestLogMiddleware(auditRepository?: AuditLogRepository) {
  return (req: Request, res: Response, next: NextFunction) => {
    const requestId = randomUUID();
    const startTime = process.hrtime.bigint();

    // Add requestId to request for potential use in routes
    (req as any).requestId = requestId;

    // Log the incoming request
    const incomingLog: Partial<RequestLog> = {
      requestId,
      method: req.method,
      path: req.path,
      userId: (req as any).user?.id, // Assuming user is set by auth middleware
      timestamp: new Date().toISOString(),
    };
    console.log(JSON.stringify({ type: 'request_start', ...incomingLog }));

    // Override res.end to log after response
    const originalEnd = res.end;
    res.end = function (chunk?: any, encoding?: BufferEncoding | (() => void)) {
      const endTime = process.hrtime.bigint();
      const duration = Number(endTime - startTime) / 1000000; // Convert to milliseconds

      const log: RequestLog = {
        requestId,
        method: req.method,
        path: req.path,
        userId: (req as any).user?.id,
        status: res.statusCode,
        duration: Math.round(duration * 100) / 100, // Round to 2 decimal places
        timestamp: new Date().toISOString(),
      };

      console.log(JSON.stringify({ type: 'request_end', ...log }));

      // Check if this is a sensitive action
      const isSensitive = SENSITIVE_ACTIONS.some(
        (action) =>
          action.method === req.method && action.pathPattern.test(req.path)
      );

      if (isSensitive) {
        const auditLog: AuditLog = {
          requestId,
          userId: (req as any).user?.id,
          action: getActionFromPath(req.method, req.path),
          resource: req.path,
          ipAddress: req.ip,
          userAgent: req.get('User-Agent'),
          timestamp: new Date().toISOString(),
        };

        console.log(JSON.stringify({ type: 'audit', ...auditLog }));

        // Persist to database if repository is provided
        if (auditRepository) {
          auditRepository.createAuditLog({
            user_id: auditLog.userId,
            action: auditLog.action,
            resource: auditLog.resource,
            ip_address: auditLog.ipAddress,
            user_agent: auditLog.userAgent,
          }).catch((error) => {
            console.error('Failed to persist audit log:', error);
          });
        }
      }

      // Call original end
      originalEnd.call(this, chunk, encoding);
    };

    next();
  };
}

function getActionFromPath(method: string, path: string): string {
  if (method === 'POST' && path === '/auth/login') return 'login';
  if (method === 'POST' && path === '/offerings') return 'create_offering';
  if (method === 'POST' && path === '/invest') return 'invest';
  if (method === 'POST' && path === '/revenue') return 'report_revenue';
  return 'unknown';
}