/**
 * Migration 095: Dead Drop / Mailbox feature.
 *
 * Creates one per-source table:
 *   - dead_drop_messages: async message store ("mesh voicemail"). A node DMs
 *     the radio `msg <name> <text>`; the row is held until the named recipient
 *     retrieves it via `inbox` / `inbox play`.
 *
 * Idempotent across SQLite / PostgreSQL / MySQL.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

const LABEL = 'Migration 095';
const MESSAGES = 'dead_drop_messages';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): creating ${MESSAGES}...`);

    db.exec(`
      CREATE TABLE IF NOT EXISTS ${MESSAGES} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sourceId TEXT NOT NULL,
        shortId TEXT NOT NULL,
        recipientName TEXT NOT NULL,
        senderNodeNum INTEGER NOT NULL,
        senderShortName TEXT NOT NULL DEFAULT '',
        senderLongName TEXT NOT NULL DEFAULT '',
        body TEXT NOT NULL,
        createdAt INTEGER NOT NULL,
        playedAt INTEGER,
        deletedAt INTEGER
      )
    `);
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ddm_source_shortid_uniq ON ${MESSAGES}(sourceId, shortId)`);
    db.exec(`CREATE INDEX IF NOT EXISTS ddm_source_recipient_idx ON ${MESSAGES}(sourceId, recipientName)`);

    logger.info(`${LABEL} complete (SQLite)`);
  },

  down: (db: Database): void => {
    logger.info(`${LABEL} down (SQLite): dropping ${MESSAGES}`);
    db.exec(`DROP TABLE IF EXISTS ${MESSAGES}`);
  },
};

// ============ PostgreSQL ============

export async function runMigration095Postgres(client: any): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): creating ${MESSAGES}...`);

  await client.query(`
    CREATE TABLE IF NOT EXISTS ${MESSAGES} (
      id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      "sourceId" TEXT NOT NULL,
      "shortId" TEXT NOT NULL,
      "recipientName" TEXT NOT NULL,
      "senderNodeNum" BIGINT NOT NULL,
      "senderShortName" TEXT NOT NULL DEFAULT '',
      "senderLongName" TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL,
      "createdAt" BIGINT NOT NULL,
      "playedAt" BIGINT,
      "deletedAt" BIGINT
    )
  `);
  await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS ddm_source_shortid_uniq ON ${MESSAGES}("sourceId", "shortId")`);
  await client.query(`CREATE INDEX IF NOT EXISTS ddm_source_recipient_idx ON ${MESSAGES}("sourceId", "recipientName")`);

  logger.info(`${LABEL} complete (PostgreSQL)`);
}

// ============ MySQL ============

export async function runMigration095Mysql(pool: any): Promise<void> {
  logger.info(`${LABEL} (MySQL): creating ${MESSAGES}...`);

  const conn = await pool.getConnection();
  try {
    const [messagesExist] = await conn.query(
      `SELECT TABLE_NAME FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
      [MESSAGES],
    );
    if ((messagesExist as any[]).length === 0) {
      await conn.query(`
        CREATE TABLE ${MESSAGES} (
          id SERIAL PRIMARY KEY,
          sourceId VARCHAR(36) NOT NULL,
          shortId VARCHAR(16) NOT NULL,
          recipientName VARCHAR(64) NOT NULL,
          senderNodeNum BIGINT NOT NULL,
          senderShortName VARCHAR(64) NOT NULL DEFAULT '',
          senderLongName VARCHAR(128) NOT NULL DEFAULT '',
          body TEXT NOT NULL,
          createdAt BIGINT NOT NULL,
          playedAt BIGINT,
          deletedAt BIGINT,
          UNIQUE KEY ddm_source_shortid_uniq (sourceId, shortId),
          KEY ddm_source_recipient_idx (sourceId, recipientName)
        )
      `);
    } else {
      logger.debug(`${MESSAGES} already exists, skipping create`);
    }
  } finally {
    conn.release();
  }

  logger.info(`${LABEL} complete (MySQL)`);
}
