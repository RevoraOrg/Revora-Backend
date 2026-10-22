import { LogoutService } from './logoutService';
import { SessionRepository } from './types';

class MockSessionRepository implements SessionRepository {
  deleteSessionById = jest.fn<Promise<void>, [string]>();
}

describe('LogoutService', () => {
  let repository: MockSessionRepository;
  let service: LogoutService;

  beforeEach(() => {
    repository = new MockSessionRepository();
    service = new LogoutService(repository);
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ── 1. Success path ──────────────────────────────────────────────────

  describe('logout()', () => {
    it('calls deleteSessionById with the provided sessionId', async () => {
      repository.deleteSessionById.mockResolvedValue(undefined);

      await service.logout('session-abc');

      expect(repository.deleteSessionById).toHaveBeenCalledTimes(1);
      expect(repository.deleteSessionById).toHaveBeenCalledWith('session-abc');
    });

    it('resolves when deleteSessionById resolves', async () => {
      repository.deleteSessionById.mockResolvedValue(undefined);

      await expect(service.logout('session-abc')).resolves.toBeUndefined();
    });

    it('delegates to the repository exactly once per logout call', async () => {
      repository.deleteSessionById.mockResolvedValue(undefined);

      await service.logout('session-1');
      await service.logout('session-2');

      expect(repository.deleteSessionById).toHaveBeenCalledTimes(2);
      expect(repository.deleteSessionById).toHaveBeenNthCalledWith(1, 'session-1');
      expect(repository.deleteSessionById).toHaveBeenNthCalledWith(2, 'session-2');
    });

    it('propagates the correct sessionId across concurrent calls', async () => {
      repository.deleteSessionById.mockImplementation(
        () => Promise.resolve(),
      );

      await Promise.all([
        service.logout('session-alpha'),
        service.logout('session-beta'),
      ]);

      expect(repository.deleteSessionById).toHaveBeenNthCalledWith(1, 'session-alpha');
      expect(repository.deleteSessionById).toHaveBeenNthCalledWith(2, 'session-beta');
    });
  });

  // ── 2. Invalid inputs ────────────────────────────────────────────────

  describe('logout() with invalid inputs', () => {
    it('calls deleteSessionById with an empty string sessionId', async () => {
      repository.deleteSessionById.mockResolvedValue(undefined);

      await service.logout('');

      expect(repository.deleteSessionById).toHaveBeenCalledWith('');
    });

    it('calls deleteSessionById with a whitespace-only sessionId', async () => {
      repository.deleteSessionById.mockResolvedValue(undefined);

      await service.logout('   ');

      expect(repository.deleteSessionById).toHaveBeenCalledWith('   ');
    });

    it('calls deleteSessionById with a sessionId containing special characters', async () => {
      repository.deleteSessionById.mockResolvedValue(undefined);

      await service.logout('session!@#$%^&*()');

      expect(repository.deleteSessionById).toHaveBeenCalledWith('session!@#$%^&*()');
    });

    it('calls deleteSessionById with a very long sessionId', async () => {
      const longSessionId = 'x'.repeat(10_000);
      repository.deleteSessionById.mockResolvedValue(undefined);

      await service.logout(longSessionId);

      expect(repository.deleteSessionById).toHaveBeenCalledWith(longSessionId);
    });

    it('calls deleteSessionById with a Unicode sessionId', async () => {
      const unicodeSessionId = 'session-🔥-test';
      repository.deleteSessionById.mockResolvedValue(undefined);

      await service.logout(unicodeSessionId);

      expect(repository.deleteSessionById).toHaveBeenCalledWith(unicodeSessionId);
    });
  });

  // ── 3. Error paths ───────────────────────────────────────────────────

  describe('logout() error propagation', () => {
    it('throws when deleteSessionById rejects', async () => {
      const error = new Error('Database failure');
      repository.deleteSessionById.mockRejectedValue(error);

      await expect(service.logout('session-abc')).rejects.toThrow('Database failure');
    });

    it('propagates a TypeError from the repository', async () => {
      repository.deleteSessionById.mockRejectedValue(new TypeError('Invalid session type'));

      await expect(service.logout('session-abc')).rejects.toThrow(TypeError);
    });

    it('propagates a generic Error when the repository fails', async () => {
      repository.deleteSessionById.mockRejectedValue(new Error('Network timeout'));

      await expect(service.logout('session-abc')).rejects.toThrow('Network timeout');
    });

    it('propagates a string error from the repository', async () => {
      repository.deleteSessionById.mockRejectedValue('unknown error');

      await expect(service.logout('session-abc')).rejects.toBe('unknown error');
    });

    it('propagates a null error from the repository', async () => {
      repository.deleteSessionById.mockRejectedValue(null);

      await expect(service.logout('session-abc')).rejects.toBeNull();
    });

    it('does not swallow errors — the rejection reason matches exactly', async () => {
      const error = new Error('Session not found');
      repository.deleteSessionById.mockRejectedValue(error);

      await expect(service.logout('session-abc')).rejects.toBe(error);
    });

    it('propagates the error on every subsequent call after a failure', async () => {
      const error = new Error('Persistent failure');
      repository.deleteSessionById.mockRejectedValue(error);

      await expect(service.logout('session-1')).rejects.toThrow('Persistent failure');
      await expect(service.logout('session-2')).rejects.toThrow('Persistent failure');
      expect(repository.deleteSessionById).toHaveBeenCalledTimes(2);
    });
  });

  // ── 4. State transitions ─────────────────────────────────────────────

  describe('logout() state transitions', () => {
    it('verifiedDeleteSessionById is called after logout is invoked', async () => {
      repository.deleteSessionById.mockResolvedValue(undefined);

      const callOrder: string[] = [];
      repository.deleteSessionById.mockImplementation((id: string) => {
        callOrder.push(`delete:${id}`);
        return Promise.resolve();
      });

      await service.logout('pre-logout-session');

      expect(callOrder).toContain('delete:pre-logout-session');
    });

    it('repository deleteSessionById is not called before logout', () => {
      expect(repository.deleteSessionById).not.toHaveBeenCalled();
    });

    it('multiple independent service instances do not share repository state', async () => {
      repository.deleteSessionById.mockResolvedValue(undefined);

      const anotherService = new LogoutService(repository);

      await service.logout('session-from-first');
      await anotherService.logout('session-from-second');

      expect(repository.deleteSessionById).toHaveBeenCalledTimes(2);
      expect(repository.deleteSessionById).toHaveBeenNthCalledWith(1, 'session-from-first');
      expect(repository.deleteSessionById).toHaveBeenNthCalledWith(2, 'session-from-second');
    });

    it('service retains the same repository instance across calls', async () => {
      repository.deleteSessionById.mockResolvedValue(undefined);

      await service.logout('session-1');
      await service.logout('session-2');
      await service.logout('session-3');

      expect(repository.deleteSessionById).toHaveBeenCalledTimes(3);
    });
  });

  // ── 5. Determinism and observability ─────────────────────────────────

  describe('logout() determinism', () => {
    it('always calls deleteSessionById for the same sessionId', async () => {
      repository.deleteSessionById.mockResolvedValue(undefined);

      await service.logout('deterministic-session');
      await service.logout('deterministic-session');
      await service.logout('deterministic-session');

      expect(repository.deleteSessionById).toHaveBeenCalledTimes(3);
      expect(repository.deleteSessionById).toHaveBeenCalledWith('deterministic-session');
    });

    it('calls deleteSessionById with different arguments for different sessionIds', async () => {
      repository.deleteSessionById.mockResolvedValue(undefined);

      await service.logout('session-a');
      await service.logout('session-b');
      await service.logout('session-c');

      expect(repository.deleteSessionById).toHaveBeenCalledWith('session-a');
      expect(repository.deleteSessionById).toHaveBeenCalledWith('session-b');
      expect(repository.deleteSessionById).toHaveBeenCalledWith('session-c');
    });
  });
});
