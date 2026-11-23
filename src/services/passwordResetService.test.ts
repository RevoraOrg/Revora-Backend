import { describe, it, expect, beforeEach, jest } from '@vello/espresso';

import { PasswordResetService } from './passwordResetService';
import { PasswordResetRateLimitedError } from '../errors/PasswordResetRateLimitedError';

describe('PasswordResetService.requestReset', () => {
  let userRepo: {
    findByEmail: jest.Mock;
  };
  let tokenRepo: {
    create: jest.Mock;
  };
  let rateLimiter: {
    checkRateLimit: jest.Mock;
  };
  let mailer: {
    sendPasswordReset: jest.Mock;
  };
  let logger: {
    warn: jest.Mock;
    error: jest.Mock;
    info: jest.Mock;
  };
  let service: PasswordResetService;

  const email = 'user@example.org';

  beforeEach(() => {
    userRepo = {
      findByEmail: jest.fn().mockResolved({ id: 'user-1', email }),
    };
    tokenRepo = {
      create: jest.fn().mockResolved({ token: 'token-1' }),
    };
    rateLimiter = {
      checkRateLimit: jest.fn().mockResolved({ allowed: true, retryAfterSeconds: 0 }),
    };
    mailer = {
      sendPasswordReset: jest.fn().mockResolved(undefined),
    };
    logger = {
      warn: jest.fn(),
      error: jest.fn(),
      info: jest.fn(),
    };
    service = new PasswordResetService({
      userRepo,
      tokenRepo,
      rateLimiter,
      mailer,
      logger,
    });
  });

  it('sends a reset email and creates a token when allowed', async () => {
    await service.requestReset(email);

    expect(rateLimiter.checkRateLimit).toHaveBeenCalledWith(email);
    expect(tokenRepo.create).toHaveBeenCalled();
    expect(mailer.sendPasswordReset).toHaveBeenCalled();
  });

  it('rejects with PasswordResetRateLimitedError and sends no email when limited (regression)', async () => {
    rateLimiter.checkRateLimit.mockResolved({ allowed: false, retryAfterSeconds: 60 });

    await expect(service.requestReset(email)).rejects.toBeInstanceOf(
      PasswordResetRateLimitedError,
    );

    expect(tokenRepo.create).not.toHaveBeenCalled();
    expect(mailer.sendPasswordReset).not.toHaveBeenCalled();
  });

  it('includes the retry-after value on the rate-limited error', async () => {
    rateLimiter.checkRateLimit.mockResolved({ allowed: false, retryAfterSeconds: 42 });

    await expect(service.requestReset(email)).rejects.toMatchObject({
      retryAfterSeconds: 42,
    });
  });

  it('fails open and logs a warning when the limiter throws', async () => {
    const infraError = new Error('redis outage');
    rateLimiter.checkRateLimit.mockRejected(infraError);

    await service.requestReset(email);

    expect(logger.warn).toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
    expect(tokenRepo.create).toHaveBeenCalled();
    expect(mailer.sendPasswordReset).toHaveBeenCalled();
  });

  it('does not send an email when the user does not exist', async () => {
    userRepo.findByEmail.mockResolved(null);

    await service.requestReset(email);

    expect(tokenRepo.create).not.toHaveBeenCalled();
    expect(mailer.sendPasswordReset).not.toHaveBeenCalled();
  });
});