import { VestingService, PartialClaimRequest, VestingEvent } from './vestingService';
import { VestingScheduleRepository, VestingSchedule } from '../db/repositories/vestingScheduleRepository';

describe('VestingService', () => {
  let service: VestingService;
  let mockRepository: jest.Mocked<VestingScheduleRepository>;

  beforeEach(() => {
    service = new VestingService();
    mockRepository = {
      findByIdAndUserId: jest.fn(),
      create: jest.fn(),
      updateClaim: jest.fn(),
      existsAndOwned: jest.fn()
    } as any;
    service.setRepository(mockRepository);
  });

  describe('processPartialClaim', () => {
    const mockSchedule: VestingSchedule = {
      id: 'sched-123',
      userId: 'user-1',
      totalAmount: 1000,
      claimedAmount: 0,
      lastClaimIndex: -1,
      schedule: [
        { index: 0, amount: 200, timestamp: Date.now() - 1000, claimed: false },
        { index: 1, amount: 300, timestamp: Date.now() + 1000, claimed: false },
        { index: 2, amount: 500, timestamp: Date.now() + 2000, claimed: false }
      ]
    };

    it('should successfully process a valid partial claim with ownership validation', async () => {
      mockRepository.findByIdAndUserId.mockResolvedValue(mockSchedule);
      mockRepository.updateClaim.mockResolvedValue(true);

      const request: PartialClaimRequest = {
        scheduleId: 'sched-123',
        claimAmount: 150,
        userId: 'user-1'
      };

      const result = await service.processPartialClaim(request);

      expect(result.success).toBe(true);
      expect(result.claimedAmount).toBe(150);
      expect(result.remainingAmount).toBe(850);
      expect(result.error).toBeUndefined();
      expect(mockRepository.findByIdAndUserId).toHaveBeenCalledWith('sched-123', 'user-1');
      expect(mockRepository.updateClaim).toHaveBeenCalledWith({
        scheduleId: 'sched-123',
        userId: 'user-1',
        claimedAmount: 150,
        lastClaimIndex: 0
      });
    });

    it('should reject claim when schedule not found or access denied (ownership check)', async () => {
      mockRepository.findByIdAndUserId.mockResolvedValue(null);

      const request: PartialClaimRequest = {
        scheduleId: 'non-existent',
        claimAmount: 100,
        userId: 'user-1'
      };

      const result = await service.processPartialClaim(request);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Schedule not found or access denied');
      expect(mockRepository.findByIdAndUserId).toHaveBeenCalledWith('non-existent', 'user-1');
      expect(mockRepository.updateClaim).not.toHaveBeenCalled();
    });

    it('should reject claim when user does not own the schedule', async () => {
      mockRepository.findByIdAndUserId.mockResolvedValue(null);

      const request: PartialClaimRequest = {
        scheduleId: 'sched-123',
        claimAmount: 100,
        userId: 'user-2' // Different user
      };

      const result = await service.processPartialClaim(request);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Schedule not found or access denied');
      expect(mockRepository.findByIdAndUserId).toHaveBeenCalledWith('sched-123', 'user-2');
    });

    it('should reject claim exceeding available amount', async () => {
      mockRepository.findByIdAndUserId.mockResolvedValue(mockSchedule);

      const request: PartialClaimRequest = {
        scheduleId: 'sched-123',
        claimAmount: 500, // More than available 200
        userId: 'user-1'
      };

      const result = await service.processPartialClaim(request);

      expect(result.success).toBe(false);
      expect(result.claimedAmount).toBe(0);
      expect(result.remainingAmount).toBe(200);
      expect(result.error).toBe('Claim amount exceeds available vested amount');
      expect(mockRepository.updateClaim).not.toHaveBeenCalled();
    });

    it('should handle zero claim amount', async () => {
      mockRepository.findByIdAndUserId.mockResolvedValue(mockSchedule);
      mockRepository.updateClaim.mockResolvedValue(true);

      const request: PartialClaimRequest = {
        scheduleId: 'sched-123',
        claimAmount: 0,
        userId: 'user-1'
      };

      const result = await service.processPartialClaim(request);

      expect(result.success).toBe(true);
      expect(result.claimedAmount).toBe(0);
      expect(result.remainingAmount).toBe(1000);
    });

    it('should handle full claim', async () => {
      mockRepository.findByIdAndUserId.mockResolvedValue(mockSchedule);
      mockRepository.updateClaim.mockResolvedValue(true);

      const request: PartialClaimRequest = {
        scheduleId: 'sched-123',
        claimAmount: 200, // Exactly available
        userId: 'user-1'
      };

      const result = await service.processPartialClaim(request);

      expect(result.success).toBe(true);
      expect(result.claimedAmount).toBe(200);
      expect(result.remainingAmount).toBe(800);
    });

    it('should reject claim when userId is missing (authentication required)', async () => {
      const request: PartialClaimRequest = {
        scheduleId: 'sched-123',
        claimAmount: 100,
        userId: ''
      };

      const result = await service.processPartialClaim(request);

      expect(result.success).toBe(false);
      expect(result.error).toBe('User authentication required');
      expect(mockRepository.findByIdAndUserId).not.toHaveBeenCalled();
    });

    it('should handle persistence failure (race condition)', async () => {
      mockRepository.findByIdAndUserId.mockResolvedValue(mockSchedule);
      mockRepository.updateClaim.mockResolvedValue(false); // Update failed

      const request: PartialClaimRequest = {
        scheduleId: 'sched-123',
        claimAmount: 100,
        userId: 'user-1'
      };

      const result = await service.processPartialClaim(request);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Failed to persist claim');
    });
  });

  describe('Edge Cases', () => {
    const mockSchedule: VestingSchedule = {
      id: 'sched-123',
      userId: 'user-1',
      totalAmount: 1000,
      claimedAmount: 0,
      lastClaimIndex: -1,
      schedule: [
        { index: 0, amount: 200, timestamp: Date.now() - 1000, claimed: false },
        { index: 1, amount: 300, timestamp: Date.now() + 1000, claimed: false },
        { index: 2, amount: 500, timestamp: Date.now() + 2000, claimed: false }
      ]
    };

    it('should prevent negative claim amounts', async () => {
      const request: PartialClaimRequest = {
        scheduleId: 'sched-123',
        claimAmount: -50,
        userId: 'user-1'
      };

      const result = await service.processPartialClaim(request);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Claim amount cannot be negative');
      expect(mockRepository.findByIdAndUserId).not.toHaveBeenCalled();
    });

    it('should handle empty schedule', async () => {
      const emptySchedule: VestingSchedule = {
        id: 'empty',
        userId: 'user-1',
        totalAmount: 0,
        claimedAmount: 0,
        lastClaimIndex: -1,
        schedule: []
      };
      mockRepository.findByIdAndUserId.mockResolvedValue(emptySchedule);

      const request: PartialClaimRequest = {
        scheduleId: 'empty',
        claimAmount: 100,
        userId: 'user-1'
      };

      const result = await service.processPartialClaim(request);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Claim amount exceeds available vested amount');
    });

    it('should prevent double-claiming by checking persisted state', async () => {
      const partiallyClaimedSchedule: VestingSchedule = {
        ...mockSchedule,
        claimedAmount: 150,
        lastClaimIndex: 0,
        schedule: [
          { index: 0, amount: 200, timestamp: Date.now() - 1000, claimed: true },
          { index: 1, amount: 300, timestamp: Date.now() + 1000, claimed: false },
          { index: 2, amount: 500, timestamp: Date.now() + 2000, claimed: false }
        ]
      };
      mockRepository.findByIdAndUserId.mockResolvedValue(partiallyClaimedSchedule);
      mockRepository.updateClaim.mockResolvedValue(true);

      // Try to claim the same amount again - should only have 50 available now
      const request: PartialClaimRequest = {
        scheduleId: 'sched-123',
        claimAmount: 150,
        userId: 'user-1'
      };

      const result = await service.processPartialClaim(request);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Claim amount exceeds available vested amount');
    });
  });

  describe('createSchedule', () => {
    it('should create a new vesting schedule', async () => {
      const mockCreatedSchedule: VestingSchedule = {
        id: 'new-sched',
        userId: 'user-1',
        totalAmount: 5000,
        claimedAmount: 0,
        lastClaimIndex: -1,
        schedule: [
          { index: 0, amount: 1000, timestamp: Date.now() + 1000, claimed: false }
        ]
      };
      mockRepository.create.mockResolvedValue(mockCreatedSchedule);

      const input = {
        userId: 'user-1',
        totalAmount: 5000,
        schedule: mockCreatedSchedule.schedule
      };

      const result = await service.createSchedule(input);

      expect(result).toEqual(mockCreatedSchedule);
      expect(mockRepository.create).toHaveBeenCalledWith(input);
    });
  });
});