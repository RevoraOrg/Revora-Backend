/**
 * Compliance routes — sanctions list version diff and audit trail.
 *
 * All endpoints are restricted to the `compliance` role via
 * `requireCompliance` middleware. No PII beyond entity names (which are
 * already public OFAC data) is returned.
 *
 * Security assumptions:
 * - JWT authentication and role verification are enforced before any handler runs.
 * - `versionId` path params are treated as opaque strings; the repository uses
 *   parameterised queries to prevent SQL injection.
 * - Changelog downloads are streamed as `text/plain` attachments so browsers do
 *   not execute the content inline.
 * - Pagination via `limit` query param is capped at 1 000 to prevent DoS.
 */
import { Router, Request, Response, NextFunction } from 'express';
import { SanctionsListVersionsRepository } from '../db/repositories/sanctionsListVersionsRepository';
import { SanctionsListDiffService } from '../services/sanctionsListDiffService';
import { requireCompliance } from '../middleware/auth';
import { Errors } from '../lib/errors';

const VALID_SOURCES = ['ofac', 'eu_consolidated', 'un_sc', 'uk_hmt'] as const;
const MAX_LIMIT = 1_000;
const DEFAULT_LIMIT = 100;

export function createComplianceRouter(
  sanctionsListVersionsRepo: SanctionsListVersionsRepository,
  sanctionsListDiffService: SanctionsListDiffService,
): Router {
  const router = Router();

  // All routes under this router require compliance role
  router.use(requireCompliance);

  /**
   * GET /compliance/sanctions-changelog/:versionId
   *
   * Returns a downloadable plain-text changelog for the requested sanctions
   * list version. The response is streamed as a `Content-Disposition: attachment`
   * to prevent inline rendering.
   *
   * @param versionId  UUID of the sanctions_list_versions row
   * @returns          text/plain attachment
   */
  router.get(
    '/sanctions-changelog/:versionId',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { versionId } = req.params;

        // Validate version exists before generating potentially large changelog
        const version = await sanctionsListVersionsRepo.findVersionById(versionId);
        if (!version) {
          next(Errors.notFound('Sanctions list version not found'));
          return;
        }

        const changelog = await sanctionsListDiffService.generateChangelog(versionId);

        // Sanitise filename to prevent header injection
        const safeSource = version.list_source.replace(/[^a-z0-9_-]/gi, '');
        const safeVersion = version.version.replace(/[^a-z0-9._-]/gi, '');
        const filename = `sanctions-changelog-${safeSource}-${safeVersion}.txt`;

        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.status(200).send(changelog);
      } catch (error) {
        next(error);
      }
    },
  );

  /**
   * GET /compliance/sanctions-versions
   *
   * Returns a paginated list of sanctions list versions ordered by load time
   * (newest first).
   *
   * Query params:
   *   - `source`  Optional — one of 'ofac' | 'eu_consolidated' | 'un_sc' | 'uk_hmt'
   *   - `limit`   Optional — max rows to return (default 100, max 1 000)
   */
  router.get(
    '/sanctions-versions',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const rawSource = req.query.source as string | undefined;
        const rawLimit = req.query.limit as string | undefined;

        // Validate source param if provided
        if (rawSource && !(VALID_SOURCES as readonly string[]).includes(rawSource)) {
          next(
            Errors.badRequest('Invalid source', {
              allowedSources: VALID_SOURCES,
            }),
          );
          return;
        }

        const limit = Math.min(
          rawLimit ? Math.max(1, parseInt(rawLimit, 10) || DEFAULT_LIMIT) : DEFAULT_LIMIT,
          MAX_LIMIT,
        );

        let versions;
        if (rawSource) {
          versions = await sanctionsListVersionsRepo.findVersionsBySource(rawSource, limit);
        } else {
          // Return the most recent version from each supported source
          const perSource = await Promise.all(
            VALID_SOURCES.map((src) => sanctionsListVersionsRepo.findLatestVersion(src)),
          );
          versions = perSource.filter(Boolean);
        }

        res.status(200).json({ versions });
      } catch (error) {
        next(error);
      }
    },
  );

  /**
   * GET /compliance/sanctions-versions/:versionId
   *
   * Returns full detail for a specific sanctions list version including the
   * per-entity diff rows.
   *
   * @param versionId  UUID of the sanctions_list_versions row
   */
  router.get(
    '/sanctions-versions/:versionId',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { versionId } = req.params;

        const version = await sanctionsListVersionsRepo.findVersionById(versionId);
        if (!version) {
          next(Errors.notFound('Sanctions list version not found'));
          return;
        }

        const diffDetails =
          await sanctionsListVersionsRepo.findDiffDetailsByVersionId(versionId);

        res.status(200).json({ version, diff_details: diffDetails });
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
}
