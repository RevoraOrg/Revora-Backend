import { VestingService, PartialClaimRequest } from './vestingService';

describe('VestingService', () => {
  let service: VestingService;

  beforeEach(() => {
    service = new VestingService();
  });

  describe('processPartialClaim', () => {
    it('should successfully process a valid partial claim', async () => {
      const request: PartialClaimRequest = {
        scheduleId: 'test-schedule',
        claimAmount: 150,
        userId: 'user-1'
      };

      const result = await service.processPartialClaim(request);

      expect(result.success).toBe(true);
      expect(result.claimedAmount).toBe(150);
      expect(result.remainingAmount).toBe(850); // 1000 - 150
      expect(result.error).toBeUndefined();
    });

    it('should reject claim exceeding available amount', async () => {
      const request: PartialClaimRequest = {
        scheduleId: 'test-schedule',
        claimAmount: 500, // More than available 200
        userId: 'user-1'
      };

      const result = await service.processPartialClaim(request);

      expect(result.success).toBe(false);
      expect(result.claimedAmount).toBe(0);
      expect(result.remainingAmount).toBe(200);
      expect(result.error).toBe('Claim amount exceeds available vested amount');
    });

    it('should handle zero claim amount', async () => {
      const request: PartialClaimRequest = {
        scheduleId: 'test-schedule',
        claimAmount: 0,
        userId: 'user-1'
      };

      const result = await service.processPartialClaim(request);

      expect(result.success).toBe(true);
      expect(result.claimedAmount).toBe(0);
      expect(result.remainingAmount).toBe(1000);
    });

    it('should handle full claim', async () => {
      const request: PartialClaimRequest = {
        scheduleId: 'test-schedule',
        claimAmount: 200, // Exactly available
        userId: 'user-1'
      };

      const result = await service.processPartialClaim(request);

      expect(result.success).toBe(true);
      expect(result.claimedAmount).toBe(200);
      expect(result.remainingAmount).toBe(800);
    });

    it('should handle non-existent schedule', async () => {
      // Mock getVestingSchedule to return null
      jest.spyOn(service as any, 'getVestingSchedule').mockResolvedValue(null);

      const request: PartialClaimRequest = {
        scheduleId: 'non-existent',
        claimAmount: 100,
        userId: 'user-1'
      };

      const result = await service.processPartialClaim(request);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Schedule not found');
    });
  });

  // Additional tests for edge cases and invariants
  describe('Edge Cases', () => {
    it('should prevent negative claim amounts', async () => {
      const request: PartialClaimRequest = {
        scheduleId: 'test-schedule',
        claimAmount: -50,
        userId: 'user-1'
      };

      const result = await service.processPartialClaim(request);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Claim amount cannot be negative');
    });

    it('should handle empty schedule', async () => {
      jest.spyOn(service as any, 'getVestingSchedule').mockResolvedValue({
        id: 'empty',
        totalAmount: 0,
        claimedAmount: 0,
        lastClaimIndex: -1,
        schedule: []
      });

      const request: PartialClaimRequest = {
        scheduleId: 'empty',
        claimAmount: 100,
        userId: 'user-1'
      };

      const result = await service.processPartialClaim(request);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Claim amount exceeds available vested amount');
    });
  });
});