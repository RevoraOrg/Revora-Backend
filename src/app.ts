import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import { pool } from './db/pool';
import { createRequireAuth } from './middleware/auth';
import { createCorsMiddleware } from './middleware/cors';
import { SessionRepository } from './db/repositories/sessionRepository';
import { createLogoutRouter } from './auth/logout/logoutRoute';
import { createChangePasswordRouter } from './auth/changePassword/changePasswordRoute';
import { createLoginRouter } from './auth/login/loginRoute';
import { createHealthRouter } from './routes/health';
import { dbHealth } from './db/client';
import { createOfferingSyncRouter } from './routes/offeringSync';
import { UserRepository } from './db/repositories/userRepository';
import { JwtIssuer, UserRole, UserRepository as IUserRepository, SessionRepository as ISessionRepository } from './auth/login/types';
import { LoginService } from './auth/login/loginService';
import { issueToken } from './lib/jwt';
import { MetricsCollector } from './lib/metrics';
import { metricsMiddleware, createPrometheusHandler } from './middleware/metricsMiddleware';
import { Logger } from './lib/logger';
import { RefreshService } from './auth/refresh/refreshService';
import { createRefreshRouter } from './auth/refresh/refreshRoute';
import { RefreshTokenRepository, TokenService } from './auth/refresh/types';
import { RefreshTokenRepositoryAdapter } from './auth/refresh/repositoryAdapter';
import { JwtTokenServiceAdapter } from './auth/refresh/tokenServiceAdapter';
import { errorHandler } from './middleware/errorHandler';

// Adapter to convert database User to login service UserRecord
class UserRepositoryAdapter implements IUserRepository {
  constructor(private dbUserRepository: UserRepository) {}

  async findByEmail(
    email: string,
  ): Promise<import("./auth/login/types").UserRecord | null> {
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

  async createSession(input: {
    id: string;
    userId: string;
    tokenHash: string;
    expiresAt: Date;
  }): Promise<void> {
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
      expiresIn: "1h",
    });

    const refreshToken = issueToken({
      subject: payload.userId,
      additionalPayload: {
        sid: payload.sessionId,
        role: payload.role,
        type: "refresh",
      },
      expiresIn: "7d",
    });

    return { accessToken, refreshToken };
  }
}

/**
 * Middleware to secure the /metrics endpoint with bearer token authentication.
 * 
 * Security Assumptions:
 * - METRICS_TOKEN environment variable must be set in production
 * - Token should be a cryptographically random string (min 32 characters)
 * - Requests without valid token are rejected with 401
 * - In development/test, endpoint is accessible without token for convenience
 * 
 * Usage:
 * Set METRICS_TOKEN environment variable:
 * ```bash
 * export METRICS_TOKEN="your-secure-random-token-here"
 * ```
 * 
 * Access metrics:
 * ```bash
 * curl -H "Authorization: Bearer your-secure-random-token-here" http://localhost:4000/metrics
 * ```
 */
function createMetricsAuthMiddleware() {
  return (req: express.Request, res: express.Response, next: express.NextFunction): void => {
    const metricsToken = process.env.METRICS_TOKEN;
    const nodeEnv = process.env.NODE_ENV;

    // In development/test, allow access without token for convenience
    if (nodeEnv === 'development' || nodeEnv === 'test') {
      next();
      return;
    }

    // In production, require METRICS_TOKEN to be set
    if (!metricsToken) {
      res.status(503).json({
        error: 'Metrics endpoint not configured',
        message: 'METRICS_TOKEN environment variable must be set',
      });
      return;
    }

    // Extract bearer token from Authorization header
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Bearer token required',
      });
      return;
    }

    const token = authHeader.substring(7); // Remove 'Bearer ' prefix

    // Constant-time comparison to prevent timing attacks
    if (token.length !== metricsToken.length || !timingSafeEqual(Buffer.from(token), Buffer.from(metricsToken))) {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Invalid token',
      });
      return;
    }

    next();
  };
}

/**
 * Timing-safe string comparison to prevent timing attacks.
 * Uses crypto.timingSafeEqual for constant-time comparison.
 */
function timingSafeEqual(a: Buffer, b: Buffer): boolean {
  try {
    const crypto = require('crypto');
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export function createApp() {
  const app = express();

  app.use(createCorsMiddleware());
  app.use(express.json());
  app.use(morgan("dev"));

  // Initialize metrics collector
  const metrics = new MetricsCollector({
    enabled: true,
    maxCardinality: 1000,
    enablePIIDetection: true,
  });

  // Register metrics middleware to track HTTP requests
  app.use(metricsMiddleware({ metrics, detailedRoutes: true }));

  const sessionRepository = new SessionRepository(pool);
  const requireAuth = createRequireAuth(sessionRepository);

  const userRepository = new UserRepository(pool);
  const jwtIssuer = new JwtIssuerImpl();
  const loginService = new LoginService(
    new UserRepositoryAdapter(userRepository),
    new SessionRepositoryAdapter(sessionRepository),
    jwtIssuer,
  );

  // Refresh service
  const refreshTokenRepository = new RefreshTokenRepositoryAdapter(sessionRepository);
  const tokenService = new JwtTokenServiceAdapter();
  const logger = new Logger({ serviceName: 'auth-refresh' });
  const refreshService = new RefreshService(refreshTokenRepository, tokenService, pool, logger);

  // Auth and health routes
  app.use(createLoginRouter({ loginService }));
  app.use(createRefreshRouter({ refreshService }));
  app.use(createLogoutRouter({ requireAuth, sessionRepository }));
  app.use(createChangePasswordRouter({ requireAuth, db: pool }));
  app.use('/api/v1/health', createHealthRouter(pool, dbHealth, metrics));

  // Metrics endpoint (Prometheus format) - secured with internal token
  app.get('/metrics', createMetricsAuthMiddleware(), createPrometheusHandler(metrics));

  // Offering sync routes
  app.use('/api/v1/offerings', createOfferingSyncRouter());

  // Global error handler — must be mounted after all routes
  app.use(errorHandler);

  return app;
}
