import { NextFunction, Request, Response } from 'express';
import {
  createSocialLinkHandler,
  createSocialLoginHandler,
  createSocialUnlinkHandler,
} from './socialAuthHandler';
import { SocialAuthError, SocialAuthErrorCode, SocialIdentityRecord } from './types';
import type { SocialAuthService } from './socialAuthService';

/**
 * Focused behaviour suite for `src/auth/social/socialAuthHandler.ts`.
 *
 * The handlers are the HTTP boundary of the Google/Apple social auth flow
 * (login / link / unlink). These tests pin down the contract they expose to
 * callers:
 *   - provider and body validation happens **before** the service is invoked,
 *     so malformed requests cannot reach the verifier or the database;
 *   - every `SocialAuthError` code keeps its documented HTTP status;
 *   - non-`SocialAuthError` rejections are forwarded to `next()` (the error
 *     middleware) instead of being swallowed or answered with a 500 body;
 *   - the success payloads stay exactly as the route contract advertises.
 */

type MockedService = {
  loginWithProvider: jest.Mock;
  linkProvider: jest.Mock;
  unlinkProvider: jest.Mock;
};

interface CapturedResponse {
  res: Response;
  status: jest.Mock;
  json: jest.Mock;
  statusCode: () => number | undefined;
  body: () => unknown;
}

function makeService(): MockedService {
  return {
    loginWithProvider: jest.fn(),
    linkProvider: jest.fn(),
    unlinkProvider: jest.fn(),
  };
}

function makeRequest(overrides: Partial<Record<string, unknown>> = {}): Request {
  return {
    params: {},
    body: {},
    method: 'POST',
    path: '/api/auth/social/provider/login',
    header: () => undefined,
    ...overrides,
  } as unknown as Request;
}

function makeResponse(): CapturedResponse {
  let statusCode: number | undefined;
  let payload: unknown;
  const res = {} as Response;
  const status = jest.fn((code: number) => {
    statusCode = code;
    return res;
  });
  const json = jest.fn((body: unknown) => {
    payload = body;
    return res;
  });
  res.status = status as unknown as Response['status'];
  res.json = json as unknown as Response['json'];
  return { res, status, json, statusCode: () => statusCode, body: () => payload };
}

function makeNext(): jest.Mock<void, [unknown]> {
  return jest.fn<void, [unknown]>();
}

function makeIdentity(overrides: Partial<SocialIdentityRecord> = {}): SocialIdentityRecord {
  return {
    id: 'identity-1',
    userId: 'user-1',
    provider: 'google',
    providerSubject: 'google-sub-1',
    providerEmail: 'user@example.com',
    emailVerified: true,
    isPrivateRelay: false,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

const loginResult = {
  accessToken: 'access-token',
  refreshToken: 'refresh-token',
  user: { id: 'user-1', email: 'user@example.com', role: 'investor' as const },
};

describe('socialAuthHandler', () => {
  let service: MockedService;

  beforeEach(() => {
    service = makeService();
  });

  const asService = () => service as unknown as SocialAuthService;

  describe('createSocialLoginHandler', () => {
    it('returns 200 with the login session payload and forwards provider + idToken', async () => {
      service.loginWithProvider.mockResolvedValue(loginResult);
      const handler = createSocialLoginHandler(asService());
      const res = makeResponse();
      const next = makeNext();

      await handler(
        makeRequest({ params: { provider: 'google' }, body: { idToken: 'id-token' } }),
        res.res,
        next as unknown as NextFunction,
      );

      expect(service.loginWithProvider).toHaveBeenCalledTimes(1);
      expect(service.loginWithProvider).toHaveBeenCalledWith('google', 'id-token');
      expect(res.statusCode()).toBe(200);
      expect(res.body()).toEqual(loginResult);
      expect(next).not.toHaveBeenCalled();
    });

    it('accepts the apple provider', async () => {
      service.loginWithProvider.mockResolvedValue(loginResult);
      const handler = createSocialLoginHandler(asService());
      const res = makeResponse();

      await handler(
        makeRequest({ params: { provider: 'apple' }, body: { idToken: 'apple-token' } }),
        res.res,
        makeNext() as unknown as NextFunction,
      );

      expect(service.loginWithProvider).toHaveBeenCalledWith('apple', 'apple-token');
      expect(res.statusCode()).toBe(200);
    });

    it('rejects an unsupported provider with 400 INVALID_PROVIDER before calling the service', async () => {
      const handler = createSocialLoginHandler(asService());
      const res = makeResponse();

      await handler(
        makeRequest({ params: { provider: 'facebook' }, body: { idToken: 'id-token' } }),
        res.res,
        makeNext() as unknown as NextFunction,
      );

      expect(service.loginWithProvider).not.toHaveBeenCalled();
      expect(res.statusCode()).toBe(400);
      expect(res.body()).toEqual({
        error: 'INVALID_PROVIDER',
        message: 'Unsupported social auth provider.',
      });
    });

    it('rejects a missing provider parameter with 400 INVALID_PROVIDER', async () => {
      const handler = createSocialLoginHandler(asService());
      const res = makeResponse();

      await handler(makeRequest({ params: {}, body: { idToken: 'id-token' } }), res.res, makeNext());

      expect(res.statusCode()).toBe(400);
      expect(res.body()).toEqual(
        expect.objectContaining({ error: 'INVALID_PROVIDER' }),
      );
    });

    it.each([
      ['undefined', undefined],
      ['empty string', ''],
      ['whitespace only', '   '],
      ['non-string', 42],
    ])('rejects %s idToken with 400 INVALID_TOKEN', async (_label, idToken) => {
      const handler = createSocialLoginHandler(asService());
      const res = makeResponse();

      await handler(
        makeRequest({ params: { provider: 'google' }, body: { idToken } }),
        res.res,
        makeNext(),
      );

      expect(service.loginWithProvider).not.toHaveBeenCalled();
      expect(res.statusCode()).toBe(400);
      expect(res.body()).toEqual({ error: 'INVALID_TOKEN', message: 'idToken is required.' });
    });

    it.each([
      ['PROVIDER_NOT_CONFIGURED', 400],
      ['INVALID_TOKEN', 400],
      ['UNVERIFIED_EMAIL', 400],
      ['SOCIAL_IDENTITY_NOT_LINKED', 401],
      ['EMAIL_ACCOUNT_REQUIRES_LINK', 401],
      ['STEP_UP_REQUIRED', 401],
      ['IDENTITY_LINKED_TO_ANOTHER_USER', 409],
      ['USER_NOT_FOUND', 404],
    ] as [SocialAuthErrorCode, number][])(
      'maps SocialAuthError %s to HTTP %i',
      async (code, expectedStatus) => {
        service.loginWithProvider.mockRejectedValue(new SocialAuthError(code, `${code} happened`));
        const handler = createSocialLoginHandler(asService());
        const res = makeResponse();

        await handler(
          makeRequest({ params: { provider: 'google' }, body: { idToken: 'id-token' } }),
          res.res,
          makeNext(),
        );

        expect(res.statusCode()).toBe(expectedStatus);
        expect(res.body()).toEqual({ error: code, message: `${code} happened` });
      },
    );

    it('forwards unexpected errors to next() without writing a response body', async () => {
      const boom = new Error('jwks endpoint unreachable');
      service.loginWithProvider.mockRejectedValue(boom);
      const handler = createSocialLoginHandler(asService());
      const res = makeResponse();
      const next = makeNext();

      await handler(
        makeRequest({ params: { provider: 'google' }, body: { idToken: 'id-token' } }),
        res.res,
        next as unknown as NextFunction,
      );

      expect(next).toHaveBeenCalledTimes(1);
      expect(next).toHaveBeenCalledWith(boom);
      expect(res.status).not.toHaveBeenCalled();
      expect(res.json).not.toHaveBeenCalled();
    });
  });

  describe('createSocialLinkHandler', () => {
    const linkedBody = { idToken: 'id-token', currentPassword: 'hunter2', confirm: true };

    it('links the provider and returns the trimmed success payload', async () => {
      const identity = makeIdentity({ id: 'identity-9', provider: 'apple' });
      service.linkProvider.mockResolvedValue({ linked: true, identity });
      const handler = createSocialLinkHandler(asService());
      const res = makeResponse();

      await handler(
        makeRequest({
          params: { provider: 'apple' },
          body: linkedBody,
          user: { sub: 'user-42' },
        }),
        res.res,
        makeNext(),
      );

      expect(service.linkProvider).toHaveBeenCalledWith({
        userId: 'user-42',
        provider: 'apple',
        idToken: 'id-token',
        currentPassword: 'hunter2',
      });
      expect(res.statusCode()).toBe(200);
      expect(res.body()).toEqual({
        linked: true,
        provider: 'apple',
        providerEmail: 'user@example.com',
      });
    });

    it.each([
      ['user.sub', { user: { sub: 'sub-user' } }],
      ['user.id', { user: { id: 'id-user' } }],
      ['auth.userId', { auth: { userId: 'auth-user' } }],
    ])('resolves the authenticated user from %s', async (_label, authShape) => {
      service.linkProvider.mockResolvedValue({ linked: true, identity: makeIdentity() });
      const handler = createSocialLinkHandler(asService());

      await handler(
        makeRequest({ params: { provider: 'google' }, body: linkedBody, ...authShape }),
        makeResponse().res,
        makeNext(),
      );

      expect(service.linkProvider).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: expect.stringMatching(/(sub|id|auth)-user/),
        }),
      );
    });

    it('requires step-up confirmation before touching the service', async () => {
      const handler = createSocialLinkHandler(asService());
      const res = makeResponse();

      await handler(
        makeRequest({
          params: { provider: 'google' },
          body: { idToken: 'id-token', currentPassword: 'hunter2' },
          user: { sub: 'user-1' },
        }),
        res.res,
        makeNext(),
      );

      expect(service.linkProvider).not.toHaveBeenCalled();
      expect(res.statusCode()).toBe(401);
      expect(res.body()).toEqual({
        error: 'STEP_UP_REQUIRED',
        message: 'Link changes require confirm: true.',
      });
    });

    it('rejects an unauthenticated caller with 401 STEP_UP_REQUIRED', async () => {
      const handler = createSocialLinkHandler(asService());
      const res = makeResponse();

      await handler(
        makeRequest({ params: { provider: 'google' }, body: linkedBody }),
        res.res,
        makeNext(),
      );

      expect(service.linkProvider).not.toHaveBeenCalled();
      expect(res.statusCode()).toBe(401);
      expect(res.body()).toEqual({
        error: 'STEP_UP_REQUIRED',
        message: 'Authenticated user is required.',
      });
    });

    it('rejects a missing currentPassword with 400 INVALID_TOKEN', async () => {
      const handler = createSocialLinkHandler(asService());
      const res = makeResponse();

      await handler(
        makeRequest({
          params: { provider: 'google' },
          body: { idToken: 'id-token', confirm: true },
          user: { sub: 'user-1' },
        }),
        res.res,
        makeNext(),
      );

      expect(service.linkProvider).not.toHaveBeenCalled();
      expect(res.statusCode()).toBe(400);
      expect(res.body()).toEqual({
        error: 'INVALID_TOKEN',
        message: 'currentPassword is required.',
      });
    });

    it('maps IDENTITY_LINKED_TO_ANOTHER_USER to 409', async () => {
      service.linkProvider.mockRejectedValue(
        new SocialAuthError('IDENTITY_LINKED_TO_ANOTHER_USER', 'already linked elsewhere'),
      );
      const handler = createSocialLinkHandler(asService());
      const res = makeResponse();

      await handler(
        makeRequest({ params: { provider: 'google' }, body: linkedBody, user: { sub: 'user-1' } }),
        res.res,
        makeNext(),
      );

      expect(res.statusCode()).toBe(409);
      expect(res.body()).toEqual({
        error: 'IDENTITY_LINKED_TO_ANOTHER_USER',
        message: 'already linked elsewhere',
      });
    });

    it('forwards unexpected errors to next()', async () => {
      const boom = new Error('identity repository offline');
      service.linkProvider.mockRejectedValue(boom);
      const handler = createSocialLinkHandler(asService());
      const res = makeResponse();
      const next = makeNext();

      await handler(
        makeRequest({ params: { provider: 'google' }, body: linkedBody, user: { sub: 'user-1' } }),
        res.res,
        next as unknown as NextFunction,
      );

      expect(next).toHaveBeenCalledWith(boom);
      expect(res.json).not.toHaveBeenCalled();
    });
  });

  describe('createSocialUnlinkHandler', () => {
    it('unlinks the provider and returns the service result', async () => {
      service.unlinkProvider.mockResolvedValue({ unlinked: true });
      const handler = createSocialUnlinkHandler(asService());
      const res = makeResponse();

      await handler(
        makeRequest({
          params: { provider: 'google' },
          body: { currentPassword: 'hunter2', confirm: true },
          user: { sub: 'user-7' },
        }),
        res.res,
        makeNext(),
      );

      expect(service.unlinkProvider).toHaveBeenCalledWith({
        userId: 'user-7',
        provider: 'google',
        currentPassword: 'hunter2',
      });
      expect(res.statusCode()).toBe(200);
      expect(res.body()).toEqual({ unlinked: true });
    });

    it('stays idempotent when the identity was already absent', async () => {
      service.unlinkProvider.mockResolvedValue({ unlinked: false });
      const handler = createSocialUnlinkHandler(asService());
      const res = makeResponse();

      await handler(
        makeRequest({
          params: { provider: 'apple' },
          body: { currentPassword: 'hunter2', confirm: true },
          user: { sub: 'user-7' },
        }),
        res.res,
        makeNext(),
      );

      expect(res.statusCode()).toBe(200);
      expect(res.body()).toEqual({ unlinked: false });
    });

    it('requires step-up confirmation before touching the service', async () => {
      const handler = createSocialUnlinkHandler(asService());
      const res = makeResponse();

      await handler(
        makeRequest({
          params: { provider: 'google' },
          body: { currentPassword: 'hunter2' },
          user: { sub: 'user-7' },
        }),
        res.res,
        makeNext(),
      );

      expect(service.unlinkProvider).not.toHaveBeenCalled();
      expect(res.statusCode()).toBe(401);
      expect(res.body()).toEqual({
        error: 'STEP_UP_REQUIRED',
        message: 'Link changes require confirm: true.',
      });
    });

    it('rejects an unauthenticated caller with 401 STEP_UP_REQUIRED', async () => {
      const handler = createSocialUnlinkHandler(asService());
      const res = makeResponse();

      await handler(
        makeRequest({
          params: { provider: 'google' },
          body: { currentPassword: 'hunter2', confirm: true },
        }),
        res.res,
        makeNext(),
      );

      expect(service.unlinkProvider).not.toHaveBeenCalled();
      expect(res.statusCode()).toBe(401);
      expect(res.body()).toEqual({
        error: 'STEP_UP_REQUIRED',
        message: 'Authenticated user is required.',
      });
    });

    it('rejects an unsupported provider with 400 INVALID_PROVIDER', async () => {
      const handler = createSocialUnlinkHandler(asService());
      const res = makeResponse();

      await handler(
        makeRequest({
          params: { provider: 'github' },
          body: { currentPassword: 'hunter2', confirm: true },
          user: { sub: 'user-7' },
        }),
        res.res,
        makeNext(),
      );

      expect(service.unlinkProvider).not.toHaveBeenCalled();
      expect(res.statusCode()).toBe(400);
      expect(res.body()).toEqual({
        error: 'INVALID_PROVIDER',
        message: 'Unsupported social auth provider.',
      });
    });

    it('maps STEP_UP_REQUIRED from the service to 401', async () => {
      service.unlinkProvider.mockRejectedValue(
        new SocialAuthError('STEP_UP_REQUIRED', 'Current password confirmation is required.'),
      );
      const handler = createSocialUnlinkHandler(asService());
      const res = makeResponse();

      await handler(
        makeRequest({
          params: { provider: 'google' },
          body: { currentPassword: 'wrong', confirm: true },
          user: { sub: 'user-7' },
        }),
        res.res,
        makeNext(),
      );

      expect(res.statusCode()).toBe(401);
      expect(res.body()).toEqual({
        error: 'STEP_UP_REQUIRED',
        message: 'Current password confirmation is required.',
      });
    });

    it('forwards unexpected errors to next()', async () => {
      const boom = new Error('delete failed');
      service.unlinkProvider.mockRejectedValue(boom);
      const handler = createSocialUnlinkHandler(asService());
      const res = makeResponse();
      const next = makeNext();

      await handler(
        makeRequest({
          params: { provider: 'google' },
          body: { currentPassword: 'hunter2', confirm: true },
          user: { sub: 'user-7' },
        }),
        res.res,
        next as unknown as NextFunction,
      );

      expect(next).toHaveBeenCalledWith(boom);
      expect(res.json).not.toHaveBeenCalled();
    });
  });

  describe('SocialAuthError contract', () => {
    it('keeps the code/message and a stable name', () => {
      const error = new SocialAuthError('USER_NOT_FOUND', 'Linked user was not found.');

      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe('SocialAuthError');
      expect(error.code).toBe('USER_NOT_FOUND');
      expect(error.message).toBe('Linked user was not found.');
      expect(Object.getPrototypeOf(error)).toBe(SocialAuthError.prototype);
    });
  });
});
