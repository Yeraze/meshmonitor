/**
 * Themes Repository
 *
 * Handles custom theme database operations.
 * Supports SQLite, PostgreSQL, and MySQL through Drizzle ORM.
 */
import { eq, asc } from 'drizzle-orm';
import { BaseRepository, DrizzleDatabase } from './base.js';
import { DatabaseType, DbCustomTheme } from '../types.js';
import { logger } from '../../utils/logger.js';

export class ThemesRepository extends BaseRepository {
  constructor(db: DrizzleDatabase, dbType: DatabaseType) {
    super(db, dbType);
  }

  // ============ CUSTOM THEMES ============

  /**
   * Normalize a raw theme row into DbCustomTheme format.
   * Ensures is_builtin is coerced to 0/1 for consistency across dialects.
   */
  private normalizeThemeRow(row: any): DbCustomTheme {
    return {
      id: Number(row.id),
      name: row.name,
      slug: row.slug,
      definition: row.definition,
      is_builtin: row.is_builtin ? 1 : 0,
      created_by: row.created_by != null ? Number(row.created_by) : undefined,
      created_at: Number(row.created_at),
      updated_at: Number(row.updated_at),
    };
  }

  /**
   * Get all custom themes ordered by name
   */
  async getAllCustomThemes(): Promise<DbCustomTheme[]> {
    const { customThemes } = this.tables;
    try {
      const results = await this.db
        .select()
        .from(customThemes)
        .orderBy(asc(customThemes.name));
      return results.map((row: any) => this.normalizeThemeRow(row));
    } catch (error) {
      logger.error('[ThemesRepository] Failed to get custom themes:', error);
      throw error;
    }
  }

  /**
   * Get a specific custom theme by slug
   */
  async getCustomThemeBySlug(slug: string): Promise<DbCustomTheme | undefined> {
    const { customThemes } = this.tables;
    try {
      const results = await this.db
        .select()
        .from(customThemes)
        .where(eq(customThemes.slug, slug))
        .limit(1);
      if (results.length === 0) return undefined;
      return this.normalizeThemeRow(results[0]);
    } catch (error) {
      logger.error(`[ThemesRepository] Failed to get custom theme ${slug}:`, error);
      throw error;
    }
  }

  /**
   * Create a new custom theme
   */
  async createCustomTheme(name: string, slug: string, definitionJson: string, userId?: number): Promise<DbCustomTheme> {
    const now = Math.floor(Date.now() / 1000);
    const { customThemes } = this.tables;

    try {
      if (this.isMySQL()) {
        // MySQL: use raw query for RETURNING-like behavior via insertId
        const db = this.getMysqlDb();
        const result = await db
          .insert(customThemes)
          .values({
            name,
            slug,
            definition: definitionJson,
            is_builtin: false,
            created_by: userId ?? null,
            created_at: now,
            updated_at: now,
          });
        const id = Number((result as any)[0].insertId);
        logger.debug(`[ThemesRepository] Created custom theme: ${name} (slug: ${slug})`);
        return { id, name, slug, definition: definitionJson, is_builtin: 0, created_by: userId, created_at: now, updated_at: now };
      } else if (this.isPostgres()) {
        // PostgreSQL: use returning()
        const db = this.getPostgresDb();
        const result = await db
          .insert(customThemes)
          .values({
            name,
            slug,
            definition: definitionJson,
            is_builtin: false,
            created_by: userId ?? null,
            created_at: now,
            updated_at: now,
          })
          .returning({ id: customThemes.id });
        const id = Number(result[0].id);
        logger.debug(`[ThemesRepository] Created custom theme: ${name} (slug: ${slug})`);
        return { id, name, slug, definition: definitionJson, is_builtin: 0, created_by: userId, created_at: now, updated_at: now };
      } else {
        // SQLite: use returning()
        const db = this.getSqliteDb();
        const result = await db
          .insert(customThemes)
          .values({
            name,
            slug,
            definition: definitionJson,
            is_builtin: false,
            created_by: userId ?? null,
            created_at: now,
            updated_at: now,
          })
          .returning({ id: customThemes.id });
        const id = Number(result[0].id);
        logger.debug(`[ThemesRepository] Created custom theme: ${name} (slug: ${slug})`);
        return { id, name, slug, definition: definitionJson, is_builtin: 0, created_by: userId, created_at: now, updated_at: now };
      }
    } catch (error) {
      logger.error(`[ThemesRepository] Failed to create custom theme ${name}:`, error);
      throw error;
    }
  }

  /**
   * Update an existing custom theme
   */
  async updateCustomTheme(slug: string, updates: Partial<{ name: string; definition: string }>): Promise<boolean> {
    const { customThemes } = this.tables;

    try {
      // Check if theme exists
      const existing = await this.getCustomThemeBySlug(slug);
      if (!existing) {
        logger.warn(`[ThemesRepository] Cannot update non-existent theme: ${slug}`);
        return false;
      }

      const now = Math.floor(Date.now() / 1000);
      const setData: Record<string, any> = { updated_at: now };

      if (updates.name !== undefined) {
        setData.name = updates.name;
      }
      if (updates.definition !== undefined) {
        setData.definition = typeof updates.definition === 'string'
          ? updates.definition
          : JSON.stringify(updates.definition);
      }

      await this.db
        .update(customThemes)
        .set(setData)
        .where(eq(customThemes.slug, slug));

      logger.debug(`[ThemesRepository] Updated custom theme: ${slug}`);
      return true;
    } catch (error) {
      logger.error(`[ThemesRepository] Failed to update custom theme ${slug}:`, error);
      throw error;
    }
  }

  /**
   * Delete a custom theme by slug
   */
  async deleteCustomTheme(slug: string): Promise<boolean> {
    const { customThemes } = this.tables;

    try {
      // Check if theme exists and is not built-in
      const existing = await this.getCustomThemeBySlug(slug);
      if (!existing) {
        logger.warn(`[ThemesRepository] Cannot delete non-existent theme: ${slug}`);
        return false;
      }
      if (existing.is_builtin) {
        throw new Error('Cannot delete built-in themes');
      }

      await this.db
        .delete(customThemes)
        .where(eq(customThemes.slug, slug));

      logger.debug(`[ThemesRepository] Deleted custom theme: ${slug}`);
      return true;
    } catch (error) {
      logger.error(`[ThemesRepository] Failed to delete custom theme ${slug}:`, error);
      throw error;
    }
  }
}
