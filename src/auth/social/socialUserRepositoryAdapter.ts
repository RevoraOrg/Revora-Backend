import { UserRepository as DbUserRepository } from '../../db/repositories/userRepository';
import { SocialUserRecord, SocialUserRepository } from './types';

export class SocialUserRepositoryAdapter implements SocialUserRepository {
  constructor(private readonly dbUserRepository: DbUserRepository) {}

  async findById(id: string): Promise<SocialUserRecord | null> {
    const user = await this.dbUserRepository.findById(id);
    return user ? this.mapUser(user) : null;
  }

  async findByEmail(email: string): Promise<SocialUserRecord | null> {
    const user = await this.dbUserRepository.findByEmail(email);
    return user ? this.mapUser(user) : null;
  }

  private mapUser(user: {
    id: string;
    email: string;
    role: 'startup' | 'investor';
    password_hash: string;
  }): SocialUserRecord {
    return {
      id: user.id,
      email: user.email,
      role: user.role,
      passwordHash: user.password_hash,
    };
  }
}
