/**
 * Migration 061: meshcore_nodes composite PK (sourceId, publicKey).
 *
 * Slice of the MeshCore per-source refactor. Before this migration the table
 * keyed on `publicKey` alone — so the same MeshCore device advertising under
 * two different sources collapsed into one row, and any second-source write
 * raised `UNIQUE constraint failed: meshcore_nodes.publicKey` (observed via
 * `POST /api/sources/{sourceId}/meshcore/nodes/{publicKey}/telemetry-config`
 * for a publicKey already owned by another source).
 *
 * New shape: composite primary key `(sourceId, publicKey)` so each
 * (source, key) pair is independent. Mirrors what migration 029 did for
 * Meshtastic `nodes (nodeNum, sourceId)`.
 *
 * Backfill: migration 057 already mints a `meshcore-legacy-default` source
 * for any orphan NULL-sourceId rows, but we still defensively backfill here
 * in case those rows were re-introduced between 057 and now. If `sources`
 * is empty we synthesise the same legacy default 057 uses so the upgrade
 * can complete.
 *
 * SQLite path uses the rebuild pattern (CREATE _new + copy + drop + rename)
 * because SQLite cannot ALTER a primary key in place. PG/MySQL just swap
 * the PK constraint.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

const LABEL = 'Migration 061';
const LEGACY_SOURCE_ID = 'meshcore-legacy-default';
const LEGACY_SOURCE_NAME = 'MeshCore (legacy)';
const LEGACY_SOURCE_TYPE = 'meshcore';
const LEGACY_SOURCE_CONFIG = JSON.stringify({
  transport: 'usb',
  port: '',
  deviceType: 'companion',
});

// Stable column order for the SQLite rebuild. Must match the post-060
// `meshcore_nodes` shape exactly: bootstrap columns + 057 (sourceId) +
// 060 (telemetry retrieval columns).
const MESHCORE_NODE_COLUMNS_SQLITE = `
  publicKey TEXT NOT NULL,
  name TEXT,
  advType INTEGER,
  txPower INTEGER,
  maxTxPower INTEGER,
  radioFreq REAL,
  radioBw REAL,
  radioSf INTEGER,
  radioCr INTEGER,
  latitude REAL,
  longitude REAL,
  altitude REAL,
  batteryMv INTEGER,
  uptimeSecs INTEGER,
  rssi INTEGER,
  snr REAL,
  lastHeard INTEGER,
  hasAdminAccess INTEGER DEFAULT 0,
  lastAdminCheck INTEGER,
  isLocalNode INTEGER DEFAULT 0,
  sourceId TEXT NOT NULL,
  telemetryEnabled INTEGER DEFAULT 0,
  telemetryIntervalMinutes INTEGER DEFAULT 60,
  lastTelemetryRequestAt INTEGER,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL
`;

const MESHCORE_NODE_COLUMN_LIST = `
  publicKey, name, advType, txPower, maxTxPower, radioFreq, radioBw,
  radioSf, radioCr, latitude, longitude, altitude, batteryMv, uptimeSecs,
  rssi, snr, lastHeard, hasAdminAccess, lastAdminCheck, isLocalNode,
  sourceId, telemetryEnabled, telemetryIntervalMinutes, lastTelemetryRequestAt,
  createdAt, updatedAt
`;

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): rebuilding meshcore_nodes with composite (sourceId, publicKey) PK...`);

    // Idempotency: composite PK already in place?
    try {
      const pkCols = db
        .prepare(`SELECT name FROM pragma_table_info('meshcore_nodes') WHERE pk > 0 ORDER BY pk`)
        .all() as Array<{ name: string }>;
      const pkNames = pkCols.map((r) => r.name);
      if (pkNames.includes('publicKey') && pkNames.includes('sourceId')) {
        logger.info(`${LABEL} (SQLite): meshcore_nodes already has composite PK, skipping`);
        return;
      }
    } catch (err) {
      logger.warn(`${LABEL} (SQLite): idempotency check failed, attempting migration anyway:`, err);
    }

    // Capture non-autoindex indexes so we can recreate them post-rebuild.
    const existingIndexes = db
      .prepare(
        `SELECT name, sql FROM sqlite_master
         WHERE type = 'index' AND tbl_name = 'meshcore_nodes' AND sql IS NOT NULL`,
      )
      .all() as Array<{ name: string; sql: string }>;

    // SQLite's table-rebuild pattern needs foreign_keys=OFF
    // (https://www.sqlite.org/lang_altertable.html). Pragma must be set
    // outside any transaction or it becomes a no-op.
    const prevForeignKeys = db.pragma('foreign_keys', { simple: true }) as number;
    if (prevForeignKeys) {
      db.pragma('foreign_keys = OFF');
    }

    const tx = db.transaction(() => {
      // Backfill any lingering NULL-sourceId rows so the new NOT NULL +
      // composite PK don't reject them. Mirrors 057's strategy.
      const nullNodesRow = db
        .prepare(`SELECT COUNT(*) as c FROM meshcore_nodes WHERE sourceId IS NULL`)
        .get() as { c: number };
      const nullNodes = nullNodesRow?.c ?? 0;

      if (nullNodes > 0) {
        const sourcesExists = db
          .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='sources'`)
          .get();

        if (sourcesExists) {
          const ts = Date.now();
          db.prepare(
            `INSERT OR IGNORE INTO sources (id, name, type, config, enabled, createdAt, updatedAt)
             VALUES (?, ?, ?, ?, 0, ?, ?)`,
          ).run(LEGACY_SOURCE_ID, LEGACY_SOURCE_NAME, LEGACY_SOURCE_TYPE, LEGACY_SOURCE_CONFIG, ts, ts);

          const res = db
            .prepare(`UPDATE meshcore_nodes SET sourceId = ? WHERE sourceId IS NULL`)
            .run(LEGACY_SOURCE_ID);
          logger.info(
            `${LABEL} (SQLite): backfilled ${res.changes ?? 0} NULL-sourceId meshcore_nodes -> ${LEGACY_SOURCE_ID}`,
          );
        } else {
          // No sources table — extremely unusual at this point. Drop the
          // orphans so the composite PK doesn't fail the upgrade.
          const res = db.prepare(`DELETE FROM meshcore_nodes WHERE sourceId IS NULL`).run();
          logger.warn(
            `${LABEL} (SQLite): sources table missing; deleted ${res.changes ?? 0} orphan NULL-sourceId meshcore_nodes`,
          );
        }
      }

      // Rebuild meshcore_nodes with composite PK.
      db.exec(`
        CREATE TABLE meshcore_nodes_new (
          ${MESHCORE_NODE_COLUMNS_SQLITE},
          PRIMARY KEY (sourceId, publicKey)
        )
      `);

      db.exec(`
        INSERT INTO meshcore_nodes_new (${MESHCORE_NODE_COLUMN_LIST})
        SELECT ${MESHCORE_NODE_COLUMN_LIST} FROM meshcore_nodes
      `);

      db.exec(`DROP TABLE meshcore_nodes`);
      db.exec(`ALTER TABLE meshcore_nodes_new RENAME TO meshcore_nodes`);

      // Recreate any non-PK indexes that existed before. Skip auto unique
      // indexes (regenerated by the new schema's PK).
      for (const idx of existingIndexes) {
        if (idx.name.startsWith('sqlite_autoindex_')) continue;
        try {
          db.exec(idx.sql);
        } catch (err) {
          logger.warn(`${LABEL} (SQLite): failed to recreate index ${idx.name}:`, err);
        }
      }

      // Ensure the source-id index from migration 057 exists.
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_meshcore_nodes_source_id ON meshcore_nodes(sourceId)`,
      );
    });

    try {
      tx();
    } finally {
      if (prevForeignKeys) {
        db.pragma('foreign_keys = ON');
      }
    }

    logger.info(`${LABEL} complete (SQLite)`);
  },

  down: (_db: Database): void => {
    logger.debug(`${LABEL} down: not implemented (destructive)`);
  },
};

// ============ PostgreSQL ============

export async function runMigration061Postgres(client: any): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): meshcore_nodes composite PK (sourceId, publicKey)...`);

  // Idempotency: already composite?
  const pkCheck = await client.query(`
    SELECT a.attname
    FROM pg_index i
    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
    WHERE i.indrelid = 'meshcore_nodes'::regclass AND i.indisprimary
  `);
  const pkCols = pkCheck.rows.map((r: any) => r.attname);
  if (pkCols.includes('sourceId') && pkCols.includes('publicKey') && pkCols.length >= 2) {
    logger.info(`${LABEL} (PostgreSQL): composite PK already present, skipping`);
    return;
  }

  await client.query('BEGIN');
  try {
    // Backfill NULL sourceIds defensively.
    const nullRes = await client.query(
      `SELECT COUNT(*)::int AS c FROM "meshcore_nodes" WHERE "sourceId" IS NULL`,
    );
    const nullNodes = nullRes.rows[0]?.c ?? 0;

    if (nullNodes > 0) {
      const ts = Date.now();
      await client.query(
        `INSERT INTO sources (id, name, type, config, enabled, "createdAt", "updatedAt")
         VALUES ($1, $2, $3, $4, false, $5, $6)
         ON CONFLICT (id) DO NOTHING`,
        [LEGACY_SOURCE_ID, LEGACY_SOURCE_NAME, LEGACY_SOURCE_TYPE, LEGACY_SOURCE_CONFIG, ts, ts],
      );

      const upd = await client.query(
        `UPDATE "meshcore_nodes" SET "sourceId" = $1 WHERE "sourceId" IS NULL`,
        [LEGACY_SOURCE_ID],
      );
      logger.info(
        `${LABEL} (PostgreSQL): backfilled ${upd.rowCount ?? 0} NULL-sourceId meshcore_nodes -> ${LEGACY_SOURCE_ID}`,
      );
    }

    await client.query(`ALTER TABLE "meshcore_nodes" ALTER COLUMN "sourceId" SET NOT NULL`);

    // Drop existing PK (Postgres-default name: meshcore_nodes_pkey).
    await client.query(`ALTER TABLE "meshcore_nodes" DROP CONSTRAINT IF EXISTS meshcore_nodes_pkey`);

    await client.query(`
      ALTER TABLE "meshcore_nodes"
        ADD CONSTRAINT meshcore_nodes_pkey PRIMARY KEY ("sourceId", "publicKey")
    `);

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }

  logger.info(`${LABEL} complete (PostgreSQL)`);
}

// ============ MySQL ============

export async function runMigration061Mysql(pool: any): Promise<void> {
  logger.info(`${LABEL} (MySQL): meshcore_nodes composite PK (sourceId, publicKey)...`);

  const conn = await pool.getConnection();
  try {
    const [pkRows] = await conn.query(
      `SELECT COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'meshcore_nodes' AND CONSTRAINT_NAME = 'PRIMARY'`,
    );
    const pkCols = (pkRows as any[]).map((r) => r.COLUMN_NAME);
    if (pkCols.includes('sourceId') && pkCols.includes('publicKey') && pkCols.length >= 2) {
      logger.info(`${LABEL} (MySQL): composite PK already present, skipping`);
      return;
    }

    await conn.beginTransaction();

    try {
      const [nullRows] = await conn.query(
        `SELECT COUNT(*) AS c FROM meshcore_nodes WHERE sourceId IS NULL`,
      );
      const nullNodes = Number((nullRows as any[])[0]?.c ?? 0);

      if (nullNodes > 0) {
        const ts = Date.now();
        await conn.query(
          `INSERT IGNORE INTO sources (id, name, type, config, enabled, createdAt, updatedAt)
           VALUES (?, ?, ?, ?, 0, ?, ?)`,
          [LEGACY_SOURCE_ID, LEGACY_SOURCE_NAME, LEGACY_SOURCE_TYPE, LEGACY_SOURCE_CONFIG, ts, ts],
        );

        const [res] = await conn.query(
          `UPDATE meshcore_nodes SET sourceId = ? WHERE sourceId IS NULL`,
          [LEGACY_SOURCE_ID],
        );
        const affected = (res as { affectedRows?: number }).affectedRows ?? 0;
        logger.info(
          `${LABEL} (MySQL): backfilled ${affected} NULL-sourceId meshcore_nodes -> ${LEGACY_SOURCE_ID}`,
        );
      }

      // sourceId was VARCHAR-ish at create (TEXT in the 057 path). MySQL
      // primary keys require a length-bounded type, so widen+NOT NULL it.
      await conn.query(`ALTER TABLE meshcore_nodes MODIFY COLUMN sourceId VARCHAR(64) NOT NULL`);

      // publicKey was VARCHAR(64) in the mysql baseline. Keep length but
      // make sure it's NOT NULL (it already is via PRIMARY KEY, but defensive).
      await conn.query(`ALTER TABLE meshcore_nodes MODIFY COLUMN publicKey VARCHAR(64) NOT NULL`);

      // Replace PK in one statement.
      await conn.query(
        `ALTER TABLE meshcore_nodes DROP PRIMARY KEY, ADD PRIMARY KEY (sourceId, publicKey)`,
      );

      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    }
  } finally {
    conn.release();
  }

  logger.info(`${LABEL} complete (MySQL)`);
}
