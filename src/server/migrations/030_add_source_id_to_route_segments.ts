/**
 * Migration 030: Add sourceId to route_segments and rebuild from traceroutes
 *
 * The route_segments table was originally inherently global — it had no
 * sourceId column, so segments from different sources all shared one pool.
 * This migration adds a nullable `sourceId` column, deletes every existing
 * row, and then rebuilds the table by walking the traceroutes table (which
 * already carries sourceId and a `routePositions` snapshot) and emitting a
 * segment row per consecutive hop pair in the recorded route.
 *
 * We intentionally do NOT try to backfill sourceId on the old segment rows.
 * They were all unscoped, and we have no reliable way to attribute them to
 * a specific source after the fact. Rebuilding from traceroutes produces
 * clean, per-source segment history with the same information content.
 *
 * Record-holder flags are cleared — the rebuild recalculates the longest
 * segment per source on next traceroute ingest via updateRecordHolderSegment.
 *
 * Idempotent across SQLite / PostgreSQL / MySQL.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

// ---------------------------------------------------------------------------
// Haversine distance (inlined to keep migrations self-contained). Mirrors
// src/utils/distance.ts calculateDistance() exactly.
// ---------------------------------------------------------------------------
function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371; // Earth radius in km
  const toRad = (d: number) => d * (Math.PI / 180);
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

interface PositionEntry {
  lat?: number | null;
  lng?: number | null;
  alt?: number | null;
}

interface RebuildSegment {
  fromNodeNum: number;
  toNodeNum: number;
  fromNodeId: string;
  toNodeId: string;
  distanceKm: number;
  fromLatitude: number;
  fromLongitude: number;
  toLatitude: number;
  toLongitude: number;
  timestamp: number;
  createdAt: number;
  sourceId: string | null;
}

function nodeIdHex(nodeNum: number): string {
  return `!${nodeNum.toString(16).padStart(8, '0')}`;
}

/**
 * Build the set of segments for a single traceroute row. Requires a
 * positions snapshot from the traceroute. Segments are only produced for
 * consecutive pairs where both endpoints have lat/lng.
 */
function segmentsFromTraceroute(
  fromNodeNum: number,
  toNodeNum: number,
  routeJson: string | null,
  routePositionsJson: string | null,
  timestamp: number,
  sourceId: string | null,
  now: number,
): RebuildSegment[] {
  if (!routePositionsJson) return [];
  let positions: Record<string, PositionEntry>;
  try {
    positions = JSON.parse(routePositionsJson) as Record<string, PositionEntry>;
  } catch {
    return [];
  }

  let intermediates: number[] = [];
  if (routeJson) {
    try {
      const parsed = JSON.parse(routeJson);
      if (Array.isArray(parsed)) {
        intermediates = parsed.map((n: unknown) => Number(n)).filter((n) => Number.isFinite(n));
      }
    } catch {
      intermediates = [];
    }
  }

  // Full path: requester -> route intermediates -> responder
  // (matches meshtasticManager's forward-route segment calculation)
  const fullRoute = [Number(toNodeNum), ...intermediates, Number(fromNodeNum)];

  const out: RebuildSegment[] = [];
  for (let i = 0; i < fullRoute.length - 1; i++) {
    const n1 = fullRoute[i];
    const n2 = fullRoute[i + 1];
    const p1 = positions[String(n1)];
    const p2 = positions[String(n2)];
    if (
      !p1 || !p2 ||
      p1.lat == null || p1.lng == null ||
      p2.lat == null || p2.lng == null
    ) {
      continue;
    }
    const distance = haversineKm(p1.lat, p1.lng, p2.lat, p2.lng);
    out.push({
      fromNodeNum: n1,
      toNodeNum: n2,
      fromNodeId: nodeIdHex(n1),
      toNodeId: nodeIdHex(n2),
      distanceKm: distance,
      fromLatitude: p1.lat,
      fromLongitude: p1.lng,
      toLatitude: p2.lat,
      toLongitude: p2.lng,
      timestamp,
      createdAt: now,
      sourceId,
    });
  }
  return out;
}

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info('Running migration 030 (SQLite): Adding sourceId to route_segments and rebuilding from traceroutes...');

    // Idempotency: check whether sourceId column already exists.
    const cols = db.prepare(`PRAGMA table_info(route_segments)`).all() as Array<{ name: string }>;
    const hasSourceId = cols.some((c) => c.name === 'sourceId');

    // Legacy databases carry `route_segments.fromNodeNum/toNodeNum REFERENCES
    // nodes(nodeNum)` FKs. Migration 029 swapped nodes to a composite PK
    // (nodeNum, sourceId), so nodeNum alone is no longer unique and the FK is
    // structurally broken. Any ALTER/DELETE/INSERT on route_segments then
    // trips SQLite's FK compatibility check with "foreign key mismatch" —
    // even with foreign_keys=OFF, ALTER TABLE still validates parent key
    // matching unless legacy_alter_table=ON. Disable both for the rebuild
    // and restore them in finally.
    const prevForeignKeys = db.pragma('foreign_keys', { simple: true }) as number;
    if (prevForeignKeys) {
      db.pragma('foreign_keys = OFF');
    }
    const prevLegacyAlter = db.pragma('legacy_alter_table', { simple: true }) as number;
    if (!prevLegacyAlter) {
      db.pragma('legacy_alter_table = ON');
    }

    const tx = db.transaction(() => {
      if (!hasSourceId) {
        db.exec(`ALTER TABLE route_segments ADD COLUMN sourceId TEXT`);
        logger.debug('Added sourceId column to route_segments');
      } else {
        logger.debug('route_segments.sourceId already exists, continuing to rebuild step');
      }

      // Wipe existing rows — they were all unscoped and cannot be safely
      // attributed to a source. We'll rebuild from traceroutes.
      const deleted = db.prepare(`DELETE FROM route_segments`).run();
      logger.info(`Cleared ${deleted.changes} legacy route_segments rows`);

      // Iterate all traceroutes with a position snapshot and re-emit segments.
      const traceroutes = db.prepare(`
        SELECT fromNodeNum, toNodeNum, route, routePositions, timestamp, sourceId
        FROM traceroutes
        WHERE routePositions IS NOT NULL
      `).all() as Array<{
        fromNodeNum: number;
        toNodeNum: number;
        route: string | null;
        routePositions: string | null;
        timestamp: number;
        sourceId: string | null;
      }>;

      const insert = db.prepare(`
        INSERT INTO route_segments (
          fromNodeNum, toNodeNum, fromNodeId, toNodeId, distanceKm,
          isRecordHolder, fromLatitude, fromLongitude, toLatitude, toLongitude,
          timestamp, createdAt, sourceId
        ) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)
      `);

      const now = Date.now();
      let inserted = 0;
      for (const tr of traceroutes) {
        const segs = segmentsFromTraceroute(
          Number(tr.fromNodeNum),
          Number(tr.toNodeNum),
          tr.route,
          tr.routePositions,
          Number(tr.timestamp),
          tr.sourceId ?? null,
          now,
        );
        for (const s of segs) {
          try {
            insert.run(
              s.fromNodeNum, s.toNodeNum, s.fromNodeId, s.toNodeId, s.distanceKm,
              s.fromLatitude, s.fromLongitude, s.toLatitude, s.toLongitude,
              s.timestamp, s.createdAt, s.sourceId,
            );
            inserted++;
          } catch (err: any) {
            // FK violations (node disappeared) — skip silently.
            logger.debug(`Skipped rebuilt segment (FK?): ${err?.message ?? err}`);
          }
        }
      }
      logger.info(`Rebuilt ${inserted} route_segments from ${traceroutes.length} traceroutes`);

      // Index on sourceId for query planner.
      db.exec(`CREATE INDEX IF NOT EXISTS idx_route_segments_source_id ON route_segments(sourceId)`);
    });

    try {
      tx();
    } catch (err: any) {
      const msg = String(err?.message || err);
      if (/duplicate column/i.test(msg)) {
        logger.info('Migration 030 (SQLite): column already exists, treating as applied');
        return;
      }
      throw err;
    } finally {
      if (prevForeignKeys) {
        db.pragma('foreign_keys = ON');
      }
      if (!prevLegacyAlter) {
        db.pragma('legacy_alter_table = OFF');
      }
    }

    logger.info('Migration 030 complete (SQLite)');
  },

  down: (_db: Database): void => {
    logger.debug('Migration 030 down: not implemented (column drops are destructive)');
  },
};

// ============ PostgreSQL ============

export async function runMigration030Postgres(client: any): Promise<void> {
  logger.info('Running migration 030 (PostgreSQL): Adding sourceId to route_segments and rebuilding from traceroutes...');

  await client.query('BEGIN');
  try {
    await client.query(`ALTER TABLE route_segments ADD COLUMN IF NOT EXISTS "sourceId" TEXT`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_route_segments_source_id ON route_segments("sourceId")`);

    const deletedRes = await client.query(`DELETE FROM route_segments`);
    logger.info(`Cleared ${deletedRes.rowCount ?? 0} legacy route_segments rows`);

    const { rows: traceroutes } = await client.query(`
      SELECT "fromNodeNum", "toNodeNum", "route", "routePositions", "timestamp", "sourceId"
      FROM traceroutes
      WHERE "routePositions" IS NOT NULL
    `);

    const now = Date.now();
    let inserted = 0;
    for (const tr of traceroutes as any[]) {
      const segs = segmentsFromTraceroute(
        Number(tr.fromNodeNum),
        Number(tr.toNodeNum),
        tr.route ?? null,
        tr.routePositions ?? null,
        Number(tr.timestamp),
        tr.sourceId ?? null,
        now,
      );
      for (const s of segs) {
        try {
          await client.query(
            `INSERT INTO route_segments (
               "fromNodeNum", "toNodeNum", "fromNodeId", "toNodeId", "distanceKm",
               "isRecordHolder", "fromLatitude", "fromLongitude", "toLatitude", "toLongitude",
               "timestamp", "createdAt", "sourceId"
             ) VALUES ($1, $2, $3, $4, $5, false, $6, $7, $8, $9, $10, $11, $12)`,
            [
              s.fromNodeNum, s.toNodeNum, s.fromNodeId, s.toNodeId, s.distanceKm,
              s.fromLatitude, s.fromLongitude, s.toLatitude, s.toLongitude,
              s.timestamp, s.createdAt, s.sourceId,
            ],
          );
          inserted++;
        } catch (err: any) {
          logger.debug(`Skipped rebuilt segment (FK?): ${err?.message ?? err}`);
        }
      }
    }
    logger.info(`Rebuilt ${inserted} route_segments from ${traceroutes.length} traceroutes`);

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }

  logger.info('Migration 030 complete (PostgreSQL)');
}

// ============ MySQL ============

export async function runMigration030Mysql(pool: any): Promise<void> {
  logger.info('Running migration 030 (MySQL): Adding sourceId to route_segments and rebuilding from traceroutes...');

  const conn = await pool.getConnection();
  try {
    // Idempotently add sourceId column.
    const [colRows] = await conn.query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'route_segments' AND COLUMN_NAME = 'sourceId'`
    );
    if (!Array.isArray(colRows) || colRows.length === 0) {
      await conn.query(`ALTER TABLE route_segments ADD COLUMN sourceId VARCHAR(36)`);
      logger.debug('Added sourceId column to route_segments');
    }

    // Index on sourceId.
    const [idxRows] = await conn.query(
      `SELECT COUNT(*) AS cnt FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'route_segments' AND INDEX_NAME = 'idx_route_segments_source_id'`
    );
    if (!(idxRows as any)[0]?.cnt) {
      await conn.query(`CREATE INDEX idx_route_segments_source_id ON route_segments(sourceId)`);
    }

    await conn.beginTransaction();
    try {
      const [delRes] = await conn.query(`DELETE FROM route_segments`);
      logger.info(`Cleared ${(delRes as any)?.affectedRows ?? 0} legacy route_segments rows`);

      const [traceroutes] = await conn.query(
        `SELECT fromNodeNum, toNodeNum, route, routePositions, timestamp, sourceId
         FROM traceroutes
         WHERE routePositions IS NOT NULL`
      );

      const now = Date.now();
      let inserted = 0;
      for (const tr of traceroutes as any[]) {
        const segs = segmentsFromTraceroute(
          Number(tr.fromNodeNum),
          Number(tr.toNodeNum),
          tr.route ?? null,
          tr.routePositions ?? null,
          Number(tr.timestamp),
          tr.sourceId ?? null,
          now,
        );
        for (const s of segs) {
          try {
            await conn.query(
              `INSERT INTO route_segments (
                 fromNodeNum, toNodeNum, fromNodeId, toNodeId, distanceKm,
                 isRecordHolder, fromLatitude, fromLongitude, toLatitude, toLongitude,
                 timestamp, createdAt, sourceId
               ) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`,
              [
                s.fromNodeNum, s.toNodeNum, s.fromNodeId, s.toNodeId, s.distanceKm,
                s.fromLatitude, s.fromLongitude, s.toLatitude, s.toLongitude,
                s.timestamp, s.createdAt, s.sourceId,
              ],
            );
            inserted++;
          } catch (err: any) {
            logger.debug(`Skipped rebuilt segment (FK?): ${err?.message ?? err}`);
          }
        }
      }
      logger.info(`Rebuilt ${inserted} route_segments from ${(traceroutes as any[]).length} traceroutes`);

      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    }
  } finally {
    conn.release();
  }

  logger.info('Migration 030 complete (MySQL)');
}
