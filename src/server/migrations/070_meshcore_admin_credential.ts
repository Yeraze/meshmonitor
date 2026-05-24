/**
 * Migration 070: Persist encrypted MeshCore admin passwords on
 * `meshcore_nodes`.
 *
 * MeshCore's remote-administration story is a CLI-over-DM protocol gated by
 * a per-node password (see meshcoreManager.loginToNode / sendCliCommand).
 * Re-prompting on every command would be hostile; opting users into a saved
 * password requires reversible encryption at rest.
 *
 * Storage shape (column `adminCredential`, JSON-as-TEXT, nullable):
 *
 *   {
 *     "v":   1,                       // KDF version, in case info-strings rotate
 *     "kid": "<8 hex chars>",         // first 4 bytes of HKDF fingerprint over
 *                                     //   SESSION_SECRET — used to detect a
 *                                     //   changed SESSION_SECRET on decrypt
 *     "iv":  "<24 hex chars>",        // 12-byte AES-GCM nonce
 *     "ct":  "<hex>",                 // ciphertext
 *     "tag": "<32 hex chars>"         // 16-byte AES-GCM auth tag
 *   }
 *
 * The previous comment on `meshcoreNodesSqlite.hasAdminAccess` warned that
 * passwords were intentionally NOT stored. That advice is replaced by the
 * encryption design in `src/server/services/meshcoreCredentialStore.ts` —
 * persistence is gated on the operator having configured SESSION_SECRET
 * (auto-generated secrets are detected and the UI hides the "remember"
 * option).
 *
 * Idempotent across SQLite / PostgreSQL / MySQL.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

const LABEL = 'Migration 070';
const TABLE = 'meshcore_nodes';
const COLUMN = 'adminCredential';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): adding ${TABLE}.${COLUMN}...`);
    try {
      // eslint-disable-next-line no-restricted-syntax -- migrations require raw DDL
      db.exec(`ALTER TABLE ${TABLE} ADD COLUMN ${COLUMN} TEXT`);
      logger.debug(`${LABEL} (SQLite): added ${TABLE}.${COLUMN}`);
    } catch (e: any) {
      if (e.message?.includes('duplicate column')) {
        logger.debug(`${LABEL} (SQLite): ${TABLE}.${COLUMN} already present, skipping`);
      } else {
        logger.error(`${LABEL} (SQLite): could not add ${TABLE}.${COLUMN}:`, e.message);
        throw e;
      }
    }
  },

  down: (_db: Database): void => {
    logger.debug(`${LABEL} down: not implemented (column drops are destructive)`);
  },
};

// ============ PostgreSQL ============

export async function runMigration070Postgres(client: any): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): adding ${TABLE}.${COLUMN}...`);
  await client.query(
    `ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS "${COLUMN}" TEXT`,
  );
}

// ============ MySQL ============

export async function runMigration070Mysql(pool: any): Promise<void> {
  logger.info(`${LABEL} (MySQL): adding ${TABLE}.${COLUMN}...`);
  const conn = await pool.getConnection();
  try {
    const [rows] = await conn.query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
      [TABLE, COLUMN],
    );
    if (Array.isArray(rows) && rows.length === 0) {
      await conn.query(`ALTER TABLE ${TABLE} ADD COLUMN ${COLUMN} VARCHAR(1024)`);
      logger.debug(`${LABEL} (MySQL): added ${TABLE}.${COLUMN}`);
    } else {
      logger.debug(`${LABEL} (MySQL): ${TABLE}.${COLUMN} already present, skipping`);
    }
  } finally {
    conn.release();
  }
}
