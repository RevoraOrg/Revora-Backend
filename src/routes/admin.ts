import { Router, Request, Response, NextFunction } from 'express';
import { Keypair } from '@stellar/stellar-sdk';
import { AuditLogRepository } from '../db/repositories/auditLogRepository';
import { requireAdmin, AuthenticatedRequest } from '../middleware/auth';
import { env } from '../config/env';
import {
  RetentionLabelError,
  RetentionLabelService,
} from '../services/retentionLabelService';
import { Errors } from '../lib/errors';
import { TenantSettingsRepository } from '../db/repositories/tenantSettingsRepository';
import { SessionPolicyValidator } from '../services/sessionPolicyValidator';

export function createAdminRouter(
  auditLogRepo: AuditLogRepository,
  retentionLabelService?: RetentionLabelService,
  tenantSettingsRepo?: TenantSettingsRepository,
  sessionPolicyValidator?: SessionPolicyValidator,
): Router {
  const router = Router();

  // Secure all routes in this router with requireAdmin
  router.use(requireAdmin);

  /**
   * GET /audit-log/export.csv
   * Returns a paginated, Ed25519-signed CSV export of audit logs
   */
  router.get('/audit-log/export.csv', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const limit = Math.min(parseInt(req.query.limit as string) || 1000, 5000);
      const offset = Math.max(parseInt(req.query.offset as string) || 0, 0);

      const logs = await auditLogRepo.getAuditLogsForExport(limit, offset);

      // Build CSV content
      const headers = ['id', 'user_id', 'action', 'resource', 'details', 'ip_address', 'user_agent', 'created_at'];
      const csvRows = [headers.join(',')];

      for (const log of logs) {
        const row = [
          log.id,
          log.user_id || '',
          log.action,
          log.resource || '',
          log.details ? `"${log.details.replace(/"/g, '""')}"` : '',
          log.ip_address || '',
          log.user_agent ? `"${log.user_agent.replace(/"/g, '""')}"` : '',
          log.created_at.toISOString()
        ];
        csvRows.push(row.join(','));
      }

      const csvContent = csvRows.join('\n');

      // Create manifest header and sign with Ed25519
      const keypair = Keypair.fromSecret(env.STELLAR_SERVER_SECRET!);
      
      const manifest = {
        rowCount: logs.length,
        limit,
        offset,
        exportedAt: new Date().toISOString()
      };
      
      const manifestString = JSON.stringify(manifest);
      const payloadToSign = Buffer.from(`${manifestString}\n${csvContent}`, 'utf8');
      const signature = keypair.sign(payloadToSign);
      
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="audit-logs.csv"');
      res.setHeader('X-Ed25519-Signature', signature.toString('base64'));
      res.setHeader('X-Ed25519-Public-Key', keypair.publicKey());
      res.setHeader('X-Audit-Manifest', Buffer.from(manifestString).toString('base64'));

      res.status(200).send(csvContent);
    } catch (error) {
      next(error);
    }
  });

  if (retentionLabelService) {
    router.get(
      '/retention-labels/active',
      async (_req: Request, res: Response, next: NextFunction) => {
        try {
          const labels = await retentionLabelService.listActiveHolds();
          res.status(200).json({ labels });
        } catch (error) {
          next(error);
        }
      },
    );

    router.get(
      '/retention-labels/:periodId',
      async (req: Request, res: Response, next: NextFunction) => {
        try {
          const label = await retentionLabelService.get(req.params.periodId);
          if (!label) {
            next(Errors.notFound('Retention label not found'));
            return;
          }
          res.status(200).json({ label });
        } catch (error) {
          next(mapRetentionError(error));
        }
      },
    );

    router.post(
      '/retention-labels/:periodId/legal-hold/propose',
      async (req: Request, res: Response, next: NextFunction) => {
        try {
          const actorId = requireActorId(req);
          const label = await retentionLabelService.proposeLegalHold({
            periodId: req.params.periodId,
            actorId,
            reason: typeof req.body?.reason === 'string' ? req.body.reason : undefined,
          });
          res.status(202).json({ label });
        } catch (error) {
          next(mapRetentionError(error));
        }
      },
    );

    router.post(
      '/retention-labels/:periodId/legal-hold/approve',
      async (req: Request, res: Response, next: NextFunction) => {
        try {
          const actorId = requireActorId(req);
          const label = await retentionLabelService.approveLegalHold({
            periodId: req.params.periodId,
            actorId,
          });
          res.status(200).json({ label });
        } catch (error) {
          next(mapRetentionError(error));
        }
      },
    );

    router.post(
      '/retention-labels/:periodId/legal-hold/propose-release',
      async (req: Request, res: Response, next: NextFunction) => {
        try {
          const actorId = requireActorId(req);
          const label = await retentionLabelService.proposeLegalHoldRelease({
            periodId: req.params.periodId,
            actorId,
          });
          res.status(202).json({ label });
        } catch (error) {
          next(mapRetentionError(error));
        }
      },
    );

    router.post(
      '/retention-labels/:periodId/legal-hold/approve-release',
      async (req: Request, res: Response, next: NextFunction) => {
        try {
          const actorId = requireActorId(req);
          const label = await retentionLabelService.approveLegalHoldRelease({
            periodId: req.params.periodId,
            actorId,
          });
          res.status(200).json({ label });
        } catch (error) {
          next(mapRetentionError(error));
        }
      },
    );
  }

  if (tenantSettingsRepo && sessionPolicyValidator) {
    router.post(
      '/tenant-settings/:tenantId/session-policy',
      async (req: Request, res: Response, next: NextFunction) => {
        try {
          const { tenantId } = req.params;
          const { policy } = req.body;
          if (policy !== 'lax' && policy !== 'strict') {
            next(Errors.badRequest('Policy must be lax or strict'));
            return;
          }

          if (policy === 'strict') {
            await sessionPolicyValidator.validateStrictOptIn(tenantId);
          }

          const settingsRow = await tenantSettingsRepo.findByTenantId(tenantId);
          const settings = settingsRow ? settingsRow.settings : {};
          const updated = await tenantSettingsRepo.upsertSettings(tenantId, settings, policy);
          
          res.status(200).json({ session_policy: updated.session_policy });
        } catch (error) {
          next(error);
        }
      }
    );
  }

  return router;
}

function requireActorId(req: Request): string {
  const user = (req as AuthenticatedRequest).user;
  const actorId = user?.id || user?.sub;
  if (!actorId || typeof actorId !== 'string') {
    throw Errors.unauthorized('Authenticated admin identity required');
  }
  return actorId;
}

function mapRetentionError(error: unknown): unknown {
  if (!(error instanceof RetentionLabelError)) {
    return error;
  }
  switch (error.code) {
    case 'INVALID_PERIOD':
      return Errors.badRequest(error.message);
    case 'DUAL_CONTROL':
    case 'ALREADY_ACTIVE':
    case 'NOT_ACTIVE':
    case 'PENDING_REQUIRED':
    case 'WRONG_PENDING':
      return Errors.conflict(error.message);
    case 'NOT_FOUND':
      return Errors.notFound(error.message);
    default:
      return error;
  }
}
