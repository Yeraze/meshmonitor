/**
 * Settings Repository
 *
 * Handles all settings-related database operations.
 * Supports SQLite, PostgreSQL, and MySQL through Drizzle ORM.
 */
import { eq, inArray, sql } from 'drizzle-orm';
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
   * Get a setting for a specific source. Returns ONLY the per-source value
   * (null if no per-source override exists). Pass `null`/`undefined` for
   * sourceId to read the un-namespaced global setting.
   *
   * The previous behaviour fell back to the global value when no per-source
   * override existed; that fallback was the root cause of issue #2839
   * (multi-source automation spam) and #2840 (auto-traceroute UI mismatch
   * after upgrade). Migration 050 promotes legacy globals into the default
   * source's namespace so single-source pre-4.x users keep their config.
   */
  async getSettingForSource(sourceId: string | null | undefined, key: string): Promise<string | null> {
    if (sourceId) {
      return await this.getSetting(`${this.sourcePrefix(sourceId)}${key}`);
    }
    return await this.getSetting(key);
  }

  /**
   * Batched per-source read of ONE key across MANY sources: a single indexed
   * `key IN (...)` lookup. Deliberately NOT getSourceSettings(), which calls
   * getAllSettings() — a full-table scan (#4419) — once per source.
   *
   * Returns a Map keyed by sourceId. Ids with no stored row are simply absent;
   * there is no fallback to the global row (#2839/#2840) — callers that want a
   * default for missing ids (e.g. getMaxNodeAgeHoursForSources) fill it
   * themselves.
   *
   * Resolution is via a reverse map from the prefixed key back to the
   * original sourceId, never by string-splitting the returned key — a
   * sourceId containing `:` would corrupt a split.
   */
  async getSettingForSources(sourceIds: string[], key: string): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    if (sourceIds.length === 0) return result;

    const uniqueIds = [...new Set(sourceIds)];
    const prefixedToSourceId = new Map<string, string>();
    for (const id of uniqueIds) {
      prefixedToSourceId.set(`${this.sourcePrefix(id)}${key}`, id);
    }

    const { settings } = this.tables;
    const rows = await this.db
      .select({ key: settings.key, value: settings.value })
      .from(settings)
      .where(inArray(settings.key, [...prefixedToSourceId.keys()]));

    for (const row of rows as Array<{ key: string; value: string }>) {
      const sourceId = prefixedToSourceId.get(row.key);
      if (sourceId !== undefined) {
        result.set(sourceId, row.value);
      }
    }
    return result;
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
    const prefixed: Record<string, string> = Object.create(null);
    for (const [k, v] of Object.entries(kv)) {
      // Only accept simple setting key names to prevent property-injection
      // on the in-memory record we build here.
      if (!/^[A-Za-z0-9_.-]+$/.test(k)) continue;
      Object.defineProperty(prefixed, `${prefix}${k}`, {
        value: v,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    await this.setSettings(prefixed);
  }

  /**
   * Delete all per-source settings for a source. Single statement — the previous
   * implementation read every settings key into memory and issued one DELETE per
   * match, which is the per-row round-trip pattern that made migration 030 a
   * startup hazard (#4233).
   *
   * `_` and `%` are LIKE wildcards; source ids are UUIDs today, but escape
   * defensively so a future non-UUID id cannot over-match a sibling namespace.
   *
   * The ESCAPE literal's backslash count is dialect-dependent (verified
   * empirically, not just by inspection): MySQL's default backslash-escape
   * mode means a single-quoted string needs TWO literal backslash characters
   * to represent ONE escape character, and errors ("syntax error near ''\''")
   * on a single-backslash literal. SQLite and PostgreSQL (standard_conforming_strings,
   * the default) treat backslash as an ordinary character in a '...' string, so
   * ONE literal backslash there already IS the one-character escape sequence —
   * a two-backslash literal fails there ("ESCAPE expression must be a single character").
   */
  async deleteSourceSettings(sourceId: string): Promise<void> {
    const { settings } = this.tables;
    const pattern = this.sourcePrefix(sourceId).replace(/([\\%_])/g, '\\$1') + '%';
    const query = this.isMySQL()
      ? sql`${settings.key} LIKE ${pattern} ESCAPE '\\\\'`
      : sql`${settings.key} LIKE ${pattern} ESCAPE '\\'`;
    await this.db.delete(settings).where(query);
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
