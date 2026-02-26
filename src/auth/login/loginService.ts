import { createHash, timingSafeEqual } from 'node:crypto';
import {
    JwtIssuer,
    LoginSuccessResponse,
    SessionRepository,
    UserRepository,
} from './types';

/**
 * Domain service that orchestrates the login flow:
 *
 *  1. Look up the user by email.
 *  2. Compare the provided password against the stored hash.
 *  3. Create a new session.
 *  4. Issue a JWT that embeds the session.
 *
 * All I/O is pushed to injected collaborators so this class can be
 * unit-tested with in-memory fakes.
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
     * @returns The signed JWT and a subset of user data on success,
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

        // 3. Create session
        const sessionId = await this.sessionRepository.createSession(user.id);

        // 4. Issue JWT
        const token = this.jwtIssuer.sign({
            userId: user.id,
            sessionId,
            role: user.role,
        });

        return {
            token,
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
