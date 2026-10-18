/**
 * Regression coverage for `DisputeSLAServiceDeps` failure handling (#1088).
 *
 * Evidence: `src/services/disputeSLAService.ts:156` contains `return null;`
 * inside `transitionState` — the explicit "no active SLA timer" failure path.
 * The surrounding suite asserts the null return, but not the rest of the
 * contract that makes the failure safe. This suite pins:
 *
 * - the null path resolves (never rejects) for every target state, including
 *   terminal states that are otherwise resolved rather than skipped,
 * - the failure is observable: a warning is logged with the dispute id and the
 *   requested state,
 * - the failure is non-mutating: no SLA row is updated/created and no audit or
 *   notification side effect is produced, and
 * - the path still holds when the optional `DisputeSLAServiceDeps` entries are
 *   omitted entirely.
 */
import { Pool } from 'pg';
import { DisputeSLAService } from '../disputeSLAService';
import { DisputeSLARepository } from '../../db/repositories/disputeSLARepository';
import { AuditLogRepository } from '../../db/repositories/auditLogRepository';
import { NotificationRepository } from '../../db/repositories/notificationRepository';
import { Logger } from '../../lib/logger';

const mockSlaRepo = {
  findActiveByDisputeId: jest.fn(),
  update: jest.fn(),
  create: jest.fn(),
};

jest.mock('../../db/repositories/disputeSLARepository', () => ({
  DisputeSLARepository: jest.fn(() => mockSlaRepo),
}));

jest.mock('../../db/repositories/notificationRepository');
jest.mock('../../db/repositories/auditLogRepository');

jest.mock('../../config/disputeSLAConfig', () => ({
  isTerminalState: jest.fn((state: string) => state === 'resolved' || state === 'closed'),
  getSLADuration: jest.fn(() => 4),
  isAutoEscalateEnabled: jest.fn(() => true),
  getJurisdictionSLAConfig: jest.fn(),
}));

describe('DisputeSLAService.transitionState null path', () => {
  let service: DisputeSLAService;
  let logger: jest.Mocked<Partial<Logger>>;
  let auditLogRepo: { createAuditLog: jest.Mock };
  let notificationRepo: { create: jest.Mock };

  beforeEach(() => {
    jest.clearAllMocks();
    logger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    };
    auditLogRepo = { createAuditLog: jest.fn().mockResolvedValue(undefined) };
    notificationRepo = { create: jest.fn().mockResolvedValue(undefined) };
    mockSlaRepo.findActiveByDisputeId.mockResolvedValue(null);

    service = new DisputeSLAService({
      db: {} as Pool,
      logger: logger as unknown as Logger,
      auditLogRepo: auditLogRepo as unknown as AuditLogRepository,
      notificationRepo: notificationRepo as unknown as NotificationRepository,
    });
  });

  it('resolves to null and logs an observable warning when no active timer exists', async () => {
    await expect(
      service.transitionState({ disputeId: 'dispute-1', newState: 'investigating' }),
    ).resolves.toBeNull();

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      'No active SLA timer found for transition',
      { disputeId: 'dispute-1', newState: 'investigating' },
    );
  });

  it('does not mutate SLA rows or emit audit/notification side effects', async () => {
    await service.transitionState({ disputeId: 'dispute-1', newState: 'investigating' });

    expect(mockSlaRepo.findActiveByDisputeId).toHaveBeenCalledWith('dispute-1');
    expect(mockSlaRepo.update).not.toHaveBeenCalled();
    expect(mockSlaRepo.create).not.toHaveBeenCalled();
    expect(auditLogRepo.createAuditLog).not.toHaveBeenCalled();
    expect(notificationRepo.create).not.toHaveBeenCalled();
  });

  it('takes the null path for a terminal target state too (no timer to resolve)', async () => {
    await expect(
      service.transitionState({ disputeId: 'dispute-1', newState: 'resolved' }),
    ).resolves.toBeNull();

    expect(mockSlaRepo.update).not.toHaveBeenCalled();
    expect(mockSlaRepo.create).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('takes the null path when only a jurisdiction change is supplied', async () => {
    await expect(
      service.transitionState({ disputeId: 'dispute-1', newState: 'triage', newJurisdiction: 'EU' }),
    ).resolves.toBeNull();

    expect(logger.warn).toHaveBeenCalledWith(
      'No active SLA timer found for transition',
      { disputeId: 'dispute-1', newState: 'triage' },
    );
    expect(mockSlaRepo.create).not.toHaveBeenCalled();
  });

  it('handles an empty dispute id boundary deterministically', async () => {
    await expect(
      service.transitionState({ disputeId: '', newState: 'investigating' }),
    ).resolves.toBeNull();

    expect(mockSlaRepo.findActiveByDisputeId).toHaveBeenCalledWith('');
    expect(mockSlaRepo.update).not.toHaveBeenCalled();
  });

  it('still returns null when the optional DisputeSLAServiceDeps entries are omitted', async () => {
    const minimal = new DisputeSLAService({ db: {} as Pool });

    await expect(
      minimal.transitionState({ disputeId: 'dispute-1', newState: 'investigating' }),
    ).resolves.toBeNull();

    expect(mockSlaRepo.update).not.toHaveBeenCalled();
    expect(mockSlaRepo.create).not.toHaveBeenCalled();
  });

  it('constructs the SLA repository with the injected pool', () => {
    const db = { marker: 'pool' } as unknown as Pool;
    const local = new DisputeSLAService({ db, logger: logger as unknown as Logger });

    expect(DisputeSLARepository).toHaveBeenCalledWith(db);
    expect(local).toBeInstanceOf(DisputeSLAService);
  });
});
