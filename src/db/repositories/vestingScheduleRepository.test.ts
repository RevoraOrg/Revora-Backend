import { Pool, QueryResult, QueryResultRow } from 'pg';
import { VestingScheduleRepository, VestingSchedule, VestingEvent } from './vestingScheduleRepository';

// ─── Shared helpers ───────────────────────────────────────────────────────────

/** Build a minimal QueryResult<T> from an array of rows. */
function makeQueryResult<T extends QueryResultRow>(rows: T[]): QueryResult<T> {
  return { rows, rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] };
}

describe('VestingScheduleRepository', () => {
  let repository: VestingScheduleRepository;
  let mockPool: jest.Mocked<Pool>;

  beforeEach(() => {
    mockPool = {
      query: jest.fn()
    } as any;
    repository = new VestingScheduleRepository(mockPool);
  });

  describe('findByIdAndUserId', () => {
    it('should return schedule when found and owned by user', async () => {
      const mockRow = {
        id: 'sched-123',
        user_id: 'user-1',
        total_amount: '1000.00',
        claimed_amount: '150.00',
        last_claim_index: 0,
        schedule_data: {
          events: [
            { index: 0, amount: 200, timestamp: Date.now() - 1000, claimed: true },
            { index: 1, amount: 300, timestamp: Date.now() + 1000, claimed: false }
          ]
        }
      };

      mockPool.query.mockResolvedValue({ rows: [mockRow] });

      const result = await repository.findByIdAndUserId('sched-123', 'user-1');

      expect(result).not.toBeNull();
      expect(result?.id).toBe('sched-123');
      expect(result?.userId).toBe('user-1');
      expect(result?.totalAmount).toBe(1000);
      expect(result?.claimedAmount).toBe(150);
      expect(result?.lastClaimIndex).toBe(0);
      expect(result?.schedule).toHaveLength(2);
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('WHERE id = $1 AND user_id = $2'),
        ['sched-123', 'user-1']
      );
    });

    it('should return null when schedule not found', async () => {
      mockPool.query.mockResolvedValue({ rows: [] });

      const result = await repository.findByIdAndUserId('non-existent', 'user-1');

      expect(result).toBeNull();
    });

    it('should return null when schedule exists but not owned by user', async () => {
      mockPool.query.mockResolvedValue({ rows: [] });

      const result = await repository.findByIdAndUserId('sched-123', 'user-2');

      expect(result).toBeNull();
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('WHERE id = $1 AND user_id = $2'),
        ['sched-123', 'user-2']
      );
    });

    it('should handle schedule with empty events array', async () => {
      const mockRow = {
        id: 'sched-123',
        user_id: 'user-1',
        total_amount: '1000.00',
        claimed_amount: '0.00',
        last_claim_index: -1,
        schedule_data: {}
      };

      mockPool.query.mockResolvedValue({ rows: [mockRow] });

      const result = await repository.findByIdAndUserId('sched-123', 'user-1');

      expect(result).not.toBeNull();
      expect(result?.schedule).toEqual([]);
    });
  });

  describe('create', () => {
    it('should create a new vesting schedule', async () => {
      const mockRow = {
        id: 'new-sched',
        user_id: 'user-1',
        total_amount: '5000.00',
        claimed_amount: '0.00',
        last_claim_index: -1,
        schedule_data: {
          events: [
            { index: 0, amount: 1000, timestamp: Date.now() + 1000, claimed: false }
          ]
        }
      };

      mockPool.query.mockResolvedValue({ rows: [mockRow] });

      const input = {
        userId: 'user-1',
        totalAmount: 5000,
        schedule: [
          { index: 0, amount: 1000, timestamp: Date.now() + 1000, claimed: false }
        ]
      };

      const result = await repository.create(input);

      expect(result.id).toBe('new-sched');
      expect(result.userId).toBe('user-1');
      expect(result.totalAmount).toBe(5000);
      expect(result.claimedAmount).toBe(0);
      expect(result.lastClaimIndex).toBe(-1);
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO vesting_schedules'),
        expect.arrayContaining([
          'user-1',
          '5000',
          expect.stringContaining('"events"')
        ])
      );
    });
  });

  describe('updateClaim', () => {
    it('should update claim when schedule exists and is owned', async () => {
      mockPool.query.mockResolvedValue({ rowCount: 1 });

      const result = await repository.updateClaim({
        scheduleId: 'sched-123',
        userId: 'user-1',
        claimedAmount: 250,
        lastClaimIndex: 1
      });

      expect(result).toBe(true);
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE vesting_schedules'),
        ['250', 1, 'sched-123', 'user-1']
      );
    });

    it('should return false when schedule not found or not owned', async () => {
      mockPool.query.mockResolvedValue({ rowCount: 0 });

      const result = await repository.updateClaim({
        scheduleId: 'sched-123',
        userId: 'user-2',
        claimedAmount: 250,
        lastClaimIndex: 1
      });

      expect(result).toBe(false);
    });

    it('should include ownership check in WHERE clause', async () => {
      mockPool.query.mockResolvedValue({ rowCount: 0 });

      await repository.updateClaim({
        scheduleId: 'sched-123',
        userId: 'user-1',
        claimedAmount: 100,
        lastClaimIndex: 0
      });

      const query = mockPool.query.mock.calls[0][0];
      expect(query).toContain('WHERE id = $3 AND user_id = $4');
    });
  });

  describe('existsAndOwned', () => {
    it('should return true when schedule exists and is owned', async () => {
      mockPool.query.mockResolvedValue({ rows: [{ '?column?': 1 }] });

      const result = await repository.existsAndOwned('sched-123', 'user-1');

      expect(result).toBe(true);
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('SELECT 1 FROM vesting_schedules'),
        ['sched-123', 'user-1']
      );
    });

    it('should return false when schedule does not exist or not owned', async () => {
      mockPool.query.mockResolvedValue({ rows: [] });

      const result = await repository.existsAndOwned('sched-123', 'user-2');

      expect(result).toBe(false);
    });
  });
});
