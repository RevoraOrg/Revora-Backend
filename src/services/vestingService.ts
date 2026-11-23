/**
 * Vesting Service
 *
 * Handles partial claims for vesting schedules to ensure schedule math integrity
 * and prevent balance inconsistencies.
 *
 * Security assumptions:
 * - All operations validate ownership via the repository
 * - Claims are persisted to the database, not in-memory
 * - Ownership is enforced at the database level (user_id foreign key)
 */

import { Pool } from 'pg';
import { 
  VestingScheduleRepository, 
  VestingSchedule, 
  VestingEvent,
  CreateVestingScheduleInput 
} from '../db/repositories/vestingScheduleRepository';

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
  private repository: VestingScheduleRepository;

  constructor(pool?: Pool) {
    // If pool is provided, use it; otherwise this is a test scenario
    // where the repository will be mocked
    if (pool) {
      this.repository = new VestingScheduleRepository(pool);
    } else {
      // Placeholder for testing - will be replaced by mocks
      this.repository = null as any;
    }
  }

  /**
   * Set the repository (primarily for testing)
   */
  setRepository(repository: VestingScheduleRepository): void {
    this.repository = repository;
  }

  /**
   * Process a partial claim for a vesting schedule
   * 
   * Security: Validates ownership via repository before processing.
   * Persists claim state to database to prevent double-claiming.
   * 
   * @param request - The partial claim request
   * @returns The claim result with success status and amounts
   */
  async processPartialClaim(request: PartialClaimRequest): Promise<PartialClaimResult> {
    // Validate input
    if (request.claimAmount < 0) {
      return { success: false, claimedAmount: 0, remainingAmount: 0, error: 'Claim amount cannot be negative' };
    }

    // Validate userId is provided
    if (!request.userId) {
      return { success: false, claimedAmount: 0, remainingAmount: 0, error: 'User authentication required' };
    }

    // Fetch schedule with ownership validation
    const schedule = await this.repository.findByIdAndUserId(request.scheduleId, request.userId);
    if (!schedule) {
      return { success: false, claimedAmount: 0, remainingAmount: 0, error: 'Schedule not found or access denied' };
    }

    // Validate claim amount against available vested amount
    const availableAmount = this.calculateAvailableAmount(schedule);
    if (request.claimAmount > availableAmount) {
      return {
        success: false,
        claimedAmount: 0,
        remainingAmount: availableAmount,
        error: 'Claim amount exceeds available vested amount'
      };
    }

    // Calculate new claim state
    const newClaimedAmount = schedule.claimedAmount + request.claimAmount;
    const newLastClaimIndex = this.updateClaimIndex(schedule, request.claimAmount);

    // Persist changes to database with ownership validation
    const updateSuccess = await this.repository.updateClaim({
      scheduleId: request.scheduleId,
      userId: request.userId,
      claimedAmount: newClaimedAmount,
      lastClaimIndex: newLastClaimIndex
    });

    if (!updateSuccess) {
      // This should not happen if we successfully fetched the schedule,
      // but it handles race conditions where the schedule was deleted
      return { success: false, claimedAmount: 0, remainingAmount: 0, error: 'Failed to persist claim' };
    }

    return {
      success: true,
      claimedAmount: request.claimAmount,
      remainingAmount: schedule.totalAmount - newClaimedAmount
    };
  }

  /**
   * Create a new vesting schedule
   * 
   * @param input - The schedule creation input
   * @returns The created schedule
   */
  async createSchedule(input: CreateVestingScheduleInput): Promise<VestingSchedule> {
    return this.repository.create(input);
  }

  /**
   * Calculate the currently available vested amount
   * 
   * @param schedule - The vesting schedule
   * @returns The available amount that can be claimed
   */
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

  /**
   * Update the claim index based on the claim amount
   * Marks events as claimed until the claim amount is covered
   * 
   * @param schedule - The vesting schedule
   * @param claimAmount - The amount being claimed
   * @returns The new last claim index
   */
  private updateClaimIndex(schedule: VestingSchedule, claimAmount: number): number {
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
}