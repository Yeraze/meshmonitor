/**
 * Migration 104: Add channel_hash column to channel_database.
 *
 * MQTT channels are identified by NAME only, which collapses two same-name but
 * differently-keyed channels into one row when neither can be decrypted
 * server-side. The Meshtastic 1-byte channel hash (`packet.channel` on MQTT,
 * = xorHash(name) ^ xorHash(psk)) gives us a second identity dimension.
 *
 * Column semantics:
 *   - ENABLED rows (real PSK): channel_hash stays NULL — their hash is
 *     computable from name + psk on demand.
 *   - PASSIVE rows (psk=''): channel_hash stores the observed packet hash so
 *     two same-name/different-key undecryptable channels stay distinct.
 *
 * Nullable integer (0-255), defaults to NULL. Existing rows keep NULL, which
 * preserves the prior name-only matching behaviour.
 *
 * Idempotent across SQLite / PostgreSQL / MySQL.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info('Running migration 104 (SQLite): Adding channel_hash to channel_database...');

    try {
      db.exec('ALTER TABLE channel_database ADD COLUMN channel_hash INTEGER');
      logger.debug('Added channel_database.channel_hash');
    } catch (e: any) {
      if (e.message?.includes('duplicate column')) {
        logger.debug('channel_database.channel_hash already exists, skipping');
      } else {
        logger.warn('Could not add channel_database.channel_hash:', e.message);
      }
    }

    logger.info('Migration 104 complete (SQLite): channel_database.channel_hash added');
  },

  down: (_db: Database): void => {
    logger.debug('Migration 104 down: Not implemented (destructive column drop)');
  },
};

// ============ PostgreSQL ============

/**
 * Rebuild channel_database from scratch to clear accumulated column tombstones.
 *
 * PostgreSQL counts every ADD COLUMN operation ever executed against a table
 * (including columns later dropped) toward a hard limit of 1600 "attribute
 * numbers" (attnums).  An earlier version of migration 021 included
 * channel_database in its ADD COLUMN loop; migration 063 then dropped that
 * same column.  Because PostgreSQL runs all migrations on every startup
 * (no completion tracking), this ADD/DROP cycle consumed one attnum per
 * restart.  Users who restarted the server 1 600+ times before the
 * migration 021 fix was shipped will hit the limit on the next ADD COLUMN
 * (migration 104's channelHash).
 *
 * The only safe recovery is to CREATE a fresh copy of the table and
 * RENAME it into place.  The new table starts with 0 tombstones.
 */
async function rebuildChannelDatabasePostgres(client: import('pg').PoolClient): Promise<void> {
  // Wrap the destructive rebuild in a single transaction. It DROPs the live
  // channel_database and RENAMEs a fresh copy into place, and the outer
  // migration runner opens no transaction of its own. PostgreSQL DDL is
  // transactional, so an error/crash mid-rebuild rolls back to the original
  // table intact instead of leaving the database with no channel_database
  // (which would also make this migration's own idempotency check throw
  // "relation does not exist" on the next startup).
  await client.query('BEGIN');
  try {
  // Clean up a leftover scratch table from any previous failed rebuild.
  await client.query(`DROP TABLE IF EXISTS channel_database_new`);

  // Discover which live columns the old table actually has.
  const liveColsResult = await client.query<{ attname: string }>(`
    SELECT attname
    FROM pg_attribute
    WHERE attrelid = 'channel_database'::regclass
      AND attnum > 0
      AND NOT attisdropped
    ORDER BY attnum
  `);
  const liveCols = new Set(liveColsResult.rows.map((r) => r.attname));

  // Create a fresh table with the current canonical schema (includes channelHash).
  await client.query(`
    CREATE TABLE channel_database_new (
      id              SERIAL PRIMARY KEY,
      name            TEXT    NOT NULL,
      psk             TEXT    NOT NULL,
      "pskLength"     INTEGER NOT NULL,
      "channelHash"   INTEGER,
      description     TEXT,
      "isEnabled"             BOOLEAN NOT NULL DEFAULT true,
      "enforceNameValidation" BOOLEAN NOT NULL DEFAULT false,
      "sortOrder"             INTEGER NOT NULL DEFAULT 0,
      "decryptedPacketCount"  INTEGER NOT NULL DEFAULT 0,
      "lastDecryptedAt"       BIGINT,
      "createdBy"     INTEGER REFERENCES users(id) ON DELETE SET NULL,
      "createdAt"     BIGINT  NOT NULL,
      "updatedAt"     BIGINT  NOT NULL
    )
  `);

  // Build an INSERT that copies only the columns present in the old table
  // (channelHash will be NULL for all migrated rows, which is the correct default).
  const canonicalCols = [
    'name', 'psk', 'pskLength', 'description', 'isEnabled',
    'enforceNameValidation', 'sortOrder', 'decryptedPacketCount',
    'lastDecryptedAt', 'createdBy', 'createdAt', 'updatedAt',
  ];
  const colsToCopy = canonicalCols.filter((c) => liveCols.has(c));
  const colList = ['id', ...colsToCopy].map((c) => `"${c}"`).join(', ');

  await client.query(
    `INSERT INTO channel_database_new (${colList}) SELECT ${colList} FROM channel_database`,
  );

  // Advance the new sequence past the highest copied id.
  await client.query(`
    SELECT setval(
      'channel_database_new_id_seq',
      COALESCE((SELECT MAX(id) FROM channel_database_new), 0)
    )
  `);

  // DROP CASCADE removes all FK constraints in referencing tables
  // (rows in channel_database_permissions are preserved).
  await client.query(`DROP TABLE channel_database CASCADE`);

  await client.query(`ALTER TABLE channel_database_new RENAME TO channel_database`);
  await client.query(`ALTER SEQUENCE channel_database_new_id_seq RENAME TO channel_database_id_seq`);

  // Re-attach the FK from channel_database_permissions (dropped by CASCADE above).
  const permExists = await client.query<{ exists: boolean }>(`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name   = 'channel_database_permissions'
    ) AS exists
  `);
  if (permExists.rows[0].exists) {
    await client.query(`
      ALTER TABLE channel_database_permissions
        ADD FOREIGN KEY ("channelDatabaseId")
            REFERENCES channel_database(id)
            ON DELETE CASCADE
    `);
    logger.debug('Migration 104 (PostgreSQL): re-attached FK on channel_database_permissions');
  }

    await client.query('COMMIT');
  } catch (err) {
    // Roll back to the original channel_database; nothing is dropped.
    await client.query('ROLLBACK');
    throw err;
  }
}

export async function runMigration104Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info('Running migration 104 (PostgreSQL): Adding channel_hash to channel_database...');

  // Idempotency check: skip if the column is already live.
  const colCheck = await client.query<{ cnt: string }>(`
    SELECT COUNT(*) AS cnt
    FROM pg_attribute
    WHERE attrelid = 'channel_database'::regclass
      AND attname  = 'channelHash'
      AND attnum   > 0
      AND NOT attisdropped
  `);
  if (parseInt(colCheck.rows[0].cnt, 10) > 0) {
    logger.info('Migration 104 (PostgreSQL): channelHash already exists, skipping');
    return;
  }

  // Check total attnum slots used (live + tombstoned).  PostgreSQL's hard
  // limit is 1600; approaching it means a rebuild is needed before we can
  // add another column.
  const tombCheck = await client.query<{ cnt: string }>(`
    SELECT COUNT(*) AS cnt
    FROM pg_attribute
    WHERE attrelid = 'channel_database'::regclass
      AND attnum > 0
  `);
  const tombstoneCount = parseInt(tombCheck.rows[0].cnt, 10);

  if (tombstoneCount >= 1500) {
    logger.warn(
      `Migration 104 (PostgreSQL): channel_database has ${tombstoneCount} column` +
      ` tombstones (PostgreSQL limit = 1600). Rebuilding table to clear tombstones...`,
    );
    await rebuildChannelDatabasePostgres(client);
    logger.info('Migration 104 (PostgreSQL): rebuild complete — channelHash now present');
    return;
  }

  // Normal path: the table has room for a new column.
  try {
    await client.query('ALTER TABLE channel_database ADD COLUMN IF NOT EXISTS "channelHash" INTEGER');
    logger.debug('Ensured channel_database.channelHash exists');
  } catch (error: any) {
    logger.error('Migration 104 (PostgreSQL) failed:', error.message);
    throw error;
  }

  logger.info('Migration 104 complete (PostgreSQL): channel_database.channelHash added');
}

// ============ MySQL ============

export async function runMigration104Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info('Running migration 104 (MySQL): Adding channel_hash to channel_database...');

  try {
    const [rows] = await pool.query(`
      SELECT COLUMN_NAME FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'channel_database' AND COLUMN_NAME = 'channelHash'
    `);
    if (!Array.isArray(rows) || rows.length === 0) {
      await pool.query('ALTER TABLE channel_database ADD COLUMN channelHash INT NULL');
      logger.debug('Added channel_database.channelHash');
    } else {
      logger.debug('channel_database.channelHash already exists, skipping');
    }
  } catch (error: any) {
    logger.error('Migration 104 (MySQL) failed:', error.message);
    throw error;
  }

  logger.info('Migration 104 complete (MySQL): channel_database.channelHash added');
}
