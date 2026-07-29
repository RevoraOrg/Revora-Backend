/**
 * @fileoverview Defines the service layer for managing user notification preferences.
 * This service handles the business logic for retrieving, updating, and deleting
 * notification preferences, interacting with the `NotificationPreferencesRepository`.
 */

import { InMemoryNotificationPreferencesRepository, NotificationPreferences, QuietHoursConfig } from '../lib/notificationPreferencesRepository';
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
  quietHours?: QuietHoursConfig;
}

/**
 * Validates a quiet-hours configuration.
 * @throws {BadRequestError} If any field is invalid.
 */
function validateQuietHours(quietHours: QuietHoursConfig): void {
  const { enabled, startHour, endHour, timezone } = quietHours;

  if (typeof enabled !== 'boolean') {
    throw new BadRequestError('quietHours.enabled must be a boolean');
  }
  for (const [field, value] of [['startHour', startHour], ['endHour', endHour]] as const) {
    if (!Number.isInteger(value) || value < 0 || value > 23) {
      throw new BadRequestError(`quietHours.${field} must be an integer between 0 and 23`);
    }
  }
  if (typeof timezone !== 'string' || timezone.length === 0) {
    throw new BadRequestError('quietHours.timezone must be a non-empty IANA timezone string');
  }
  // Validate the timezone against the runtime's tz database. An invalid zone
  // throws a RangeError, which we surface as a client error rather than a 500.
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
  } catch {
    throw new BadRequestError(`quietHours.timezone is not a valid IANA timezone: ${timezone}`);
  }
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
    if (input.quietHours) {
      validateQuietHours(input.quietHours);
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