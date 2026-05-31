import { Router, Request, Response, NextFunction } from 'express';
import { Keypair } from '@stellar/stellar-sdk';
import { AuditLogRepository } from '../db/repositories/auditLogRepository';
import { requireAdmin } from '../middleware/auth';
import { env } from '../config/env';

export function createAdminRouter(auditLogRepo: AuditLogRepository): Router {
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

  return router;
}
