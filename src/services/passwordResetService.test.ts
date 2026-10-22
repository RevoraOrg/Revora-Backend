import { Pool, PoolClient } from 'pg';
import { PasswordResetService } from './passwordResetService';

describe('PasswordResetService', () => {
  let mockClient: any;
  let mockPool: any;
  let service: PasswordResetService;

  const validRow = {
    id: 'token-1',
    user_id: 'user-1',
    expires_at: new Date(Date.now() + 60_000),
    used_at: null,
  };

  beforeEach(() => {
    mockClient = {
      query: jest.fn().mockImplementation((queryText: string) => {
        if (queryText.includes('FROM password_reset_tokens')) {
          return Promise.resolve({ rows: [{ ...validRow }] });
        }
        return Promise.resolve({ rows: [] });
      }),
      release: jest.fn(),
    } as unknown as PoolClient;

    mockPool = {
      query: jest.fn().mockResolved({ rows: [] }),
      connect: jest.fn().mockResolved(mockClient),
    } as unknown as Pool;

    service = new PasswordResetService(mockPool);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('resetPassword', () => {
    it('rejects weak passwords without opening a transaction', async () => {
      const result = await service.resetPassword('raw-token', 'a');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('weak_password');
        expect((result as any).errors.length).toBeGreaterThan(0);
      }
      expect(mockPool.connect).not.toHaveBeenCalled();
    });

    it('returns invalid_token when the token is not found', async () => {
      mockClient.query.mockImplementation((queryText: string) => {
        if (queryText.includes('FROM password_reset_tokens')) {
          return Promise.resolve({ rows: [] });
        }
        return Promise.resolve({ rows: [] });
      });

      const result = await service.resetPassword('raw-token', 'StrongPassword123!');
      expect(result).toEqual({ ok: false, reason: 'invalid_token' });
      expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
    });

    it('returns invalid_token when the token is expired', async () => {
      mockClient.query.mockImplementation((queryText: string) => {
        if (queryText.includes('FROM password_reset_tokens')) {
          return Promise.resolve({ rows: [{ ...validRow, expires_at: new Date(Date.now() - 60_000) }] });
        }
        return Promise.resolve({ rows: [] });
      });

      const result = await service.resetPassword('raw-token', 'StrongPassword123!');
      expect(result).toEqual({ ok: false, reason: 'invalid_token' });
    });

    it('returns invalid_token when the token is already used', async () => {
      mockClient.query.mockImplementation((queryText: string) => {
        if (queryText.includes('FROM password_reset_tokens')) {
          return Promise.resolve({ rows: [{ ...validRow, used_at: new Date() }] });
        }
        return Promise.resolve({ rows: [] });
      });

      const result = await service.resetPassword('raw-token', 'StrongPassword123!');
      expect(result).toEqual({ ok: false, reason: 'invalid_token' });
    });

    it('revokes all sessions and invalidates other tokens on successful reset', async () => {
      const result = await service.resetPassword('raw-token', 'StrongPassword123!');
      expect(result).toEqual({ ok: true });

      const calls = mockClient.query.mock.calls.map((c: any[]) => c[0] as string);
      expect(calls.some((q) => /UPDATE sessions\s*SET `\"revoked_at`\" = NOW()/i.test(q))).toBe(true);
      expect(calls.some((q) => /UPDATE password_reset_tokens[\s\S]*used_at IS NULL/i.test(q))).toBe(true);
      expect(calls).toContain('COMMIT');
    });

    it('rolls back and throws when a query fails', async () => {
      mockClient.query.mockImplementation((queryText: string) => {
        if (queryText.includes('FROM password_reset_tokens')) {
          return Promise.resolve({ rows: [{ ...validRow }] });
        }
        if (queryText.includes('UPDATE users')) {
          return Promise.reject(new Error('db'));
        }
        return Promise.resolve({ rows: [] });
      });

      await expect(service.resetPassword('raw-token', 'StrongPassword123!')).rejects.toThrow('Password reset failed');
      expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
      expect(mockClient.release).toHaveBeenCalled();
    });
  });
});
