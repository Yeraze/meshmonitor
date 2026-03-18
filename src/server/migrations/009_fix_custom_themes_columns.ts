/**
 * Migration 085: Fix custom_themes table column names and add missing columns
 *
 * The PostgreSQL/MySQL CREATE TABLE had camelCase column names (createdBy, createdAt, updatedAt)
 * and was missing the slug and is_builtin columns that the Drizzle schema and SQLite migration define.
 * This migration:
 * 1. Adds missing columns: slug, is_builtin
 * 2. Renames camelCase columns to snake_case to match Drizzle schema
 * 3. Generates slug values for existing themes that don't have one
 */

import type { Database } from 'better-sqlite3';
import type { PoolClient } from 'pg';
import type { Pool as MySQLPool } from 'mysql2/promise';
import { logger } from '../../utils/logger.js';

export const migration = {
  up: (_db: Database): void => {
    // SQLite already has the correct schema from migration 022
    logger.debug('⏭️  Migration 085: SQLite already has correct custom_themes schema');
  },
  down: (_db: Database): void => {
    logger.debug('⏭️  Migration 085: No SQLite changes to revert');
  }
};

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 128);
}

export async function runMigration085Postgres(client: PoolClient): Promise<void> {
  try {
    // Check if migration is needed by looking for the slug column
    const slugCheck = await client.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'custom_themes' AND column_name = 'slug'
    `);

    if (slugCheck.rows.length > 0) {
      logger.debug('⏭️  Migration 085: custom_themes already has slug column');
    } else {
      // Add slug column
      await client.query(`ALTER TABLE custom_themes ADD COLUMN IF NOT EXISTS slug TEXT`);

      // Generate slugs for existing themes
      const themes = await client.query('SELECT id, name FROM custom_themes WHERE slug IS NULL');
      for (const theme of themes.rows) {
        const slug = slugify(theme.name);
        await client.query('UPDATE custom_themes SET slug = $1 WHERE id = $2', [slug, theme.id]);
      }

      // Make slug NOT NULL and UNIQUE
      await client.query(`ALTER TABLE custom_themes ALTER COLUMN slug SET NOT NULL`);
      await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_custom_themes_slug ON custom_themes(slug)`);

      logger.debug('✅ Migration 085: Added slug column to custom_themes');
    }

    // Add is_builtin column
    const builtinCheck = await client.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'custom_themes' AND column_name = 'is_builtin'
    `);
    if (builtinCheck.rows.length === 0) {
      await client.query(`ALTER TABLE custom_themes ADD COLUMN is_builtin BOOLEAN DEFAULT false`);
      logger.debug('✅ Migration 085: Added is_builtin column to custom_themes');
    }

    // Rename camelCase columns to snake_case if needed
    const createdByCheck = await client.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'custom_themes' AND column_name = 'createdBy'
    `);
    if (createdByCheck.rows.length > 0) {
      await client.query(`ALTER TABLE custom_themes RENAME COLUMN "createdBy" TO created_by`);
      await client.query(`ALTER TABLE custom_themes RENAME COLUMN "createdAt" TO created_at`);
      await client.query(`ALTER TABLE custom_themes RENAME COLUMN "updatedAt" TO updated_at`);
      logger.debug('✅ Migration 085: Renamed camelCase columns to snake_case in custom_themes');
    }

    logger.debug('✅ Migration 085 (PostgreSQL) completed');
  } catch (error: any) {
    if (error.message?.includes('already exists')) {
      logger.debug('⏭️  Migration 085: custom_themes columns already correct');
    } else {
      logger.error('❌ Migration 085 (PostgreSQL) failed:', error);
      throw error;
    }
  }
}

export async function runMigration085Mysql(pool: MySQLPool): Promise<void> {
  try {
    // Check if migration is needed
    const [slugRows] = await pool.query(`
      SELECT COLUMN_NAME FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'custom_themes' AND COLUMN_NAME = 'slug'
    `);

    if ((slugRows as any[]).length === 0) {
      // Add slug column
      await pool.query(`ALTER TABLE custom_themes ADD COLUMN slug VARCHAR(128) AFTER name`);

      // Generate slugs for existing themes
      const [themes] = await pool.query('SELECT id, name FROM custom_themes WHERE slug IS NULL');
      for (const theme of themes as any[]) {
        const slug = slugify(theme.name);
        await pool.query('UPDATE custom_themes SET slug = ? WHERE id = ?', [slug, theme.id]);
      }

      // Make slug NOT NULL and UNIQUE
      await pool.query(`ALTER TABLE custom_themes MODIFY COLUMN slug VARCHAR(128) NOT NULL`);
      await pool.query(`CREATE UNIQUE INDEX idx_custom_themes_slug ON custom_themes(slug)`);

      logger.debug('✅ Migration 085: Added slug column to custom_themes');
    }

    // Add is_builtin column
    const [builtinRows] = await pool.query(`
      SELECT COLUMN_NAME FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'custom_themes' AND COLUMN_NAME = 'is_builtin'
    `);
    if ((builtinRows as any[]).length === 0) {
      await pool.query(`ALTER TABLE custom_themes ADD COLUMN is_builtin BOOLEAN DEFAULT false`);
      logger.debug('✅ Migration 085: Added is_builtin column to custom_themes');
    }

    // Rename camelCase columns to snake_case if needed
    const [createdByRows] = await pool.query(`
      SELECT COLUMN_NAME FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'custom_themes' AND COLUMN_NAME = 'createdBy'
    `);
    if ((createdByRows as any[]).length > 0) {
      await pool.query(`ALTER TABLE custom_themes CHANGE COLUMN createdBy created_by INT`);
      await pool.query(`ALTER TABLE custom_themes CHANGE COLUMN createdAt created_at BIGINT NOT NULL`);
      await pool.query(`ALTER TABLE custom_themes CHANGE COLUMN updatedAt updated_at BIGINT NOT NULL`);
      logger.debug('✅ Migration 085: Renamed camelCase columns to snake_case in custom_themes');
    }

    logger.debug('✅ Migration 085 (MySQL) completed');
  } catch (error: any) {
    if (error.message?.includes('Duplicate')) {
      logger.debug('⏭️  Migration 085: custom_themes columns already correct');
    } else {
      logger.error('❌ Migration 085 (MySQL) failed:', error);
      throw error;
    }
  }
}
