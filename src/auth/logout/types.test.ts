import { AuthContext, AuthenticatedRequest, SessionRepository } from './types';

describe('AuthContext', () => {
  describe('valid instances', () => {
    it('can be created with required userId and sessionId', () => {
      const context: AuthContext = {
        userId: 'user-123',
        sessionId: 'session-abc',
      };

      expect(context.userId).toBe('user-123');
      expect(context.sessionId).toBe('session-abc');
      expect(context.tokenId).toBeUndefined();
    });

    it('can be created with all fields including optional tokenId', () => {
      const context: AuthContext = {
        userId: 'user-123',
        sessionId: 'session-abc',
        tokenId: 'token-xyz',
      };

      expect(context.userId).toBe('user-123');
      expect(context.sessionId).toBe('session-abc');
      expect(context.tokenId).toBe('token-xyz');
    });

    it('allows empty string values for userId and sessionId', () => {
      const context: AuthContext = {
        userId: '',
        sessionId: '',
      };

      expect(context.userId).toBe('');
      expect(context.sessionId).toBe('');
    });

    it('allows whitespace-only values', () => {
      const context: AuthContext = {
        userId: '  ',
        sessionId: '\t\n',
      };

      expect(context.userId).toBe('  ');
      expect(context.sessionId).toBe('\t\n');
    });

    it('allows Unicode characters in all fields', () => {
      const context: AuthContext = {
        userId: '用户-123',
        sessionId: 'сессия-🔥',
        tokenId: 'トークン-🎫',
      };

      expect(context.userId).toBe('用户-123');
      expect(context.sessionId).toBe('сессия-🔥');
      expect(context.tokenId).toBe('トークン-🎫');
    });

    it('allows very long string values', () => {
      const longString = 'x'.repeat(10_000);
      const context: AuthContext = {
        userId: longString,
        sessionId: longString,
        tokenId: longString,
      };

      expect(context.userId).toHaveLength(10_000);
      expect(context.sessionId).toHaveLength(10_000);
      expect(context.tokenId).toHaveLength(10_000);
    });

    it('allows special characters in all fields', () => {
      const context: AuthContext = {
        userId: 'user!@#$%^&*()',
        sessionId: 'session-_-.',
        tokenId: 'token/\\|',
      };

      expect(context.userId).toBe('user!@#$%^&*()');
      expect(context.sessionId).toBe('session-_-.');
      expect(context.tokenId).toBe('token/\\|');
    });
  });

  describe('structural typing', () => {
    it('accepts object literals with extra properties (structural typing)', () => {
      const context = {
        userId: 'user-123',
        sessionId: 'session-abc',
        tokenId: 'token-xyz',
        extraField: 'ignored',
      };

      const typedContext: AuthContext = context;
      expect(typedContext.userId).toBe('user-123');
      expect(typedContext.sessionId).toBe('session-abc');
      expect(typedContext.tokenId).toBe('token-xyz');
    });

    it('is compatible with narrower types', () => {
      const base: AuthContext = {
        userId: 'user-123',
        sessionId: 'session-abc',
      };

      const withToken: AuthContext = {
        ...base,
        tokenId: 'token-xyz',
      };

      expect(withToken.tokenId).toBe('token-xyz');
    });
  });

  describe('type guards and narrowing', () => {
    it('can be distinguished by presence of tokenId', () => {
      const withoutToken: AuthContext = { userId: 'u1', sessionId: 's1' };
      const withToken: AuthContext = { userId: 'u2', sessionId: 's2', tokenId: 't1' };

      const hasToken = (ctx: AuthContext): ctx is AuthContext & { tokenId: string } => {
        return typeof ctx.tokenId === 'string';
      };

      expect(hasToken(withToken)).toBe(true);
      expect(hasToken(withoutToken)).toBe(false);
    });

    it('can be used in switch-like narrowing', () => {
      const contexts: AuthContext[] = [
        { userId: 'u1', sessionId: 's1' },
        { userId: 'u2', sessionId: 's2', tokenId: 't2' },
        { userId: 'u3', sessionId: 's3' },
      ];

      const withTokens = contexts.filter((c): c is AuthContext & { tokenId: string } => !!c.tokenId);

      expect(withTokens).toHaveLength(1);
      expect(withTokens[0].tokenId).toBe('t2');
    });
  });
});

describe('AuthenticatedRequest', () => {
  describe('extends Request with optional auth', () => {
    it('can be created without auth property', () => {
      const req = {} as AuthenticatedRequest;

      expect(req.auth).toBeUndefined();
    });

    it('can be created with auth property', () => {
      const req = {
        auth: {
          userId: 'user-123',
          sessionId: 'session-abc',
          tokenId: 'token-xyz',
        },
      } as AuthenticatedRequest;

      expect(req.auth).toBeDefined();
      expect(req.auth?.userId).toBe('user-123');
      expect(req.auth?.sessionId).toBe('session-abc');
      expect(req.auth?.tokenId).toBe('token-xyz');
    });

    it('can have auth set to undefined explicitly', () => {
      const req = {
        auth: undefined,
      } as AuthenticatedRequest;

      expect(req.auth).toBeUndefined();
    });

    it('inherits Request properties', () => {
      const req = {
        method: 'POST',
        url: '/api/auth/logout',
        headers: { authorization: 'Bearer token' },
        auth: { userId: 'user-1', sessionId: 'session-1' },
      } as AuthenticatedRequest;

      expect(req.method).toBe('POST');
      expect(req.url).toBe('/api/auth/logout');
      expect(req.headers.authorization).toBe('Bearer token');
    });
  });

  describe('type narrowing with auth guard', () => {
    function assertAuth(req: AuthenticatedRequest): asserts req is AuthenticatedRequest & { auth: AuthContext } {
      if (!req.auth) {
        throw new Error('Unauthorized');
      }
    }

    it('narrows auth to required after assertion', () => {
      const req = {
        auth: { userId: 'user-1', sessionId: 'session-1' },
      } as AuthenticatedRequest;

      assertAuth(req);

      expect(req.auth.userId).toBe('user-1');
      expect(req.auth.sessionId).toBe('session-1');
    });

    it('throws when auth is missing', () => {
      const req = {} as AuthenticatedRequest;

      expect(() => assertAuth(req)).toThrow('Unauthorized');
    });

    it('throws when auth is explicitly undefined', () => {
      const req = { auth: undefined } as AuthenticatedRequest;

      expect(() => assertAuth(req)).toThrow('Unauthorized');
    });
  });
});

describe('SessionRepository', () => {
  describe('interface contract', () => {
    class ValidRepository implements SessionRepository {
      private deleted: string[] = [];

      async deleteSessionById(sessionId: string): Promise<void> {
        this.deleted.push(sessionId);
      }

      getDeleted(): string[] {
        return this.deleted;
      }
    }

    it('requires deleteSessionById method', () => {
      const repo = new ValidRepository();
      expect(typeof repo.deleteSessionById).toBe('function');
    });

    it('deleteSessionById accepts string and returns Promise<void>', async () => {
      const repo = new ValidRepository();

      await expect(repo.deleteSessionById('session-123')).resolves.toBeUndefined();
      expect(repo.getDeleted()).toContain('session-123');
    });

    it('can be called multiple times', async () => {
      const repo = new ValidRepository();

      await repo.deleteSessionById('session-1');
      await repo.deleteSessionById('session-2');
      await repo.deleteSessionById('session-3');

      expect(repo.getDeleted()).toEqual(['session-1', 'session-2', 'session-3']);
    });

    it('accepts empty string sessionId', async () => {
      const repo = new ValidRepository();

      await repo.deleteSessionById('');
      expect(repo.getDeleted()).toContain('');
    });

    it('accepts Unicode sessionId', async () => {
      const repo = new ValidRepository();
      const unicodeId = 'session-🔥-test';

      await repo.deleteSessionById(unicodeId);
      expect(repo.getDeleted()).toContain(unicodeId);
    });

    it('accepts very long sessionId', async () => {
      const repo = new ValidRepository();
      const longId = 'x'.repeat(10_000);

      await repo.deleteSessionById(longId);
      expect(repo.getDeleted()).toContain(longId);
    });
  });

  describe('error handling', () => {
    class FailingRepository implements SessionRepository {
      constructor(private readonly error: Error) {}

      async deleteSessionById(): Promise<void> {
        throw this.error;
      }
    }

    it('propagates errors thrown by implementation', async () => {
      const repo = new FailingRepository(new Error('Database unavailable'));

      await expect(repo.deleteSessionById('session-1')).rejects.toThrow('Database unavailable');
    });

    it('propagates TypeError', async () => {
      const repo = new FailingRepository(new TypeError('Invalid session ID type'));

      await expect(repo.deleteSessionById('session-1')).rejects.toThrow(TypeError);
    });

    it('propagates any rejection reason', async () => {
      const repo = new FailingRepository(new Error('Network timeout'));

      await expect(repo.deleteSessionById('session-1')).rejects.toMatchObject({
        message: 'Network timeout',
      });
    });
  });

  describe('state transitions', () => {
    class TrackingRepository implements SessionRepository {
      private states: Map<string, 'pending' | 'deleted' | 'failed'> = new Map();
      private failNext = false;

      async deleteSessionById(sessionId: string): Promise<void> {
        if (this.failNext) {
          this.failNext = false;
          this.states.set(sessionId, 'failed');
          throw new Error('Simulated failure');
        }
        this.states.set(sessionId, 'deleted');
      }

      setFailNext(fail: boolean): void {
        this.failNext = fail;
      }

      getState(sessionId: string): string | undefined {
        return this.states.get(sessionId);
      }
    }

    it('tracks successful deletion state', async () => {
      const repo = new TrackingRepository();

      await repo.deleteSessionById('session-1');

      expect(repo.getState('session-1')).toBe('deleted');
    });

    it('tracks failed deletion state', async () => {
      const repo = new TrackingRepository();
      repo.setFailNext(true);

      await expect(repo.deleteSessionById('session-1')).rejects.toThrow();

      expect(repo.getState('session-1')).toBe('failed');
    });

    it('allows retry after failure', async () => {
      const repo = new TrackingRepository();
      repo.setFailNext(true);

      await expect(repo.deleteSessionById('session-1')).rejects.toThrow();
      expect(repo.getState('session-1')).toBe('failed');

      await repo.deleteSessionById('session-1');
      expect(repo.getState('session-1')).toBe('deleted');
    });

    it('maintains independent state per sessionId', async () => {
      const repo = new TrackingRepository();

      await repo.deleteSessionById('session-a');
      repo.setFailNext(true);
      await expect(repo.deleteSessionById('session-b')).rejects.toThrow();

      expect(repo.getState('session-a')).toBe('deleted');
      expect(repo.getState('session-b')).toBe('failed');
    });
  });

  describe('conformance testing', () => {
    it('any object with deleteSessionById is structurally compatible', async () => {
      const adHocRepo = {
        async deleteSessionById(): Promise<void> {
          return Promise.resolve();
        },
      };

      const repo: SessionRepository = adHocRepo;
      await expect(repo.deleteSessionById('test')).resolves.toBeUndefined();
    });

    it('class implementations work polymorphically', async () => {
      class MemoryRepo implements SessionRepository {
        private store = new Set<string>();

        async deleteSessionById(sessionId: string): Promise<void> {
          this.store.add(sessionId);
        }

        has(sessionId: string): boolean {
          return this.store.has(sessionId);
        }
      }

      class LoggingRepo implements SessionRepository {
        constructor(private readonly delegate: SessionRepository) {}

        async deleteSessionById(sessionId: string): Promise<void> {
          console.log(`Deleting session: ${sessionId}`);
          await this.delegate.deleteSessionById(sessionId);
        }
      }

      const memory = new MemoryRepo();
      const logged = new LoggingRepo(memory);

      await logged.deleteSessionById('session-1');
      expect(memory.has('session-1')).toBe(true);
    });
  });
});

describe('Type integration', () => {
  it('AuthContext works with AuthenticatedRequest', () => {
    const context: AuthContext = {
      userId: 'user-123',
      sessionId: 'session-abc',
      tokenId: 'token-xyz',
    };

    const req: AuthenticatedRequest = {
      auth: context,
    } as AuthenticatedRequest;

    expect(req.auth).toEqual(context);
  });

  it('SessionRepository can be used with AuthContext sessionId', async () => {
    class TestRepo implements SessionRepository {
      deletedId: string | null = null;

      async deleteSessionById(sessionId: string): Promise<void> {
        this.deletedId = sessionId;
      }
    }

    const repo = new TestRepo();
    const context: AuthContext = {
      userId: 'user-1',
      sessionId: 'session-abc',
    };

    await repo.deleteSessionById(context.sessionId);

    expect(repo.deletedId).toBe('session-abc');
  });

  it('AuthenticatedRequest with AuthContext integrates with SessionRepository', async () => {
    class TestRepo implements SessionRepository {
      deletedId: string | null = null;

      async deleteSessionById(sessionId: string): Promise<void> {
        this.deletedId = sessionId;
      }
    }

    const repo = new TestRepo();
    const req: AuthenticatedRequest = {
      auth: {
        userId: 'user-1',
        sessionId: 'session-xyz',
        tokenId: 'token-123',
      },
    } as AuthenticatedRequest;

    if (req.auth) {
      await repo.deleteSessionById(req.auth.sessionId);
    }

    expect(repo.deletedId).toBe('session-xyz');
  });
});