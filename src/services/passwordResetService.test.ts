import { PasswordResetService } from './passwordResetService';
import { PasswordResetTokenInvalidError } from '../lib/errors';

describe('PasswordResetService', () => {
  let mockPool: any;
  let mockClient: any;
  let emailSender: jest.Mock<Promise<void>, [string, string, string]>;
  let service: PasswordResetService;

  beforeEach(() => {
    emailSender = jest.fn(async () => {});
    mockClient = {
      query: jest.fn(async () => ({ rows: [] })),
      release: jest.fn(),
    };
    mockPool = {
      connect: jest.fn(async () => mockClient),
      query: jest.fn(),
    };
    service = new PasswordResetService(mockPool, {
      emailSender,
      appUrl: 'http://localhost',
    });
  });

  it('returns silently for unknown email and does not send mail', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    await expect(service.requestPasswordReset('unknown@example.com')).resolves.toBeUndefined();
    expect(emailSender).not.toHaveBeenCalled();
    expect(mockPool.query).toHaveBeenCalledWith(
      expect.stringContaining('SELECT id, email FROM users'),
      ['unknown@example.com'],
    );
  });

  it('invalidates old tokens and inserts a new token before sending email', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'user-1', email: 'user@example.com' }] });

    const sent = await service.requestPasswordReset('user@example.com');

    expect(mockPool.connect).toHaveBeenCalled();
    expect(mockClient.query).toHaveBeenNthCalledWith(1, 'BEGIN');
    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE password_reset_tokens SET used = TRUE'),
      ['user-1'],
    );
    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO password_reset_tokens'),
      expect.any(Array),
    );
    expect(mockClient.query).toHaveBeenLastCalledWith('COMMIT');
    expect(emailSender).toHaveBeenCalledTimes(1);
    expect(emailSender).toHaveBeenCalledWith(
      'user@example.com',
      'Password reset request',
      expect.stringMatching(/Use this secure token to reset your password: [0-9a-f]{64}/),
    );
    expect(sent).toBeUndefined();
  });

  it('throws PasswordResetTokenInvalidError when token is unknown', async () => {
    mockPool.connect.mockResolvedValue(mockClient);
    mockClient.query.mockImplementation(async (query: string) => {
      if (query === 'BEGIN' || query === 'ROLLBACK' || query === 'COMMIT') {
        return { rows: [] };
      }
      return { rows: [] };
    });

    await expect(service.resetPassword('f'.repeat(64), 'StrongPass123!')).rejects.toBeInstanceOf(
      PasswordResetTokenInvalidError,
    );
    expect(mockClient.query).toHaveBeenCalledWith(expect.stringContaining('BEGIN'));
    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining('SELECT id, user_id, expires_at, used'),
      [expect.any(String)],
    );
  });

  it('throws PasswordResetTokenInvalidError when token was already used', async () => {
    const pastDate = new Date(Date.now() + 60_000);
    mockPool.connect.mockResolvedValue(mockClient);
    mockClient.query.mockImplementation(async (query: string) => {
      if (query === 'BEGIN' || query === 'ROLLBACK') {
        return { rows: [] };
      }
      if (query.includes('SELECT id, user_id, expires_at, used')) {
        return { rows: [{ id: 'token-1', user_id: 'user-1', expires_at: pastDate, used: true }] };
      }
      return { rows: [] };
    });

    await expect(service.resetPassword('f'.repeat(64), 'StrongPass123!')).rejects.toBeInstanceOf(
      PasswordResetTokenInvalidError,
    );
  });

  it('throws PasswordResetTokenInvalidError when token is expired', async () => {
    const expired = new Date(Date.now() - 1000);
    mockPool.connect.mockResolvedValue(mockClient);
    mockClient.query.mockImplementation(async (query: string) => {
      if (query === 'BEGIN' || query === 'ROLLBACK') {
        return { rows: [] };
      }
      if (query.includes('SELECT id, user_id, expires_at, used')) {
        return { rows: [{ id: 'token-1', user_id: 'user-1', expires_at: expired, used: false }] };
      }
      return { rows: [] };
    });

    await expect(service.resetPassword('f'.repeat(64), 'StrongPass123!')).rejects.toBeInstanceOf(
      PasswordResetTokenInvalidError,
    );
  });

  it('updates password and marks token used when reset token is valid', async () => {
    const futureDate = new Date(Date.now() + 60_000);
    mockPool.connect.mockResolvedValue(mockClient);
    mockClient.query.mockImplementation(async (query: string) => {
      if (query === 'BEGIN' || query === 'COMMIT' || query === 'ROLLBACK') {
        return { rows: [] };
      }
      if (query.includes('SELECT id, user_id, expires_at, used')) {
        return { rows: [{ id: 'token-1', user_id: 'user-1', expires_at: futureDate, used: false }] };
      }
      return { rows: [] };
    });

    await expect(service.resetPassword('f'.repeat(64), 'StrongPass123!')).resolves.toBeUndefined();
    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE password_reset_tokens SET used = TRUE'),
      ['token-1'],
    );
    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE users SET password_hash = $1 WHERE id = $2'),
      expect.any(Array),
    );
    expect(mockClient.query).toHaveBeenLastCalledWith('COMMIT');
  });
});
