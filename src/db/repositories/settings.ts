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
    rows.forEach((row: any) => {
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

    await this.upsert(
      settings,
      { key, value, createdAt: now, updatedAt: now },
      settings.key,
      { value, updatedAt: now },
    );
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

    for (const [key, value] of entries) {
      await this.upsert(
        settingsTable,
        { key, value, createdAt: now, updatedAt: now },
        settingsTable.key,
        { value, updatedAt: now },
      );
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

  // ─── Per-source settings helpers ────────────────────────────────────────

  private sourcePrefix(sourceId: string): string {
    return `source:${sourceId}:`;
  }

  /**
   * Get all settings for a specific source (returns bare keys without prefix)
   */
  async getSourceSettings(sourceId: string): Promise<Record<string, string>> {
    const prefix = this.sourcePrefix(sourceId);
    const all = await this.getAllSettings();
    const result: Record<string, string> = {};
    for (const [k, v] of Object.entries(all)) {
      if (k.startsWith(prefix)) {
        result[k.slice(prefix.length)] = v;
      }
    }
    return result;
  }

  /**
   * Get a setting for a specific source, falling back to the global value when
   * no per-source override exists. Pass `null`/`undefined` for sourceId to get
   * the plain global setting.
   */
  async getSettingForSource(sourceId: string | null | undefined, key: string): Promise<string | null> {
    if (sourceId) {
      const prefixed = await this.getSetting(`${this.sourcePrefix(sourceId)}${key}`);
      if (prefixed !== null && prefixed !== undefined) return prefixed;
    }
    return await this.getSetting(key);
  }

  /**
   * Set a single per-source setting
   */
  async setSourceSetting(sourceId: string, key: string, value: string): Promise<void> {
    await this.setSetting(`${this.sourcePrefix(sourceId)}${key}`, value);
  }

  /**
   * Set multiple per-source settings
   */
  async setSourceSettings(sourceId: string, kv: Record<string, string>): Promise<void> {
    const prefix = this.sourcePrefix(sourceId);
    const prefixed: Record<string, string> = {};
    for (const [k, v] of Object.entries(kv)) {
      prefixed[`${prefix}${k}`] = v;
    }
    await this.setSettings(prefixed);
  }

  /**
   * Delete all per-source settings for a source
   */
  async deleteSourceSettings(sourceId: string): Promise<void> {
    const prefix = this.sourcePrefix(sourceId);
    const { settings } = this.tables;
    const rows = await this.db.select({ key: settings.key }).from(settings);
    for (const row of rows) {
      if ((row as any).key.startsWith(prefix)) {
        await this.db.delete(settings).where(eq(settings.key, (row as any).key));
      }
    }
  }

  // ─── Synchronous SQLite variants ────────────────────────────────────────
  // These use drizzle's sync query builder on better-sqlite3, which is truly
  // synchronous. Needed because DatabaseService exposes sync getSetting/
  // setSetting used during migrations (before async cache hydration completes).
  // Only valid on SQLite — throw if called on PG/MySQL.

  /**
   * Synchronously get a single setting value (SQLite only).
   */
  getSettingSync(key: string): string | null {
    const db = this.getSqliteDb();
    const { settings } = this.tables;
    const rows = db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, key))
      .limit(1)
      .all();
    return rows.length > 0 ? (rows[0] as any).value : null;
  }

  /**
   * Synchronously get all settings (SQLite only).
   */
  getAllSettingsSync(): Record<string, string> {
    const db = this.getSqliteDb();
    const { settings } = this.tables;
    const rows = db
      .select({ key: settings.key, value: settings.value })
      .from(settings)
      .all();
    const result: Record<string, string> = {};
    for (const row of rows) {
      result[(row as any).key] = (row as any).value;
    }
    return result;
  }

  /**
   * Synchronously upsert a single setting (SQLite only).
   */
  setSettingSync(key: string, value: string): void {
    const db = this.getSqliteDb();
    const { settings } = this.tables;
    const now = this.now();
    db
      .insert(settings)
      .values({ key, value, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: now } })
      .run();
  }

  /**
   * Synchronously upsert multiple settings in a transaction (SQLite only).
   */
  setSettingsSync(settings: Record<string, string>): void {
    const db = this.getSqliteDb();
    const entries = Object.entries(settings);
    if (entries.length === 0) return;
    const { settings: settingsTable } = this.tables;
    const now = this.now();
    db.transaction((tx) => {
      for (const [key, value] of entries) {
        tx
          .insert(settingsTable)
          .values({ key, value, createdAt: now, updatedAt: now })
          .onConflictDoUpdate({ target: settingsTable.key, set: { value, updatedAt: now } })
          .run();
      }
    });
  }

  /**
   * Synchronously delete all settings (SQLite only).
   */
  deleteAllSettingsSync(): void {
    const db = this.getSqliteDb();
    const { settings } = this.tables;
    db.delete(settings).run();
  }
}
