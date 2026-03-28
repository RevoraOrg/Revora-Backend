import { NextFunction, Response } from 'express';
import { createLogoutHandler } from './logoutHandler';
import { LogoutService } from './logoutService';
import { AuthenticatedRequest, SessionRepository } from './types';

class InMemorySessionRepository implements SessionRepository {
  constructor(private readonly tokenToSession = new Map<string, string>()) {}

  add(token: string, sessionId: string): void {
    this.tokenToSession.set(token, sessionId);
  }

  getSessionId(token: string): string | undefined {
    return this.tokenToSession.get(token);
  }

  async deleteSessionById(sessionId: string): Promise<void> {
    for (const [token, storedSessionId] of this.tokenToSession.entries()) {
      if (storedSessionId === sessionId) {
        this.tokenToSession.delete(token);
        return;
      }
    }
  }
}

class MockResponse {
  statusCode = 200;
  payload: unknown;

  status(code: number): this {
    this.statusCode = code;
    return this;
  }

  json(payload: unknown): this {
    this.payload = payload;
    return this;
  }

  send(payload?: unknown): this {
    this.payload = payload;
    return this;
  }
}

const createBearerHeader = (token: string): string => `Bearer ${token}`;

const createProtectedAuthMiddleware = (sessions: InMemorySessionRepository) => {
  return (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): void => {
    const bearer = req.headers.authorization;
    const token = bearer?.startsWith('Bearer ') ? bearer.slice(7) : undefined;

    if (!token) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const sessionId = sessions.getSessionId(token);

    if (!sessionId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    req.auth = {
      userId: 'user-1',
      sessionId,
      tokenId: token,
    };

    next();
  };
};

const login = (sessions: InMemorySessionRepository): string => {
  const token = 'jwt-token-1';
  sessions.add(token, 'session-1');
  return token;
};

describe('logout route', () => {
  it('invalidates current session and token can no longer be used', async () => {
    const sessions = new InMemorySessionRepository();
    const requireAuth = createProtectedAuthMiddleware(sessions);
    const logoutHandler = createLogoutHandler(new LogoutService(sessions));

    const token = login(sessions);

    const authorizedRequestBeforeLogout = {
      headers: { authorization: createBearerHeader(token) },
    } as AuthenticatedRequest;

    const authorizedResponseBeforeLogout = new MockResponse() as unknown as Response;

    let nextCalledBeforeLogout = false;
    requireAuth(
      authorizedRequestBeforeLogout,
      authorizedResponseBeforeLogout,
      () => {
        nextCalledBeforeLogout = true;
      },
    );

    expect(nextCalledBeforeLogout).toBe(true);
    expect(authorizedRequestBeforeLogout.auth?.sessionId).toBe('session-1');

    const logoutResponse = new MockResponse();
    await logoutHandler(
      authorizedRequestBeforeLogout,
      logoutResponse as unknown as Response,
      () => undefined,
    );

    expect(logoutResponse.statusCode).toBe(204);

    const authorizedRequestAfterLogout = {
      headers: { authorization: createBearerHeader(token) },
    } as AuthenticatedRequest;

    const unauthorizedResponseAfterLogout = new MockResponse();

    let nextCalledAfterLogout = false;
    requireAuth(
      authorizedRequestAfterLogout,
      unauthorizedResponseAfterLogout as unknown as Response,
      () => {
        nextCalledAfterLogout = true;
      },
    );

    expect(nextCalledAfterLogout).toBe(false);
    expect(unauthorizedResponseAfterLogout.statusCode).toBe(401);
  });
});
