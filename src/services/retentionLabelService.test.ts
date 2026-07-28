import { RetentionLabelRepository } from '../db/repositories/retentionLabelRepository';
import {
  RetentionLabelError,
  RetentionLabelService,
} from '../services/retentionLabelService';

describe('RetentionLabelService dual-control legal hold', () => {
  const labels = {
    findByPeriodId: jest.fn(),
    listActiveHolds: jest.fn(),
    upsertProposeAdd: jest.fn(),
    approveAdd: jest.fn(),
    proposeRemove: jest.fn(),
    approveRemove: jest.fn(),
  } as unknown as jest.Mocked<RetentionLabelRepository>;

  const auditLogRepo = {
    createAuditLog: jest.fn().mockResolvedValue({}),
  };

  const service = new RetentionLabelService(labels, auditLogRepo as any);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('rejects invalid period ids', async () => {
    await expect(
      service.proposeLegalHold({ periodId: '2026-13', actorId: 'admin-a' }),
    ).rejects.toMatchObject({ code: 'INVALID_PERIOD' });
  });

  it('requires a second distinct admin to activate a hold', async () => {
    labels.findByPeriodId.mockResolvedValue({
      period_id: '2024-01',
      legal_hold: false,
      reason: 'litigation',
      pending_action: 'add',
      pending_proposed_by: 'admin-a',
      pending_proposed_at: new Date(),
      activated_by: null,
      activated_at: null,
      released_by: null,
      released_at: null,
      created_at: new Date(),
      updated_at: new Date(),
    });

    await expect(
      service.approveLegalHold({ periodId: '2024-01', actorId: 'admin-a' }),
    ).rejects.toBeInstanceOf(RetentionLabelError);

    labels.approveAdd.mockResolvedValue({
      period_id: '2024-01',
      legal_hold: true,
      reason: 'litigation',
      pending_action: null,
      pending_proposed_by: null,
      pending_proposed_at: null,
      activated_by: 'admin-b',
      activated_at: new Date(),
      released_by: null,
      released_at: null,
      created_at: new Date(),
      updated_at: new Date(),
    });

    const activated = await service.approveLegalHold({
      periodId: '2024-01',
      actorId: 'admin-b',
    });
    expect(activated.legal_hold).toBe(true);
    expect(labels.approveAdd).toHaveBeenCalledWith({
      periodId: '2024-01',
      actorId: 'admin-b',
    });
  });

  it('requires dual-control to release a hold and does not purge immediately', async () => {
    labels.findByPeriodId.mockResolvedValue({
      period_id: '2024-01',
      legal_hold: true,
      reason: 'litigation',
      pending_action: 'remove',
      pending_proposed_by: 'admin-a',
      pending_proposed_at: new Date(),
      activated_by: 'admin-b',
      activated_at: new Date(),
      released_by: null,
      released_at: null,
      created_at: new Date(),
      updated_at: new Date(),
    });

    labels.approveRemove.mockResolvedValue({
      period_id: '2024-01',
      legal_hold: false,
      reason: 'litigation',
      pending_action: null,
      pending_proposed_by: null,
      pending_proposed_at: null,
      activated_by: 'admin-b',
      activated_at: new Date(),
      released_by: 'admin-c',
      released_at: new Date(),
      created_at: new Date(),
      updated_at: new Date(),
    });

    const released = await service.approveLegalHoldRelease({
      periodId: '2024-01',
      actorId: 'admin-c',
    });

    expect(released.legal_hold).toBe(false);
    expect(auditLogRepo.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'RETENTION_LEGAL_HOLD_RELEASED',
        details: expect.stringContaining('next purge cycle'),
      }),
    );
  });
});
