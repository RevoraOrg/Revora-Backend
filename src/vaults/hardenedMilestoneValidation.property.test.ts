import * as fc from 'fast-check';
import { validateMilestoneInvariants, validateVaultInvariants, Milestone, Vault } from './hardenedMilestoneValidation';
import { MilestoneRepository, VaultRepository } from './hardenedMilestoneValidation';
import { AppError } from '../lib/errors';

describe('HardenedMilestoneValidation Property-based Tests', () => {
  const mockVaultRepository = (): jest.Mocked<VaultRepository> => ({
    getById: jest.fn(),
  });

  const mockMilestoneRepository = (): jest.Mocked<MilestoneRepository> => ({
    getByVaultAndId: jest.fn(),
    listByVault: jest.fn(),
    markValidated: jest.fn(),
  });

  describe('validateVaultInvariants', () => {
    it('should only accept active vaults', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.record({
            id: fc.uuid(),
            status: fc.constantFrom('active', 'closed', 'paused'),
          }),
          async (vaultData) => {
            const vaultRepo = mockVaultRepository();
            vaultRepo.getById.mockResolvedValue(vaultData as Vault);

            if (vaultData.status === 'active') {
              const result = await validateVaultInvariants(vaultData.id, vaultRepo);
              expect(result).toEqual(vaultData);
            } else {
              await expect(validateVaultInvariants(vaultData.id, vaultRepo)).rejects.toThrow(AppError);
            }
          }
        )
      );
    });

    it('should throw AppError when vault is not found', async () => {
      await fc.assert(
        fc.asyncProperty(fc.uuid(), async (vaultId) => {
          const vaultRepo = mockVaultRepository();
          vaultRepo.getById.mockResolvedValue(null);

          await expect(validateVaultInvariants(vaultId, vaultRepo)).rejects.toThrow(AppError);
        })
      );
    });
  });

  describe('validateMilestoneInvariants', () => {
    it('should handle milestone sequence based on created_at correctly', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.record({
            id: fc.uuid(),
            vault_id: fc.uuid(),
            status: fc.constantFrom('pending', 'validated'),
            created_at: fc.date(),
          }),
          fc.array(
            fc.record({
              id: fc.uuid(),
              status: fc.constantFrom('pending', 'validated'),
              created_at: fc.date(),
            }),
            { minLength: 0, maxLength: 10 }
          ),
          async (targetMilestone, otherMilestonesData) => {
            const milestoneRepo = mockMilestoneRepository();
            
            // Ensure target is in the list
            const allMilestones = [
              targetMilestone,
              ...otherMilestonesData.map(m => ({ ...m, vault_id: targetMilestone.vault_id }))
            ] as Milestone[];

            milestoneRepo.listByVault.mockResolvedValue(allMilestones);

            if (targetMilestone.status === 'validated') {
              // Already validated should fail
              await expect(validateMilestoneInvariants(targetMilestone as Milestone, milestoneRepo)).rejects.toThrow(AppError);
              return;
            }

            // Find if target is the first pending
            const sortedPending = allMilestones
              .filter(m => m.status === 'pending')
              .sort((a, b) => a.created_at.getTime() - b.created_at.getTime());
            
            const isFirstPending = sortedPending.length > 0 && sortedPending[0].id === targetMilestone.id;

            if (isFirstPending) {
              await expect(validateMilestoneInvariants(targetMilestone as Milestone, milestoneRepo)).resolves.not.toThrow();
            } else {
              await expect(validateMilestoneInvariants(targetMilestone as Milestone, milestoneRepo)).rejects.toThrow(AppError);
            }
          }
        )
      );
    });
  });
});
