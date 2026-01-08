/**
 * Settings Repository
 *
 * Handles all settings-related database operations.
 * Supports both SQLite and PostgreSQL through Drizzle ORM.
 */
import { eq } from 'drizzle-orm';
import { settingsSqlite, settingsPostgres } from '../schema/settings.js';
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
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const result = await db
        .select({ value: settingsSqlite.value })
        .from(settingsSqlite)
        .where(eq(settingsSqlite.key, key))
        .limit(1);
      return result.length > 0 ? result[0].value : null;
    } else {
      const db = this.getPostgresDb();
      const result = await db
        .select({ value: settingsPostgres.value })
        .from(settingsPostgres)
        .where(eq(settingsPostgres.key, key))
        .limit(1);
      return result.length > 0 ? result[0].value : null;
    }
  }

  /**
   * Get all settings as a key-value object
   */
  async getAllSettings(): Promise<Record<string, string>> {
    const settings: Record<string, string> = {};

    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const rows = await db
        .select({ key: settingsSqlite.key, value: settingsSqlite.value })
        .from(settingsSqlite);
      rows.forEach(row => {
        settings[row.key] = row.value;
      });
    } else {
      const db = this.getPostgresDb();
      const rows = await db
        .select({ key: settingsPostgres.key, value: settingsPostgres.value })
        .from(settingsPostgres);
      rows.forEach(row => {
        settings[row.key] = row.value;
      });
    }

    return settings;
  }

  /**
   * Set a single setting value (insert or update)
   */
  async setSetting(key: string, value: string): Promise<void> {
    const now = this.now();

    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      await db
        .insert(settingsSqlite)
        .values({ key, value, createdAt: now, updatedAt: now })
        .onConflictDoUpdate({
          target: settingsSqlite.key,
          set: { value, updatedAt: now },
        });
    } else {
      const db = this.getPostgresDb();
      await db
        .insert(settingsPostgres)
        .values({ key, value, createdAt: now, updatedAt: now })
        .onConflictDoUpdate({
          target: settingsPostgres.key,
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

    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      for (const [key, value] of entries) {
        await db
          .insert(settingsSqlite)
          .values({ key, value, createdAt: now, updatedAt: now })
          .onConflictDoUpdate({
            target: settingsSqlite.key,
            set: { value, updatedAt: now },
          });
      }
    } else {
      const db = this.getPostgresDb();
      for (const [key, value] of entries) {
        await db
          .insert(settingsPostgres)
          .values({ key, value, createdAt: now, updatedAt: now })
          .onConflictDoUpdate({
            target: settingsPostgres.key,
            set: { value, updatedAt: now },
          });
      }
    }
  }

  /**
   * Delete a single setting by key
   */
  async deleteSetting(key: string): Promise<void> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      await db.delete(settingsSqlite).where(eq(settingsSqlite.key, key));
    } else {
      const db = this.getPostgresDb();
      await db.delete(settingsPostgres).where(eq(settingsPostgres.key, key));
    }
  }

  /**
   * Delete all settings
   */
  async deleteAllSettings(): Promise<void> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      await db.delete(settingsSqlite);
    } else {
      const db = this.getPostgresDb();
      await db.delete(settingsPostgres);
    }
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
