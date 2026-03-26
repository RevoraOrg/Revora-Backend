import { UserRepository as DBUserRepository } from '../../db/repositories/userRepository';
import { UserRepository, UserRecord } from './types';

export class UserRepositoryAdapter implements UserRepository {
    constructor(private readonly dbRepo: DBUserRepository) {}

    async findByEmail(email: string): Promise<UserRecord | null> {
        const user = await this.dbRepo.findByEmail(email);
        if (!user) return null;
        
        return {
            id: user.id,
            email: user.email,
            role: user.role as any,
            passwordHash: user.password_hash,
        };
    }
}
