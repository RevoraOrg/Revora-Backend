import { Pool, PoolClient, QueryResult } from 'pg';
import {
  withTransaction,
  transactional,
  TransactionError,
} from './transaction';

describe('Repository Transaction Boundaries', () => {
  let mockPool: jest.Mocked<Pool>;
  let mockClient: {
    query: jest.Mock<Promise<QueryResult<any>>, any[]>;
    release: jest.Mock<void, []>;
  };

  beforeEach(() => {
    // Create mock client with explicit types to avoid 'never' inference
    mockClient = {
      query: jest.fn<Promise<QueryResult<any>>, any[]>(),
      release: jest.fn<void, []>(),
    };

    // Create mock pool
    mockPool = {
      connect: jest.fn<Promise<any>, []>().mockResolvedValue(mockClient),
      query: jest.fn<Promise<any>, any[]>(),
    } as unknown as jest.Mocked<Pool>;

    jest.clearAllMocks();
  });

  const createMockQueryResult = (rows: any[] = []): QueryResult<any> => ({
    rows,
    command: '',
    oid: 0,
    fields: [],
    rowCount: rows.length,
  });

  describe('Successful Transaction Commit', () => {
    it('should commit transaction on successful execution', async () => {
      mockClient.query.mockResolvedValue(createMockQueryResult());

      const result = await withTransaction(mockPool, async (client) => {
        await client.query('INSERT INTO users (email) VALUES ($1)', ['test@example.com']);
        return { success: true };
      });

      expect(result).toEqual({ success: true });
      expect(mockPool.connect).toHaveBeenCalledTimes(1);
      expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
      expect(mockClient.query).toHaveBeenCalledWith('INSERT INTO users (email) VALUES ($1)', ['test@example.com']);
      expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
      expect(mockClient.release).toHaveBeenCalledTimes(1);
    });

    it('should execute multiple operations atomically', async () => {
      mockClient.query.mockResolvedValue(createMockQueryResult());

      await withTransaction(mockPool, async (client) => {
        await client.query('INSERT INTO users (email) VALUES ($1)', ['user1@example.com']);
        await client.query('INSERT INTO users (email) VALUES ($1)', ['user2@example.com']);
        await client.query('INSERT INTO users (email) VALUES ($1)', ['user3@example.com']);
      });

      expect(mockClient.query).toHaveBeenCalledTimes(5); // BEGIN + 3 inserts + COMMIT
      expect(mockClient.query).toHaveBeenNthCalledWith(1, 'BEGIN');
      expect(mockClient.query).toHaveBeenNthCalledWith(5, 'COMMIT');
    });

    it('should return callback result', async () => {
      mockClient.query.mockResolvedValue({ 
        rows: [{ id: '123', email: 'test@example.com' }], 
        command: 'INSERT', 
        oid: 0, 
        fields: [] as any[], 
        rowCount: 1 
      });

      const result = await withTransaction(mockPool, async (client) => {
        const res = await client.query('INSERT INTO users (email) VALUES ($1) RETURNING *', ['test@example.com']);
        return res.rows[0];
      });

      expect(result).toEqual({ id: '123', email: 'test@example.com' });
    });

    it('should call afterCommit callback after a successful commit', async () => {
      mockClient.query.mockResolvedValue({ rows: [], command: '', oid: 0, fields: [], rowCount: 0 });
      const afterCommit = jest.fn().mockResolvedValue(undefined);

      const result = await withTransaction(mockPool, async (client) => {
        await client.query('INSERT INTO users (email) VALUES ($1)', ['test@example.com']);
        return { success: true };
      }, { afterCommit });

      expect(result).toEqual({ success: true });
      expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
      expect(afterCommit).toHaveBeenCalledWith({ success: true });
      expect(mockClient.release).toHaveBeenCalledTimes(1);
    });

    it('should propagate afterCommit failure after commit', async () => {
      mockClient.query.mockResolvedValue({ rows: [], command: '', oid: 0, fields: [], rowCount: 0 });
      const afterCommitError = new Error('External system call failed');
      const afterCommit = jest.fn().mockRejectedValue(afterCommitError);

      await expect(
        withTransaction(mockPool, async (client) => {
          await client.query('INSERT INTO users (email) VALUES ($1)', ['test@example.com']);
          return { success: true };
        }, { afterCommit })
      ).rejects.toThrow('Transaction committed but post-commit action failed');

      expect(afterCommit).toHaveBeenCalledWith({ success: true });
      expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
      expect(mockClient.release).toHaveBeenCalledTimes(1);
    });
  });

  describe('Transaction Rollback on Error', () => {
    it('should rollback transaction on error', async () => {
      mockClient.query
        .mockResolvedValueOnce(createMockQueryResult()) // BEGIN
        .mockResolvedValueOnce(createMockQueryResult()) // First insert
        .mockRejectedValueOnce(new Error('Unique constraint violation')) // Second insert fails
        .mockResolvedValueOnce(createMockQueryResult()); // ROLLBACK

      await expect(
        withTransaction(mockPool, async (client) => {
          await client.query('INSERT INTO users (email) VALUES ($1)', ['user1@example.com']);
          await client.query('INSERT INTO users (email) VALUES ($1)', ['user1@example.com']); // Duplicate
        })
      ).rejects.toThrow(TransactionError);

      expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
      expect(mockClient.release).toHaveBeenCalledTimes(1);
    });

    it('should prevent partial writes on failure', async () => {
      mockClient.query
        .mockResolvedValueOnce(createMockQueryResult()) // BEGIN
        .mockResolvedValueOnce(createMockQueryResult()) // First insert succeeds
        .mockResolvedValueOnce(createMockQueryResult()) // Second insert succeeds
        .mockRejectedValueOnce(new Error('Foreign key violation')) // Third insert fails
        .mockResolvedValueOnce(createMockQueryResult()); // ROLLBACK

      await expect(
        withTransaction(mockPool, async (client) => {
          await client.query('INSERT INTO users (email) VALUES ($1)', ['user1@example.com']);
          await client.query('INSERT INTO profiles (user_id) VALUES ($1)', ['user-id-1']);
          await client.query('INSERT INTO orders (user_id) VALUES ($1)', ['invalid-user-id']);
        })
      ).rejects.toThrow(TransactionError);

      // Verify rollback was called
      expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
      
      // Verify all operations were attempted but none committed
      expect(mockClient.query).not.toHaveBeenCalledWith('COMMIT');
    });

    it('should include rollback status in error', async () => {
      mockClient.query
        .mockResolvedValueOnce(createMockQueryResult()) // BEGIN
        .mockRejectedValueOnce(new Error('Query failed'))
        .mockResolvedValueOnce(createMockQueryResult()); // ROLLBACK

      try {
        await withTransaction(mockPool, async (client) => {
          await client.query('INVALID SQL');
        });
        fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(TransactionError);
        expect((error as TransactionError).rollbackSucceeded).toBe(true);
      }
    });

    it('should handle rollback failure gracefully', async () => {
      mockClient.query
        .mockResolvedValueOnce(createMockQueryResult()) // BEGIN
        .mockRejectedValueOnce(new Error('Query failed'))
        .mockRejectedValueOnce(new Error('Rollback failed')); // ROLLBACK fails

      const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation();

      try {
        await withTransaction(mockPool, async (client) => {
          await client.query('INVALID SQL');
        });
        fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(TransactionError);
        expect((error as TransactionError).rollbackSucceeded).toBe(false);
        expect(consoleErrorSpy).toHaveBeenCalledWith(
          expect.stringContaining('Rollback failed')
        );
      }

      stderrSpy.mockRestore();
    });
  });

  describe('Connection Pool Management', () => {
    it('should release connection after successful commit', async () => {
      mockClient.query.mockResolvedValue(createMockQueryResult());

      await withTransaction(mockPool, async (client) => {
        await client.query('SELECT 1');
      });

      expect(mockClient.release).toHaveBeenCalledTimes(1);
    });

    it('should release connection after rollback', async () => {
      mockClient.query
        .mockResolvedValueOnce(createMockQueryResult()) // BEGIN
        .mockRejectedValueOnce(new Error('Query failed'))
        .mockResolvedValueOnce(createMockQueryResult()); // ROLLBACK

      await expect(
        withTransaction(mockPool, async (client) => {
          await client.query('INVALID SQL');
        })
      ).rejects.toThrow();

      expect(mockClient.release).toHaveBeenCalledTimes(1);
    });

    it('should release connection even if rollback fails', async () => {
      mockClient.query
        .mockResolvedValueOnce(createMockQueryResult()) // BEGIN
        .mockRejectedValueOnce(new Error('Query failed'))
        .mockRejectedValueOnce(new Error('Rollback failed'));

      jest.spyOn(console, 'error').mockImplementation();

      await expect(
        withTransaction(mockPool, async (client) => {
          await client.query('INVALID SQL');
        })
      ).rejects.toThrow();

      expect(mockClient.release).toHaveBeenCalledTimes(1);
    });

    it('should not leak connections on callback exception', async () => {
      mockClient.query
        .mockResolvedValueOnce(createMockQueryResult()) // BEGIN
        .mockResolvedValueOnce(createMockQueryResult()); // ROLLBACK

      await expect(
        withTransaction(mockPool, async () => {
          throw new Error('Callback exception');
        })
      ).rejects.toThrow();

      expect(mockClient.release).toHaveBeenCalledTimes(1);
    });
  });

  describe('Nested Transaction Behavior', () => {
    it('should create independent transactions for nested calls', async () => {
      const mockClient2 = {
        query: jest.fn<Promise<QueryResult<any>>, any[]>().mockResolvedValue(createMockQueryResult()),
        release: jest.fn<void, []>(),
      };

      mockClient.query.mockResolvedValue(createMockQueryResult());
      (mockPool.connect as jest.Mock)
        .mockResolvedValueOnce(mockClient)
        .mockResolvedValueOnce(mockClient2);

      await withTransaction(mockPool, async (client) => {
        await client.query('INSERT INTO users (email) VALUES ($1)', ['outer@example.com']);
        
        // Nested call creates a separate transaction
        await withTransaction(mockPool, async (nestedClient) => {
          await nestedClient.query('INSERT INTO profiles (user_id) VALUES ($1)', ['user-id']);
        });
        
        await client.query('INSERT INTO orders (user_id) VALUES ($1)', ['user-id']);
      });

      // Both transactions should have BEGIN and COMMIT
      expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
      expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
      expect(mockClient2.query).toHaveBeenCalledWith('BEGIN');
      expect(mockClient2.query).toHaveBeenCalledWith('COMMIT');
    });

    it('should rollback nested transaction independently', async () => {
      const mockClient2 = {
        query: jest.fn<Promise<QueryResult<any>>, any[]>()
          .mockResolvedValueOnce(createMockQueryResult()) // BEGIN
          .mockRejectedValueOnce(new Error('Nested query failed'))
          .mockResolvedValueOnce(createMockQueryResult()), // ROLLBACK
        release: jest.fn<void, []>(),
      };

      mockClient.query.mockResolvedValue(createMockQueryResult());
      (mockPool.connect as jest.Mock)
        .mockResolvedValueOnce(mockClient)
        .mockResolvedValueOnce(mockClient2);

      try {
        await withTransaction(mockPool, async (client) => {
          await client.query('INSERT INTO users (email) VALUES ($1)', ['outer@example.com']);
          
          await withTransaction(mockPool, async (nestedClient) => {
            await nestedClient.query('INVALID SQL');
          });
        });
        fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(TransactionError);
      }

      // Nested transaction should have rolled back
      expect(mockClient2.query).toHaveBeenCalledWith('ROLLBACK');
    });
  });

  describe('Input Validation', () => {
    it('should reject null pool', async () => {
      await expect(
        withTransaction(null as any, async () => {})
      ).rejects.toThrow(TransactionError);
      await expect(
        withTransaction(null as any, async () => {})
      ).rejects.toThrow('Pool is required');
    });

    it('should reject undefined pool', async () => {
      await expect(
        withTransaction(undefined as any, async () => {})
      ).rejects.toThrow(TransactionError);
    });

    it('should reject non-function callback', async () => {
      await expect(
        withTransaction(mockPool, 'not a function' as any)
      ).rejects.toThrow('Callback must be a function');
    });

    it('should reject null callback', async () => {
      await expect(
        withTransaction(mockPool, null as any)
      ).rejects.toThrow('Callback must be a function');
    });
  });

  describe('Transaction Options', () => {
    it('should support custom isolation level', async () => {
      mockClient.query.mockResolvedValue(createMockQueryResult());

      await withTransaction(
        mockPool,
        async (client) => {
          await client.query('SELECT 1');
        },
        { isolationLevel: 'SERIALIZABLE' }
      );

      expect(mockClient.query).toHaveBeenCalledWith('BEGIN ISOLATION LEVEL SERIALIZABLE');
    });

    it('should support read-only transactions', async () => {
      mockClient.query.mockResolvedValue(createMockQueryResult());

      await withTransaction(
        mockPool,
        async (client) => {
          await client.query('SELECT * FROM users');
        },
        { readOnly: true }
      );

      expect(mockClient.query).toHaveBeenCalledWith('BEGIN READ ONLY');
    });

    it('should support combined isolation level and read-only', async () => {
      mockClient.query.mockResolvedValue(createMockQueryResult());

      await withTransaction(
        mockPool,
        async (client) => {
          await client.query('SELECT * FROM users');
        },
        { isolationLevel: 'REPEATABLE READ', readOnly: true }
      );

      expect(mockClient.query).toHaveBeenCalledWith('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    });

    it('should use default READ COMMITTED isolation level', async () => {
      mockClient.query.mockResolvedValue(createMockQueryResult());

      await withTransaction(mockPool, async (client) => {
        await client.query('SELECT 1');
      });

      expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
    });
  });

  describe('Concurrent Transaction Handling', () => {
    it('should handle serialization failures', async () => {
      const serializationError = new Error('could not serialize access');
      (serializationError as any).code = '40001';

      mockClient.query
        .mockResolvedValueOnce(createMockQueryResult()) // BEGIN
        .mockRejectedValueOnce(serializationError)
        .mockResolvedValueOnce(createMockQueryResult()); // ROLLBACK

      await expect(
        withTransaction(mockPool, async (client) => {
          await client.query('UPDATE accounts SET balance = balance - 100 WHERE id = $1', ['acc-1']);
        }, { isolationLevel: 'SERIALIZABLE' })
      ).rejects.toThrow(TransactionError);

      expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
    });

    it('should handle deadlock detection', async () => {
      const deadlockError = new Error('deadlock detected');
      (deadlockError as any).code = '40P01';

      mockClient.query
        .mockResolvedValueOnce(createMockQueryResult()) // BEGIN
        .mockRejectedValueOnce(deadlockError)
        .mockResolvedValueOnce(createMockQueryResult()); // ROLLBACK

      await expect(
        withTransaction(mockPool, async (client) => {
          await client.query('UPDATE table1 SET value = 1');
          await client.query('UPDATE table2 SET value = 2');
        })
      ).rejects.toThrow(TransactionError);

      expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
    });
  });

  describe('Error Message Sanitization', () => {
    it('should sanitize connection strings in error messages', async () => {
      const error = new Error('Connection failed: postgresql://user:password@localhost:5432/db');
      
      mockClient.query
        .mockResolvedValueOnce(createMockQueryResult()) // BEGIN
        .mockRejectedValueOnce(error)
        .mockResolvedValueOnce(createMockQueryResult()); // ROLLBACK

      try {
        await withTransaction(mockPool, async (client) => {
          await client.query('SELECT 1');
        });
        fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(TransactionError);
        expect((err as TransactionError).message).toContain('postgresql://[REDACTED]');
        expect((err as TransactionError).message).not.toContain('password');
      }
    });

    it('should sanitize password patterns in error messages', async () => {
      const error = new Error('Auth failed: password=secret123');
      
      mockClient.query
        .mockResolvedValueOnce(createMockQueryResult()) // BEGIN
        .mockRejectedValueOnce(error)
        .mockResolvedValueOnce(createMockQueryResult()); // ROLLBACK

      try {
        await withTransaction(mockPool, async (client) => {
          await client.query('SELECT 1');
        });
        fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(TransactionError);
        expect((err as TransactionError).message).toContain('password=[REDACTED]');
        expect((err as TransactionError).message).not.toContain('secret123');
      }
    });

    it('should sanitize potential tokens in error messages', async () => {
      const error = new Error('API error: token abc123def456ghi789jkl012mno345pqr678');
      
      mockClient.query
        .mockResolvedValueOnce(createMockQueryResult()) // BEGIN
        .mockRejectedValueOnce(error)
        .mockResolvedValueOnce(createMockQueryResult()); // ROLLBACK

      try {
        await withTransaction(mockPool, async (client) => {
          await client.query('SELECT 1');
        });
        fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(TransactionError);
        expect((err as TransactionError).message).toContain('[REDACTED]');
        expect((err as TransactionError).message).not.toContain('abc123def456ghi789jkl012mno345pqr678');
      }
    });
  });

  describe('transactional() Helper Function', () => {
    it('should execute multiple operations in sequence', async () => {
      mockClient.query.mockResolvedValue({ 
        rows: [{ id: '1' }], 
        command: 'INSERT', 
        oid: 0, 
        fields: [] as any[], 
        rowCount: 1 
      });

      const [result1, result2] = await transactional(mockPool, [
        (client) => (client as any).query('INSERT INTO users (email) VALUES ($1) RETURNING id', ['user1@example.com']),
        (client) => (client as any).query('INSERT INTO users (email) VALUES ($1) RETURNING id', ['user2@example.com']),
      ]);

      expect(result1).toHaveProperty('rows');
      expect(result2).toHaveProperty('rows');
      expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
      expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
    });

    it('should rollback all operations if any fails', async () => {
      mockClient.query
        .mockResolvedValueOnce(createMockQueryResult()) // BEGIN
        .mockResolvedValueOnce({ rows: [{ id: '1' }], command: 'INSERT', oid: 0, fields: [] as any[], rowCount: 1 }) // First insert
        .mockRejectedValueOnce(new Error('Second insert failed'))
        .mockResolvedValueOnce(createMockQueryResult()); // ROLLBACK

      await expect(
        transactional(mockPool, [
          (client) => (client as any).query('INSERT INTO users (email) VALUES ($1)', ['user1@example.com']),
          (client) => (client as any).query('INSERT INTO users (email) VALUES ($1)', ['user1@example.com']), // Duplicate
        ])
      ).rejects.toThrow(TransactionError);

      expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
    });
  });

  describe('Auth Boundary Tests', () => {
    it('should reject transaction without proper authorization context', async () => {
      // Simulate unauthorized access attempt
      const unauthorizedError = new Error('Unauthorized');
      (unauthorizedError as any).code = 'UNAUTHORIZED';

      mockClient.query
        .mockResolvedValueOnce(createMockQueryResult()) // BEGIN
        .mockRejectedValueOnce(unauthorizedError)
        .mockResolvedValueOnce(createMockQueryResult()); // ROLLBACK

      await expect(
        withTransaction(mockPool, async (client) => {
          await client.query('UPDATE sensitive_data SET value = $1', ['new-value']);
        })
      ).rejects.toThrow(TransactionError);

      expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty transaction', async () => {
      mockClient.query.mockResolvedValue(createMockQueryResult());

      const result = await withTransaction(mockPool, async () => {
        return 'empty';
      });

      expect(result).toBe('empty');
      expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
      expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
    });

    it('should handle transaction returning null', async () => {
      mockClient.query.mockResolvedValue(createMockQueryResult());

      const result = await withTransaction(mockPool, async () => {
        return null;
      });

      expect(result).toBeNull();
    });

    it('should handle transaction returning undefined', async () => {
      mockClient.query.mockResolvedValue(createMockQueryResult());

      const result = await withTransaction(mockPool, async () => {
        return undefined;
      });

      expect(result).toBeUndefined();
    });

    it('should handle very long transactions', async () => {
      mockClient.query.mockResolvedValue(createMockQueryResult());

      await withTransaction(mockPool, async (client) => {
        for (let i = 0; i < 100; i++) {
          await client.query(`INSERT INTO test VALUES (${i})`);
        }
      });

      expect(mockClient.query).toHaveBeenCalledTimes(102); // BEGIN + 100 inserts + COMMIT
    });
  });
});
