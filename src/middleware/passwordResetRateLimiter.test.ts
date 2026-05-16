import { Request, Response, NextFunction } from 'express';
import { createPasswordResetRateLimiter } from './passwordResetRateLimiter';
import { PasswordResetRateLimitError } from '../lib/errors';
import { logger } from '../lib/logger';

describe('Password reset rate limiter middleware', () => {
  const makeReq = (): Request => ({
    ip: '127.0.0.1',
    socket: { remoteAddress: '127.0.0.1' },
    headers: {},
    get: jest.fn().mockReturnValue(undefined),
    app: { get: jest.fn().mockReturnValue(false) },
  } as unknown as Request);

  const makeRes = (): Response => ({
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    setHeader: jest.fn(),
    getHeader: jest.fn(),
  } as unknown as Response);

  beforeEach(() => {
    jest.spyOn(logger, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('calls next for requests under the limit', async () => {
    const res = makeRes();
    const next: NextFunction = jest.fn();
    const limiter = createPasswordResetRateLimiter();

    await limiter(makeReq(), res, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('calls next with PasswordResetRateLimitError when the limit is exceeded', async () => {
    const res = makeRes();
    const next: NextFunction = jest.fn();
    const limiter = createPasswordResetRateLimiter();

    for (let i = 0; i < 5; i++) {
      await limiter(makeReq(), res, next);
    }

    await limiter(makeReq(), res, next);

    expect(next).toHaveBeenLastCalledWith(expect.any(PasswordResetRateLimitError));
    expect(logger.warn).toHaveBeenCalledWith('Password reset rate limit exceeded', {
      ip: '127.0.0.1',
    });
  });
});
