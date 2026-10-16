/**
 * Migration 207: passkey storage (issue #5841, PR 1 of 4).
 *
 *   user_passkeys — one row per WebAuthn credential on a local user.
 *     FK user → users(id) ON DELETE CASCADE, UNIQUE credential id, index on
 *     the user column. Public keys and credential ids are base64url text so
 *     one column type works on every backend.
 *
 *   users.password_login_disabled — BOOLEAN NOT NULL DEFAULT false. The
 *     passkey-only switch (spec D1).
 *   users.passkey_recovery_codes — TEXT NULL. JSON array of bcrypt hashes,
 *     the same format as mfa_backup_codes (spec D2).
 *
 * GLOBAL, not per-source: passkeys belong to a user account, like api_tokens.
 *
 * Column naming follows the users/api_tokens precedent: snake_case on SQLite,
 * camelCase on PostgreSQL/MySQL.
 *
 * Idempotent on all three backends: CREATE ... IF NOT EXISTS (MySQL through
 * the information_schema helper, indexes inline) and the add-column helpers.
 * No backfill.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';
import {
  addColumnIfMissing,
  addColumnIfMissingPostgres,
  addColumnIfMissingMysql,
  createTableIfMissingMysql,
} from './helpers.js';

const LABEL = 'Migration 207';
const TABLE = 'user_passkeys';
const USER_INDEX = 'idx_user_passkeys_user';

const USER_COLS_SQLITE = [
  ['password_login_disabled', 'password_login_disabled INTEGER NOT NULL DEFAULT 0'],
  ['passkey_recovery_codes', 'passkey_recovery_codes TEXT'],
] as const;

const USER_COLS_PG = [
  ['passwordLoginDisabled', '"passwordLoginDisabled" BOOLEAN NOT NULL DEFAULT FALSE'],
  ['passkeyRecoveryCodes', '"passkeyRecoveryCodes" TEXT'],
] as const;

const USER_COLS_MYSQL = [
  ['passwordLoginDisabled', 'passwordLoginDisabled BOOLEAN NOT NULL DEFAULT FALSE'],
  ['passkeyRecoveryCodes', 'passkeyRecoveryCodes TEXT'],
] as const;

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): passkey storage...`);

    for (const [column, ddl] of USER_COLS_SQLITE) {
      addColumnIfMissing(db, 'users', column, ddl);
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        credential_id TEXT NOT NULL UNIQUE,
        public_key TEXT NOT NULL,
        counter INTEGER NOT NULL DEFAULT 0,
        transports TEXT,
        device_type TEXT,
        backed_up INTEGER NOT NULL DEFAULT 0,
        rp_id TEXT NOT NULL,
        nickname TEXT,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS ${USER_INDEX} ON ${TABLE}(user_id)`);

    logger.info(`${LABEL} complete (SQLite)`);
  },

  down: (db: Database): void => {
    logger.info(`${LABEL} down (SQLite): dropping ${TABLE} (users columns kept; column drops are destructive)`);
    db.exec(`DROP TABLE IF EXISTS ${TABLE}`);
  },
};

// ============ PostgreSQL ============

export async function runMigration207Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): passkey storage...`);

  for (const [column, ddl] of USER_COLS_PG) {
    await addColumnIfMissingPostgres(client, 'users', column, ddl);
  }

  await client.query(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id SERIAL PRIMARY KEY,
      "userId" INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      "credentialId" TEXT NOT NULL UNIQUE,
      "publicKey" TEXT NOT NULL,
      counter BIGINT NOT NULL DEFAULT 0,
      transports TEXT,
      "deviceType" TEXT,
      "backedUp" BOOLEAN NOT NULL DEFAULT FALSE,
      "rpId" TEXT NOT NULL,
      nickname TEXT,
      "createdAt" BIGINT NOT NULL,
      "lastUsedAt" BIGINT
    )
  `);
  await client.query(`CREATE INDEX IF NOT EXISTS ${USER_INDEX} ON ${TABLE}("userId")`);

  logger.info(`${LABEL} complete (PostgreSQL)`);
}

// ============ MySQL ============

export async function runMigration207Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info(`${LABEL} (MySQL): passkey storage...`);

  for (const [column, ddl] of USER_COLS_MYSQL) {
    await addColumnIfMissingMysql(pool, 'users', column, ddl);
  }

  // credentialId: ASCII + binary collation. base64url is case-sensitive, and a
  // WebAuthn credential id can be up to 1023 bytes (1364 base64url chars), so
  // utf8mb4 would both fold case and blow the 3072-byte index limit.
  await createTableIfMissingMysql(pool, TABLE, `
    CREATE TABLE ${TABLE} (
      id INT AUTO_INCREMENT PRIMARY KEY,
      userId INT NOT NULL,
      credentialId VARCHAR(1400) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      publicKey TEXT NOT NULL,
      counter BIGINT NOT NULL DEFAULT 0,
      transports TEXT,
      deviceType VARCHAR(32),
      backedUp BOOLEAN NOT NULL DEFAULT FALSE,
      rpId VARCHAR(255) NOT NULL,
      nickname VARCHAR(255),
      createdAt BIGINT NOT NULL,
      lastUsedAt BIGINT,
      UNIQUE KEY user_passkeys_credential_id_uniq (credentialId),
      INDEX ${USER_INDEX} (userId),
      FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  logger.info(`${LABEL} complete (MySQL)`);
}
