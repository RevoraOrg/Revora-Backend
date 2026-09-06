import { Pool } from 'pg';
import { InvestmentService, createInvestmentService } from './investmentService';
import { SanctionsScreeningService } from './sanctionsScreeningService';
import { SanctionsListRepository } from '../db/repositories/sanctionsListRepository';
import { AuditLogRepository } from '../db/repositories/auditLogRepository';
import { AMLService } from '../aml/amlService';

/**
 * Builds an {@link InvestmentService} wired with sanctions screening so that
 * every investment submission is screened against the latest verified OFAC
 * snapshot before it is persisted.
 *
 * Fail-closed: if the screening service throws (e.g. no verified snapshot),
 * `createInvestment` rejects the submission; investments are never silently
 * cleared against a missing list.
 */
export function createInvestmentServiceWithScreening(
  db: Pool,
  amlService?: AMLService,
  kycGateEnabled: boolean = false,
): InvestmentService {
  const screeningService = new SanctionsScreeningService(
    new SanctionsListRepository(db),
  );
  const auditLogRepo = new AuditLogRepository(db);
  return createInvestmentService(
    db,
    amlService,
    screeningService,
    auditLogRepo,
    kycGateEnabled,
  );
}