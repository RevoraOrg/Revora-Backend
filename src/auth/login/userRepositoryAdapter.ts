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
            role: user.role as UserRecord['role'],
            passwordHash: user.password_hash,
        };
    }

    async create(email: string, passwordHash: string, role: string): Promise<UserRecord> {
        const user = await this.dbRepo.create(email, passwordHash, role);

        return {
            id: user.id,
            email: user.email,
            role: user.role as UserRecord['role'],
            passwordHash: user.password_hash,
        };
    }

    async findById(id: string): Promise<UserRecord | null> {
        const user = await this.dbRepo.findById(id);
        if (!user) return null;

        return {
            id: user.id,
            email: user.email,
            role: user.role as UserRecord['role'],
            passwordHash: user.password_hash,
        };
    }

    async update(id: string, updates: Partial<UserRecord>): Promise<UserRecord> {
        const user = await this.dbRepo.update(id, updates);

        return {
            id: user.id,
            email: user.email,
            role: user.role as UserRecord['role'],
            passwordHash: user.password_hash,
        };
    }
}
