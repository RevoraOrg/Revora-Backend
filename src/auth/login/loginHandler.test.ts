import { NextFunction, Request, Response } from 'express';
import { createLoginHandler } from './loginHandler';
import { LoginService } from './loginService';
import { LoginRequestBody, LoginSuccessResponse } from './types';

class MockResponse {
  statusCode = 200;
  body: unknown;

  status(code: number): this {
    this.statusCode = code;
    return this;
  }

  json(body: unknown): this {
    this.body = body;
    return this;
  }
}

const successResponse: LoginSuccessResponse = {
  accessToken: 'access-token',
  refreshToken: 'refresh-token',
  user: {
    id: 'user-1',
    email: 'user@example.com',
    role: 'investor',
  },
};

function createService(
  result: LoginSuccessResponse | null = successResponse,
): LoginService & { login: jest.Mock } {
  return {
    login: jest.fn().mockResolvedValue(result),
  } as unknown as LoginService & { login: jest.Mock };
}

function createRequest(
  body: unknown,
): Request<unknown, unknown, LoginRequestBody> {
  return { body } as unknown as Request<unknown, unknown, LoginRequestBody>;
}

function createNext(): jest.MockedFunction<NextFunction> {
  return jest.fn();
}

describe('createLoginHandler', () => {
  it('returns the service result with 200 and delegates valid credentials', async () => {
    const loginService = createService();
    const handler = createLoginHandler(loginService);
    const response = new MockResponse();

    await handler(
      createRequest({ email: 'user@example.com', password: 'secret' }),
      response as unknown as Response,
      createNext(),
    );

    expect(loginService.login).toHaveBeenCalledWith('user@example.com', 'secret');
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(successResponse);
  });

  it.each([
    ['missing body', undefined],
    ['missing email', { password: 'secret' }],
    ['missing password', { email: 'user@example.com' }],
    ['empty email', { email: '', password: 'secret' }],
    ['empty password', { email: 'user@example.com', password: '' }],
    ['null email', { email: null, password: 'secret' }],
    ['null password', { email: 'user@example.com', password: null }],
  ])('returns 400 for %s without calling the service', async (_case, body) => {
    const loginService = createService();
    const handler = createLoginHandler(loginService);
    const response = new MockResponse();

    await handler(
      createRequest(body),
      response as unknown as Response,
      createNext(),
    );

    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({
      error: 'Bad Request',
      message: 'Both "email" and "password" are required.',
    });
    expect(loginService.login).not.toHaveBeenCalled();
  });

  it.each([
    ['non-string email', { email: 123, password: 'secret' }],
    ['non-string password', { email: 'user@example.com', password: 123 }],
  ])('returns 400 for %s without calling the service', async (_case, body) => {
    const loginService = createService();
    const handler = createLoginHandler(loginService);
    const response = new MockResponse();

    await handler(
      createRequest(body),
      response as unknown as Response,
      createNext(),
    );

    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({
      error: 'Bad Request',
      message: '"email" and "password" must be strings.',
    });
    expect(loginService.login).not.toHaveBeenCalled();
  });

  it('returns 401 when the service rejects invalid credentials', async () => {
    const loginService = createService(null);
    const handler = createLoginHandler(loginService);
    const response = new MockResponse();

    await handler(
      createRequest({ email: 'user@example.com', password: 'wrong' }),
      response as unknown as Response,
      createNext(),
    );

    expect(response.statusCode).toBe(401);
    expect(response.body).toEqual({ error: 'Invalid email or password' });
  });

  it('forwards service failures to next without writing a response', async () => {
    const failure = new Error('database unavailable');
    const loginService = createService();
    loginService.login.mockRejectedValue(failure);
    const handler = createLoginHandler(loginService);
    const response = new MockResponse();
    const next = createNext();

    await handler(
      createRequest({ email: 'user@example.com', password: 'secret' }),
      response as unknown as Response,
      next,
    );

    expect(next).toHaveBeenCalledWith(failure);
    expect(response.statusCode).toBe(200);
    expect(response.body).toBeUndefined();
  });
});
