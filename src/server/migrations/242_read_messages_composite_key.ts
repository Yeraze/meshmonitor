/**
 * Migration 242: key SQLite `read_messages` by (message_id, user_id) (#6505).
 *
 * The v3.7 baseline made `message_id` the table's only PRIMARY KEY, and every
 * mark-read path inserts with ON CONFLICT DO NOTHING. So once any user read a
 * message, no other user could mark it read: their insert hit the key and was
 * dropped, and the message stayed unread for them forever. PostgreSQL and
 * MySQL never had this problem; they use a serial id and check
 * (messageId, userId) with NOT EXISTS before inserting.
 *
 * SQLite cannot change a primary key in place, so this rebuilds the table
 * (the 12-step pattern, as in migration 115) and copies every row. `user_id`
 * stays nullable so old rows survive as-is; no write path stores NULL
 * (anonymous writes use 0).
 *
 * PostgreSQL / MySQL: no-op.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

const REBUILD_TABLE = 'read_messages_rebuild_242';

interface TableInfoRow {
  name: string;
  pk: number;
}

export const migration = {
  up: (db: Database): void => {
    const hasTable = db
      .prepare("SELECT COUNT(*) as count FROM sqlite_master WHERE type='table' AND name='read_messages'")
      .get() as { count: number };
    if (hasTable.count === 0) {
      logger.debug('Migration 242 (SQLite): read_messages does not exist, skipping');
      return;
    }

    const columns = db.prepare(`PRAGMA table_info('read_messages')`).all() as TableInfoRow[];
    const userIdCol = columns.find((c) => c.name === 'user_id');
    if (userIdCol && userIdCol.pk > 0) {
      logger.debug('Migration 242 (SQLite): read_messages already keyed by (message_id, user_id), skipping');
      return;
    }

    const prevForeignKeys = db.pragma('foreign_keys', { simple: true }) as number;
    if (prevForeignKeys) db.pragma('foreign_keys = OFF');
    const prevLegacyAlter = db.pragma('legacy_alter_table', { simple: true }) as number;
    if (!prevLegacyAlter) db.pragma('legacy_alter_table = ON');

    try {
      const tx = db.transaction(() => {
        // A crash between CREATE and RENAME can leave this behind.
        db.exec(`DROP TABLE IF EXISTS ${REBUILD_TABLE}`);
        db.exec(`
          CREATE TABLE ${REBUILD_TABLE} (
            message_id TEXT NOT NULL,
            user_id INTEGER,
            read_at INTEGER NOT NULL,
            PRIMARY KEY (message_id, user_id),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
          )
        `);
        db.exec(`
          INSERT OR IGNORE INTO ${REBUILD_TABLE} (message_id, user_id, read_at)
          SELECT message_id, user_id, read_at FROM read_messages
        `);
        db.exec('DROP TABLE read_messages');
        db.exec(`ALTER TABLE ${REBUILD_TABLE} RENAME TO read_messages`);
      });
      tx();
    } finally {
      if (!prevLegacyAlter) db.pragma('legacy_alter_table = OFF');
      if (prevForeignKeys) db.pragma('foreign_keys = ON');
    }

    logger.info('Migration 242 (SQLite): read_messages now keyed by (message_id, user_id)');
  },
};

export async function runMigration242Postgres(_client: import('pg').PoolClient): Promise<void> {
  // PostgreSQL already keys reads by (messageId, userId) semantics.
}

export async function runMigration242Mysql(_pool: import('mysql2/promise').Pool): Promise<void> {
  // MySQL already keys reads by (messageId, userId) semantics.
}
