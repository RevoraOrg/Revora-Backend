import { Pool, QueryResult } from 'pg';
import { SessionRepository, Session, CreateSessionInput } from './sessionRepository';

const mockSession: Session = {
  id: 'session-123',
  user_id: 'user-456',
  token_hash: 'abc123hash',
  expires_at: new Date('2099-01-01'),
  created_at: new Date('2024-01-01'),
};

describe('SessionRepository', () => {
  let repository: SessionRepository;
  let mockPool: jest.Mocked<Pool>;

  beforeEach(() => {
    mockPool = { query: jest.fn() } as any;
    repository = new SessionRepository(mockPool);
  });

  describe('createSession', () => {
    it('inserts and returns the session', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [mockSession], rowCount: 1, command: 'INSERT', oid: 0, fields: [],
      } as QueryResult<Session>);

      const input: CreateSessionInput = {
        user_id: 'user-456',
        token_hash: 'abc123hash',
        expires_at: new Date('2099-01-01'),
      };

      const result = await repository.createSession(input);

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO sessions'),
        [input.user_id, input.token_hash, input.expires_at]
      );
      expect(result.id).toBe('session-123');
    });

    it('throws when no row is returned', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [], rowCount: 0, command: 'INSERT', oid: 0, fields: [],
      } as any);

      await expect(
        repository.createSession({ user_id: 'u', token_hash: 'h', expires_at: new Date() })
      ).rejects.toThrow('Failed to create session');
    });
  });

  describe('deleteSessionById', () => {
    it('calls DELETE with the correct session id', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);

      await repository.deleteSessionById('session-123');

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('DELETE FROM sessions WHERE id'),
        ['session-123']
      );
    });
  });

  describe('deleteAllSessionsByUserId', () => {
    it('calls DELETE with the correct user id', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 2 } as any);

      await repository.deleteAllSessionsByUserId('user-456');

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('DELETE FROM sessions WHERE user_id'),
        ['user-456']
      );
    });
  });
});
