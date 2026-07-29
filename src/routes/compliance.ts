import { Router, Request, Response, NextFunction } from 'express';
import { SanctionsListVersionsRepository } from '../db/repositories/sanctionsListVersionsRepository';
import { SanctionsListDiffService } from '../services/sanctionsListDiffService';
import { requireAdmin, AuthenticatedRequest } from '../middleware/auth';
import { Errors } from '../lib/errors';

export function createComplianceRouter(
  sanctionsListVersionsRepo: SanctionsListVersionsRepository,
  sanctionsListDiffService: SanctionsListDiffService
): Router {
  const router = Router();

  // Secure all routes in this router with requireAdmin (compliance role check should be added in middleware)
  // TODO: Add requireCompliance middleware for role-based access control
  router.use(requireAdmin);

  /**
   * GET /compliance/sanctions-changelog/:versionId
   * Returns a human-readable changelog for a specific sanctions list version
   * Restricted to users with compliance role
   */
  router.get('/sanctions-changelog/:versionId', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { versionId } = req.params;

      if (!versionId) {
        return next(Errors.badRequest('Version ID is required'));
      }

      // Generate changelog
      const changelog = await sanctionsListDiffService.generateChangelog(versionId);

      // Get version details for filename
      const version = await sanctionsListVersionsRepo.findVersionById(versionId);
      if (!version) {
        return next(Errors.notFound('Sanctions list version not found'));
      }

      const filename = `sanctions-changelog-${version.list_source}-${version.version}.txt`;

      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.status(200).send(changelog);
    } catch (error) {
      next(error);
    }
  });

  /**
   * GET /compliance/sanctions-versions
   * Returns a list of sanctions list versions for audit
   * Restricted to users with compliance role
   */
  router.get('/sanctions-versions', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const listSource = req.query.source as string;
      const limit = Math.min(parseInt(req.query.limit as string) || 100, 1000);

      let versions;
      if (listSource) {
        versions = await sanctionsListVersionsRepo.findVersionsBySource(listSource, limit);
      } else {
        // Return latest versions from all sources
        const sources = ['ofac', 'eu_consolidated', 'un_sc', 'uk_hmt'];
        versions = [];
        for (const source of sources) {
          const latest = await sanctionsListVersionsRepo.findLatestVersion(source);
          if (latest) {
            versions.push(latest);
          }
        }
      }

      res.status(200).json({ versions });
    } catch (error) {
      next(error);
    }
  });

  /**
   * GET /compliance/sanctions-versions/:versionId
   * Returns detailed information about a specific sanctions list version
   * Restricted to users with compliance role
   */
  router.get('/sanctions-versions/:versionId', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { versionId } = req.params;

      if (!versionId) {
        return next(Errors.badRequest('Version ID is required'));
      }

      const version = await sanctionsListVersionsRepo.findVersionById(versionId);
      if (!version) {
        return next(Errors.notFound('Sanctions list version not found'));
      }

      // Get diff details for this version
      const diffDetails = await sanctionsListVersionsRepo.findDiffDetailsByVersionId(versionId);

      res.status(200).json({
        version,
        diff_details: diffDetails,
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
