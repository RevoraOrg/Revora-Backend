/**
 * @fileoverview Defines API routes for managing user notification preferences.
 * These routes allow authenticated users to export, update, and delete their
 * notification preferences, aligning with GDPR-style data management.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { NotificationPreferencesService, UpdateNotificationPreferencesInput } from '../services/notificationPreferencesService';
import { authMiddleware, ensureUserOwnsResource } from '../middleware/auth';
import { Logger } from '../lib/logger';
import { BadRequestError, NotFoundError, AppError } from '../lib/errors';

/**
 * @interface AuthenticatedRequest
 * @description Extends Express Request to include `user` property from authentication middleware.
 */
interface AuthenticatedRequest extends Request {
  user?: { id: string; role: string };
}

/**
 * @function createNotificationPreferencesRouter
 * @description Creates and configures the Express router for notification preferences.
 * @param {object} dependencies - Dependencies for the router.
 * @param {NotificationPreferencesService} dependencies.notificationPreferencesService - The service for managing preferences.
 * @param {Logger} dependencies.logger - The logger instance.
 * @returns {Router} The configured Express router.
 */
export const createNotificationPreferencesRouter = (dependencies: {
  notificationPreferencesService: NotificationPreferencesService;
  logger: Logger;
}): Router => {
  const router = Router();
  const { notificationPreferencesService, logger } = dependencies;

  /**
   * @route GET /api/v1/users/:userId/notifications
   * @description Exports notification preferences for a specific user.
   * Requires authentication and authorization (user must own the resource).
   * @security BearerAuth
   * @returns {Response} 200 OK with preferences, or 404 Not Found.
   */
  router.get('/:userId/notifications', authMiddleware, ensureUserOwnsResource, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    const { userId } = req.params;
    logger.info(`Attempting to export notification preferences for user: ${userId}`);
    try {
      const preferences = await notificationPreferencesService.getPreferences(userId);
      res.status(200).json(preferences);
    } catch (error) {
      logger.error(`Failed to export notification preferences for user ${userId}:`, error);
      next(error);
    }
  });

  /**
   * @route PUT /api/v1/users/:userId/notifications
   * @description Updates notification preferences for a specific user.
   * Requires authentication and authorization (user must own the resource).
   * @security BearerAuth
   * @param {UpdateNotificationPreferencesInput} req.body - The preferences to update.
   * @returns {Response} 200 OK with updated preferences, or 400 Bad Request, 404 Not Found.
   */
  router.put('/:userId/notifications', authMiddleware, ensureUserOwnsResource, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    const { userId } = req.params;
    const input: UpdateNotificationPreferencesInput = req.body;
    logger.info(`Attempting to update notification preferences for user: ${userId}`, { input });

    // Basic input validation
    if (Object.keys(input).length === 0) {
      return next(new BadRequestError('Request body cannot be empty for update.'));
    }

    try {
      const updatedPreferences = await notificationPreferencesService.updatePreferences(userId, input);
      res.status(200).json(updatedPreferences);
    } catch (error) {
      logger.error(`Failed to update notification preferences for user ${userId}:`, error, { input });
      next(error);
    }
  });

  /**
   * @route DELETE /api/v1/users/:userId/notifications
   * @description Deletes notification preferences for a specific user.
   * Requires authentication and authorization (user must own the resource).
   * @security BearerAuth
   * @returns {Response} 204 No Content on successful deletion, or 404 Not Found.
   */
  router.delete('/:userId/notifications', authMiddleware, ensureUserOwnsResource, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    const { userId } = req.params;
    logger.info(`Attempting to delete notification preferences for user: ${userId}`);
    try {
      await notificationPreferencesService.deletePreferences(userId);
      res.status(204).send();
    } catch (error) {
      logger.error(`Failed to delete notification preferences for user ${userId}:`, error);
      next(error);
    }
  });

  return router;
};