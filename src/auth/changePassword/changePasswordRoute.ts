import { RequestHandler, Router } from 'express';
import { Pool } from 'pg';
import { UserRepository } from '../../db/repositories/userRepository';
import { SessionRepository } from '../../db/repositories/sessionRepository';
import { ChangePasswordService } from './changePasswordService';
import { createChangePasswordHandler } from './changePasswordHandler';

interface CreateChangePasswordRouterDeps {
  requireAuth: RequestHandler;
  db: Pool;
}

export const createChangePasswordRouter = ({
  requireAuth,
  db,
}: CreateChangePasswordRouterDeps): Router => {
  const router = Router();

  const userRepository = new UserRepository(db);
  const sessionRepository = new SessionRepository(db);
  const changePasswordService = new ChangePasswordService(userRepository, sessionRepository);
  const handler = createChangePasswordHandler(changePasswordService);

  router.post('/api/users/me/change-password', requireAuth, handler);

  return router;
};