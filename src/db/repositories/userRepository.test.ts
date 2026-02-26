import { Pool, QueryResult } from 'pg';
import { UserRepository, User } from './userRepository';

const mockUser: User = {
  id: 'user-123',
  email: 'alice@example.com',
  password_hash: 'salt:hash',
  created_at: new Date('2024-01-01'),
  updated_at: new Date('2024-01-01'),
};

describe('UserRepository', () => {
  let repository: UserRepository;
  let mockPool: jest.Mocked<Pool>;

  beforeEach(() => {
    mockPool = { query: jest.fn() } as any;
    repository = new UserRepository(mockPool);
  });

  describe('findById', () => {
    it('returns the user when found', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [mockUser], rowCount: 1, command: 'SELECT', oid: 0, fields: [],
      } as QueryResult<User>);

      const result = await repository.findById('user-123');

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('SELECT'),
        ['user-123']
      );
      expect(result).not.toBeNull();
      expect(result!.id).toBe('user-123');
      expect(result!.password_hash).toBe('salt:hash');
    });

    it('returns null when user is not found', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [], rowCount: 0, command: 'SELECT', oid: 0, fields: [],
      } as QueryResult<User>);

      expect(await repository.findById('ghost')).toBeNull();
    });
  });

  describe('findByEmail', () => {
    it('returns the user when found by email', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [mockUser], rowCount: 1, command: 'SELECT', oid: 0, fields: [],
      } as QueryResult<User>);

      const result = await repository.findByEmail('alice@example.com');
      expect(result!.email).toBe('alice@example.com');
    });

    it('returns null when email is not found', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [], rowCount: 0, command: 'SELECT', oid: 0, fields: [],
      } as QueryResult<User>);

      expect(await repository.findByEmail('nobody@example.com')).toBeNull();
    });
  });

  describe('updatePasswordHash', () => {
    it('runs the UPDATE query with correct arguments', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [], rowCount: 1, command: 'UPDATE', oid: 0, fields: [],
      } as any);

      await repository.updatePasswordHash('user-123', 'newsalt:newhash');

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE users'),
        ['newsalt:newhash', 'user-123']
      );
    });
  });
});