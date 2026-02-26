import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import { pool } from './db/pool';
import { requireAuth } from './middleware/auth';
import { SessionRepository } from './db/repositories/sessionRepository';
import { createLogoutRouter } from './auth/logout/logoutRoute';
import { createChangePasswordRouter } from './auth/changePassword/changePasswordRoute';

export function createApp() {
  const app = express();

  app.use(cors());
  app.use(express.json());
  app.use(morgan('dev'));

  const sessionRepository = new SessionRepository(pool);

  // Auth routes
  app.use(createLogoutRouter({ requireAuth, sessionRepository }));
  app.use(createChangePasswordRouter({ requireAuth, db: pool }));

  return app;
}