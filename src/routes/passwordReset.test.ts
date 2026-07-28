import request from 'supertest';
import { Pool } from 'pg';
import { createPasswordResetRouter } from './passwordReset';
import { EmailService } from '../services/emailService';

// Mock EmailService
jest.mock('../services/emailService');

describe('Password Reset Router', () => {
  let mockPool: jest.Mocked<Pool>;
  let mockEmailService: jest.Mocked<EmailService>;
  let router: ReturnType<typeof createPasswordResetRouter>;

  beforeEach(() => {
    // Mock pool
    mockPool = {
      query: jest.fn(),
    } as unknown as jest.Mocked<Pool>;

    // Mock EmailService
    mockEmailService = {
      sendMail: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<EmailService>;

    router = createPasswordResetRouter({ db: mockPool, emailService: mockEmailService });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /api/auth/forgot-password', () => {
    it('should return uniform response for invalid email format', async () => {
      const response = await request(router)
        .post('/api/auth/forgot-password')
        .send({ email: 'invalid-email' });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        message: 'If the email exists, a password reset link has been sent',
      });
      expect(mockPool.query).not.toHaveBeenCalled();
      expect(mockEmailService.sendMail).not.toHaveBeenCalled();
    });

    it('should return uniform response for missing email', async () => {
      const response = await request(router)
        .post('/api/auth/forgot-password')
        .send({});

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        message: 'If the email exists, a password reset link has been sent',
      });
      expect(mockPool.query).not.toHaveBeenCalled();
      expect(mockEmailService.sendMail).not.toHaveBeenCalled();
    });

    it('should process valid email and send reset email', async () => {
      mockPool.query.mockResolvedValue({ rows: [] });
      mockEmailService.sendMail.mockResolvedValue(undefined);

      const response = await request(router)
        .post('/api/auth/forgot-password')
        .send({ email: 'test@example.com' });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        message: 'If the email exists, a password reset link has been sent',
      });
      expect(mockEmailService.sendMail).toHaveBeenCalledWith(
        'test@example.com',
        expect.stringContaining('password reset'),
        expect.any(String)
      );
    });

    it('should return 429 when rate limited', async () => {
      const { PasswordResetRateLimitedError } = require('../services/passwordResetService');
      
      mockPool.query.mockRejectedValue(
        new PasswordResetRateLimitedError('Too many requests', 900)
      );

      const response = await request(router)
        .post('/api/auth/forgot-password')
        .send({ email: 'test@example.com' });

      expect(response.status).toBe(429);
      expect(response.body.error).toContain('Too many requests');
      expect(response.body.retryAfter).toBe(900);
    });

    it('should handle service errors gracefully', async () => {
      mockPool.query.mockRejectedValue(new Error('Database error'));

      const response = await request(router)
        .post('/api/auth/forgot-password')
        .send({ email: 'test@example.com' });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        message: 'If the email exists, a password reset link has been sent',
      });
    });

    it('should handle email service errors gracefully', async () => {
      mockPool.query.mockResolvedValue({ rows: [] });
      mockEmailService.sendMail.mockRejectedValue(new Error('Email service error'));

      const response = await request(router)
        .post('/api/auth/forgot-password')
        .send({ email: 'test@example.com' });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        message: 'If the email exists, a password reset link has been sent',
      });
    });

    it('should normalize email to lowercase', async () => {
      mockPool.query.mockResolvedValue({ rows: [] });
      mockEmailService.sendMail.mockResolvedValue(undefined);

      await request(router)
        .post('/api/auth/forgot-password')
        .send({ email: 'Test@Example.COM' });

      expect(mockEmailService.sendMail).toHaveBeenCalledWith(
        'test@example.com',
        expect.any(String),
        expect.any(String)
      );
    });
  });

  describe('POST /api/auth/reset-password', () => {
    it('should return 400 for missing token', async () => {
      const response = await request(router)
        .post('/api/auth/reset-password')
        .send({ password: 'newpassword123' });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Invalid token or password');
    });

    it('should return 400 for missing password', async () => {
      const response = await request(router)
        .post('/api/auth/reset-password')
        .send({ token: 'valid-token' });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Invalid token or password');
    });

    it('should return 400 for short password', async () => {
      const response = await request(router)
        .post('/api/auth/reset-password')
        .send({ token: 'valid-token', password: 'short' });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Invalid token or password');
    });

    it('should return 400 for password less than 8 characters', async () => {
      const response = await request(router)
        .post('/api/auth/reset-password')
        .send({ token: 'valid-token', password: '1234567' });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Invalid token or password');
    });

    it('should successfully reset password with valid token', async () => {
      mockPool.query.mockResolvedValue({ rows: [] });

      const response = await request(router)
        .post('/api/auth/reset-password')
        .send({ token: 'valid-token', password: 'newpassword123' });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ message: 'Password updated' });
    });

    it('should return 400 for invalid token', async () => {
      mockPool.query.mockResolvedValue({ rows: [] });

      // Mock the service to return false for invalid token
      const { PasswordResetService } = require('../services/passwordResetService');
      jest.spyOn(PasswordResetService.prototype, 'resetPassword').mockResolvedValue(false);

      const response = await request(router)
        .post('/api/auth/reset-password')
        .send({ token: 'invalid-token', password: 'newpassword123' });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Invalid or expired token');
    });

    it('should return 400 for expired token', async () => {
      mockPool.query.mockRejectedValue(new Error('Token expired'));

      const response = await request(router)
        .post('/api/auth/reset-password')
        .send({ token: 'expired-token', password: 'newpassword123' });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Invalid or expired token');
    });

    it('should handle database errors gracefully', async () => {
      mockPool.query.mockRejectedValue(new Error('Database connection failed'));

      const response = await request(router)
        .post('/api/auth/reset-password')
        .send({ token: 'valid-token', password: 'newpassword123' });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Invalid or expired token');
    });

    it('should accept password with exactly 8 characters', async () => {
      mockPool.query.mockResolvedValue({ rows: [] });

      const response = await request(router)
        .post('/api/auth/reset-password')
        .send({ token: 'valid-token', password: '12345678' });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ message: 'Password updated' });
    });

    it('should accept long passwords', async () => {
      mockPool.query.mockResolvedValue({ rows: [] });

      const response = await request(router)
        .post('/api/auth/reset-password')
        .send({ token: 'valid-token', password: 'very-long-password-with-special-chars-123!@#' });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ message: 'Password updated' });
    });
  });

  describe('Security - Token Leakage Prevention', () => {
    it('should not log reset token in error messages', async () => {
      mockPool.query.mockRejectedValue(new Error('Database error'));

      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

      await request(router)
        .post('/api/auth/reset-password')
        .send({ token: 'secret-token-123', password: 'newpassword123' });

      expect(consoleSpy).toHaveBeenCalledWith('[password-reset] Reset password error');
      expect(consoleSpy).not.toHaveBeenCalledWith(expect.stringContaining('secret-token-123'));

      consoleSpy.mockRestore();
    });

    it('should not expose token in response body', async () => {
      mockPool.query.mockRejectedValue(new Error('Invalid token'));

      const response = await request(router)
        .post('/api/auth/reset-password')
        .send({ token: 'secret-token-123', password: 'newpassword123' });

      expect(response.body.error).toBe('Invalid or expired token');
      expect(response.body.error).not.toContain('secret-token-123');
    });
  });

  describe('Security - Account Enumeration Prevention', () => {
    it('should return same response for non-existent email', async () => {
      mockPool.query.mockResolvedValue({ rows: [] });

      const response = await request(router)
        .post('/api/auth/forgot-password')
        .send({ email: 'nonexistent@example.com' });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        message: 'If the email exists, a password reset link has been sent',
      });
    });

    it('should return same response for existing email', async () => {
      mockPool.query.mockResolvedValue({ rows: [{ id: 'user-123' }] });
      mockEmailService.sendMail.mockResolvedValue(undefined);

      const response = await request(router)
        .post('/api/auth/forgot-password')
        .send({ email: 'existing@example.com' });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        message: 'If the email exists, a password reset link has been sent',
      });
    });

    it('should return same response for invalid email format', async () => {
      const response = await request(router)
        .post('/api/auth/forgot-password')
        .send({ email: 'not-an-email' });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        message: 'If the email exists, a password reset link has been sent',
      });
    });
  });

  describe('Email Service Integration', () => {
    it('should call EmailService.sendMail with correct parameters', async () => {
      mockPool.query.mockResolvedValue({ rows: [] });
      mockEmailService.sendMail.mockResolvedValue(undefined);

      await request(router)
        .post('/api/auth/forgot-password')
        .send({ email: 'user@example.com' });

      expect(mockEmailService.sendMail).toHaveBeenCalledTimes(1);
      expect(mockEmailService.sendMail).toHaveBeenCalledWith(
        'user@example.com',
        expect.stringContaining('password reset'),
        expect.any(String)
      );
    });

    it('should handle EmailService sendMail errors without exposing details', async () => {
      mockPool.query.mockResolvedValue({ rows: [] });
      mockEmailService.sendMail.mockRejectedValue(new Error('SMTP authentication failed'));

      const response = await request(router)
        .post('/api/auth/forgot-password')
        .send({ email: 'user@example.com' });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        message: 'If the email exists, a password reset link has been sent',
      });
    });
  });
});
