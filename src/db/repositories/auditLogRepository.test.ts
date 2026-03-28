import { Pool, QueryResult } from 'pg';
import {
  AuditLogRepository,
  AuditLog,
  CreateAuditLogInput,
} from './auditLogRepository';

describe('AuditLogRepository', () => {
  let repository: AuditLogRepository;
  let mockPool: { query: jest.Mock };

  beforeEach(() => {
    // Mock Pool
    mockPool = {
      query: jest.fn(),
    } as any;

    repository = new AuditLogRepository(mockPool as unknown as Pool);
  });

  describe('createAuditLog', () => {
    it('should create an audit log entry', async () => {
      const input: CreateAuditLogInput = {
        user_id: 'user-123',
        action: 'login',
        resource: 'auth',
        details: 'User logged in',
        ip_address: '192.168.1.1',
        user_agent: 'Mozilla/5.0',
      };

      const mockResult: QueryResult<AuditLog> = {
        rows: [
          {
            id: 'audit-123',
            user_id: 'user-123',
            action: 'login',
            resource: 'auth',
            details: 'User logged in',
            ip_address: '192.168.1.1',
            user_agent: 'Mozilla/5.0',
            created_at: new Date(),
          },
        ],
        rowCount: 1,
        command: 'INSERT',
        oid: 0,
        fields: [],
      };

      mockPool.query.mockResolvedValueOnce(mockResult);

      const result = await repository.createAuditLog(input);

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO audit_logs'),
        [
          'user-123',
          'login',
          'auth',
          'User logged in',
          '192.168.1.1',
          'Mozilla/5.0',
        ]
      );
      expect(result).toEqual({
        id: 'audit-123',
        user_id: 'user-123',
        action: 'login',
        resource: 'auth',
        details: 'User logged in',
        ip_address: '192.168.1.1',
        user_agent: 'Mozilla/5.0',
        created_at: expect.any(Date),
      });
    });

    it('should create an audit log entry without optional fields', async () => {
      const input: CreateAuditLogInput = {
        action: 'create_offering',
      };

      const mockResult: QueryResult<AuditLog> = {
        rows: [
          {
            id: 'audit-124',
            user_id: null,
            action: 'create_offering',
            resource: null,
            details: null,
            ip_address: null,
            user_agent: null,
            created_at: new Date(),
          },
        ],
        rowCount: 1,
        command: 'INSERT',
        oid: 0,
        fields: [],
      };

      mockPool.query.mockResolvedValueOnce(mockResult);

      const result = await repository.createAuditLog(input);

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO audit_logs'),
        [undefined, 'create_offering', undefined, undefined, undefined, undefined]
      );
      expect(result.action).toBe('create_offering');
    });
  });

  describe('getAuditLogsByUser', () => {
    it('should get audit logs by user', async () => {
      const userId = 'user-123';
      const mockResult: QueryResult<AuditLog> = {
        rows: [
          {
            id: 'audit-123',
            user_id: 'user-123',
            action: 'login',
            resource: 'auth',
            details: 'User logged in',
            ip_address: '192.168.1.1',
            user_agent: 'Mozilla/5.0',
            created_at: new Date(),
          },
        ],
        rowCount: 1,
        command: 'SELECT',
        oid: 0,
        fields: [],
      };

      mockPool.query.mockResolvedValueOnce(mockResult);

      const result = await repository.getAuditLogsByUser(userId);

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringMatching(/SELECT\s*\*\s*FROM\s+audit_logs[\s\S]*WHERE\s+user_id\s*=\s*\$1[\s\S]*ORDER\s+BY\s+created_at\s+DESC[\s\S]*LIMIT\s+\$2/),
        [userId, 50]
      );
      expect(result).toHaveLength(1);
      expect(result[0].user_id).toBe(userId);
    });
  });

  describe('getAuditLogsByAction', () => {
    it('should get audit logs by action', async () => {
      const action = 'invest';
      const mockResult: QueryResult<AuditLog> = {
        rows: [
          {
            id: 'audit-125',
            user_id: 'user-456',
            action: 'invest',
            resource: 'offering-123',
            details: 'Invested 1000',
            ip_address: '192.168.1.2',
            user_agent: 'Mozilla/5.0',
            created_at: new Date(),
          },
        ],
        rowCount: 1,
        command: 'SELECT',
        oid: 0,
        fields: [],
      };

      mockPool.query.mockResolvedValueOnce(mockResult);

      const result = await repository.getAuditLogsByAction(action);

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringMatching(/SELECT\s*\*\s*FROM\s+audit_logs[\s\S]*WHERE\s+action\s*=\s*\$1[\s\S]*ORDER\s+BY\s+created_at\s+DESC[\s\S]*LIMIT\s+\$2/),
        [action, 50]
      );
      expect(result).toHaveLength(1);
      expect(result[0].action).toBe(action);
    });
  });
});