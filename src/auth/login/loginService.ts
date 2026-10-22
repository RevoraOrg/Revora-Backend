import { randomUUID } from 'node:crypto';
import { comparePassword } from '../../utils/password';
import {
    JwtIssuer,
    LoginSuccessResponse,
    SessionRepository,
    UserRepository,
} from './types';
import { hashSessionToken, SESSION_TTL_MS, computeFamilyExpiresAt } from '../session';

/**
 * Fixed hash used for the dummy password verification when no user is found.
 * Running the same SHA-256 cost on both the found and missing-user paths
 * removes the timing oracle that would otherwise reveal account existence.
 */
const DUMMY_PASSWORD_HASH = createHash('sha256')
    .update('__revora_login_dummy_user__')
    .digest('hex');

/**
 * Domain service that orchestrates the login flow:
 *
 *  1. Normalise and resolve the user by email.
 *  2. Compare the provided password against the stored hash (or a fixed dummy
 *     hash when the user is missing, so both paths take comparable time).
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
        // 1. Normalise the email the same way RegisterService does
        //    (lowercase + trim) so mixed-case logins succeed against the
        //    stored canonical form.
        const normalisedEmail = email.trim().toLowerCase();

        // 2. Resolve user
        const user = await this.userRepository.findByEmail(normalisedEmail);

        // 3. Verify password. Always run the hash — against the stored hash
        //    when the user exists, against a fixed dummy hash when they do not
        //    — so both branches take comparable time and no timing oracle
        //    reveals whether an account exists.
        const storedHash = user?.passwordHash ?? DUMMY_PASSWORD_HASH;
        const passwordValid = this.verifyPassword(password, storedHash);

        if (!user || !passwordValid) {
            return null;
        }

        // 4. Generate session ID
        const sessionId = randomUUID();

        // 5. Issue tokens
        const tokens = this.jwtIssuer.sign({
            userId: user.id,
            sessionId,
            role: user.role,
        });

        // 6. Persist session
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
            // Anchor the absolute family deadline at login so refresh rotation
            // can never extend the family's total lifetime.
            familyExpiresAt: computeFamilyExpiresAt(),
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
