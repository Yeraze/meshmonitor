/**
 * Settings Repository
 *
 * Handles all settings-related database operations.
 * Supports SQLite, PostgreSQL, and MySQL through Drizzle ORM.
 */
import { eq } from 'drizzle-orm';
import { BaseRepository, DrizzleDatabase } from './base.js';
import { DatabaseType } from '../types.js';

/**
 * Repository for settings operations
 */
export class SettingsRepository extends BaseRepository {
  constructor(db: DrizzleDatabase, dbType: DatabaseType) {
    super(db, dbType);
  }

  /**
   * Get a single setting value by key
   */
  async getSetting(key: string): Promise<string | null> {
    const { settings } = this.tables;
    const result = await this.db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, key))
      .limit(1);
    return result.length > 0 ? result[0].value : null;
  }

  /**
   * Get all settings as a key-value object
   */
  async getAllSettings(): Promise<Record<string, string>> {
    const { settings } = this.tables;
    const allSettings: Record<string, string> = {};
    const rows = await this.db
      .select({ key: settings.key, value: settings.value })
      .from(settings);
    rows.forEach(row => {
      allSettings[row.key] = row.value;
    });
    return allSettings;
  }

  /**
   * Set a single setting value (insert or update)
   */
  async setSetting(key: string, value: string): Promise<void> {
    const now = this.now();
    const { settings } = this.tables;

    if (this.isMySQL()) {
      const db = this.getMysqlDb();
      await db
        .insert(settings)
        .values({ key, value, createdAt: now, updatedAt: now })
        .onDuplicateKeyUpdate({
          set: { value, updatedAt: now },
        });
    } else {
      // SQLite and PostgreSQL both use onConflictDoUpdate
      await (this.db as any)
        .insert(settings)
        .values({ key, value, createdAt: now, updatedAt: now })
        .onConflictDoUpdate({
          target: settings.key,
          set: { value, updatedAt: now },
        });
    }
  }

  /**
   * Set multiple settings at once
   */
  async setSettings(settings: Record<string, string>): Promise<void> {
    const now = this.now();
    const entries = Object.entries(settings);

    if (entries.length === 0) {
      return;
    }

    const { settings: settingsTable } = this.tables;

    if (this.isMySQL()) {
      const db = this.getMysqlDb();
      for (const [key, value] of entries) {
        await db
          .insert(settingsTable)
          .values({ key, value, createdAt: now, updatedAt: now })
          .onDuplicateKeyUpdate({
            set: { value, updatedAt: now },
          });
      }
    } else {
      // SQLite and PostgreSQL both use onConflictDoUpdate
      for (const [key, value] of entries) {
        await (this.db as any)
          .insert(settingsTable)
          .values({ key, value, createdAt: now, updatedAt: now })
          .onConflictDoUpdate({
            target: settingsTable.key,
            set: { value, updatedAt: now },
          });
      }
    }
  }

  /**
   * Delete a single setting by key
   */
  async deleteSetting(key: string): Promise<void> {
    const { settings } = this.tables;
    await this.db.delete(settings).where(eq(settings.key, key));
  }

  /**
   * Delete all settings
   */
  async deleteAllSettings(): Promise<void> {
    const { settings } = this.tables;
    await this.db.delete(settings);
  }

  /**
   * Check if a setting exists
   */
  async hasSetting(key: string): Promise<boolean> {
    const result = await this.getSetting(key);
    return result !== null;
  }

  /**
   * Get a setting with a default value if not found
   */
  async getSettingWithDefault(key: string, defaultValue: string): Promise<string> {
    const value = await this.getSetting(key);
    return value ?? defaultValue;
  }

  /**
   * Get a setting as a number, with optional default
   */
  async getSettingAsNumber(key: string, defaultValue?: number): Promise<number | null> {
    const value = await this.getSetting(key);
    if (value === null) {
      return defaultValue ?? null;
    }
    const num = parseInt(value, 10);
    return isNaN(num) ? (defaultValue ?? null) : num;
  }

  /**
   * Get a setting as a boolean
   */
  async getSettingAsBoolean(key: string, defaultValue: boolean = false): Promise<boolean> {
    const value = await this.getSetting(key);
    if (value === null) {
      return defaultValue;
    }
    return value === 'true' || value === '1';
  }

  /**
   * Set a boolean setting
   */
  async setSettingBoolean(key: string, value: boolean): Promise<void> {
    await this.setSetting(key, value ? 'true' : 'false');
  }

  /**
   * Get a setting as JSON, with optional default
   */
  async getSettingAsJson<T>(key: string, defaultValue?: T): Promise<T | null> {
    const value = await this.getSetting(key);
    if (value === null) {
      return defaultValue ?? null;
    }
    try {
      return JSON.parse(value) as T;
    } catch {
      return defaultValue ?? null;
    }
  }

  /**
   * Set a setting as JSON
   */
  async setSettingJson<T>(key: string, value: T): Promise<void> {
    await this.setSetting(key, JSON.stringify(value));
  }
}
