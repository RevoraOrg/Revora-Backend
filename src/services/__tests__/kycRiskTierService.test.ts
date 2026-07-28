import { UserRepository, User } from '../../db/repositories/userRepository';
import { SecurityAuditRepository, AuditEvent } from '../../security/types';
import { KycRiskTierService } from '../kycRiskTierService';
import { INVESTOR_CAP_RECALCULATED_ACTION } from '../../lib/kycRiskTierCaps';

function makeInvestor(override: Partial<User> = {}): User {
  return {
    id: 'investor-1',
    email: 'inv@example.com',
    password_hash: 'hash',
    role: 'investor',
    kyc_risk_tier: 'standard',
    created_at: new Date('2024-01-01'),
    updated_at: new Date('2024-01-01'),
    ...override,
  };
}

describe('KycRiskTierService', () => {
  let userRepo: jest.Mocked<Pick<UserRepository, 'findById' | 'updateKycRiskTier'>>;
  let auditRepo: jest.Mocked<Pick<SecurityAuditRepository, 'record'>>;
  let service: KycRiskTierService;

  beforeEach(() => {
    userRepo = {
      findById: jest.fn(),
      updateKycRiskTier: jest.fn(),
    };
    auditRepo = {
      record: jest.fn().mockResolvedValue(undefined),
    };
    service = new KycRiskTierService(
      userRepo as unknown as UserRepository,
      auditRepo as unknown as SecurityAuditRepository,
    );
  });

  it('updates tier and emits investor.cap.recalculated', async () => {
    const before = makeInvestor({ kyc_risk_tier: 'high' });
    const after = makeInvestor({ kyc_risk_tier: 'standard' });
    userRepo.findById.mockResolvedValue(before);
    userRepo.updateKycRiskTier.mockResolvedValue(after);

    const result = await service.updateKycRiskTier({
      investorId: 'investor-1',
      tier: 'standard',
      actorId: 'admin-1',
      referenceOfferingCapBps: 1_000,
    });

    expect(result.previousTier).toBe('high');
    expect(result.user.kyc_risk_tier).toBe('standard');
    expect(result.resolution.effectiveCapBps).toBe(1_000);
    expect(userRepo.updateKycRiskTier).toHaveBeenCalledWith('investor-1', 'standard');

    expect(auditRepo.record).toHaveBeenCalledTimes(1);
    const event = auditRepo.record.mock.calls[0][0] as AuditEvent;
    expect(event.action).toBe(INVESTOR_CAP_RECALCULATED_ACTION);
    expect(event.details).toMatchObject({
      investor_id: 'investor-1',
      previous_tier: 'high',
      new_tier: 'standard',
      effective_cap_bps: 1_000,
      retroactive_invalidation: false,
      changed: true,
    });
  });

  it('skips DB update when tier is unchanged but still audits', async () => {
    const user = makeInvestor({ kyc_risk_tier: 'elevated' });
    userRepo.findById.mockResolvedValue(user);

    await service.updateKycRiskTier({
      investorId: 'investor-1',
      tier: 'elevated',
      actorId: 'admin-1',
    });

    expect(userRepo.updateKycRiskTier).not.toHaveBeenCalled();
    expect(auditRepo.record).toHaveBeenCalledTimes(1);
    const event = auditRepo.record.mock.calls[0][0] as AuditEvent;
    expect(event.details.changed).toBe(false);
  });

  it('rejects unknown investors', async () => {
    userRepo.findById.mockResolvedValue(null);
    await expect(
      service.updateKycRiskTier({
        investorId: 'missing',
        tier: 'high',
        actorId: 'admin-1',
      }),
    ).rejects.toThrow(/not found/);
  });

  it('rejects non-investor accounts', async () => {
    userRepo.findById.mockResolvedValue(makeInvestor({ role: 'startup' }));
    await expect(
      service.updateKycRiskTier({
        investorId: 'investor-1',
        tier: 'high',
        actorId: 'admin-1',
      }),
    ).rejects.toThrow(/investor accounts/);
  });

  it('rejects invalid tier values', async () => {
    await expect(
      service.updateKycRiskTier({
        investorId: 'investor-1',
        tier: 'nope' as any,
        actorId: 'admin-1',
      }),
    ).rejects.toThrow(/Invalid kyc_risk_tier/);
  });
});
