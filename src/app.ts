import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import { pool } from './db/pool';
import { createRequireAuth } from './middleware/auth';
import { SessionRepository } from './db/repositories/sessionRepository';
import { createLogoutRouter } from './auth/logout/logoutRoute';
import { createChangePasswordRouter } from './auth/changePassword/changePasswordRoute';
import { createLoginRouter } from './auth/login/loginRoute';
import { createHealthRouter } from './routes/health';
import { UserRepository } from './db/repositories/userRepository';
import { JwtIssuer, UserRole, UserRepository as IUserRepository, SessionRepository as ISessionRepository } from './auth/login/types';
import { LoginService } from './auth/login/loginService';
import { issueToken } from './lib/jwt';

// Adapter to convert database User to login service UserRecord
class UserRepositoryAdapter implements IUserRepository {
  constructor(private dbUserRepository: UserRepository) {}
  
  async findByEmail(email: string): Promise<import('./auth/login/types').UserRecord | null> {
    const user = await this.dbUserRepository.findByEmail(email);
    if (!user) return null;
    
    return {
      id: user.id,
      email: user.email,
      role: user.role,
      passwordHash: user.password_hash,
    };
  }
}

// Adapter to convert database SessionRepository to login service SessionRepository
class SessionRepositoryAdapter implements ISessionRepository {
  constructor(private dbSessionRepository: SessionRepository) {}
  
  async createSession(input: { id: string; userId: string; tokenHash: string; expiresAt: Date; }): Promise<void> {
    await this.dbSessionRepository.createSession({
      id: input.id,
      user_id: input.userId,
      token_hash: input.tokenHash,
      expires_at: input.expiresAt,
    });
  }
}

class JwtIssuerImpl implements JwtIssuer {
  sign(payload: { userId: string; sessionId: string; role: UserRole }) {
    const accessToken = issueToken({
      subject: payload.userId,
      additionalPayload: {
        sid: payload.sessionId,
        role: payload.role,
      },
      expiresIn: '1h',
    });
    
    const refreshToken = issueToken({
      subject: payload.userId,
      additionalPayload: {
        sid: payload.sessionId,
        role: payload.role,
        type: 'refresh',
      },
      expiresIn: '7d',
    });
    
    return { accessToken, refreshToken };
  }
}

export function createApp() {
  const app = express();

  app.use(cors());
  app.use(express.json());
  app.use(morgan('dev'));

  const sessionRepository = new SessionRepository(pool);
  const requireAuth = createRequireAuth(sessionRepository);

  const userRepository = new UserRepository(pool);
  const jwtIssuer = new JwtIssuerImpl();
  const loginService = new LoginService(new UserRepositoryAdapter(userRepository), new SessionRepositoryAdapter(sessionRepository), jwtIssuer);

  // Auth and health routes
  app.use(createLoginRouter({ loginService }));
  app.use(createLogoutRouter({ requireAuth, sessionRepository }));
  app.use(createChangePasswordRouter({ requireAuth, db: pool }));
  app.use('/api/v1/health', createHealthRouter(pool));

  return app;
}