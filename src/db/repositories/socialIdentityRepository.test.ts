import { Pool } from 'pg';
import { SocialIdentityRepository } from './socialIdentityRepository';
import { SocialAuthProvider } from '../../auth/social/types';

describe('SocialIdentityRepository', () => {
  let pool: Pool;
  let repository: SocialIdentityRepository;

  beforeEach(() => {
    pool = {
      query: jest.fn(),
    } as unknown as Pool;
    repository = new SocialIdentityRepository(pool);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('findByProviderSubject', () => {
    it('returns the identity when found', async () => {
      const mockRow = {
        id: 'id-123',
        user_id: 'user-123',
        provider: 'google',
        provider_subject: 'subject-123',
        provider_email: 'test@example.com',
        email_verified: true,
        is_private_relay: false,
        created_at: new Date('2023-01-01T00:00:00Z'),
        updated_at: new Date('2023-01-01T00:00:00Z'),
      };

      (pool.query as jest.Mock).mockResolvedValueOnce({ rows: [mockRow], rowCount: 1 });

      const result = await repository.findByProviderSubject('google' as SocialAuthProvider, 'subject-123');

      expect(pool.query).toHaveBeenCalledWith(
        expect.stringContaining('SELECT *'),
        ['google', 'subject-123'],
      );
      expect(result).toEqual({
        id: 'id-123',
        userId: 'user-123',
        provider: 'google',
        providerSubject: 'subject-123',
        providerEmail: 'test@example.com',
        emailVerified: true,
        isPrivateRelay: false,
        createdAt: mockRow.created_at,
        updatedAt: mockRow.updated_at,
      });
    });

    it('returns null when not found', async () => {
      (pool.query as jest.Mock).mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const result = await repository.findByProviderSubject('google' as SocialAuthProvider, 'subject-123');

      expect(result).toBeNull();
    });
  });

  describe('findByUserAndProvider', () => {
    it('returns the identity when found', async () => {
      const mockRow = {
        id: 'id-123',
        user_id: 'user-123',
        provider: 'apple',
        provider_subject: 'subject-123',
        provider_email: 'test@apple.com',
        email_verified: true,
        is_private_relay: true,
        created_at: new Date('2023-01-01T00:00:00Z'),
        updated_at: new Date('2023-01-01T00:00:00Z'),
      };

      (pool.query as jest.Mock).mockResolvedValueOnce({ rows: [mockRow], rowCount: 1 });

      const result = await repository.findByUserAndProvider('user-123', 'apple' as SocialAuthProvider);

      expect(pool.query).toHaveBeenCalledWith(
        expect.stringContaining('SELECT *'),
        ['user-123', 'apple'],
      );
      expect(result).toEqual({
        id: 'id-123',
        userId: 'user-123',
        provider: 'apple',
        providerSubject: 'subject-123',
        providerEmail: 'test@apple.com',
        emailVerified: true,
        isPrivateRelay: true,
        createdAt: mockRow.created_at,
        updatedAt: mockRow.updated_at,
      });
    });

    it('returns null when not found', async () => {
      (pool.query as jest.Mock).mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const result = await repository.findByUserAndProvider('user-123', 'apple' as SocialAuthProvider);

      expect(result).toBeNull();
    });
  });

  describe('createIdentity', () => {
    it('creates and returns a new identity', async () => {
      const input = {
        userId: 'user-123',
        provider: 'google' as SocialAuthProvider,
        providerSubject: 'subject-123',
        providerEmail: 'test@example.com',
        emailVerified: true,
      };

      const mockRow = {
        id: 'id-123',
        user_id: input.userId,
        provider: input.provider,
        provider_subject: input.providerSubject,
        provider_email: input.providerEmail,
        email_verified: input.emailVerified,
        is_private_relay: false,
        created_at: new Date('2023-01-01T00:00:00Z'),
        updated_at: new Date('2023-01-01T00:00:00Z'),
      };

      (pool.query as jest.Mock).mockResolvedValueOnce({ rows: [mockRow], rowCount: 1 });

      const result = await repository.createIdentity(input);

      expect(pool.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO social_identities'),
        [input.userId, input.provider, input.providerSubject, input.providerEmail, input.emailVerified, false],
      );
      expect(result).toEqual({
        id: 'id-123',
        userId: input.userId,
        provider: input.provider,
        providerSubject: input.providerSubject,
        providerEmail: input.providerEmail,
        emailVerified: input.emailVerified,
        isPrivateRelay: false,
        createdAt: mockRow.created_at,
        updatedAt: mockRow.updated_at,
      });
    });

    it('creates and returns a new identity with isPrivateRelay provided', async () => {
      const input = {
        userId: 'user-123',
        provider: 'apple' as SocialAuthProvider,
        providerSubject: 'subject-123',
        providerEmail: 'test@apple.com',
        emailVerified: true,
        isPrivateRelay: true,
      };

      const mockRow = {
        id: 'id-123',
        user_id: input.userId,
        provider: input.provider,
        provider_subject: input.providerSubject,
        provider_email: input.providerEmail,
        email_verified: input.emailVerified,
        is_private_relay: input.isPrivateRelay,
        created_at: new Date('2023-01-01T00:00:00Z'),
        updated_at: new Date('2023-01-01T00:00:00Z'),
      };

      (pool.query as jest.Mock).mockResolvedValueOnce({ rows: [mockRow], rowCount: 1 });

      const result = await repository.createIdentity(input);

      expect(pool.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO social_identities'),
        [input.userId, input.provider, input.providerSubject, input.providerEmail, input.emailVerified, true],
      );
      expect(result.isPrivateRelay).toBe(true);
    });
  });

  describe('updateIdentityEmail', () => {
    it('updates email when isPrivateRelay is undefined', async () => {
      (pool.query as jest.Mock).mockResolvedValueOnce({ rowCount: 1 });

      await repository.updateIdentityEmail('id-123', 'new@example.com');

      expect(pool.query).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE social_identities'),
        ['new@example.com', 'id-123'],
      );
      expect(pool.query).toHaveBeenCalledWith(
        expect.not.stringContaining('is_private_relay ='),
        expect.any(Array)
      );
    });

    it('updates email and isPrivateRelay when provided', async () => {
      (pool.query as jest.Mock).mockResolvedValueOnce({ rowCount: 1 });

      await repository.updateIdentityEmail('id-123', 'new@apple.com', true);

      expect(pool.query).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE social_identities'),
        ['new@apple.com', true, 'id-123'],
      );
      expect(pool.query).toHaveBeenCalledWith(
        expect.stringContaining('is_private_relay = $2'),
        expect.any(Array)
      );
    });
  });

  describe('deleteByUserAndProvider', () => {
    it('returns true if rows were deleted', async () => {
      (pool.query as jest.Mock).mockResolvedValueOnce({ rowCount: 1 });

      const result = await repository.deleteByUserAndProvider('user-123', 'google' as SocialAuthProvider);

      expect(pool.query).toHaveBeenCalledWith(
        expect.stringContaining('DELETE FROM social_identities'),
        ['user-123', 'google'],
      );
      expect(result).toBe(true);
    });

    it('returns false if no rows were deleted', async () => {
      (pool.query as jest.Mock).mockResolvedValueOnce({ rowCount: 0 });

      const result = await repository.deleteByUserAndProvider('user-123', 'google' as SocialAuthProvider);

      expect(result).toBe(false);
    });
  });
});
