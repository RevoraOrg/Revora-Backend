import { Pool, QueryResult } from 'pg';
import { DisputeSLARepository, DisputeSLARecord, SLABurnReportRow } from './disputeSLARepository';

// Mock pg Pool
jest.mock('pg', () => {
  const mockPool = {
    query: jest.fn(),
  };
  return { Pool: jest.fn(() => mockPool) };
});

describe('DisputeSLARepository', () => {
  let repo: DisputeSLARepository;
  let mockPool: jest.Mocked<Pool>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockPool = new Pool() as jest.Mocked<Pool>;
    repo = new DisputeSLARepository(mockPool);
  });

  describe('create', () => {
    it('should create a new SLA record', async () => {
      const mockRecord: DisputeSLARecord = {
        id: 'sla-1',
        dispute_id: 'dispute-1',
        jurisdiction: 'US',
        state: 'new',
        sla_duration_hours: 4,
        started_at: new Date('2025-01-01T00:00:00Z'),
        paused_at: null,
        total_paused_ms: 0,
        escalated_at: null,
        escalated: false,
        resolved_at: null,
        assigned_user_id: 'user-1',
        created_at: new Date('2025-01-01T00:00:00Z'),
        updated_at: new Date('2025-01-01T00:00:00Z'),
      };

      (mockPool.query as jest.Mock).mockResolvedValue({ rows: [mockRecord] } as QueryResult<DisputeSLARecord>);

      const result = await repo.create({
        dispute_id: 'dispute-1',
        jurisdiction: 'US',
        state: 'new',
        sla_duration_hours: 4,
        assigned_user_id: 'user-1',
      });

      expect(result).toEqual(mockRecord);
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO dispute_slas'),
        expect.arrayContaining(['dispute-1', 'US', 'new', 4, 'user-1']),
      );
    });

    it('should handle null assigned_user_id', async () => {
      const mockRecord: DisputeSLARecord = {
        id: 'sla-1',
        dispute_id: 'dispute-1',
        jurisdiction: 'US',
        state: 'new',
        sla_duration_hours: 4,
        started_at: new Date('2025-01-01T00:00:00Z'),
        paused_at: null,
        total_paused_ms: 0,
        escalated_at: null,
        escalated: false,
        resolved_at: null,
        assigned_user_id: null,
        created_at: new Date('2025-01-01T00:00:00Z'),
        updated_at: new Date('2025-01-01T00:00:00Z'),
      };

      (mockPool.query as jest.Mock).mockResolvedValue({ rows: [mockRecord] } as QueryResult<DisputeSLARecord>);

      const result = await repo.create({
        dispute_id: 'dispute-1',
        jurisdiction: 'US',
        state: 'new',
        sla_duration_hours: 4,
      });

      expect(result.assigned_user_id).toBeNull();
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining([null]),
      );
    });

    it('should throw when no rows returned', async () => {
      (mockPool.query as jest.Mock).mockResolvedValue({ rows: [] } as unknown as QueryResult<DisputeSLARecord>);

      await expect(
        repo.create({
          dispute_id: 'dispute-1',
          jurisdiction: 'US',
          state: 'new',
          sla_duration_hours: 4,
        }),
      ).rejects.toThrow('Failed to create dispute SLA record');
    });
  });

  describe('findActiveByDisputeId', () => {
    it('should return active SLA record', async () => {
      const mockRecord: DisputeSLARecord = {
        id: 'sla-1',
        dispute_id: 'dispute-1',
        jurisdiction: 'US',
        state: 'new',
        sla_duration_hours: 4,
        started_at: new Date('2025-01-01T00:00:00Z'),
        paused_at: null,
        total_paused_ms: 0,
        escalated_at: null,
        escalated: false,
        resolved_at: null,
        assigned_user_id: 'user-1',
        created_at: new Date('2025-01-01T00:00:00Z'),
        updated_at: new Date('2025-01-01T00:00:00Z'),
      };

      (mockPool.query as jest.Mock).mockResolvedValue({ rows: [mockRecord] } as QueryResult<DisputeSLARecord>);

      const result = await repo.findActiveByDisputeId('dispute-1');

      expect(result).toEqual(mockRecord);
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('WHERE dispute_id = $1'),
        ['dispute-1'],
      );
    });

    it('should return null when no active record found', async () => {
      (mockPool.query as jest.Mock).mockResolvedValue({ rows: [] } as unknown as QueryResult<DisputeSLARecord>);

      const result = await repo.findActiveByDisputeId('dispute-1');

      expect(result).toBeNull();
    });
  });

  describe('findByDisputeId', () => {
    it('should return all SLA records for a dispute', async () => {
      const mockRecords: DisputeSLARecord[] = [
        {
          id: 'sla-2',
          dispute_id: 'dispute-1',
          jurisdiction: 'US',
          state: 'investigating',
          sla_duration_hours: 72,
          started_at: new Date('2025-01-02T00:00:00Z'),
          paused_at: null,
          total_paused_ms: 0,
          escalated_at: null,
          escalated: false,
          resolved_at: null,
          assigned_user_id: 'user-1',
          created_at: new Date('2025-01-02T00:00:00Z'),
          updated_at: new Date('2025-01-02T00:00:00Z'),
        },
        {
          id: 'sla-1',
          dispute_id: 'dispute-1',
          jurisdiction: 'US',
          state: 'new',
          sla_duration_hours: 4,
          started_at: new Date('2025-01-01T00:00:00Z'),
          paused_at: null,
          total_paused_ms: 0,
          escalated_at: null,
          escalated: false,
          resolved_at: new Date('2025-01-02T00:00:00Z'),
          assigned_user_id: 'user-1',
          created_at: new Date('2025-01-01T00:00:00Z'),
          updated_at: new Date('2025-01-02T00:00:00Z'),
        },
      ];

      (mockPool.query as jest.Mock).mockResolvedValue({ rows: mockRecords } as QueryResult<DisputeSLARecord>);

      const result = await repo.findByDisputeId('dispute-1');

      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('sla-2'); // Should be ordered by created_at DESC
    });
  });

  describe('update', () => {
    it('should update SLA record fields', async () => {
      const updatedRecord: DisputeSLARecord = {
        id: 'sla-1',
        dispute_id: 'dispute-1',
        jurisdiction: 'US',
        state: 'new',
        sla_duration_hours: 4,
        started_at: new Date('2025-01-01T00:00:00Z'),
        paused_at: new Date('2025-01-01T01:00:00Z'),
        total_paused_ms: 3600000,
        escalated_at: null,
        escalated: false,
        resolved_at: null,
        assigned_user_id: 'user-1',
        created_at: new Date('2025-01-01T00:00:00Z'),
        updated_at: new Date('2025-01-01T01:00:00Z'),
      };

      (mockPool.query as jest.Mock).mockResolvedValue({ rows: [updatedRecord] } as QueryResult<DisputeSLARecord>);

      const result = await repo.update('sla-1', {
        paused_at: new Date('2025-01-01T01:00:00Z'),
        total_paused_ms: 3600000,
      });

      expect(result.paused_at).toEqual(new Date('2025-01-01T01:00:00Z'));
      expect(result.total_paused_ms).toBe(3600000);
    });

    it('should throw when no fields to update', async () => {
      await expect(repo.update('sla-1', {})).rejects.toThrow('No fields to update');
    });

    it('should throw when record not found', async () => {
      (mockPool.query as jest.Mock).mockResolvedValue({ rows: [] } as unknown as QueryResult<DisputeSLARecord>);

      await expect(
        repo.update('sla-1', { paused_at: new Date() }),
      ).rejects.toThrow('Dispute SLA record not found');
    });

    it('should update state field', async () => {
      const updatedRecord: DisputeSLARecord = {
        id: 'sla-1',
        dispute_id: 'dispute-1',
        jurisdiction: 'US',
        state: 'investigating',
        sla_duration_hours: 4,
        started_at: new Date('2025-01-01T00:00:00Z'),
        paused_at: null,
        total_paused_ms: 0,
        escalated_at: null,
        escalated: false,
        resolved_at: null,
        assigned_user_id: 'user-1',
        created_at: new Date('2025-01-01T00:00:00Z'),
        updated_at: new Date('2025-01-01T01:00:00Z'),
      };

      (mockPool.query as jest.Mock).mockResolvedValue({ rows: [updatedRecord] } as unknown as QueryResult<DisputeSLARecord>);

      const result = await repo.update('sla-1', { state: 'investigating' });

      expect(result.state).toBe('investigating');
    });

    it('should update escalated field', async () => {
      const updatedRecord: DisputeSLARecord = {
        id: 'sla-1',
        dispute_id: 'dispute-1',
        jurisdiction: 'US',
        state: 'new',
        sla_duration_hours: 4,
        started_at: new Date('2025-01-01T00:00:00Z'),
        paused_at: null,
        total_paused_ms: 0,
        escalated_at: new Date('2025-01-01T01:00:00Z'),
        escalated: true,
        resolved_at: null,
        assigned_user_id: 'user-1',
        created_at: new Date('2025-01-01T00:00:00Z'),
        updated_at: new Date('2025-01-01T01:00:00Z'),
      };

      (mockPool.query as jest.Mock).mockResolvedValue({ rows: [updatedRecord] } as unknown as QueryResult<DisputeSLARecord>);

      const result = await repo.update('sla-1', { escalated: true, escalated_at: new Date('2025-01-01T01:00:00Z') });

      expect(result.escalated).toBe(true);
      expect(result.escalated_at).not.toBeNull();
    });

    it('should update resolved_at field', async () => {
      const updatedRecord: DisputeSLARecord = {
        id: 'sla-1',
        dispute_id: 'dispute-1',
        jurisdiction: 'US',
        state: 'new',
        sla_duration_hours: 4,
        started_at: new Date('2025-01-01T00:00:00Z'),
        paused_at: null,
        total_paused_ms: 0,
        escalated_at: null,
        escalated: false,
        resolved_at: new Date('2025-01-01T01:00:00Z'),
        assigned_user_id: 'user-1',
        created_at: new Date('2025-01-01T00:00:00Z'),
        updated_at: new Date('2025-01-01T01:00:00Z'),
      };

      (mockPool.query as jest.Mock).mockResolvedValue({ rows: [updatedRecord] } as unknown as QueryResult<DisputeSLARecord>);

      const result = await repo.update('sla-1', { resolved_at: new Date('2025-01-01T01:00:00Z') });

      expect(result.resolved_at).not.toBeNull();
    });

    it('should update assigned_user_id field', async () => {
      const updatedRecord: DisputeSLARecord = {
        id: 'sla-1',
        dispute_id: 'dispute-1',
        jurisdiction: 'US',
        state: 'new',
        sla_duration_hours: 4,
        started_at: new Date('2025-01-01T00:00:00Z'),
        paused_at: null,
        total_paused_ms: 0,
        escalated_at: null,
        escalated: false,
        resolved_at: null,
        assigned_user_id: 'user-2',
        created_at: new Date('2025-01-01T00:00:00Z'),
        updated_at: new Date('2025-01-01T01:00:00Z'),
      };

      (mockPool.query as jest.Mock).mockResolvedValue({ rows: [updatedRecord] } as unknown as QueryResult<DisputeSLARecord>);

      const result = await repo.update('sla-1', { assigned_user_id: 'user-2' });

      expect(result.assigned_user_id).toBe('user-2');
    });
  });

  describe('getSLABurnReport', () => {
    it('should generate burn report for date range', async () => {
      const mockRows = [
        {
          id: 'sla-1',
          dispute_id: 'dispute-1',
          jurisdiction: 'US',
          state: 'new',
          sla_duration_hours: 4,
          started_at: new Date('2025-01-01T00:00:00Z'),
          paused_at: null,
          total_paused_ms: 0,
          escalated: false,
          resolved_at: null,
          assigned_user_id: 'user-1',
          elapsed_ms: 18000000, // 5 hours
        },
      ];

      (mockPool.query as jest.Mock).mockResolvedValue({ rows: mockRows } as unknown as QueryResult);

      const result = await repo.getSLABurnReport(
        new Date('2025-01-01'),
        new Date('2025-01-07'),
      );

      expect(result).toHaveLength(1);
      expect(result[0].dispute_id).toBe('dispute-1');
      expect(result[0].elapsed_hours).toBe(5);
      expect(result[0].remaining_hours).toBe(0);
      expect(result[0].is_breached).toBe(true);
    });

    it('should filter by jurisdiction', async () => {
      (mockPool.query as jest.Mock).mockResolvedValue({ rows: [] } as unknown as QueryResult);

      await repo.getSLABurnReport(
        new Date('2025-01-01'),
        new Date('2025-01-07'),
        'US',
      );

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('ds.jurisdiction ='),
        expect.arrayContaining([new Date('2025-01-01'), new Date('2025-01-07'), 'US']),
      );
    });

    it('should calculate elapsed time excluding paused time', async () => {
      const mockRows = [
        {
          id: 'sla-1',
          dispute_id: 'dispute-1',
          jurisdiction: 'US',
          state: 'new',
          sla_duration_hours: 10,
          started_at: new Date('2025-01-01T00:00:00Z'),
          paused_at: null,
          total_paused_ms: 3600000, // 1 hour paused
          escalated: false,
          resolved_at: null,
          assigned_user_id: 'user-1',
          elapsed_ms: 18000000, // 5 hours gross
        },
      ];

      (mockPool.query as jest.Mock).mockResolvedValue({ rows: mockRows } as unknown as QueryResult);

      const result = await repo.getSLABurnReport(
        new Date('2025-01-01'),
        new Date('2025-01-07'),
      );

      expect(result[0].elapsed_hours).toBe(4); // 5 - 1 = 4 hours net
      expect(result[0].remaining_hours).toBe(6);
    });
  });

  describe('findOverdueNonEscalated', () => {
    it('should find overdue non-escalated records', async () => {
      const mockRecords: DisputeSLARecord[] = [
        {
          id: 'sla-1',
          dispute_id: 'dispute-1',
          jurisdiction: 'US',
          state: 'new',
          sla_duration_hours: 4,
          started_at: new Date('2025-01-01T00:00:00Z'),
          paused_at: null,
          total_paused_ms: 0,
          escalated_at: null,
          escalated: false,
          resolved_at: null,
          assigned_user_id: 'user-1',
          created_at: new Date('2025-01-01T00:00:00Z'),
          updated_at: new Date('2025-01-01T00:00:00Z'),
        },
      ];

      (mockPool.query as jest.Mock).mockResolvedValue({ rows: mockRecords } as unknown as QueryResult<DisputeSLARecord>);

      const result = await repo.findOverdueNonEscalated();

      expect(result).toHaveLength(1);
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('escalated = FALSE'),
      );
    });

    it('should return empty array when no overdue records', async () => {
      (mockPool.query as jest.Mock).mockResolvedValue({ rows: [] } as unknown as QueryResult<DisputeSLARecord>);

      const result = await repo.findOverdueNonEscalated();

      expect(result).toHaveLength(0);
    });
  });
});
