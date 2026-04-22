/**
 * Migration 046: Add missing `id` / `createdAt` / `updatedAt` columns to
 * `user_map_preferences` on SQLite.
 *
 * Context:
 *   Migration 037 ensured `id`, `createdAt`, and `updatedAt` exist on
 *   PostgreSQL/MySQL `user_map_preferences`, but its SQLite counterpart is
 *   a no-op — it assumes the bootstrap `CREATE TABLE IF NOT EXISTS` block
 *   in src/services/database.ts already creates the table with those
 *   columns. That is only true for fresh installs. Legacy v3.x SQLite
 *   databases created the table before the bootstrap declared `id`, so
 *   `CREATE TABLE IF NOT EXISTS` is a no-op and the column never materialises.
 *
 *   Drizzle's getMapPreferences does `.select()` (SELECT *), which references
 *   every schema column including `id`, `createdAt`, and `updatedAt`. On
 *   those legacy SQLite tables this raises:
 *
 *     SqliteError: no such column: "id" - should this be a string literal in single-quotes?
 *
 *   SQLite can't add a PRIMARY KEY via ALTER TABLE, so we rebuild the
 *   table. All snake_case feature columns (`show_*`, `map_tileset`, etc.)
 *   are guaranteed to exist here because migration 007 already added them.
 *   Legacy camelCase variants (showAccuracyRegions, showEstimatedPositions,
 *   showMeshCoreNodes, sortBy, sortDirection, userId) are not part of the
 *   current Drizzle schema and are intentionally dropped during the rebuild.
 *
 * Dialect notes:
 *   - SQLite: rebuild table to add missing `id`, `createdAt`, `updatedAt`.
 *   - PostgreSQL / MySQL: no-op (migration 037 already handled them).
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

const TABLE_COLUMNS_SQLITE = `
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  centerLat REAL,
  centerLng REAL,
  zoom REAL,
  selectedLayer TEXT,
  map_tileset TEXT,
  show_paths INTEGER DEFAULT 0,
  show_neighbor_info INTEGER DEFAULT 0,
  show_route INTEGER DEFAULT 1,
  show_motion INTEGER DEFAULT 1,
  show_mqtt_nodes INTEGER DEFAULT 1,
  show_meshcore_nodes INTEGER DEFAULT 1,
  show_animations INTEGER DEFAULT 0,
  show_accuracy_regions INTEGER DEFAULT 0,
  show_estimated_positions INTEGER DEFAULT 0,
  position_history_hours INTEGER,
  createdAt INTEGER,
  updatedAt INTEGER
`;

const COPY_COLUMNS = [
  'user_id',
  'centerLat', 'centerLng', 'zoom', 'selectedLayer',
  'map_tileset',
  'show_paths', 'show_neighbor_info', 'show_route', 'show_motion',
  'show_mqtt_nodes', 'show_meshcore_nodes', 'show_animations',
  'show_accuracy_regions', 'show_estimated_positions',
  'position_history_hours',
  'createdAt', 'updatedAt',
];

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    const tableExists = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='user_map_preferences'`,
    ).get() as { name: string } | undefined;
    if (!tableExists) {
      logger.debug('Migration 046 (SQLite): user_map_preferences table does not exist, skipping');
      return;
    }

    const cols = db.prepare(`PRAGMA table_info(user_map_preferences)`).all() as Array<{ name: string }>;
    const liveCols = new Set(cols.map((c) => c.name));
    if (liveCols.has('id')) {
      logger.debug('Migration 046 (SQLite): user_map_preferences.id already exists, skipping');
      return;
    }

    logger.info('Migration 046 (SQLite): rebuilding user_map_preferences to add id/createdAt/updatedAt...');

    // Must disable FK enforcement during the rebuild so the child-table
    // REFERENCES users(id) doesn't trip parent-key checks mid-swap, and so
    // any preexisting broken FKs elsewhere don't block the DDL.
    const prevForeignKeys = db.pragma('foreign_keys', { simple: true }) as number;
    if (prevForeignKeys) {
      db.pragma('foreign_keys = OFF');
    }
    const prevLegacyAlter = db.pragma('legacy_alter_table', { simple: true }) as number;
    if (!prevLegacyAlter) {
      db.pragma('legacy_alter_table = ON');
    }

    const copyCols = COPY_COLUMNS.filter((c) => liveCols.has(c));
    const copyList = copyCols.join(', ');

    const existingIndexes = db.prepare(`
      SELECT name, sql FROM sqlite_master
      WHERE type='index' AND tbl_name='user_map_preferences' AND sql IS NOT NULL
    `).all() as Array<{ name: string; sql: string }>;

    const tx = db.transaction(() => {
      db.exec(`CREATE TABLE user_map_preferences_new (${TABLE_COLUMNS_SQLITE})`);
      if (copyList.length > 0) {
        db.exec(`
          INSERT INTO user_map_preferences_new (${copyList})
          SELECT ${copyList} FROM user_map_preferences
        `);
      }
      db.exec(`DROP TABLE user_map_preferences`);
      db.exec(`ALTER TABLE user_map_preferences_new RENAME TO user_map_preferences`);

      for (const idx of existingIndexes) {
        if (idx.name.startsWith('sqlite_autoindex_')) continue;
        try {
          db.exec(idx.sql);
        } catch (err) {
          logger.warn(`Migration 046 (SQLite): failed to recreate index ${idx.name}:`, err);
        }
      }
    });

    try {
      tx();
    } finally {
      if (prevForeignKeys) {
        db.pragma('foreign_keys = ON');
      }
      if (!prevLegacyAlter) {
        db.pragma('legacy_alter_table = OFF');
      }
    }

    logger.info('Migration 046 complete (SQLite)');
  },

  down: (_db: Database): void => {
    logger.debug('Migration 046 down: not implemented (column drop is destructive)');
  },
};

// ============ PostgreSQL ============

export async function runMigration046Postgres(_client: any): Promise<void> {
  logger.debug('Migration 046 (PostgreSQL): no-op (migration 037 already ensured id/createdAt/updatedAt)');
}

// ============ MySQL ============

export async function runMigration046Mysql(_pool: any): Promise<void> {
  logger.debug('Migration 046 (MySQL): no-op (migration 037 already ensured id/createdAt/updatedAt)');
}
