/**
 * @fileoverview Defines the repository for managing user notification preferences.
 * This module provides an in-memory implementation for demonstration and testing purposes,
 * consistent with the E2E test strategy. In a production environment, this would be
 * replaced with a database-backed implementation (e.g., PostgreSQL).
 */

import { randomUUID } from 'crypto';

/**
 * @interface QuietHoursConfig
 * @description Quiet-hours window for push notifications.
 * Times are interpreted in the investor's local timezone (IANA identifier).
 * Non-urgent pushes arriving within the window are deferred to the next
 * available window. Default window: 22:00–08:00.
 */
export interface QuietHoursConfig {
  /** Whether quiet hours are active for this user. */
  enabled: boolean;
  /** Hour to begin quiet period (0–23, inclusive). Default 22. */
  startHour: number;
  /** Hour to end quiet period (0–23, exclusive). Default 8. */
  endHour: number;
  /** IANA timezone string, e.g. "America/New_York". */
  timezone: string;
}

/**
 * Default quiet-hours configuration: 22:00–08:00 in UTC, enabled.
 * Callers should override `timezone` with the investor's local timezone.
 */
export const DEFAULT_QUIET_HOURS: QuietHoursConfig = {
  enabled: true,
  startHour: 22,
  endHour: 8,
  timezone: 'UTC',
};

/**
 * @interface NotificationPreferences
 * @description Represents a user's notification preferences.
 * Contains PII fields like `emailAddress` and `phoneNumber` which require redaction in logs.
 */
export interface NotificationPreferences {
  id: string;
  userId: string;
  emailNotifications: boolean;
  smsNotifications: boolean;
  emailAddress?: string; // PII
  phoneNumber?: string; // PII
  preferredLanguage: string;
  quietHours?: QuietHoursConfig; // push notification quiet-hours config
  createdAt: Date;
  updatedAt: Date;
}

/**
 * @class InMemoryNotificationPreferencesRepository
 * @description An in-memory repository for NotificationPreferences.
 * Suitable for testing and development without a real database.
 */
export class InMemoryNotificationPreferencesRepository {
  private preferences: Map<string, NotificationPreferences> = new Map();

  /**
   * Finds notification preferences by user ID.
   * @param {string} userId - The ID of the user.
   * @returns {Promise<NotificationPreferences | undefined>} The preferences if found, otherwise undefined.
   */
  async findByUserId(userId: string): Promise<NotificationPreferences | undefined> {
    return Array.from(this.preferences.values()).find(pref => pref.userId === userId);
  }

  /**
   * Creates or updates notification preferences for a user.
   * @param {string} userId - The ID of the user.
   * @param {Partial<Omit<NotificationPreferences, 'id' | 'userId' | 'createdAt' | 'updatedAt'>>} data - The preferences data to upsert.
   * @returns {Promise<NotificationPreferences>} The created or updated preferences.
   */
  async upsert(userId: string, data: Partial<Omit<NotificationPreferences, 'id' | 'userId' | 'createdAt' | 'updatedAt'>>): Promise<NotificationPreferences> {
    let existing = await this.findByUserId(userId);
    if (existing) {
      existing = { ...existing, ...data, updatedAt: new Date() };
      this.preferences.set(existing.id, existing);
      return existing;
    }
    const newPreferences: NotificationPreferences = { id: randomUUID(), userId, ...data, createdAt: new Date(), updatedAt: new Date() } as NotificationPreferences;
    this.preferences.set(newPreferences.id, newPreferences);
    return newPreferences;
  }

  /**
   * Deletes notification preferences for a user.
   * @param {string} userId - The ID of the user whose preferences to delete.
   * @returns {Promise<boolean>} True if preferences were deleted, false otherwise.
   */
  async deleteByUserId(userId: string): Promise<boolean> {
    const existing = await this.findByUserId(userId);
    if (existing) {
      this.preferences.delete(existing.id);
      return true;
    }
    return false;
  }

  /**
   * Clears all preferences from the repository (for testing).
   */
  async clear(): Promise<void> {
    this.preferences.clear();
  }
}