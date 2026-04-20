/**
 * Migration 029: Nodes composite PK (nodeNum, sourceId)
 *
 * Phase 1 of nodes per-source refactor. Converts the `nodes` table from a
 * single-row-per-nodeNum model into a per-source model where each (source,
 * nodeNum) pair is independent.
 *
 * Strategy:
 *  - Backfill any NULL sourceId rows with the *first* registered source
 *    (oldest by createdAt/id). If the sources table is empty, abort with a
 *    clear error — Phase 1 cannot proceed without at least one source.
 *  - Drop the existing PRIMARY KEY on nodeNum.
 *  - Add a new composite PRIMARY KEY (nodeNum, sourceId).
 *  - Drop the old UNIQUE constraint on nodeId; add a new composite UNIQUE
 *    on (nodeId, sourceId) so the same hardware can be tracked independently
 *    by multiple sources.
 *
 * The SQLite path uses the table-rebuild pattern (CREATE _new + copy + drop +
 * rename) because SQLite cannot ALTER an existing PRIMARY KEY in place.
 */
import type { Database } from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { logger } from '../../utils/logger.js';

/**
 * Build a default source config from env vars. Used by migration 029 when an
 * upgrade finds legacy nodes with NULL sourceId but no sources row to backfill
 * from. We synthesize a `meshtastic_tcp` source so the upgrade can proceed;
 * the app will reconnect on next boot using whatever env vars are present.
 */
function buildLegacyDefaultSource(): { id: string; name: string; type: string; config: string; createdAt: number; updatedAt: number } {
  const now = Date.now();
  const host = process.env.MESHTASTIC_NODE_IP || 'meshtastic.local';
  const port = parseInt(process.env.MESHTASTIC_TCP_PORT || '4403', 10) || 4403;
  return {
    id: randomUUID(),
    name: 'Default',
    type: 'meshtastic_tcp',
    config: JSON.stringify({ host, port }),
    createdAt: now,
    updatedAt: now,
  };
}

// Columns in the nodes table, in stable order. Used for the SQLite rebuild
// INSERT and CREATE TABLE statements.
const NODE_COLUMNS_SQLITE = `
  nodeNum INTEGER NOT NULL,
  nodeId TEXT NOT NULL,
  longName TEXT,
  shortName TEXT,
  hwModel INTEGER,
  role INTEGER,
  hopsAway INTEGER,
  lastMessageHops INTEGER,
  viaMqtt INTEGER,
  macaddr TEXT,
  latitude REAL,
  longitude REAL,
  altitude REAL,
  batteryLevel INTEGER,
  voltage REAL,
  channelUtilization REAL,
  airUtilTx REAL,
  lastHeard INTEGER,
  snr REAL,
  rssi INTEGER,
  lastTracerouteRequest INTEGER,
  firmwareVersion TEXT,
  channel INTEGER,
  isFavorite INTEGER DEFAULT 0,
  favoriteLocked INTEGER DEFAULT 0,
  isIgnored INTEGER DEFAULT 0,
  mobile INTEGER DEFAULT 0,
  rebootCount INTEGER,
  publicKey TEXT,
  lastMeshReceivedKey TEXT,
  hasPKC INTEGER,
  lastPKIPacket INTEGER,
  keyIsLowEntropy INTEGER,
  duplicateKeyDetected INTEGER,
  keyMismatchDetected INTEGER,
  keySecurityIssueDetails TEXT,
  isExcessivePackets INTEGER DEFAULT 0,
  packetRatePerHour INTEGER,
  packetRateLastChecked INTEGER,
  isTimeOffsetIssue INTEGER DEFAULT 0,
  timeOffsetSeconds INTEGER,
  welcomedAt INTEGER,
  positionChannel INTEGER,
  positionPrecisionBits INTEGER,
  positionGpsAccuracy REAL,
  positionHdop REAL,
  positionTimestamp INTEGER,
  positionOverrideEnabled INTEGER DEFAULT 0,
  latitudeOverride REAL,
  longitudeOverride REAL,
  altitudeOverride REAL,
  positionOverrideIsPrivate INTEGER DEFAULT 0,
  hasRemoteAdmin INTEGER DEFAULT 0,
  lastRemoteAdminCheck INTEGER,
  remoteAdminMetadata TEXT,
  lastTimeSync INTEGER,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL,
  sourceId TEXT NOT NULL
`;

const NODE_COLUMN_LIST = `
  nodeNum, nodeId, longName, shortName, hwModel, role, hopsAway, lastMessageHops,
  viaMqtt, macaddr, latitude, longitude, altitude, batteryLevel, voltage,
  channelUtilization, airUtilTx, lastHeard, snr, rssi, lastTracerouteRequest,
  firmwareVersion, channel, isFavorite, favoriteLocked, isIgnored, mobile,
  rebootCount, publicKey, lastMeshReceivedKey, hasPKC, lastPKIPacket,
  keyIsLowEntropy, duplicateKeyDetected, keyMismatchDetected, keySecurityIssueDetails,
  isExcessivePackets, packetRatePerHour, packetRateLastChecked, isTimeOffsetIssue,
  timeOffsetSeconds, welcomedAt, positionChannel, positionPrecisionBits,
  positionGpsAccuracy, positionHdop, positionTimestamp, positionOverrideEnabled,
  latitudeOverride, longitudeOverride, altitudeOverride, positionOverrideIsPrivate,
  hasRemoteAdmin, lastRemoteAdminCheck, remoteAdminMetadata, lastTimeSync,
  createdAt, updatedAt, sourceId
`;

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info('Running migration 029 (SQLite): Rebuilding nodes table with composite (nodeNum, sourceId) PK...');

    // Idempotency: if a unique index already exists with composite (nodeId, sourceId),
    // assume migration already applied. We also check whether `nodeNum` alone is
    // still the primary key — when it isn't, the rebuild has already happened.
    try {
      const idxRows = db.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'index' AND name = 'nodes_nodeId_sourceId_uniq'
      `).all() as Array<{ name: string }>;

      const tableInfo = db.prepare(`PRAGMA table_info(nodes)`).all() as Array<{ name: string; pk: number }>;
      const pkColumns = tableInfo.filter(c => c.pk > 0).length;

      if (idxRows.length > 0 && pkColumns >= 2) {
        logger.info('Migration 029 (SQLite): nodes already migrated to composite PK, skipping');
        return;
      }
    } catch (err) {
      logger.warn('Migration 029 (SQLite): idempotency check failed, attempting migration anyway:', err);
    }

    // Capture indexes that exist on the nodes table (we'll recreate them after rebuild).
    const existingIndexes = db.prepare(`
      SELECT name, sql FROM sqlite_master
      WHERE type = 'index' AND tbl_name = 'nodes' AND sql IS NOT NULL
    `).all() as Array<{ name: string; sql: string }>;

    // SQLite's documented table-rebuild pattern REQUIRES foreign_keys=OFF
    // (https://www.sqlite.org/lang_altertable.html, section "Making Other Kinds
    // Of Table Schema Changes"). Without this, DROP TABLE / RENAME TABLE can
    // trip FOREIGN KEY constraint failures from unrelated orphan rows in the
    // database — we saw this on upgrade with 955 legacy nodes and pre-existing
    // user_notification_preferences rows. The pragma is a no-op inside an
    // active transaction, so it MUST be set before tx() runs.
    const prevForeignKeys = db.pragma('foreign_keys', { simple: true }) as number;
    if (prevForeignKeys) {
      db.pragma('foreign_keys = OFF');
    }

    // Legacy databases (upgrades from pre-baseline v3 or early Drizzle pushes)
    // carry FK declarations like `telemetry.nodeNum REFERENCES nodes(nodeNum)`
    // and `route_segments.fromNodeNum REFERENCES nodes(nodeNum)`. When we
    // rebuild nodes to a composite PK (nodeNum, sourceId), nodeNum alone is no
    // longer unique, so SQLite's RENAME-time FK compatibility check raises
    // "foreign key mismatch — <child> referencing nodes" even with FK
    // enforcement disabled. Switching legacy_alter_table=ON tells SQLite to
    // skip the rewrite/validation during RENAME, which is exactly what we
    // want here: the child FKs are already unenforceable and the app doesn't
    // rely on DB-level FK integrity to the nodes table.
    const prevLegacyAlter = db.pragma('legacy_alter_table', { simple: true }) as number;
    if (!prevLegacyAlter) {
      db.pragma('legacy_alter_table = ON');
    }

    const tx = db.transaction(() => {
      // Count nodes requiring backfill (rows with NULL sourceId).
      const nullNodesRow = db.prepare(`SELECT COUNT(*) as c FROM nodes WHERE sourceId IS NULL`).get() as { c: number };
      const nullNodes = nullNodesRow?.c ?? 0;

      const srcCountRow = db.prepare(`SELECT COUNT(*) as c FROM sources`).get() as { c: number };
      const srcCount = srcCountRow?.c ?? 0;

      if (srcCount === 0 && nullNodes > 0) {
        // Legacy v3 data with no sources yet — synthesize a default source so the
        // upgrade can proceed. The app will reuse/update it on next boot.
        const legacy = buildLegacyDefaultSource();
        logger.info(`Migration 029 (SQLite): sources table empty with ${nullNodes} legacy nodes; creating default source '${legacy.id}'`);
        db.prepare(`
          INSERT INTO sources (id, name, type, config, enabled, createdAt, updatedAt)
          VALUES (?, ?, ?, ?, 1, ?, ?)
        `).run(legacy.id, legacy.name, legacy.type, legacy.config, legacy.createdAt, legacy.updatedAt);
      }

      // Re-count sources now that we may have inserted one.
      const srcCountAfter = (db.prepare(`SELECT COUNT(*) as c FROM sources`).get() as { c: number }).c;
      if (srcCountAfter > 0 && nullNodes > 0) {
        // Determine default sourceId = first source by createdAt then rowid.
        const defaultSrcRow = db.prepare(`
          SELECT id FROM sources ORDER BY createdAt ASC, rowid ASC LIMIT 1
        `).get() as { id: string } | undefined;
        if (!defaultSrcRow) {
          throw new Error('Migration 029 aborted: failed to read default sourceId from sources table.');
        }
        const defaultSourceId = defaultSrcRow.id;
        logger.info(`Migration 029 (SQLite): backfilling ${nullNodes} NULL sourceId rows with default source '${defaultSourceId}'`);
        db.prepare(`UPDATE nodes SET sourceId = ? WHERE sourceId IS NULL`).run(defaultSourceId);
      }

      // Create rebuilt table with composite PK.
      db.exec(`
        CREATE TABLE nodes_new (
          ${NODE_COLUMNS_SQLITE},
          PRIMARY KEY (nodeNum, sourceId),
          UNIQUE (nodeId, sourceId)
        )
      `);

      // Copy rows.
      db.exec(`
        INSERT INTO nodes_new (${NODE_COLUMN_LIST})
        SELECT ${NODE_COLUMN_LIST} FROM nodes
      `);

      db.exec(`DROP TABLE nodes`);
      db.exec(`ALTER TABLE nodes_new RENAME TO nodes`);

      // Recreate any non-PK indexes that existed before. Skip the auto unique index
      // for the old nodeId column (sqlite_autoindex_*) which is regenerated by the new schema.
      for (const idx of existingIndexes) {
        if (idx.name.startsWith('sqlite_autoindex_')) continue;
        try {
          db.exec(idx.sql);
        } catch (err) {
          logger.warn(`Migration 029 (SQLite): failed to recreate index ${idx.name}:`, err);
        }
      }

      // Ensure the composite unique index by name exists (it's part of CREATE TABLE
      // as an unnamed UNIQUE constraint, so add a named index for query planner clarity).
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS nodes_nodeId_sourceId_uniq ON nodes(nodeId, sourceId)`);
    });

    try {
      tx();

      // Per SQLite docs: after a table rebuild with FKs disabled, verify that
      // the rebuild didn't leave any orphaned rows. foreign_key_check returns
      // one row per violating row — empty result means the schema is healthy.
      // foreign_key_check itself raises "foreign key mismatch" when a child
      // FK references a now-non-unique parent column (legacy DBs with
      // telemetry.nodeNum → nodes(nodeNum) hit this after the composite PK
      // swap). Swallow that — the FK is unenforceable post-rebuild and the
      // app doesn't depend on it.
      if (prevForeignKeys) {
        try {
          const violations = db.prepare(`PRAGMA foreign_key_check`).all() as Array<{ table: string; rowid: number; parent: string; fkid: number }>;
          if (violations.length > 0) {
            // Log but don't fail — these violations pre-existed the migration
            // and we don't want to prevent the upgrade from completing. The
            // same rows were already being tolerated before the rebuild.
            logger.warn(
              `Migration 029 (SQLite): foreign_key_check reports ${violations.length} pre-existing orphan row(s); tolerating:`,
              violations.slice(0, 5),
            );
          }
        } catch (checkErr: any) {
          const checkMsg = String(checkErr?.message || checkErr);
          if (/foreign key mismatch/i.test(checkMsg)) {
            logger.warn(
              'Migration 029 (SQLite): legacy child FKs to nodes(nodeNum) no longer match composite PK; tolerating:',
              checkMsg,
            );
          } else {
            throw checkErr;
          }
        }
      }
    } catch (err: any) {
      const msg = String(err?.message || err);
      if (/already exists/i.test(msg) || /duplicate column/i.test(msg)) {
        logger.info('Migration 029 (SQLite): treated as already-migrated:', msg);
        return;
      }
      throw err;
    } finally {
      // Always restore the original pragma state — even on success, we must
      // not leave the database in a looser mode than we found it.
      if (prevForeignKeys) {
        db.pragma('foreign_keys = ON');
      }
      if (!prevLegacyAlter) {
        db.pragma('legacy_alter_table = OFF');
      }
    }

    logger.info('Migration 029 complete (SQLite)');
  },

  down: (_db: Database): void => {
    logger.debug('Migration 029 down: not implemented (destructive)');
  },
};

// ============ PostgreSQL ============

export async function runMigration029Postgres(client: any): Promise<void> {
  logger.info('Running migration 029 (PostgreSQL): nodes composite PK (nodeNum, sourceId)...');

  // Idempotency: check if PK already includes sourceId
  const pkCheck = await client.query(`
    SELECT a.attname
    FROM pg_index i
    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
    WHERE i.indrelid = 'nodes'::regclass AND i.indisprimary
  `);
  const pkCols = pkCheck.rows.map((r: any) => r.attname);
  if (pkCols.includes('sourceId') && pkCols.length >= 2) {
    logger.info('Migration 029 (PostgreSQL): composite PK already present, skipping');
    return;
  }

  await client.query('BEGIN');
  try {
    const nullNodesRes = await client.query(`SELECT COUNT(*)::int AS c FROM "nodes" WHERE "sourceId" IS NULL`);
    const nullNodes = nullNodesRes.rows[0]?.c ?? 0;
    const srcCountRes = await client.query(`SELECT COUNT(*)::int AS c FROM sources`);
    const srcCount = srcCountRes.rows[0]?.c ?? 0;

    if (srcCount === 0 && nullNodes > 0) {
      const legacy = buildLegacyDefaultSource();
      logger.info(`Migration 029 (PostgreSQL): sources table empty with ${nullNodes} legacy nodes; creating default source '${legacy.id}'`);
      await client.query(
        `INSERT INTO sources (id, name, type, config, enabled, "createdAt", "updatedAt")
         VALUES ($1, $2, $3, $4, true, $5, $6)`,
        [legacy.id, legacy.name, legacy.type, legacy.config, legacy.createdAt, legacy.updatedAt],
      );
    }

    const srcCountAfterRes = await client.query(`SELECT COUNT(*)::int AS c FROM sources`);
    const srcCountAfter = srcCountAfterRes.rows[0]?.c ?? 0;

    if (srcCountAfter > 0 && nullNodes > 0) {
      // Backfill NULL sourceIds from the oldest source.
      await client.query(`
        UPDATE "nodes"
        SET "sourceId" = (SELECT id FROM sources ORDER BY "createdAt" ASC, id ASC LIMIT 1)
        WHERE "sourceId" IS NULL
      `);
    }

    await client.query(`ALTER TABLE "nodes" ALTER COLUMN "sourceId" SET NOT NULL`);

    // Drop existing PK (named nodes_pkey by Postgres convention)
    await client.query(`ALTER TABLE "nodes" DROP CONSTRAINT IF EXISTS nodes_pkey`);

    // Add composite PK
    await client.query(`
      ALTER TABLE "nodes" ADD CONSTRAINT nodes_pkey PRIMARY KEY ("nodeNum", "sourceId")
    `);

    // Drop the old unique on nodeId. The constraint name varies by Postgres version
    // ("nodes_nodeId_key" or "nodes_nodeId_unique"); look it up.
    const uniqRows = await client.query(`
      SELECT conname FROM pg_constraint
      WHERE conrelid = 'nodes'::regclass
        AND contype = 'u'
        AND pg_get_constraintdef(oid) ILIKE '%(nodeId)%'
    `);
    for (const row of uniqRows.rows) {
      await client.query(`ALTER TABLE "nodes" DROP CONSTRAINT IF EXISTS "${row.conname}"`);
    }

    // Add composite unique (nodeId, sourceId)
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS nodes_nodeId_sourceId_uniq ON "nodes" ("nodeId", "sourceId")
    `);

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }

  logger.info('Migration 029 complete (PostgreSQL)');
}

// ============ MySQL ============

export async function runMigration029Mysql(pool: any): Promise<void> {
  logger.info('Running migration 029 (MySQL): nodes composite PK (nodeNum, sourceId)...');

  const conn = await pool.getConnection();
  try {
    // Idempotency: check whether the PK already contains sourceId.
    const [pkRows] = await conn.query(
      `SELECT COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'nodes' AND CONSTRAINT_NAME = 'PRIMARY'`
    );
    const pkCols = (pkRows as any[]).map(r => r.COLUMN_NAME);
    if (pkCols.includes('sourceId') && pkCols.length >= 2) {
      logger.info('Migration 029 (MySQL): composite PK already present, skipping');
      return;
    }

    await conn.beginTransaction();

    try {
      const [nullNodeRows] = await conn.query(`SELECT COUNT(*) AS c FROM nodes WHERE sourceId IS NULL`);
      const nullNodes = Number((nullNodeRows as any[])[0]?.c ?? 0);
      const [srcRows] = await conn.query(`SELECT COUNT(*) AS c FROM sources`);
      const srcCount = Number((srcRows as any[])[0]?.c ?? 0);

      if (srcCount === 0 && nullNodes > 0) {
        const legacy = buildLegacyDefaultSource();
        logger.info(`Migration 029 (MySQL): sources table empty with ${nullNodes} legacy nodes; creating default source '${legacy.id}'`);
        await conn.query(
          `INSERT INTO sources (id, name, type, config, enabled, createdAt, updatedAt)
           VALUES (?, ?, ?, ?, 1, ?, ?)`,
          [legacy.id, legacy.name, legacy.type, legacy.config, legacy.createdAt, legacy.updatedAt],
        );
      }

      const [srcAfterRows] = await conn.query(`SELECT COUNT(*) AS c FROM sources`);
      const srcCountAfter = Number((srcAfterRows as any[])[0]?.c ?? 0);

      if (srcCountAfter > 0 && nullNodes > 0) {
        // Backfill NULLs from oldest source.
        await conn.query(`
          UPDATE nodes
          SET sourceId = (SELECT id FROM (SELECT id FROM sources ORDER BY createdAt ASC, id ASC LIMIT 1) AS s)
          WHERE sourceId IS NULL
        `);
      }

      await conn.query(`ALTER TABLE nodes MODIFY COLUMN sourceId VARCHAR(36) NOT NULL`);

      // Drop the existing unique on nodeId. Find any UNIQUE indexes that include nodeId solely.
      const [uniqRows] = await conn.query(
        `SELECT INDEX_NAME, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS cols
         FROM information_schema.STATISTICS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'nodes' AND NON_UNIQUE = 0
         GROUP BY INDEX_NAME`
      );
      for (const row of uniqRows as any[]) {
        if (row.INDEX_NAME === 'PRIMARY') continue;
        if (row.cols === 'nodeId') {
          await conn.query(`ALTER TABLE nodes DROP INDEX \`${row.INDEX_NAME}\``);
        }
      }

      // Replace primary key.
      await conn.query(`ALTER TABLE nodes DROP PRIMARY KEY, ADD PRIMARY KEY (nodeNum, sourceId)`);

      // Add composite unique on (nodeId, sourceId).
      await conn.query(`
        CREATE UNIQUE INDEX nodes_nodeId_sourceId_uniq ON nodes (nodeId, sourceId)
      `).catch((err: any) => {
        if (!/Duplicate key name/i.test(String(err?.message))) throw err;
      });

      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    }
  } finally {
    conn.release();
  }

  logger.info('Migration 029 complete (MySQL)');
}
