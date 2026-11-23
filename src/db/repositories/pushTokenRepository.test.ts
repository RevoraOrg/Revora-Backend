import { PgPushTokenRepository } from './pushTokenRepository';
import { Pool } from 'pg';

describe('PgPushTokenRepository', () => {
  let mockPool: jest.Mocked<Pool>;
  let repo: PgPushTokenRepository;

  beforeEach(() => {
    mockPool = {
      query: jest.fn(),
    } as unknown as jest.Mocked<Pool>;
    repo = new PgPushTokenRepository(mockPool);
  });

  describe('upsert', () => {
    it('throws error when no rows are returned', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] } as any);
      await expect(
        repo.upsert({ user_id: 'u1', token: 't1', provider: 'fcm' })
      ).rejects.toThrow('Failed to upsert push token');
    });

    it('returns mapped token on successful upsert', async () => {
      const mockRow = {
        id: '123',
        user_id: 'u1',
        token: 't1',
        provider: 'fcm',
        status: 'active',
        last_used_at: new Date(),
        created_at: new Date(),
        updated_at: new Date(),
      };
      mockPool.query.mockResolvedValueOnce({ rows: [mockRow] } as any);
      
      const result = await repo.upsert({ user_id: 'u1', token: 't1', provider: 'fcm' });
      expect(result).toEqual(mockRow);
    });
  });

  describe('findByToken', () => {
    it('returns null when no rows are returned', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] } as any);
      const result = await repo.findByToken('non-existent-token');
      expect(result).toBeNull();
    });

    it('returns token when found', async () => {
      const mockRow = {
        id: '123',
        user_id: 'u1',
        token: 'existing-token',
        provider: 'apns',
        status: 'active',
        last_used_at: new Date(),
        created_at: new Date(),
        updated_at: new Date(),
      };
      mockPool.query.mockResolvedValueOnce({ rows: [mockRow] } as any);
      
      const result = await repo.findByToken('existing-token');
      expect(result).toEqual(mockRow);
    });
  });

  describe('markPruned', () => {
    it('returns null when no rows are returned', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] } as any);
      const result = await repo.markPruned('non-existent-id');
      expect(result).toBeNull();
    });

    it('returns token when pruned successfully', async () => {
      const mockRow = {
        id: '123',
        user_id: 'u1',
        token: 't1',
        provider: 'fcm',
        status: 'pruned',
        last_used_at: new Date(),
        created_at: new Date(),
        updated_at: new Date(),
      };
      mockPool.query.mockResolvedValueOnce({ rows: [mockRow] } as any);
      
      const result = await repo.markPruned('123');
      expect(result).toEqual(mockRow);
    });
  });
});
