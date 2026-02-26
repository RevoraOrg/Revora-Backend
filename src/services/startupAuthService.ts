import { UserRepository, CreateUserInput, User } from '../db/repositories/userRepository';
import { hashPassword } from '../lib/hash';

export interface RegistrationResult {
    success: boolean;
    user?: Omit<User, 'password_hash'>;
    error?: string;
    statusCode: number;
}

export class StartupAuthService {
    constructor(private userRepository: UserRepository) { }

    /**
     * Register a new startup user
     * @param input User registration data
     * @returns Registration result
     */
    async register(input: {
        email: string;
        password: string;
        name?: string;
    }): Promise<RegistrationResult> {
        try {
            // 1. Check if user already exists
            const existingUser = await this.userRepository.findByEmail(input.email);
            if (existingUser) {
                return {
                    success: false,
                    error: 'User with this email already exists',
                    statusCode: 409,
                };
            }

            // 2. Hash password
            const passwordHash = hashPassword(input.password);

            // 3. Create user
            const createInput: CreateUserInput = {
                email: input.email,
                password_hash: passwordHash,
                name: input.name,
                role: 'startup_admin',
            };

            const newUser = await this.userRepository.createUser(createInput);

            // 4. Return success (excluding password hash)
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            const { password_hash, ...userResult } = newUser;

            return {
                success: true,
                user: userResult,
                statusCode: 201,
            };
        } catch (error) {
            console.error('Error in StartupAuthService.register:', error);
            return {
                success: false,
                error: 'An internal server error occurred',
                statusCode: 500,
            };
        }
    }
}
