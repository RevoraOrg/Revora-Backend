/**
 * @fileoverview Defines the repository for managing user notification preferences.
 * This module provides an in-memory implementation for demonstration and testing purposes,
 * consistent with the E2E test strategy. In a production environment, this would be
 * replaced with a database-backed implementation (e.g., PostgreSQL).
 */

import { v4 as uuidv4 } from 'uuid';

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
    const newPreferences: NotificationPreferences = { id: uuidv4(), userId, ...data, createdAt: new Date(), updatedAt: new Date() } as NotificationPreferences;
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