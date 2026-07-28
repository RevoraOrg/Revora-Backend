/**
 * @fileoverview Defines the service layer for managing user notification preferences.
 * This service handles the business logic for retrieving, updating, and deleting
 * notification preferences, interacting with the `NotificationPreferencesRepository`.
 */

import { InMemoryNotificationPreferencesRepository, NotificationPreferences } from '../repositories/notificationPreferencesRepository';
import { NotFoundError, BadRequestError } from '../lib/errors';

/**
 * @interface UpdateNotificationPreferencesInput
 * @description Input DTO for updating notification preferences.
 */
export interface UpdateNotificationPreferencesInput {
  emailNotifications?: boolean;
  smsNotifications?: boolean;
  emailAddress?: string;
  phoneNumber?: string;
  preferredLanguage?: string;
}

/**
 * @class NotificationPreferencesService
 * @description Service for managing user notification preferences.
 */
export class NotificationPreferencesService {
  private repository: InMemoryNotificationPreferencesRepository;

  constructor(repository: InMemoryNotificationPreferencesRepository) {
    this.repository = repository;
  }

  /**
   * Retrieves notification preferences for a specific user.
   * @param {string} userId - The ID of the user.
   * @returns {Promise<NotificationPreferences>} The user's notification preferences.
   * @throws {NotFoundError} If preferences for the user are not found.
   */
  async getPreferences(userId: string): Promise<NotificationPreferences> {
    const preferences = await this.repository.findByUserId(userId);
    if (!preferences) {
      throw new NotFoundError(`Notification preferences not found for user ${userId}`);
    }
    return preferences;
  }

  /**
   * Updates or creates notification preferences for a user.
   * @param {string} userId - The ID of the user.
   * @param {UpdateNotificationPreferencesInput} input - The data to update.
   * @returns {Promise<NotificationPreferences>} The updated or created preferences.
   */
  async updatePreferences(userId: string, input: UpdateNotificationPreferencesInput): Promise<NotificationPreferences> {
    // Basic validation for PII fields if they are provided
    if (input.emailAddress && !/\S+@\S+\.\S+/.test(input.emailAddress)) {
      throw new BadRequestError('Invalid email address format');
    }
    // Add more robust phone number validation if necessary
    return this.repository.upsert(userId, input);
  }

  /**
   * Deletes notification preferences for a specific user.
   * @param {string} userId - The ID of the user.
   * @returns {Promise<void>}
   * @throws {NotFoundError} If preferences for the user are not found.
   */
  async deletePreferences(userId: string): Promise<void> {
    const deleted = await this.repository.deleteByUserId(userId);
    if (!deleted) {
      throw new NotFoundError(`Notification preferences not found for user ${userId}`);
    }
  }
}