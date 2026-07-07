/**
 * Migration 069: Normalize `nodes.publicKey` to base64.
 *
 * Cleanup for the MQTT ingest bug at `src/server/mqttIngestion.ts:224`
 * (fixed in the same PR as this migration): NodeInfo packets received
 * via MQTT were written as **hex** while the direct serial/TCP path and
 * the device's own security-config handshake both wrote **base64**.
 *
 * The encoding mismatch caused the key-mismatch detector at
 * `meshtasticManager.ts:5572` (`existingNode.publicKey !== nodeData.publicKey`)
 * to fire as a false positive every time a node first seen via MQTT
 * later sent NodeInfo over the radio — the underlying bytes were
 * identical, only the string encoding differed.
 *
 * This migration converts every `nodes.publicKey` value that matches
 * `^[0-9a-f]{64}$` (lowercase 32-byte hex) into its base64 equivalent.
 * Idempotent: base64-encoded keys are 44 chars and include uppercase or
 * `+/=`, so they don't match the predicate on a second run.
 *
 * Idempotent across SQLite / PostgreSQL / MySQL.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

const LABEL = 'Migration 069';
const HEX_PUBKEY_RE = /^[0-9a-f]{64}$/;

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): normalizing hex-encoded nodes.publicKey to base64...`);
    // SQLite has no native base64 encode; do the conversion in JS.
     
    const rows = db
      .prepare(`SELECT nodeNum, publicKey FROM nodes WHERE publicKey IS NOT NULL AND length(publicKey) = 64`)
      .all() as Array<{ nodeNum: number; publicKey: string }>;
     
    const update = db.prepare(`UPDATE nodes SET publicKey = ? WHERE nodeNum = ?`);
    let converted = 0;
    for (const row of rows) {
      if (!HEX_PUBKEY_RE.test(row.publicKey)) continue;
      const base64 = Buffer.from(row.publicKey, 'hex').toString('base64');
      update.run(base64, row.nodeNum);
      converted++;
    }
    logger.info(`${LABEL} (SQLite): converted ${converted} hex publicKey value(s) to base64`);
  },

  down: (_db: Database): void => {
    logger.debug(`${LABEL} down: not implemented (data conversion is not safely reversible)`);
  },
};

// ============ PostgreSQL ============

export async function runMigration069Postgres(client: any): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): normalizing hex-encoded nodes."publicKey" to base64...`);
  // PG's encode(decode(col, 'hex'), 'base64') would work, but it wraps
  // every 76 chars with newlines. For 32-byte keys (44 base64 chars)
  // no wrap occurs, but to stay defensive against future longer keys,
  // do the conversion in JS for parity with the SQLite path.
  const { rows } = await client.query(
    `SELECT "nodeNum", "publicKey" FROM nodes
      WHERE "publicKey" IS NOT NULL
        AND length("publicKey") = 64
        AND "publicKey" ~ '^[0-9a-f]+$'`,
  );
  let converted = 0;
  for (const row of rows as Array<{ nodeNum: number | string; publicKey: string }>) {
    if (!HEX_PUBKEY_RE.test(row.publicKey)) continue;
    const base64 = Buffer.from(row.publicKey, 'hex').toString('base64');
    await client.query(
      `UPDATE nodes SET "publicKey" = $1 WHERE "nodeNum" = $2`,
      [base64, row.nodeNum],
    );
    converted++;
  }
  logger.info(`${LABEL} (PostgreSQL): converted ${converted} hex publicKey value(s) to base64`);
}

// ============ MySQL ============

export async function runMigration069Mysql(pool: any): Promise<void> {
  logger.info(`${LABEL} (MySQL): normalizing hex-encoded nodes.publicKey to base64...`);
  const conn = await pool.getConnection();
  try {
    const [rows] = await conn.query(
      `SELECT nodeNum, publicKey FROM nodes
        WHERE publicKey IS NOT NULL
          AND CHAR_LENGTH(publicKey) = 64
          AND publicKey REGEXP '^[0-9a-f]+$'`,
    );
    let converted = 0;
    for (const row of rows as Array<{ nodeNum: number | string; publicKey: string }>) {
      if (!HEX_PUBKEY_RE.test(row.publicKey)) continue;
      const base64 = Buffer.from(row.publicKey, 'hex').toString('base64');
      await conn.query(`UPDATE nodes SET publicKey = ? WHERE nodeNum = ?`, [base64, row.nodeNum]);
      converted++;
    }
    logger.info(`${LABEL} (MySQL): converted ${converted} hex publicKey value(s) to base64`);
  } finally {
    conn.release();
  }
}
