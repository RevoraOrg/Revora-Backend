import { Pool, PoolClient } from 'pg';

/**
 * Vesting schedule entity from database
 */
export interface VestingScheduleRow {
  id: string;
  user_id: string;
  total_amount: string;
  claimed_amount: string;
  last_claim_index: number;
  schedule_data: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

/**
 * Vesting schedule domain model
 */
export interface VestingSchedule {
  id: string;
  userId: string;
  totalAmount: number;
  claimedAmount: number;
  lastClaimIndex: number;
  schedule: VestingEvent[];
}

/**
 * Vesting event within a schedule
 */
export interface VestingEvent {
  index: number;
  amount: number;
  timestamp: number;
  claimed: boolean;
}

/**
 * Input for creating a vesting schedule
 */
export interface CreateVestingScheduleInput {
  userId: string;
  totalAmount: number;
  schedule: VestingEvent[];
}

/**
 * Input for updating claimed amount
 */
export interface UpdateClaimInput {
  scheduleId: string;
  userId: string;
  claimedAmount: number;
  lastClaimIndex: number;
}

/**
 * Vesting Schedule Repository
 * 
 * Provides database operations for vesting schedules with ownership validation.
 * All operations enforce that the requesting user owns the schedule.
 */
export class VestingScheduleRepository {
  constructor(private pool: Pool) {}

  /**
   * Find a vesting schedule by ID and validate ownership
   * 
   * @param scheduleId - The schedule ID to look up
   * @param userId - The user ID claiming ownership
   * @returns The schedule if found and owned by the user, null otherwise
   */
  async findByIdAndUserId(scheduleId: string, userId: string): Promise<VestingSchedule | null> {
    const query = `
      SELECT id, user_id, total_amount, claimed_amount, last_claim_index, schedule_data
      FROM vesting_schedules
      WHERE id = $1 AND user_id = $2
    `;

    const result = await this.pool.query(query, [scheduleId, userId]);

    if (result.rows.length === 0) {
      return null;
    }

    const row = result.rows[0] as VestingScheduleRow;
    return this.mapRowToDomain(row);
  }

  /**
   * Create a new vesting schedule
   * 
   * @param input - The schedule creation input
   * @returns The created schedule
   */
  async create(input: CreateVestingScheduleInput): Promise<VestingSchedule> {
    const query = `
      INSERT INTO vesting_schedules (user_id, total_amount, claimed_amount, last_claim_index, schedule_data)
      VALUES ($1, $2, 0, -1, $3)
      RETURNING id, user_id, total_amount, claimed_amount, last_claim_index, schedule_data
    `;

    const result = await this.pool.query(query, [
      input.userId,
      input.totalAmount.toString(),
      JSON.stringify({ events: input.schedule })
    ]);

    const row = result.rows[0] as VestingScheduleRow;
    return this.mapRowToDomain(row);
  }

  /**
   * Update claimed amount and last claim index for a schedule
   * 
   * This operation validates ownership via the WHERE clause.
   * If the schedule doesn't exist or isn't owned by the user, no rows are updated.
   * 
   * @param input - The update input including scheduleId, userId, and new claim state
   * @returns true if the update succeeded, false if the schedule wasn't found or owned
   */
  async updateClaim(input: UpdateClaimInput): Promise<boolean> {
    const query = `
      UPDATE vesting_schedules
      SET claimed_amount = $1,
          last_claim_index = $2,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $3 AND user_id = $4
    `;

    const result = await this.pool.query(query, [
      input.claimedAmount.toString(),
      input.lastClaimIndex,
      input.scheduleId,
      input.userId
    ]);

    return result.rowCount > 0;
  }

  /**
   * Check if a schedule exists and is owned by a user
   * 
   * @param scheduleId - The schedule ID
   * @param userId - The user ID
   * @returns true if the schedule exists and is owned by the user
   */
  async existsAndOwned(scheduleId: string, userId: string): Promise<boolean> {
    const query = `
      SELECT 1 FROM vesting_schedules
      WHERE id = $1 AND user_id = $2
    `;

    const result = await this.pool.query(query, [scheduleId, userId]);
    return result.rows.length > 0;
  }

  /**
   * Map a database row to the domain model
   */
  private mapRowToDomain(row: VestingScheduleRow): VestingSchedule {
    const scheduleData = row.schedule_data as { events?: VestingEvent[] };
    const events = scheduleData.events || [];

    return {
      id: row.id,
      userId: row.user_id,
      totalAmount: parseFloat(row.total_amount),
      claimedAmount: parseFloat(row.claimed_amount),
      lastClaimIndex: row.last_claim_index,
      schedule: events
    };
  }
}
