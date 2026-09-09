/**
 * Migration 162: the `privacy_documents` table (issue #5156).
 *
 * A publicly-reachable MeshMonitor re-serves mesh data to anonymous visitors
 * and to tokenless embed viewers. The operator running it needs somewhere to
 * publish a privacy policy, terms and a contact page. They can point at an
 * external URL (three global settings), or host the document here.
 *
 * GLOBAL by design — no `sourceId`. The document describes the deployment
 * serving the dashboard, not any one mesh source; an operator with four
 * sources publishes one policy. Mirrors `channel_database` / `automations`.
 *
 * One row per slug ('privacy' | 'terms' | 'contact'), so `slug` is UNIQUE and
 * doubles as the public URL segment (`/privacy/:slug`).
 *
 * `content` is Markdown source, never HTML — see the schema file for why that
 * distinction is load-bearing on an unauthenticated surface.
 *
 * `content` is LONGTEXT on MySQL, not TEXT. TEXT caps at 64 KiB and truncates
 * silently in non-strict mode; the route accepts up to 256 KiB, so a TEXT
 * column would silently amputate a long policy rather than reject it.
 *
 * Idempotent across SQLite / PostgreSQL / MySQL (CLAUDE.md migration recipe).
 * SQLite and PostgreSQL get native `CREATE TABLE IF NOT EXISTS` /
 * `CREATE INDEX IF NOT EXISTS`; MySQL has neither for indexes, so the unique
 * key is declared inline and the whole statement is guarded by the
 * `information_schema` helper.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';
import { createTableIfMissingMysql } from './helpers.js';

const LABEL = 'Migration 162';
const TABLE = 'privacy_documents';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): creating ${TABLE}...`);

    db.exec(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        slug TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        updatedBy TEXT,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      )
    `);

    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS privacy_documents_slug_idx ON ${TABLE} (slug)`,
    );
  },

  down: (_db: Database): void => {
    logger.debug(`${LABEL} down: not implemented (dropping a published policy is destructive)`);
  },
};

// ============ PostgreSQL ============

export async function runMigration162Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): creating ${TABLE}...`);

  await client.query(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id SERIAL PRIMARY KEY,
      slug TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      "updatedBy" TEXT,
      "createdAt" BIGINT NOT NULL,
      "updatedAt" BIGINT NOT NULL
    )
  `);

  await client.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS privacy_documents_slug_idx ON ${TABLE} (slug)`,
  );
}

// ============ MySQL ============

export async function runMigration162Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info(`${LABEL} (MySQL): creating ${TABLE}...`);

  // The unique key is declared inline: MySQL has no CREATE INDEX IF NOT
  // EXISTS, and `createTableIfMissingMysql` already guards the statement.
  await createTableIfMissingMysql(
    pool,
    TABLE,
    `CREATE TABLE ${TABLE} (
      id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      slug VARCHAR(32) NOT NULL,
      title VARCHAR(255) NOT NULL,
      content LONGTEXT NOT NULL,
      updatedBy VARCHAR(191),
      createdAt BIGINT NOT NULL,
      updatedAt BIGINT NOT NULL,
      UNIQUE KEY privacy_documents_slug_idx (slug)
    )`,
  );
}
