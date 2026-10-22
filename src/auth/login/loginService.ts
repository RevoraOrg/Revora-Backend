import { randomUUID } from 'node:crypto';
import { comparePassword } from '../../utils/password';
import {
    JwtIssuer,
    LoginSuccessResponse,
    SessionRepository,
    UserRepository,
} from './types';
import { hashSessionToken, SESSION_TTL_MS } from '../session';

/**
 * Domain service that orchestrates the login flow:
 *
 *  1. Look up the user by email.
 *  2. Compare the provided password against the stored hash and reject
 *     deactivated accounts.
 *  3. Generate a new session ID.
 *  4. Issue tokens embedding the session ID.
 *  5. Persist the session with the refresh token hash.
 */
export class LoginService {
    constructor(
        private readonly userRepository: UserRepository,
        private readonly sessionRepository: SessionRepository,
        private readonly jwtIssuer: JwtIssuer,
    ) { }

    /**
     * Attempt to log a user in.
     *
     * @returns The signed JWTs and a subset of user data on success,
     *          or `null` when the credentials are invalid.
     */
    async login(
        email: string,
        password: string,
    ): Promise<LoginSuccessResponse | null> {
        // 1. Resolve user
        const user = await this.userRepository.findByEmail(email);

        if (!user) {
            return null;
        }

        // 2. Verify password (supports scrypt and legacy SHA-256)
        const isMatch = await comparePassword(password, user.passwordHash);
        if (!isMatch) {
            return null;
        }

        // Deactivated (#1300). Same result as a wrong password, and checked
        // after it so the timing doesn't give the account state away.
        if (user.isActive === false) {
            return null;
        }

        // 3. Generate session ID
        const sessionId = randomUUID();

        // 4. Issue tokens
        const tokens = this.jwtIssuer.sign({
            userId: user.id,
            sessionId,
            role: user.role,
        });

        // 5. Persist session
        const tokenHash = createHash('sha256')
            .update(tokens.refreshToken)
            .digest('hex');

        const expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + 7); // 7 days

        await this.sessionRepository.createSession({
            id: sessionId,
            userId: user.id,
            tokenHash,
            expiresAt,
        });

        return {
            ...tokens,
            user: {
                id: user.id,
                email: user.email,
                role: user.role,
            },
        };
    }
}
