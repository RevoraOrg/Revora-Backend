import { Pool } from 'pg';
import { DisputeSLAService, sanitizeCSVCell } from '../services/disputeSLAService';
import { DisputeSLARepository, DisputeSLARecord, SLABurnReportRow } from '../db/repositories/disputeSLARepository';
import { NotificationRepository } from '../db/repositories/notificationRepository';
import { AuditLogRepository } from '../db/repositories/auditLogRepository';
import { Logger } from '../lib/logger';
import { getSLADuration, isTerminalState } from '../config/disputeSLAConfig';

// Mock the repository
jest.mock('../db/repositories/disputeSLARepository');
jest.mock('../db/repositories/notificationRepository');
jest.mock('../db/repositories/auditLogRepository');
jest.mock('../config/disputeSLAConfig', () => ({
  getSLADuration: jest.fn(),
  isTerminalState: jest.fn(),
  isAutoEscalateEnabled: jest.fn(),
  getJurisdictionSLAConfig: jest.fn(),
  DISPUTE_STATES: ['new', 'triage', 'investigating', 'awaiting_customer', 'awaiting_merchant', 'awaiting_evidence', 'under_review', 'resolution_proposed', 'escalated_internal', 'resolved', 'closed'],
  DISPUTE_JURISDICTIONS: ['US', 'EU', 'UK', 'CA', 'AU', 'SG', 'default'],
  JURISDICTION_SLA_CONFIGS: {},
}));

const MockedSLARepo = DisputeSLARepository as jest.MockedClass<typeof DisputeSLARepository>;
const MockedNotificationRepo = NotificationRepository as jest.MockedClass<typeof NotificationRepository>;
const MockedAuditLogRepo = AuditLogRepository as jest.MockedClass<typeof AuditLogRepository>;

function createMockSLARecord(overrides: Partial<DisputeSLARecord> = {}): DisputeSLARecord {
  return {
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
    ...overrides,
  };
}

function createMockSLABurnRow(overrides: Partial<SLABurnReportRow> = {}): SLABurnReportRow {
  return {
    dispute_id: 'dispute-1',
    jurisdiction: 'US',
    state: 'new',
    sla_duration_hours: 4,
    elapsed_hours: 5,
    remaining_hours: 0,
    is_breached: true,
    escalated: false,
    paused: false,
    started_at: new Date('2025-01-01T00:00:00Z'),
    resolved_at: null,
    assigned_user_id: 'user-1',
    ...overrides,
  };
}

describe('DisputeSLAService', () => {
  let service: DisputeSLAService;
  let mockDB: Pool;
  let mockSLARepo: jest.Mocked<DisputeSLARepository>;
  let mockNotificationRepo: jest.Mocked<NotificationRepository>;
  let mockAuditLogRepo: jest.Mocked<AuditLogRepository>;
  let mockLogger: jest.Mocked<Partial<Logger>>;

  beforeEach(() => {
    jest.clearAllMocks();

    // Set up default config mocks
    (getSLADuration as jest.Mock).mockReturnValue(4);
    (isTerminalState as jest.Mock).mockImplementation((state: string) => state === 'resolved' || state === 'closed');
    (require('../config/disputeSLAConfig').isAutoEscalateEnabled as jest.Mock).mockReturnValue(true);

    mockDB = {} as Pool;
    mockLogger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    };

    mockNotificationRepo = new MockedNotificationRepo(mockDB) as jest.Mocked<NotificationRepository>;
    mockAuditLogRepo = new MockedAuditLogRepo(mockDB) as jest.Mocked<AuditLogRepository>;

    service = new DisputeSLAService({
      db: mockDB,
      notificationRepo: mockNotificationRepo,
      auditLogRepo: mockAuditLogRepo,
      logger: mockLogger as unknown as Logger,
    });

    mockSLARepo = (DisputeSLARepository as jest.Mock).mock.instances[0] as jest.Mocked<DisputeSLARepository>;
  });

  it('should use global logger when no logger provided', () => {
    const serviceNoLogger = new DisputeSLAService({
      db: mockDB,
      notificationRepo: mockNotificationRepo,
      auditLogRepo: mockAuditLogRepo,
    });

    expect(serviceNoLogger).toBeDefined();
  });

  describe('startTimer', () => {
    it('should reject terminal state resolved', async () => {
      await expect(
        service.startTimer({
          disputeId: 'dispute-1',
          jurisdiction: 'US',
          state: 'resolved',
        }),
      ).rejects.toThrow('Cannot start SLA timer for terminal state');
    });

    it('should reject terminal state closed', async () => {
      await expect(
        service.startTimer({
          disputeId: 'dispute-1',
          jurisdiction: 'US',
          state: 'closed',
        }),
      ).rejects.toThrow('Cannot start SLA timer for terminal state');
    });

    it('should create a new SLA timer when no active timer exists', async () => {
      mockSLARepo.findActiveByDisputeId.mockResolvedValue(null);
      mockSLARepo.create.mockResolvedValue(createMockSLARecord());
      mockAuditLogRepo.createAuditLog.mockResolvedValue({} as any);

      const result = await service.startTimer({
        disputeId: 'dispute-1',
        jurisdiction: 'US',
        state: 'new',
        assignedUserId: 'user-1',
      });

      expect(result.dispute_id).toBe('dispute-1');
      expect(mockSLARepo.create).toHaveBeenCalledTimes(1);
      expect(mockSLARepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          dispute_id: 'dispute-1',
          jurisdiction: 'US',
          state: 'new',
          sla_duration_hours: 4,
        }),
      );
    });

    it('should resolve existing active timer before creating new one', async () => {
      const existing = createMockSLARecord({
        id: 'sla-old',
        state: 'triage',
        started_at: new Date('2025-01-01T00:00:00Z'),
      });

      mockSLARepo.findActiveByDisputeId.mockResolvedValue(existing);
      mockSLARepo.update.mockResolvedValue({ ...existing, resolved_at: new Date() });
      mockSLARepo.create.mockResolvedValue(createMockSLARecord());
      mockAuditLogRepo.createAuditLog.mockResolvedValue({} as any);

      const result = await service.startTimer({
        disputeId: 'dispute-1',
        jurisdiction: 'US',
        state: 'investigating',
        assignedUserId: 'user-1',
      });

      expect(mockSLARepo.update).toHaveBeenCalledWith('sla-old', expect.objectContaining({
        resolved_at: expect.any(Date),
      }));
      expect(mockSLARepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          state: 'investigating',
        }),
      );
    });

    it('should mark existing timer as escalated if SLA was breached', async () => {
      const existing = createMockSLARecord({
        id: 'sla-old',
        state: 'triage',
        sla_duration_hours: 1,
        started_at: new Date(Date.now() - 2 * 3600 * 1000), // 2 hours ago
      });

      mockSLARepo.findActiveByDisputeId.mockResolvedValue(existing);
      mockSLARepo.update.mockResolvedValue({ ...existing, resolved_at: new Date(), escalated: true, escalated_at: new Date() });
      mockSLARepo.create.mockResolvedValue(createMockSLARecord());
      mockAuditLogRepo.createAuditLog.mockResolvedValue({} as any);

      await service.startTimer({
        disputeId: 'dispute-1',
        jurisdiction: 'US',
        state: 'investigating',
      });

      expect(mockSLARepo.update).toHaveBeenCalledWith('sla-old', expect.objectContaining({
        escalated: true,
        escalated_at: expect.any(Date),
      }));
    });

    it('should create audit log on timer start', async () => {
      mockSLARepo.findActiveByDisputeId.mockResolvedValue(null);
      mockSLARepo.create.mockResolvedValue(createMockSLARecord());
      mockAuditLogRepo.createAuditLog.mockResolvedValue({} as any);

      await service.startTimer({
        disputeId: 'dispute-1',
        jurisdiction: 'US',
        state: 'new',
        assignedUserId: 'user-1',
      });

      expect(mockAuditLogRepo.createAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'dispute_sla_timer_started',
          resource: 'dispute:dispute-1',
          user_id: 'user-1',
        }),
      );
    });

    it('should handle missing notificationRepo gracefully', async () => {
      const serviceNoNotifs = new DisputeSLAService({
        db: mockDB,
        auditLogRepo: mockAuditLogRepo,
        logger: mockLogger as unknown as Logger,
      });

      const repo = (DisputeSLARepository as jest.Mock).mock.instances[1] as jest.Mocked<DisputeSLARepository>;
      repo.findActiveByDisputeId.mockResolvedValue(null);
      repo.create.mockResolvedValue(createMockSLARecord());
      mockAuditLogRepo.createAuditLog.mockResolvedValue({} as any);

      const result = await serviceNoNotifs.startTimer({
        disputeId: 'dispute-1',
        jurisdiction: 'US',
        state: 'new',
      });

      expect(result).toBeDefined();
    });

    it('should escalate when SLA duration is 0 or negative for non-terminal state', async () => {
      (getSLADuration as jest.Mock).mockReturnValue(0);
      (isTerminalState as jest.Mock).mockReturnValue(false);

      mockSLARepo.findActiveByDisputeId.mockResolvedValue(null);
      const record = createMockSLARecord({ sla_duration_hours: 0, state: 'investigating' });
      mockSLARepo.create.mockResolvedValue(record);
      const escalatedRecord = { ...record, escalated: true, escalated_at: new Date() };
      mockSLARepo.update.mockResolvedValue(escalatedRecord);
      mockNotificationRepo.create.mockResolvedValue({} as any);
      mockAuditLogRepo.createAuditLog.mockResolvedValue({} as any);

      await service.startTimer({
        disputeId: 'dispute-1',
        jurisdiction: 'US',
        state: 'investigating',
      });

      expect(mockSLARepo.update).toHaveBeenCalled();
      expect(mockNotificationRepo.create).toHaveBeenCalled();
    });

    it('should resolve existing timer when breached before starting new one', async () => {
      const existing = createMockSLARecord({
        id: 'sla-old',
        started_at: new Date(Date.now() - 10 * 3600 * 1000), // 10 hours ago
        sla_duration_hours: 4,
        paused_at: null,
        total_paused_ms: 0,
        escalated: false,
      });

      mockSLARepo.findActiveByDisputeId.mockResolvedValue(existing);
      const newRecord = createMockSLARecord({ id: 'sla-new' });
      mockSLARepo.create.mockResolvedValue(newRecord);
      mockSLARepo.update.mockResolvedValue({
        ...existing,
        resolved_at: new Date(),
        escalated: true,
        escalated_at: new Date(),
      });
      mockAuditLogRepo.createAuditLog.mockResolvedValue({} as any);

      await service.startTimer({
        disputeId: 'dispute-1',
        jurisdiction: 'US',
        state: 'new',
      });

      expect(mockSLARepo.update).toHaveBeenCalledWith(
        existing.id,
        expect.objectContaining({ resolved_at: expect.any(Date), escalated: true }),
      );
    });

    it('should resolve existing timer when not breached before starting new one', async () => {
      const existing = createMockSLARecord({
        id: 'sla-old',
        started_at: new Date(Date.now() - 2 * 3600 * 1000), // 2 hours ago
        sla_duration_hours: 4,
        paused_at: null,
        total_paused_ms: 0,
        escalated: false,
      });

      mockSLARepo.findActiveByDisputeId.mockResolvedValue(existing);
      const newRecord = createMockSLARecord({ id: 'sla-new' });
      mockSLARepo.create.mockResolvedValue(newRecord);
      mockSLARepo.update.mockResolvedValue({
        ...existing,
        resolved_at: new Date(),
        escalated: false,
        escalated_at: null,
      });
      mockAuditLogRepo.createAuditLog.mockResolvedValue({} as any);

      await service.startTimer({
        disputeId: 'dispute-1',
        jurisdiction: 'US',
        state: 'new',
      });

      expect(mockSLARepo.update).toHaveBeenCalledWith(
        existing.id,
        expect.objectContaining({ resolved_at: expect.any(Date), escalated: false, escalated_at: null }),
      );
    });

  });

  describe('transitionState', () => {
    it('should transition to a new state and create new timer', async () => {
      const existing = createMockSLARecord({
        id: 'sla-1',
        state: 'new',
        started_at: new Date('2025-01-01T00:00:00Z'),
      });

      mockSLARepo.findActiveByDisputeId.mockResolvedValue(existing);
      mockSLARepo.update.mockResolvedValue({ ...existing, resolved_at: new Date() });
      mockSLARepo.create.mockResolvedValue(
        createMockSLARecord({ id: 'sla-2', state: 'investigating', sla_duration_hours: 72 }),
      );
      mockAuditLogRepo.createAuditLog.mockResolvedValue({} as any);

      const result = await service.transitionState({
        disputeId: 'dispute-1',
        newState: 'investigating',
      });

      expect(result).not.toBeNull();
      expect(result!.state).toBe('investigating');
      expect(result!.sla_duration_hours).toBe(72);
      expect(mockSLARepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ state: 'investigating' }),
      );
    });

    it('should update jurisdiction when provided', async () => {
      const existing = createMockSLARecord({
        id: 'sla-1',
        state: 'new',
        started_at: new Date('2025-01-01T00:00:00Z'),
      });

      mockSLARepo.findActiveByDisputeId.mockResolvedValue(existing);
      const newRecord = createMockSLARecord({
        id: 'sla-2',
        state: 'investigating',
        jurisdiction: 'EU',
      });
      mockSLARepo.update.mockResolvedValue({
        ...existing,
        resolved_at: new Date(),
      });
      mockSLARepo.create.mockResolvedValue(newRecord);
      mockAuditLogRepo.createAuditLog.mockResolvedValue({} as any);

      const result = await service.transitionState({
        disputeId: 'dispute-1',
        newState: 'investigating',
        newJurisdiction: 'EU',
      });

      expect(result).toEqual(newRecord);
      expect(mockSLARepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ jurisdiction: 'EU' }),
      );
    });

    it('should resolve current timer when breached during transition', async () => {
      const existing = createMockSLARecord({
        id: 'sla-1',
        state: 'new',
        started_at: new Date(Date.now() - 10 * 3600 * 1000), // 10 hours ago
        sla_duration_hours: 4,
        paused_at: null,
        total_paused_ms: 0,
        escalated: false,
      });

      mockSLARepo.findActiveByDisputeId.mockResolvedValue(existing);
      const newRecord = createMockSLARecord({ id: 'sla-2', state: 'investigating' });
      mockSLARepo.update.mockResolvedValue({
        ...existing,
        resolved_at: new Date(),
        escalated: true,
        escalated_at: new Date(),
      });
      mockSLARepo.create.mockResolvedValue(newRecord);
      mockAuditLogRepo.createAuditLog.mockResolvedValue({} as any);

      const result = await service.transitionState({
        disputeId: 'dispute-1',
        newState: 'investigating',
      });

      expect(mockSLARepo.update).toHaveBeenCalledWith(
        existing.id,
        expect.objectContaining({ escalated: true, escalated_at: expect.any(Date) }),
      );
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'SLA breached during transition',
        expect.any(Object),
      );
    });

    it('should resolve timer when transitioning to terminal state', async () => {
      const existing = createMockSLARecord({
        id: 'sla-1',
        state: 'under_review',
      });

      mockSLARepo.findActiveByDisputeId.mockResolvedValue(existing);
      mockSLARepo.update.mockResolvedValue({
        ...existing,
        resolved_at: new Date(),
        state: 'resolved',
      });
      mockAuditLogRepo.createAuditLog.mockResolvedValue({} as any);

      const result = await service.transitionState({
        disputeId: 'dispute-1',
        newState: 'resolved',
      });

      expect(result).not.toBeNull();
      expect(result!.resolved_at).not.toBeNull();
      expect(mockSLARepo.create).not.toHaveBeenCalled();
    });

    it('should return null if no active timer exists', async () => {
      mockSLARepo.findActiveByDisputeId.mockResolvedValue(null);

      const result = await service.transitionState({
        disputeId: 'dispute-1',
        newState: 'investigating',
      });

      expect(result).toBeNull();
    });

    it('should return existing record if state and jurisdiction unchanged', async () => {
      const existing = createMockSLARecord({
        state: 'investigating',
        jurisdiction: 'US',
      });

      mockSLARepo.findActiveByDisputeId.mockResolvedValue(existing);

      const result = await service.transitionState({
        disputeId: 'dispute-1',
        newState: 'investigating',
      });

      expect(result).toBe(existing);
      expect(mockSLARepo.update).not.toHaveBeenCalled();
    });

    it('should update jurisdiction when provided', async () => {
      const existing = createMockSLARecord({
        id: 'sla-1',
        state: 'new',
        jurisdiction: 'US',
      });

      mockSLARepo.findActiveByDisputeId.mockResolvedValue(existing);
      mockSLARepo.update.mockResolvedValue({ ...existing, resolved_at: new Date() });
      mockSLARepo.create.mockResolvedValue(
        createMockSLARecord({ id: 'sla-2', state: 'triage', jurisdiction: 'EU', sla_duration_hours: 8 }),
      );
      mockAuditLogRepo.createAuditLog.mockResolvedValue({} as any);

      const result = await service.transitionState({
        disputeId: 'dispute-1',
        newState: 'triage',
        newJurisdiction: 'EU',
      });

      expect(result!.jurisdiction).toBe('EU');
    });

    it('should handle assigned_user_id null when resolving terminal state', async () => {
      const existing = createMockSLARecord({
        id: 'sla-1',
        state: 'under_review',
        assigned_user_id: null,
      });

      mockSLARepo.findActiveByDisputeId.mockResolvedValue(existing);
      mockSLARepo.update.mockResolvedValue({
        ...existing,
        resolved_at: new Date(),
        state: 'resolved',
      });
      mockAuditLogRepo.createAuditLog.mockResolvedValue({} as any);

      await service.transitionState({
        disputeId: 'dispute-1',
        newState: 'resolved',
      });

      expect(mockAuditLogRepo.createAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          user_id: null,
          action: 'dispute_sla_timer_resolved',
        }),
      );
    });

    it('should handle assigned_user_id null when transitioning to non-terminal state', async () => {
      const existing = createMockSLARecord({
        id: 'sla-1',
        state: 'new',
        assigned_user_id: null,
      });

      mockSLARepo.findActiveByDisputeId.mockResolvedValue(existing);
      mockSLARepo.update.mockResolvedValue({ ...existing, resolved_at: new Date() });
      mockSLARepo.create.mockResolvedValue(
        createMockSLARecord({ id: 'sla-2', state: 'triage', assigned_user_id: null }),
      );
      mockAuditLogRepo.createAuditLog.mockResolvedValue({} as any);

      await service.transitionState({
        disputeId: 'dispute-1',
        newState: 'triage',
      });

      expect(mockAuditLogRepo.createAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          user_id: null,
          action: 'dispute_sla_timer_transitioned',
        }),
      );
    });
  });

  describe('pauseTimer', () => {
    it('should pause an active timer', async () => {
      const existing = createMockSLARecord();
      mockSLARepo.findActiveByDisputeId.mockResolvedValue(existing);
      mockSLARepo.update.mockResolvedValue({
        ...existing,
        paused_at: new Date(),
      });
      mockAuditLogRepo.createAuditLog.mockResolvedValue({} as any);

      const result = await service.pauseTimer('dispute-1');

      expect(result.paused_at).not.toBeNull();
      expect(mockSLARepo.update).toHaveBeenCalledWith('sla-1', expect.objectContaining({
        paused_at: expect.any(Date),
      }));
    });

    it('should throw if no active timer exists', async () => {
      mockSLARepo.findActiveByDisputeId.mockResolvedValue(null);

      await expect(service.pauseTimer('dispute-1')).rejects.toThrow(
        'No active SLA timer found',
      );
    });

    it('should throw if already paused', async () => {
      const existing = createMockSLARecord({ paused_at: new Date() });
      mockSLARepo.findActiveByDisputeId.mockResolvedValue(existing);

      await expect(service.pauseTimer('dispute-1')).rejects.toThrow(
        'already paused',
      );
    });

    it('should handle assigned_user_id null when pausing timer', async () => {
      const existing = createMockSLARecord({ assigned_user_id: null });
      mockSLARepo.findActiveByDisputeId.mockResolvedValue(existing);
      mockSLARepo.update.mockResolvedValue({
        ...existing,
        paused_at: new Date(),
      });
      mockAuditLogRepo.createAuditLog.mockResolvedValue({} as any);

      await service.pauseTimer('dispute-1');

      expect(mockAuditLogRepo.createAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          user_id: null,
          action: 'dispute_sla_timer_paused',
        }),
      );
    });
  });

  describe('resumeTimer', () => {
    it('should resume a paused timer and accumulate paused time', async () => {
      const pausedAt = new Date(Date.now() - 5000); // paused 5 seconds ago
      const existing = createMockSLARecord({
        paused_at: pausedAt,
        total_paused_ms: 1000,
      });

      mockSLARepo.findActiveByDisputeId.mockResolvedValue(existing);
      mockSLARepo.update.mockResolvedValue({
        ...existing,
        paused_at: null,
        total_paused_ms: existing.total_paused_ms + 5000, // roughly
      });
      mockAuditLogRepo.createAuditLog.mockResolvedValue({} as any);

      const result = await service.resumeTimer('dispute-1');

      expect(result.paused_at).toBeNull();
      expect(result.total_paused_ms).toBeGreaterThan(existing.total_paused_ms);
    });

    it('should throw if no active timer exists', async () => {
      mockSLARepo.findActiveByDisputeId.mockResolvedValue(null);

      await expect(service.resumeTimer('dispute-1')).rejects.toThrow(
        'No active SLA timer found',
      );
    });

    it('should throw if not paused', async () => {
      const existing = createMockSLARecord({ paused_at: null });
      mockSLARepo.findActiveByDisputeId.mockResolvedValue(existing);

      await expect(service.resumeTimer('dispute-1')).rejects.toThrow(
        'not paused',
      );
    });

    it('should handle assigned_user_id null when resuming timer', async () => {
      const pausedAt = new Date(Date.now() - 5000);
      const existing = createMockSLARecord({
        paused_at: pausedAt,
        assigned_user_id: null,
      });

      mockSLARepo.findActiveByDisputeId.mockResolvedValue(existing);
      mockSLARepo.update.mockResolvedValue({
        ...existing,
        paused_at: null,
      });
      mockAuditLogRepo.createAuditLog.mockResolvedValue({} as any);

      await service.resumeTimer('dispute-1');

      expect(mockAuditLogRepo.createAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          user_id: null,
          action: 'dispute_sla_timer_resumed',
        }),
      );
    });

    it('should check for escalation after resume if overdue', async () => {
      const pausedAt = new Date(Date.now() - 3600 * 1000);
      const existing = createMockSLARecord({
        paused_at: pausedAt,
        total_paused_ms: 1000,
        sla_duration_hours: 1,
        started_at: new Date(Date.now() - 5 * 3600 * 1000), // 5 hours ago
        jurisdiction: 'US',
        escalated: false,
      });

      mockSLARepo.findActiveByDisputeId.mockResolvedValue(existing);
      const resumed = {
        ...existing,
        paused_at: null,
        total_paused_ms: existing.total_paused_ms + 3600 * 1000,
      };
      // First call to update is for resume, second (if escalation fires) for escalate
      mockSLARepo.update.mockResolvedValueOnce(resumed);
      // Escalate also calls update - provide escalated result
      mockSLARepo.update.mockResolvedValueOnce({
        ...resumed,
        escalated: true,
        escalated_at: new Date(),
      });
      mockNotificationRepo.create.mockResolvedValue({} as any);
      mockAuditLogRepo.createAuditLog.mockResolvedValue({} as any);

      await service.resumeTimer('dispute-1');

      // Verify resume and escalation happened
      expect(mockSLARepo.update).toHaveBeenCalledTimes(2);
      expect(mockAuditLogRepo.createAuditLog).toHaveBeenCalled();
    });

    it('should not escalate after resume if not overdue', async () => {
      const pausedAt = new Date(Date.now() - 3600 * 1000);
      const existing = createMockSLARecord({
        paused_at: pausedAt,
        total_paused_ms: 1000,
        sla_duration_hours: 10,
        started_at: new Date(Date.now() - 2 * 3600 * 1000), // 2 hours ago
        jurisdiction: 'US',
        escalated: false,
      });

      mockSLARepo.findActiveByDisputeId.mockResolvedValue(existing);
      const resumed = {
        ...existing,
        paused_at: null,
        total_paused_ms: existing.total_paused_ms + 3600 * 1000,
      };
      mockSLARepo.update.mockResolvedValue(resumed);
      mockAuditLogRepo.createAuditLog.mockResolvedValue({} as any);

      await service.resumeTimer('dispute-1');

      // Only resume should happen, no escalation
      expect(mockSLARepo.update).toHaveBeenCalledTimes(1);
    });

    it('should not escalate after resume if already escalated', async () => {
      const pausedAt = new Date(Date.now() - 3600 * 1000);
      const existing = createMockSLARecord({
        paused_at: pausedAt,
        total_paused_ms: 1000,
        sla_duration_hours: 1,
        started_at: new Date(Date.now() - 5 * 3600 * 1000), // 5 hours ago
        jurisdiction: 'US',
        escalated: true,
      });

      mockSLARepo.findActiveByDisputeId.mockResolvedValue(existing);
      const resumed = {
        ...existing,
        paused_at: null,
        total_paused_ms: existing.total_paused_ms + 3600 * 1000,
      };
      mockSLARepo.update.mockResolvedValue(resumed);
      mockAuditLogRepo.createAuditLog.mockResolvedValue({} as any);

      await service.resumeTimer('dispute-1');

      // Only resume should happen, no escalation
      expect(mockSLARepo.update).toHaveBeenCalledTimes(1);
    });

    it('should not escalate after resume if auto-escalate disabled', async () => {
      const pausedAt = new Date(Date.now() - 3600 * 1000);
      const existing = createMockSLARecord({
        paused_at: pausedAt,
        total_paused_ms: 1000,
        sla_duration_hours: 1,
        started_at: new Date(Date.now() - 5 * 3600 * 1000), // 5 hours ago
        jurisdiction: 'US',
        escalated: false,
      });

      mockSLARepo.findActiveByDisputeId.mockResolvedValue(existing);
      const resumed = {
        ...existing,
        paused_at: null,
        total_paused_ms: existing.total_paused_ms + 3600 * 1000,
      };
      mockSLARepo.update.mockResolvedValue(resumed);
      mockAuditLogRepo.createAuditLog.mockResolvedValue({} as any);

      // Mock isAutoEscalateEnabled to return false
      const { isAutoEscalateEnabled } = require('../config/disputeSLAConfig');
      isAutoEscalateEnabled.mockReturnValue(false);

      await service.resumeTimer('dispute-1');

      // Only resume should happen, no escalation
      expect(mockSLARepo.update).toHaveBeenCalledTimes(1);
    });

    it('should not escalate after resume if state is terminal', async () => {
      const pausedAt = new Date(Date.now() - 3600 * 1000);
      const existing = createMockSLARecord({
        paused_at: pausedAt,
        total_paused_ms: 1000,
        sla_duration_hours: 1,
        started_at: new Date(Date.now() - 5 * 3600 * 1000), // 5 hours ago
        jurisdiction: 'US',
        escalated: false,
        state: 'resolved',
      });

      mockSLARepo.findActiveByDisputeId.mockResolvedValue(existing);
      const resumed = {
        ...existing,
        paused_at: null,
        total_paused_ms: existing.total_paused_ms + 3600 * 1000,
      };
      mockSLARepo.update.mockResolvedValue(resumed);
      mockAuditLogRepo.createAuditLog.mockResolvedValue({} as any);

      await service.resumeTimer('dispute-1');

      // Only resume should happen, no escalation
      expect(mockSLARepo.update).toHaveBeenCalledTimes(1);
    });

    it('should not escalate after resume if resolved_at is set', async () => {
      const pausedAt = new Date(Date.now() - 3600 * 1000);
      const existing = createMockSLARecord({
        paused_at: pausedAt,
        total_paused_ms: 1000,
        sla_duration_hours: 1,
        started_at: new Date(Date.now() - 5 * 3600 * 1000), // 5 hours ago
        jurisdiction: 'US',
        escalated: false,
        resolved_at: new Date(),
      });

      mockSLARepo.findActiveByDisputeId.mockResolvedValue(existing);
      const resumed = {
        ...existing,
        paused_at: null,
        total_paused_ms: existing.total_paused_ms + 3600 * 1000,
      };
      mockSLARepo.update.mockResolvedValue(resumed);
      mockAuditLogRepo.createAuditLog.mockResolvedValue({} as any);

      await service.resumeTimer('dispute-1');

      // Only resume should happen, no escalation
      expect(mockSLARepo.update).toHaveBeenCalledTimes(1);
    });
  });

  describe('escalate', () => {
    it('should mark record as escalated', async () => {
      const record = createMockSLARecord({ escalated: false });
      mockSLARepo.update.mockResolvedValue({
        ...record,
        escalated: true,
        escalated_at: new Date(),
      });
      mockNotificationRepo.create.mockResolvedValue({} as any);
      mockAuditLogRepo.createAuditLog.mockResolvedValue({} as any);

      const result = await service.escalate(record);

      expect(result.escalated).toBe(true);
      expect(result.escalated_at).not.toBeNull();
    });

    it('should skip escalation if already escalated', async () => {
      const record = createMockSLARecord({ escalated: true });
      const result = await service.escalate(record);

      expect(result).toBe(record);
      expect(mockSLARepo.update).not.toHaveBeenCalled();
    });

    it('should create notification for assigned user', async () => {
      const record = createMockSLARecord({ escalated: false, assigned_user_id: 'user-1' });
      mockSLARepo.update.mockResolvedValue({
        ...record,
        escalated: true,
        escalated_at: new Date(),
      });
      mockNotificationRepo.create.mockResolvedValue({} as any);
      mockAuditLogRepo.createAuditLog.mockResolvedValue({} as any);

      await service.escalate(record);

      expect(mockNotificationRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          user_id: 'user-1',
          type: 'dispute_sla_breach',
        }),
      );
    });

    it('should not create notification when notificationRepo is null', async () => {
      const serviceNoNotifs = new DisputeSLAService({
        db: mockDB,
        auditLogRepo: mockAuditLogRepo,
        logger: mockLogger as unknown as Logger,
      });

      const record = createMockSLARecord({ escalated: false, assigned_user_id: 'user-1' });
      const repo = (DisputeSLARepository as jest.Mock).mock.instances[1] as jest.Mocked<DisputeSLARepository>;
      repo.update.mockResolvedValue({
        ...record,
        escalated: true,
        escalated_at: new Date(),
      });
      mockAuditLogRepo.createAuditLog.mockResolvedValue({} as any);

      await serviceNoNotifs.escalate(record);

      expect(repo.update).toHaveBeenCalled();
    });

    it('should not create notification when assigned_user_id is null', async () => {
      const record = createMockSLARecord({ escalated: false, assigned_user_id: null });
      mockSLARepo.update.mockResolvedValue({
        ...record,
        escalated: true,
        escalated_at: new Date(),
      });
      mockAuditLogRepo.createAuditLog.mockResolvedValue({} as any);

      await service.escalate(record);

      expect(mockNotificationRepo.create).not.toHaveBeenCalled();
    });

    it('should handle notification creation failure gracefully', async () => {
      const record = createMockSLARecord({ escalated: false, assigned_user_id: 'user-1' });
      mockSLARepo.update.mockResolvedValue({
        ...record,
        escalated: true,
        escalated_at: new Date(),
      });
      mockNotificationRepo.create.mockRejectedValue(new Error('DB error'));
      mockAuditLogRepo.createAuditLog.mockResolvedValue({} as any);

      // Should not throw
      const result = await service.escalate(record);

      expect(result.escalated).toBe(true);
      expect(mockLogger.error).toHaveBeenCalled();
    });

    it('should handle audit log creation failure gracefully', async () => {
      const record = createMockSLARecord({ escalated: false, assigned_user_id: 'user-1' });
      mockSLARepo.update.mockResolvedValue({
        ...record,
        escalated: true,
        escalated_at: new Date(),
      });
      mockNotificationRepo.create.mockResolvedValue({} as any);
      mockAuditLogRepo.createAuditLog.mockRejectedValue(new Error('Audit DB error'));

      // Should not throw
      const result = await service.escalate(record);

      expect(result.escalated).toBe(true);
      expect(mockLogger.error).toHaveBeenCalled();
    });

    it('should handle when auditLogRepo is null', async () => {
      const serviceNoAudit = new DisputeSLAService({
        db: mockDB,
        notificationRepo: mockNotificationRepo,
        logger: mockLogger as unknown as Logger,
      });

      const record = createMockSLARecord({ escalated: false, assigned_user_id: 'user-1' });
      const repo = (DisputeSLARepository as jest.Mock).mock.instances[1] as jest.Mocked<DisputeSLARepository>;
      repo.update.mockResolvedValue({
        ...record,
        escalated: true,
        escalated_at: new Date(),
      });
      mockNotificationRepo.create.mockResolvedValue({} as any);

      const result = await serviceNoAudit.escalate(record);

      expect(result.escalated).toBe(true);
    });
  });

  describe('escalateOverdue', () => {
    it('should escalate overdue records with auto-escalate enabled', async () => {
      const overdue = [
        createMockSLARecord({ id: 'sla-1', jurisdiction: 'US', escalated: false }),
        createMockSLARecord({ id: 'sla-2', jurisdiction: 'EU', escalated: false }),
      ];

      mockSLARepo.findOverdueNonEscalated.mockResolvedValue(overdue);
      mockSLARepo.update.mockResolvedValue({ ...overdue[0], escalated: true, escalated_at: new Date() });
      mockNotificationRepo.create.mockResolvedValue({} as any);
      mockAuditLogRepo.createAuditLog.mockResolvedValue({} as any);

      const result = await service.escalateOverdue();

      expect(result).toHaveLength(2);
      expect(mockSLARepo.update).toHaveBeenCalledTimes(2);
    });

    it('should skip default jurisdiction (auto-escalate disabled)', async () => {
      const overdue = [
        createMockSLARecord({ id: 'sla-1', jurisdiction: 'default', escalated: false, paused_at: null, resolved_at: null }),
      ];

      mockSLARepo.findOverdueNonEscalated.mockResolvedValue(overdue);
      mockAuditLogRepo.createAuditLog.mockResolvedValue({} as any);

      // Mock isAutoEscalateEnabled to return false for default
      const { isAutoEscalateEnabled } = require('../config/disputeSLAConfig');
      isAutoEscalateEnabled.mockImplementation((juris: string) => juris !== 'default');

      const result = await service.escalateOverdue();

      expect(result).toHaveLength(0);
      expect(mockSLARepo.update).not.toHaveBeenCalled();
    });

    it('should handle empty overdue list', async () => {
      mockSLARepo.findOverdueNonEscalated.mockResolvedValue([]);

      const result = await service.escalateOverdue();
      expect(result).toHaveLength(0);
    });
  });

  describe('calculateElapsedMs', () => {
    it('should calculate elapsed time excluding paused time', () => {
      const record = createMockSLARecord({
        started_at: new Date(Date.now() - 10000), // 10 seconds ago
        total_paused_ms: 3000, // 3 seconds paused
        paused_at: null,
      });

      const elapsed = service.calculateElapsedMs(record);
      expect(elapsed).toBeGreaterThanOrEqual(6000);
      expect(elapsed).toBeLessThan(8000);
    });

    it('should use paused_at time if timer is paused', () => {
      const record = createMockSLARecord({
        started_at: new Date(Date.now() - 20000), // 20 seconds ago
        paused_at: new Date(Date.now() - 10000), // paused 10 seconds ago
        total_paused_ms: 0,
      });

      const elapsed = service.calculateElapsedMs(record);
      expect(elapsed).toBeGreaterThanOrEqual(9000);
      expect(elapsed).toBeLessThan(11000);
    });

    it('should use resolved_at time if timer is resolved', () => {
      const resolvedAt = new Date(Date.now() - 5000);
      const record = createMockSLARecord({
        started_at: new Date(Date.now() - 20000), // 20 seconds ago
        paused_at: null,
        resolved_at: resolvedAt,
        total_paused_ms: 0,
      });

      const elapsed = service.calculateElapsedMs(record);
      expect(elapsed).toBeGreaterThanOrEqual(14000);
      expect(elapsed).toBeLessThan(16000);
    });

    it('should return 0 for just-started timer', () => {
      const record = createMockSLARecord({
        started_at: new Date(),
        paused_at: null,
      });

      const elapsed = service.calculateElapsedMs(record);
      expect(elapsed).toBeLessThan(1000);
    });

    it('should handle paused_at when both paused and resolved', async () => {
      const pausedAt = new Date(Date.now() - 10000);
      const record = createMockSLARecord({
        started_at: new Date(Date.now() - 20000),
        paused_at: pausedAt,
        total_paused_ms: 0,
      });

      const elapsed = service.calculateElapsedMs(record);
      expect(elapsed).toBeGreaterThanOrEqual(9000);
      expect(elapsed).toBeLessThan(11000);
    });
  });

  describe('generateBurnReport', () => {
    it('should return burn report rows', async () => {
      const mockRows = [
        createMockSLABurnRow(),
        createMockSLABurnRow({ dispute_id: 'dispute-2', jurisdiction: 'EU' }),
      ];
      mockSLARepo.getSLABurnReport.mockResolvedValue(mockRows);

      const result = await service.generateBurnReport({
        startDate: new Date('2025-01-01'),
        endDate: new Date('2025-01-07'),
      });

      expect(result).toHaveLength(2);
      expect(mockSLARepo.getSLABurnReport).toHaveBeenCalledWith(
        expect.any(Date),
        expect.any(Date),
        undefined,
      );
    });

    it('should filter by jurisdiction', async () => {
      mockSLARepo.getSLABurnReport.mockResolvedValue([]);

      await service.generateBurnReport({
        startDate: new Date('2025-01-01'),
        endDate: new Date('2025-01-07'),
        jurisdiction: 'US',
      });

      expect(mockSLARepo.getSLABurnReport).toHaveBeenCalledWith(
        expect.any(Date),
        expect.any(Date),
        'US',
      );
    });
  });

  describe('exportBurnReportCSV', () => {
    it('should export CSV with headers and data rows', async () => {
      const mockRows = [createMockSLABurnRow()];
      mockSLARepo.getSLABurnReport.mockResolvedValue(mockRows);

      const result = await service.exportBurnReportCSV({
        startDate: new Date('2025-01-01'),
        endDate: new Date('2025-01-07'),
      });

      expect(result.csv).toContain('Dispute ID');
      expect(result.csv).toContain('Jurisdiction');
      expect(result.csv).toContain('State');
      expect(result.csv).toContain('dispute-1');
      expect(result.csv).toContain('US');
      expect(result.filename).toMatch(/sla-burn-report-.*\.csv/);
      expect(result.rowCount).toBe(1);
    });

    it('should export empty CSV when no rows', async () => {
      mockSLARepo.getSLABurnReport.mockResolvedValue([]);

      const result = await service.exportBurnReportCSV({
        startDate: new Date('2025-01-01'),
        endDate: new Date('2025-01-07'),
      });

      expect(result.rowCount).toBe(0);
      // Should still have headers
      expect(result.csv).toContain('Dispute ID');
    });

    it('should include HMAC signature in CSV', async () => {
      const mockRows = [createMockSLABurnRow()];
      mockSLARepo.getSLABurnReport.mockResolvedValue(mockRows);

      const result = await service.exportBurnReportCSV({
        startDate: new Date('2025-01-01'),
        endDate: new Date('2025-01-07'),
      });

      expect(result.csv).toContain('# HMAC-SHA256:');
    });

    it('should handle rows with null resolved_at', async () => {
      const mockRows = [createMockSLABurnRow({ resolved_at: null })];
      mockSLARepo.getSLABurnReport.mockResolvedValue(mockRows);

      const result = await service.exportBurnReportCSV({
        startDate: new Date('2025-01-01'),
        endDate: new Date('2025-01-07'),
      });

      expect(result.csv).toContain('dispute-1');
      expect(result.rowCount).toBe(1);
    });

    it('should handle rows with null assigned_user_id', async () => {
      const mockRows = [createMockSLABurnRow({ assigned_user_id: null })];
      mockSLARepo.getSLABurnReport.mockResolvedValue(mockRows);

      const result = await service.exportBurnReportCSV({
        startDate: new Date('2025-01-01'),
        endDate: new Date('2025-01-07'),
      });

      expect(result.csv).toContain('dispute-1');
      expect(result.rowCount).toBe(1);
    });

    it('should handle rows with non-null resolved_at', async () => {
      const mockRows = [createMockSLABurnRow({ resolved_at: new Date('2025-01-05T12:00:00Z') })];
      mockSLARepo.getSLABurnReport.mockResolvedValue(mockRows);

      const result = await service.exportBurnReportCSV({
        startDate: new Date('2025-01-01'),
        endDate: new Date('2025-01-07'),
      });

      expect(result.csv).toContain('2025-01-05T12:00:00.000Z');
      expect(result.rowCount).toBe(1);
    });

    it('should use SLA_REPORT_SIGNING_SECRET env var when set', async () => {
      const originalSecret = process.env.SLA_REPORT_SIGNING_SECRET;
      process.env.SLA_REPORT_SIGNING_SECRET = 'custom-secret-key';
      try {
        const mockRows = [createMockSLABurnRow()];
        mockSLARepo.getSLABurnReport.mockResolvedValue(mockRows);

        const result = await service.exportBurnReportCSV({
          startDate: new Date('2025-01-01'),
          endDate: new Date('2025-01-07'),
        });

        expect(result.csv).toContain('# HMAC-SHA256:');
      } finally {
        if (originalSecret === undefined) {
          delete process.env.SLA_REPORT_SIGNING_SECRET;
        } else {
          process.env.SLA_REPORT_SIGNING_SECRET = originalSecret;
        }
      }
    });
  });
});

describe('sanitizeCSVCell', () => {
  it('should wrap values in double quotes', () => {
    expect(sanitizeCSVCell('hello')).toBe('"hello"');
  });

  it('should escape double quotes', () => {
    expect(sanitizeCSVCell('say "hello"')).toBe('"say ""hello"""');
  });

  it('should prefix cells starting with =', () => {
    expect(sanitizeCSVCell('=SUM(A1:A10)')).toBe(`"'=SUM(A1:A10)"`);
  });

  it('should prefix cells starting with +', () => {
    expect(sanitizeCSVCell('+12345')).toBe(`"'+12345"`);
  });

  it('should prefix cells starting with -', () => {
    expect(sanitizeCSVCell('-12345')).toBe(`"'-12345"`);
  });

  it('should prefix cells starting with @', () => {
    expect(sanitizeCSVCell('@SUM')).toBe(`"'@SUM"`);
  });

  it('should return empty string for empty input', () => {
    expect(sanitizeCSVCell('')).toBe('');
  });

  it('should return empty string for undefined input', () => {
    expect(sanitizeCSVCell(undefined as any)).toBe('');
  });
});
