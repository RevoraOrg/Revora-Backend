import { Pool } from 'pg';
import { PasswordResetRateLimiter, RateLimitResult } from './passwordResetRateLimiter';

describe('PasswordResetRateLimiter', () => {
  let mockPool: jest.Mocked<Pool>;
  let queryMock: jest.Mock;

  beforeEach(() => {
    queryMock = jest.fn();
    mockPool = {
      query: queryMock,
    } as unknown as jest.Mocked<Pool>;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  const createRateLimiter = (overrides?: { maxRequests?: number; windowMinutes?: number; blockMinutes?: number }) => {
    return new PasswordResetRateLimiter(mockPool, {
      maxRequests: 3,
      windowMinutes: 60,
      blockMinutes: 15,
      ...overrides,
    });
  };

  describe('checkRateLimit', () => {
    it('should allow requests within rate limit', async () => {
      queryMock
        .mockResolvedValueOnce({ rows: [] }) // checkIfBlocked
        .mockResolvedValueOnce({ rows: [{ count: '1' }] }) // getRequestCount
        .mockResolvedValueOnce({ rows: [] }); // recordRequest

      const limiter = createRateLimiter();
      const result = await limiter.checkRateLimit('test@example.com');

      expect(result.allowed).toBe(true);
      expect(result.remainingRequests).toBe(1);
    });

    it('should allow first request with max requests available', async () => {
      queryMock
        .mockResolvedValueOnce({ rows: [] }) // checkIfBlocked
        .mockResolvedValueOnce({ rows: [{ count: '0' }] }) // getRequestCount
        .mockResolvedValueOnce({ rows: [] }); // recordRequest

      const limiter = createRateLimiter();
      const result = await limiter.checkRateLimit('test@example.com');

      expect(result.allowed).toBe(true);
      expect(result.remainingRequests).toBe(2);
    });

    it('should block when rate limit exceeded', async () => {
      queryMock
        .mockResolvedValueOnce({ rows: [] }) // checkIfBlocked
        .mockResolvedValueOnce({ rows: [{ count: '3' }] }) // getRequestCount
        .mockResolvedValueOnce({ rows: [] }); // blockIdentifier

      const limiter = createRateLimiter({ maxRequests: 3 });
      const result = await limiter.checkRateLimit('test@example.com');

      expect(result.allowed).toBe(false);
      expect(result.remainingRequests).toBe(0);
      expect(result.retryAfter).toBeDefined();
    });

    it('should remain blocked when already blocked', async () => {
      const blockedUntil = new Date(Date.now() + 10 * 60 * 1000);
      queryMock
        .mockResolvedValueOnce({ rows: [{ blocked_until: blockedUntil }] }) // checkIfBlocked
        .mockResolvedValueOnce({ rows: [{ blocked_until: blockedUntil }] }); // getBlockExpiry

      const limiter = createRateLimiter();
      const result = await limiter.checkRateLimit('test@example.com');

      expect(result.allowed).toBe(false);
      expect(result.retryAfter).toBeGreaterThan(0);
    });

    it('should normalize email to lowercase', async () => {
      queryMock
        .mockResolvedValueOnce({ rows: [] }) // checkIfBlocked
        .mockResolvedValueOnce({ rows: [{ count: '0' }] }) // getRequestCount
        .mockResolvedValueOnce({ rows: [] }); // recordRequest

      const limiter = createRateLimiter();
      await limiter.checkRateLimit('Test@Example.COM');

      expect(queryMock).toHaveBeenCalledWith(
        expect.stringContaining('identifier = $1'),
        ['test@example.com']
      );
    });

    it('should handle empty request count gracefully', async () => {
      queryMock
        .mockResolvedValueOnce({ rows: [] }) // checkIfBlocked
        .mockResolvedValueOnce({ rows: [] }) // getRequestCount (empty)
        .mockResolvedValueOnce({ rows: [] }); // recordRequest

      const limiter = createRateLimiter();
      const result = await limiter.checkRateLimit('test@example.com');

      expect(result.allowed).toBe(true);
      expect(result.remainingRequests).toBe(2);
    });
  });

  describe('resetRateLimit', () => {
    it('should delete rate limit entries for identifier', async () => {
      queryMock.mockResolvedValueOnce({ rows: [] });

      const limiter = createRateLimiter();
      await limiter.resetRateLimit('test@example.com');

      expect(queryMock).toHaveBeenCalledWith(
        expect.stringContaining('DELETE FROM password_reset_rate_limits'),
        ['test@example.com']
      );
    });

    it('should normalize email before reset', async () => {
      queryMock.mockResolvedValueOnce({ rows: [] });

      const limiter = createRateLimiter();
      await limiter.resetRateLimit('TEST@EXAMPLE.COM');

      expect(queryMock).toHaveBeenCalledWith(
        expect.any(String),
        ['test@example.com']
      );
    });
  });

  describe('security edge cases', () => {
    it('should handle SQL injection in identifier', async () => {
      queryMock
        .mockResolvedValueOnce({ rows: [] }) // checkIfBlocked
        .mockResolvedValueOnce({ rows: [{ count: '0' }] }) // getRequestCount
        .mockResolvedValueOnce({ rows: [] }); // recordRequest

      const limiter = createRateLimiter();
      const result = await limiter.checkRateLimit("test'; DROP TABLE users; --");

      expect(result.allowed).toBe(true);
      expect(queryMock).toHaveBeenCalledWith(
        expect.any(String),
        ["test'; drop table users; --"]
      );
    });

    it('should handle whitespace in identifier', async () => {
      queryMock
        .mockResolvedValueOnce({ rows: [] }) // checkIfBlocked
        .mockResolvedValueOnce({ rows: [{ count: '0' }] }) // getRequestCount
        .mockResolvedValueOnce({ rows: [] }); // recordRequest

      const limiter = createRateLimiter();
      await limiter.checkRateLimit('  test@example.com  ');

      expect(queryMock).toHaveBeenCalledWith(
        expect.any(String),
        ['test@example.com']
      );
    });

    it('should handle very long identifiers', async () => {
      const longIdentifier = 'a'.repeat(1000) + '@example.com';
      queryMock
        .mockResolvedValueOnce({ rows: [] }) // checkIfBlocked
        .mockResolvedValueOnce({ rows: [{ count: '0' }] }) // getRequestCount
        .mockResolvedValueOnce({ rows: [] }); // recordRequest

      const limiter = createRateLimiter();
      const result = await limiter.checkRateLimit(longIdentifier);

      expect(result.allowed).toBe(true);
    });
  });

  describe('rate limit configuration', () => {
    it('should use custom configuration when provided', async () => {
      queryMock
        .mockResolvedValueOnce({ rows: [] }) // checkIfBlocked
        .mockResolvedValueOnce({ rows: [{ count: '5' }] }) // getRequestCount
        .mockResolvedValueOnce({ rows: [] }); // blockIdentifier

      const limiter = createRateLimiter({ maxRequests: 5, blockMinutes: 30 });
      const result = await limiter.checkRateLimit('test@example.com');

      expect(result.allowed).toBe(false);
      expect(result.retryAfter).toBe(30 * 60);
    });

    it('should return correct remaining requests', async () => {
      queryMock
        .mockResolvedValueOnce({ rows: [] }) // checkIfBlocked
        .mockResolvedValueOnce({ rows: [{ count: '1' }] }) // getRequestCount
        .mockResolvedValueOnce({ rows: [] }); // recordRequest

      const limiter = createRateLimiter({ maxRequests: 3 });
      const result = await limiter.checkRateLimit('test@example.com');

      expect(result.remainingRequests).toBe(1);
    });
  });
});
