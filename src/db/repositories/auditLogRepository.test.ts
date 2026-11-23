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

  /**
   * Regression coverage for the explicit empty-result guard in
   * `createAuditLog` (auditLogRepository.ts:71-73).
   *
   * `INSERT ... RETURNING *` should always yield one row, so an empty
   * `rows` array means the driver returned no row. The repository must
   * surface that as a thrown Error rather than resolving with
   * `undefined`, which would otherwise propagate a falsy audit record to
   * callers that treat creation as durable.
   */
  describe('createAuditLog failure handling', () => {
    const input: CreateAuditLogInput = {
      user_id: 'user-123',
      action: 'login',
      resource: 'auth',
      details: 'User logged in',
      ip_address: '192.168.1.1',
      user_agent: 'Mozilla/5.0',
    };

    /** Builds a minimal pg QueryResult stub with a caller-controlled rows array. */
    const queryResult = (
      rows: unknown[],
      overrides: Partial<QueryResult<AuditLog>> = {}
    ): QueryResult<AuditLog> =>
      ({
        rows,
        rowCount: rows.length,
        command: 'INSERT',
        oid: 0,
        fields: [],
        ...overrides,
      }) as QueryResult<AuditLog>;

    it('should throw "Failed to create audit log" when RETURNING yields no rows', async () => {
      // rowCount: 0 with a non-null rows array is the exact shape that trips
      // the guard: result.rows.length === 0 is true even though no driver
      // error was raised.
      mockPool.query.mockResolvedValueOnce(queryResult([]));

      await expect(repository.createAuditLog(input)).rejects.toThrow(
        new Error('Failed to create audit log')
      );
    });

    it('should throw a plain Error whose message is exactly the documented string', async () => {
      mockPool.query.mockResolvedValueOnce(queryResult([]));

      const error = await repository
        .createAuditLog(input)
        .then(
          () => null,
          (e: unknown) => e
        );

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).constructor).toBe(Error);
      expect((error as Error).message).toBe('Failed to create audit log');
    });

    it('should not resolve with undefined or a partial record on the empty-result path', async () => {
      mockPool.query.mockResolvedValueOnce(queryResult([]));

      // Guards against a future refactor changing the guard from `throw` to an
      // early `return` / `return null`, which would let audit writes silently
      // appear to succeed.
      const settled = await repository
        .createAuditLog(input)
        .then(
          (value) => ({ state: 'resolved' as const, value }),
          (error: unknown) => ({ state: 'rejected' as const, error })
        );

      expect(settled.state).toBe('rejected');
      expect(settled).not.toHaveProperty('value');
    });

    it('should still reject when rows is empty even if rowCount is non-zero', async () => {
      // Boundary: the guard keys off `rows.length`, not `rowCount`. A driver
      // that reports a positive rowCount with no returned rows must not be
      // allowed to yield a phantom audit log.
      mockPool.query.mockResolvedValueOnce(queryResult([], { rowCount: 1 }));

      await expect(repository.createAuditLog(input)).rejects.toThrow(
        'Failed to create audit log'
      );
    });

    it('should propagate the original database error without masking it', async () => {
      // Failure path: driver/constraint errors must reach the caller with
      // their identity intact so callers can distinguish a real DB fault
      // (e.g. unique violation) from the empty-result guard.
      const dbError = Object.assign(new Error('duplicate key value violates unique constraint'), {
        code: '23505',
      });
      mockPool.query.mockRejectedValueOnce(dbError);

      const thrown = await repository
        .createAuditLog(input)
        .then(
          () => null,
          (e: unknown) => e
        );

      expect(thrown).toBe(dbError);
      expect((thrown as { code?: string }).code).toBe('23505');
      expect((thrown as Error).message).not.toBe('Failed to create audit log');
    });

    it('should issue exactly one query on the failure path', async () => {
      // No retry/compensation loop: a single attempt keeps the failure
      // observable instead of duplicating audit rows.
      mockPool.query.mockResolvedValueOnce(queryResult([]));

      await expect(repository.createAuditLog(input)).rejects.toThrow();
      expect(mockPool.query).toHaveBeenCalledTimes(1);
    });

    it('should return the first row when RETURNING yields multiple rows', async () => {
      // Boundary: rows.length > 1 must resolve using rows[0] only, and must
      // not throw the empty-result error.
      const first = {
        id: 'audit-first',
        user_id: 'user-123',
        action: 'login',
        resource: 'auth',
        details: 'User logged in',
        ip_address: '192.168.1.1',
        user_agent: 'Mozilla/5.0',
        created_at: new Date('2026-01-01T00:00:00.000Z'),
      };
      const second = { ...first, id: 'audit-second' };

      mockPool.query.mockResolvedValueOnce(queryResult([first, second]));

      const result = await repository.createAuditLog(input);

      expect(result.id).toBe('audit-first');
    });

    it('should resolve when rowCount is 0 but a row was actually returned', async () => {
      // Boundary: the guard reads `rows`, so a rowCount inconsistency must not
      // turn a successful insert into a thrown error.
      const row = {
        id: 'audit-1',
        user_id: null,
        action: 'login',
        resource: null,
        details: null,
        ip_address: null,
        user_agent: null,
        created_at: new Date('2026-01-01T00:00:00.000Z'),
      };
      mockPool.query.mockResolvedValueOnce(queryResult([row], { rowCount: 0 }));

      const result = await repository.createAuditLog(input);

      expect(result.id).toBe('audit-1');
    });

    it('should map explicit null optional fields through mapAuditLog', async () => {
      const row = {
        id: 'audit-null',
        user_id: null,
        action: 'create_offering',
        resource: null,
        details: null,
        ip_address: null,
        user_agent: null,
        created_at: new Date('2026-01-01T00:00:00.000Z'),
      };
      mockPool.query.mockResolvedValueOnce(queryResult([row]));

      const result = await repository.createAuditLog({
        action: 'create_offering',
      });

      expect(result).toEqual({
        id: 'audit-null',
        user_id: null,
        action: 'create_offering',
        resource: null,
        details: null,
        ip_address: null,
        user_agent: null,
        created_at: new Date('2026-01-01T00:00:00.000Z'),
        prev_hash: undefined,
        row_hash: undefined,
      });
    });

    it('should preserve tamper-evident chain hashes on the success path', async () => {
      // prev_hash is the genesis marker for the first row in the chain; both
      // fields are optional and must survive mapping unmodified.
      const row = {
        id: 'audit-chain',
        user_id: 'user-123',
        action: 'login',
        resource: 'auth',
        details: null,
        ip_address: null,
        user_agent: null,
        created_at: new Date('2026-01-01T00:00:00.000Z'),
        prev_hash: 'GENESIS',
        row_hash: 'a'.repeat(64),
      };
      mockPool.query.mockResolvedValueOnce(queryResult([row]));

      const result = await repository.createAuditLog(input);

      expect(result.prev_hash).toBe('GENESIS');
      expect(result.row_hash).toBe('a'.repeat(64));
    });

    it('should use a server-side NOW() timestamp rather than a client-supplied one', async () => {
      // Boundary: created_at is assigned by the database so a caller cannot
      // backdate an audit record.
      const row = {
        id: 'audit-ts',
        user_id: 'user-123',
        action: 'login',
        resource: null,
        details: null,
        ip_address: null,
        user_agent: null,
        created_at: new Date('2026-02-02T03:04:05.000Z'),
      };
      mockPool.query.mockResolvedValueOnce(queryResult([row]));

      await repository.createAuditLog(input);

      const [query, values] = mockPool.query.mock.calls[0];
      expect(query).toMatch(/VALUES\s*\(\s*\$1,\s*\$2,\s*\$3,\s*\$4,\s*\$5,\s*\$6,\s*NOW\(\)\s*\)/);
      // Six bind params only: no created_at is passed through from the caller.
      expect(values).toHaveLength(6);
      expect(values).not.toContain(expect.any(Date));
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