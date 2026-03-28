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
import { JwtIssuer } from './auth/login/types';
import { issueToken } from './lib/jwt';

class JwtIssuerImpl implements JwtIssuer {
  sign(payload: { userId: string; sessionId: string; role: 'startup' | 'investor' }) {
    return issueToken({
      subject: payload.userId,
      additionalPayload: {
        sid: payload.sessionId,
        role: payload.role,
      },
      expiresIn: '1h',
    });
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

  // Auth and health routes
  app.use(createLoginRouter({ userRepository, sessionRepository, jwtIssuer }));
  app.use(createLogoutRouter({ requireAuth, sessionRepository }));
  app.use(createChangePasswordRouter({ requireAuth, db: pool }));
  app.use('/api/v1/health', createHealthRouter(pool, requireAuth));

  return app;
}