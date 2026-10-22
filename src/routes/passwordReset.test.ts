import request from 'supertest';
import { Pool } from 'pg';
import express from 'express';
import { createPasswordResetRouter } from './passwordReset';
import { EmailService } from '../services/emailService';

// Mock EmailService
jest.mock('../services/emailService');

describe('Password Reset Router', () => {
  let mockPool: any;
  let mockEmailService: any;
  let app: any;

  const validRow = {
    id: 'token-123',
    user_id: 'user-123',
    expires_at: new Date(Date.now() + 60_000),
    used_at: null,
  };

  beforeEach(() => {
    const mockClient = {
      query: jest.fn().mockImplementation((queryText: string) => {
        if (queryText.includes('FROM password_reset_tokens')) {
          return Promise.resolve({ rows: [{ ...validRow }] });
        }
        return Promise.resolve({ rows: [] });
      }),
      release: jest.fn(),
    };

    mockPool = {
      query: jest.fn().mockImplementation((queryText: string, values?: any[]) => {
        if (queryText.includes('FROM users')) {
          const email = values ? values[0] : 'test@example.com';
          return Promise.resolve({ rows: [{ id: 'user-123', email }] });
        }
        if (queryText.includes('COUNT(*)')) {
          return Promise.resolve({ rows: [{ count: '0' }] });
        }
        return Promise.resolve({ rows: [] });
      }),
      connect: jest.fn().mockResolved(mockClient),
    } as unknown as jest.Mocked<Pool>;

    mockEmailService = {
      sendMail: jest.fn().mockResolved(undefined),
    } as unknown as jest.Mocked<EmailService>;

    app = express();
    app.use(express.json());
    app.use(createPasswordResetRouter({ db: mockPool, emailService: mockEmailService }));
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  describe('POST /api/auth/forgot-password', () => {
    it('returns uniform response for invalid email format', async () => {
      const response = await request(app)
        .post('/api/auth/forgot-password')
        .send({ email: 'invalid-email' });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        message: 'If the email exists, a password reset link has been sent',
      });
      expect(mockPool.query).not.toHaveBeenCalled();
      expect(mockEmailService.sendMail).not.toHaveBeenCalled();
    });

    it('returns uniform response for missing email', async () => {
      const response = await request(app)
        .post('/api/auth/forgot-password')
        .send({});

      expect(response.status).toBe(200);
      expect(mockPool.query).not.toHaveBeenCalled();
    });

    it('processes valid email and sends reset email', async () => {
      const response = await request(app)
        .post('/api/auth/forgot-password')
        .send({ email: 'test@example.com' });

      expect(response.status).toBe(200);
      expect(mockEmailService.sendMail).toHaveBeenCalled();
    });

    it('returns 429 when rate limited', async () => {
      const { PasswordResetRateLimitedError } = require('../services/passwordResetService');
      mockPool.query.mockRejectedOnce(new PasswordResetRateLimitedError('Too many requests', 900));

      const response = await request(app)
        .post('/api/auth/forgot-password')
        .send({ email: 'test@example.com' });

      expect(response.status).toBe(429);
      expect(response.body.error).toContain('Too many requests');
      expect(response.body.retryAfter).toBe(900);
    });
  });

  describe('POST /api/auth/reset-password', () => {
    it('returns 400 for missing token', async () => {
      const response = await request(app)
        .post('/api/auth/reset-password')
        .send({ password: 'StrongPassword123!' });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Invalid token or password');
    });

    it('returns 400 for missing password', async () => {
      const response = await request(app)
        .post('/api/auth/reset-password')
        .send({ token: 'valid-token' });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Invalid token or password');
    });

    it('returns 400 and leaves token unused for weak password', async () => {
      const response = await request(app)
        .post('/api/auth/reset-password')
        .send({ token: 'valid-token', password: 'a' });

      expect(response.status).toBe(400);
      expect(response.body.error).toContainRegex(/strength/i);
      expect(mockPool.connect).not.toHaveBeenCalled();
    });

    it('successfully resets password with valid token', async () => {
      const response = await request(app)
        .post('/api/auth/reset-password')
        .send({ token: 'valid-token', password: 'StrongPassword123!' });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ message: 'Password updated' });
    });

    it('returns 400 for invalid token', async () => {
      const { PasswordResetService } = require('../services/passwordResetService');
      jest.spyOn(PasswordResetService.prototype, 'resetPassword').mockResolved({ ok: false, reason: 'invalid_token' });

      const response = await request(app)
        .post('/api/auth/reset-password')
        .send({ token: 'invalid-token', password: 'StrongPassword123!' });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Invalid or expired token');
    });

    it('returns 400 for expired token', async () => {
      mockPool.connect.mockImplementationOnce(() => {
        const expiredClient = {
          query: jest.fn().mockImplementation((queryText: string) => {
            if (queryText.includes('FROM password_reset_tokens')) {
              return Promise.resolve({
                rows: [{ ...validRow, expires_at: new Date(Date.now() - 60_000) }],
              });
            }
            return Promise.resolve({ rows: [] });
          }),
          release: jest.fn(),
        };
        return Promise.resolve(expiredClient);
      });

      const response = await request(app)
        .post('/api/auth/reset-password')
        .send({ token: 'expired-token', password: 'StrongPassword123!' });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Invalid or expired token');
    });

    it('handles database errors gracefully', async () => {
      mockPool.connect.mockRejected(new Error('Database connection failed'));

      const response = await request(app)
        .post('/api/auth/reset-password')
        .send({ token: 'valid-token', password: 'StrongPassword123!' });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Invalid or expired token');
    });
  });

  describe('Security - Token Leakage Prevention', () => {
    it('does not log reset token in error messages', async () => {
      mockPool.connect.mockRejected(new Error('Database error'));
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

      await request(app)
        .post('/api/auth/reset-password')
        .send({ token: 'secret-token-123', password: 'StrongPassword123!' });

      expect(consoleSpy).toHaveBeenCalledWith('[password-reset] Reset password error');
      expect(consoleSpy).not.toHaveBeenCalledWith(expect.stringContaining('secret-token-123'));

      consoleSpy.mockRestore();
    });

    it('does not expose token in response body', async () => {
      mockPool.connect.mockRejected(new Error('Invalid token'));

      const response = await request(app)
        .post('/api/auth/reset-password')
        .send({ token: 'secret-token-123', password: 'StrongPassword123!' });

      expect(response.body.error).toBe('Invalid or expired token');
      expect(response.body.error).not.toContain('secret-token-123');
    });
  });
});
