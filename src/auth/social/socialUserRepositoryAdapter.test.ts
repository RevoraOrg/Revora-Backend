import { SocialUserRepositoryAdapter } from './socialUserRepositoryAdapter';
import { UserRepository as DbUserRepository } from '../../db/repositories/userRepository';

describe('SocialUserRepositoryAdapter', () => {
  let adapter: SocialUserRepositoryAdapter;
  let mockDbUserRepository: jest.Mocked<Partial<DbUserRepository>>;

  beforeEach(() => {
    mockDbUserRepository = {
      findById: jest.fn(),
      findByEmail: jest.fn(),
    };
    adapter = new SocialUserRepositoryAdapter(mockDbUserRepository as unknown as DbUserRepository);
  });

  describe('findById', () => {
    it('should return a mapped SocialUserRecord when the user exists', async () => {
      const dbUser = {
        id: 'user-123',
        email: 'test@example.com',
        role: 'investor' as const,
        password_hash: 'hashed-password',
      };
      mockDbUserRepository.findById!.mockResolvedValueOnce(dbUser as any);

      const result = await adapter.findById('user-123');

      expect(mockDbUserRepository.findById).toHaveBeenCalledWith('user-123');
      expect(result).toEqual({
        id: 'user-123',
        email: 'test@example.com',
        role: 'investor',
        passwordHash: 'hashed-password',
      });
    });

    it('should return null when the user does not exist', async () => {
      mockDbUserRepository.findById!.mockResolvedValueOnce(null);

      const result = await adapter.findById('non-existent');

      expect(mockDbUserRepository.findById).toHaveBeenCalledWith('non-existent');
      expect(result).toBeNull();
    });
  });

  describe('findByEmail', () => {
    it('should return a mapped SocialUserRecord when the user exists', async () => {
      const dbUser = {
        id: 'user-456',
        email: 'startup@example.com',
        role: 'startup' as const,
        password_hash: 'startup-hashed',
      };
      mockDbUserRepository.findByEmail!.mockResolvedValueOnce(dbUser as any);

      const result = await adapter.findByEmail('startup@example.com');

      expect(mockDbUserRepository.findByEmail).toHaveBeenCalledWith('startup@example.com');
      expect(result).toEqual({
        id: 'user-456',
        email: 'startup@example.com',
        role: 'startup',
        passwordHash: 'startup-hashed',
      });
    });

    it('should return null when the user does not exist by email', async () => {
      mockDbUserRepository.findByEmail!.mockResolvedValueOnce(null);

      const result = await adapter.findByEmail('notfound@example.com');

      expect(mockDbUserRepository.findByEmail).toHaveBeenCalledWith('notfound@example.com');
      expect(result).toBeNull();
    });
  });
});
