import { StartupAuthService } from './startupAuthService';
import { UserRepository } from '../db/repositories/userRepository';

describe('StartupAuthService', () => {
    let service: StartupAuthService;
    let mockUserRepository: jest.Mocked<UserRepository>;

    beforeEach(() => {
        mockUserRepository = {
            findByEmail: jest.fn(),
            createUser: jest.fn(),
        } as any;

        service = new StartupAuthService(mockUserRepository);
    });

    describe('register', () => {
        it('should register a new user successfully', async () => {
            const input = {
                email: 'test@example.com',
                password: 'password123',
                name: 'Test Startup',
            };

            mockUserRepository.findByEmail.mockResolvedValue(null);
            mockUserRepository.createUser.mockResolvedValue({
                id: 'user-123',
                email: input.email,
                password_hash: 'hashed_password',
                name: input.name,
                role: 'startup_admin',
                created_at: new Date(),
                updated_at: new Date(),
            });

            const result = await service.register(input);

            expect(result.success).toBe(true);
            expect(result.statusCode).toBe(201);
            expect(result.user).toBeDefined();
            expect(result.user?.email).toBe(input.email);
            expect((result.user as any).password_hash).toBeUndefined();
            expect(mockUserRepository.createUser).toHaveBeenCalled();
        });

        it('should return 409 if user already exists', async () => {
            const input = {
                email: 'existing@example.com',
                password: 'password123',
            };

            mockUserRepository.findByEmail.mockResolvedValue({
                id: 'user-123',
                email: input.email,
            } as any);

            const result = await service.register(input);

            expect(result.success).toBe(false);
            expect(result.statusCode).toBe(409);
            expect(result.error).toBe('User with this email already exists');
            expect(mockUserRepository.createUser).not.toHaveBeenCalled();
        });
    });
});
