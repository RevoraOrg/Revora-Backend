import { createHash, timingSafeEqual, randomUUID } from 'node:crypto';
import {
    JwtIssuer,
    LoginSuccessResponse,
    SessionRepository,
    UserRepository,
} from './types';
import { hashSessionToken, SESSION_TTL_MS } from '../auth/session';

/**
 * Domain service that orchestrates the login flow:
 *
 *  1. Look up the user by email.
 *  2. Compare the provided password against the stored hash.
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

        // 2. Verify password
        if (!this.verifyPassword(password, user.passwordHash)) {
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

    // ── Private helpers ─────────────────────────────────────────────────

    /**
     * Timing-safe comparison of a plain-text password against a SHA-256
     * hex digest.
     *
     * SHA-256 is used here because the existing project has no bcrypt /
     * argon2 dependency and `package.json` must not be modified.
     * In production you would swap this for a proper password-hashing
     * algorithm (bcrypt / argon2) via the same interface boundary.
     */
    private verifyPassword(plaintext: string, storedHash: string): boolean {
        const candidateHash = createHash('sha256')
            .update(plaintext)
            .digest('hex');

        const a = Buffer.from(candidateHash, 'utf-8');
        const b = Buffer.from(storedHash, 'utf-8');

        if (a.length !== b.length) {
            return false;
        }

        return timingSafeEqual(a, b);
    }
}
