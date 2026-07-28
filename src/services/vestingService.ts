/**
 * Vesting Service
 *
 * Handles partial claims for vesting schedules to ensure schedule math integrity
 * and prevent balance inconsistencies.
 */

export interface VestingSchedule {
  id: string;
  totalAmount: number;
  claimedAmount: number;
  lastClaimIndex: number;
  schedule: VestingEvent[];
}

export interface VestingEvent {
  index: number;
  amount: number;
  timestamp: number;
  claimed: boolean;
}

export interface PartialClaimRequest {
  scheduleId: string;
  claimAmount: number;
  userId: string;
}

export interface PartialClaimResult {
  success: boolean;
  claimedAmount: number;
  remainingAmount: number;
  error?: string;
}

export class VestingService {
  /**
   * Process a partial claim for a vesting schedule
   * Ensures no double-claiming and maintains cursor integrity
   */
  async processPartialClaim(request: PartialClaimRequest): Promise<PartialClaimResult> {
    // Validate input
    if (request.claimAmount < 0) {
      return { success: false, claimedAmount: 0, remainingAmount: 0, error: 'Claim amount cannot be negative' };
    }

    const schedule = await this.getVestingSchedule(request.scheduleId);
    if (!schedule) {
      return { success: false, claimedAmount: 0, remainingAmount: 0, error: 'Schedule not found' };
    }

    // Validate claim amount
    const availableAmount = this.calculateAvailableAmount(schedule);
    if (request.claimAmount > availableAmount) {
      return {
        success: false,
        claimedAmount: 0,
        remainingAmount: availableAmount,
        error: 'Claim amount exceeds available vested amount'
      };
    }

    // Update schedule with partial claim
    schedule.claimedAmount += request.claimAmount;
    schedule.lastClaimIndex = this.updateClaimIndex(schedule, request.claimAmount);

    // Persist changes (mock)
    await this.saveVestingSchedule(schedule);

    return {
      success: true,
      claimedAmount: request.claimAmount,
      remainingAmount: schedule.totalAmount - schedule.claimedAmount
    };
  }

  private calculateAvailableAmount(schedule: VestingSchedule): number {
    const now = Date.now();
    let available = 0;

    for (const event of schedule.schedule) {
      if (event.timestamp <= now && !event.claimed) {
        available += event.amount;
      }
    }

    return Math.max(0, available - schedule.claimedAmount);
  }

  private updateClaimIndex(schedule: VestingSchedule, claimAmount: number): number {
    // Simple implementation: mark events as claimed until claimAmount is covered
    let remainingClaim = claimAmount;
    let lastIndex = schedule.lastClaimIndex;

    for (let i = schedule.lastClaimIndex + 1; i < schedule.schedule.length; i++) {
      const event = schedule.schedule[i];
      if (remainingClaim >= event.amount) {
        event.claimed = true;
        remainingClaim -= event.amount;
        lastIndex = i;
      } else {
        // Partial claim on this event
        lastIndex = i;
        break;
      }
    }

    return lastIndex;
  }

  private async getVestingSchedule(id: string): Promise<VestingSchedule | null> {
    // Mock implementation
    return {
      id,
      totalAmount: 1000,
      claimedAmount: 0,
      lastClaimIndex: -1,
      schedule: [
        { index: 0, amount: 200, timestamp: Date.now() - 1000, claimed: false },
        { index: 1, amount: 300, timestamp: Date.now() + 1000, claimed: false },
        { index: 2, amount: 500, timestamp: Date.now() + 2000, claimed: false }
      ]
    };
  }

  private async saveVestingSchedule(schedule: VestingSchedule): Promise<void> {
    // Mock persistence
    console.log('Saved vesting schedule:', schedule.id);
  }
}