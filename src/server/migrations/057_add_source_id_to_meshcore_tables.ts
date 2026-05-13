/**
 * Migration 057: Lift MeshCore out of singleton-land into the per-source
 * model that Meshtastic already uses.
 *
 * Adds a nullable `sourceId TEXT` column to `meshcore_nodes` and
 * `meshcore_messages`, indexes it, and — if any rows exist that pre-date
 * multi-source MeshCore — synthesises a legacy default MeshCore source
 * (`meshcore-legacy-default`, enabled=0, companion-USB) and backfills
 * those rows to point at it.
 *
 * Mirrors what migration 021 + 050 / `_legacyDefaultSource.ts` did for
 * Meshtastic, but scoped to the MeshCore tables.
 *
 * Idempotent across SQLite/PostgreSQL/MySQL: ALTER guards against
 * duplicate columns, the synth-source uses a fixed id with INSERT ...
 * IGNORE / ON CONFLICT DO NOTHING, and backfill UPDATEs run only against
 * NULL rows so a manual re-run is a no-op.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

const LABEL = 'Migration 057';
const LEGACY_SOURCE_ID = 'meshcore-legacy-default';
const LEGACY_SOURCE_NAME = 'MeshCore (legacy)';
const LEGACY_SOURCE_TYPE = 'meshcore';
const LEGACY_SOURCE_CONFIG = JSON.stringify({
  transport: 'usb',
  port: '',
  deviceType: 'companion',
});

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): adding sourceId to meshcore tables...`);

    for (const table of ['meshcore_nodes', 'meshcore_messages']) {
      try {
        db.exec(`ALTER TABLE ${table} ADD COLUMN sourceId TEXT`);
        logger.debug(`${LABEL} (SQLite): added sourceId to ${table}`);
      } catch (e: any) {
        if (e.message?.includes('duplicate column')) {
          logger.debug(`${LABEL} (SQLite): ${table}.sourceId already exists, skipping`);
        } else {
          // Don't swallow — silent failure leaves rows without sourceId at runtime.
          logger.error(`${LABEL} (SQLite): could not add sourceId to ${table}:`, e.message);
          throw e;
        }
      }
    }

    db.exec(`CREATE INDEX IF NOT EXISTS idx_meshcore_nodes_source_id ON meshcore_nodes(sourceId)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_meshcore_messages_source_id ON meshcore_messages(sourceId)`);

    // If any rows still have NULL sourceId, mint the legacy default source
    // and backfill them.
    const hasOrphans = (() => {
      try {
        const nodes = db.prepare(`SELECT 1 FROM meshcore_nodes WHERE sourceId IS NULL LIMIT 1`).get();
        if (nodes) return true;
        const msgs = db.prepare(`SELECT 1 FROM meshcore_messages WHERE sourceId IS NULL LIMIT 1`).get();
        return Boolean(msgs);
      } catch {
        return false;
      }
    })();

    if (!hasOrphans) {
      logger.info(`${LABEL} (SQLite): no orphan meshcore rows, skipping legacy source seed`);
      return;
    }

    const sourcesExists = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='sources'`)
      .get();
    if (!sourcesExists) {
      logger.debug(`${LABEL} (SQLite): sources table missing — leaving meshcore rows with NULL sourceId`);
      return;
    }

    const ts = Date.now();
    db.prepare(`
      INSERT OR IGNORE INTO sources (id, name, type, config, enabled, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, 0, ?, ?)
    `).run(LEGACY_SOURCE_ID, LEGACY_SOURCE_NAME, LEGACY_SOURCE_TYPE, LEGACY_SOURCE_CONFIG, ts, ts);

    const nodeRes = db
      .prepare(`UPDATE meshcore_nodes SET sourceId = ? WHERE sourceId IS NULL`)
      .run(LEGACY_SOURCE_ID);
    const msgRes = db
      .prepare(`UPDATE meshcore_messages SET sourceId = ? WHERE sourceId IS NULL`)
      .run(LEGACY_SOURCE_ID);

    logger.info(
      `${LABEL} (SQLite): backfilled ${nodeRes.changes ?? 0} meshcore_nodes + ${msgRes.changes ?? 0} meshcore_messages -> ${LEGACY_SOURCE_ID}`,
    );
  },

  down: (_db: Database): void => {
    logger.debug(`${LABEL} down: not implemented (column drops are destructive)`);
  },
};

// ============ PostgreSQL ============

export async function runMigration057Postgres(client: any): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): adding sourceId to meshcore tables...`);

  for (const table of ['meshcore_nodes', 'meshcore_messages']) {
    await client.query(
      `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS "sourceId" TEXT`,
    );
    logger.debug(`${LABEL} (PostgreSQL): ensured sourceId on ${table}`);
  }

  await client.query(
    `CREATE INDEX IF NOT EXISTS idx_meshcore_nodes_source_id ON meshcore_nodes("sourceId")`,
  );
  await client.query(
    `CREATE INDEX IF NOT EXISTS idx_meshcore_messages_source_id ON meshcore_messages("sourceId")`,
  );

  const orphanNodes = await client.query(
    `SELECT 1 FROM meshcore_nodes WHERE "sourceId" IS NULL LIMIT 1`,
  );
  const orphanMsgs = await client.query(
    `SELECT 1 FROM meshcore_messages WHERE "sourceId" IS NULL LIMIT 1`,
  );
  const hasOrphans = (orphanNodes.rowCount ?? 0) > 0 || (orphanMsgs.rowCount ?? 0) > 0;

  if (!hasOrphans) {
    logger.info(`${LABEL} (PostgreSQL): no orphan meshcore rows, skipping legacy source seed`);
    return;
  }

  const sourcesExists = await client.query(`SELECT to_regclass('public.sources') AS reg`);
  if (!sourcesExists.rows[0]?.reg) {
    logger.debug(`${LABEL} (PostgreSQL): sources table missing — leaving meshcore rows with NULL sourceId`);
    return;
  }

  const ts = Date.now();
  await client.query(
    `INSERT INTO sources (id, name, type, config, enabled, "createdAt", "updatedAt")
     VALUES ($1, $2, $3, $4, false, $5, $6)
     ON CONFLICT (id) DO NOTHING`,
    [LEGACY_SOURCE_ID, LEGACY_SOURCE_NAME, LEGACY_SOURCE_TYPE, LEGACY_SOURCE_CONFIG, ts, ts],
  );

  const nodeRes = await client.query(
    `UPDATE meshcore_nodes SET "sourceId" = $1 WHERE "sourceId" IS NULL`,
    [LEGACY_SOURCE_ID],
  );
  const msgRes = await client.query(
    `UPDATE meshcore_messages SET "sourceId" = $1 WHERE "sourceId" IS NULL`,
    [LEGACY_SOURCE_ID],
  );

  logger.info(
    `${LABEL} (PostgreSQL): backfilled ${nodeRes.rowCount ?? 0} meshcore_nodes + ${msgRes.rowCount ?? 0} meshcore_messages -> ${LEGACY_SOURCE_ID}`,
  );
}

// ============ MySQL ============

export async function runMigration057Mysql(pool: any): Promise<void> {
  logger.info(`${LABEL} (MySQL): adding sourceId to meshcore tables...`);

  const conn = await pool.getConnection();
  try {
    for (const table of ['meshcore_nodes', 'meshcore_messages']) {
      const [rows] = await conn.query(
        `SELECT COLUMN_NAME FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = 'sourceId'`,
        [table],
      );
      if (!Array.isArray(rows) || rows.length === 0) {
        await conn.query(`ALTER TABLE ${table} ADD COLUMN sourceId VARCHAR(64)`);
        logger.debug(`${LABEL} (MySQL): added sourceId to ${table}`);
      } else {
        logger.debug(`${LABEL} (MySQL): ${table}.sourceId already exists, skipping`);
      }
    }

    const indexChecks: Array<[string, string]> = [
      ['meshcore_nodes', 'idx_meshcore_nodes_source_id'],
      ['meshcore_messages', 'idx_meshcore_messages_source_id'],
    ];
    for (const [table, indexName] of indexChecks) {
      const [idxRows] = await conn.query(
        `SELECT COUNT(*) as cnt FROM information_schema.STATISTICS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?`,
        [table, indexName],
      );
      if (!(idxRows as any)[0]?.cnt) {
        await conn.query(`CREATE INDEX ${indexName} ON ${table}(sourceId)`);
        logger.debug(`${LABEL} (MySQL): created index ${indexName}`);
      }
    }

    const [orphanNodes] = await conn.query(
      `SELECT 1 FROM meshcore_nodes WHERE sourceId IS NULL LIMIT 1`,
    );
    const [orphanMsgs] = await conn.query(
      `SELECT 1 FROM meshcore_messages WHERE sourceId IS NULL LIMIT 1`,
    );
    const hasOrphans =
      (Array.isArray(orphanNodes) && orphanNodes.length > 0) ||
      (Array.isArray(orphanMsgs) && orphanMsgs.length > 0);

    if (!hasOrphans) {
      logger.info(`${LABEL} (MySQL): no orphan meshcore rows, skipping legacy source seed`);
      return;
    }

    const [sourcesTable] = await conn.query(
      `SELECT COUNT(*) AS c FROM information_schema.tables
       WHERE table_schema = DATABASE() AND table_name = 'sources'`,
    );
    if (!Number((sourcesTable as any[])[0]?.c ?? 0)) {
      logger.debug(`${LABEL} (MySQL): sources table missing — leaving meshcore rows with NULL sourceId`);
      return;
    }

    const ts = Date.now();
    await conn.query(
      `INSERT IGNORE INTO sources (id, name, type, config, enabled, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, 0, ?, ?)`,
      [LEGACY_SOURCE_ID, LEGACY_SOURCE_NAME, LEGACY_SOURCE_TYPE, LEGACY_SOURCE_CONFIG, ts, ts],
    );

    const [nodeRes] = await conn.query(
      `UPDATE meshcore_nodes SET sourceId = ? WHERE sourceId IS NULL`,
      [LEGACY_SOURCE_ID],
    );
    const [msgRes] = await conn.query(
      `UPDATE meshcore_messages SET sourceId = ? WHERE sourceId IS NULL`,
      [LEGACY_SOURCE_ID],
    );

    const nodeAffected = (nodeRes as { affectedRows?: number }).affectedRows ?? 0;
    const msgAffected = (msgRes as { affectedRows?: number }).affectedRows ?? 0;
    logger.info(
      `${LABEL} (MySQL): backfilled ${nodeAffected} meshcore_nodes + ${msgAffected} meshcore_messages -> ${LEGACY_SOURCE_ID}`,
    );
  } finally {
    conn.release();
  }
}
