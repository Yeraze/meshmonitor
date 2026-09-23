/**
 * Migration 171: best-effort reclassify existing `route_segments` record
 * holders by transport (#5101, Phase 2 spec §3/§10.1).
 *
 * Migrations 169/170 add `transportMechanism` columns that every NEW write
 * populates. But a record holder (`isRecordHolder = true`) never ages out
 * (`cleanupOldRouteSegments` spares flagged rows forever), so an existing
 * record predates the column and would otherwise sit at NULL (= RF) forever,
 * even if the link that set the record actually crossed MQTT.
 *
 * This migration gives each existing NULL-mechanism record holder the
 * transport of the hop that produced it, where the traceroute that produced
 * it still exists (traceroutes age out and are capped per node pair, so an
 * old record often has nothing left to match — it then stays NULL/RF, which
 * is today's behaviour, not a regression). The matching and collision logic
 * is pure and unit-tested independently — see
 * `src/utils/segmentTransportBackfill.ts` (`matchSegmentTransport`,
 * `recordHolderIdsToDemote`).
 *
 * Records are now kept per (source, transport class) rather than one per
 * source, so a source whose reclassified rows land in more than one class
 * can end up with more than one flagged row. Step 2 below resolves any such
 * collision, keeping the longest per (source, class) and unflagging the
 * rest — those demoted rows simply become ordinary segments and age out
 * normally.
 *
 * ## How this avoids the #4233 bug class (a migration that rebuilt 865k rows
 * on every boot)
 *
 * - **Once.** The ledger (`migrationLedger.ts`) and the SQLite `settingsKey`
 *   check run this once per database.
 * - **Idempotent if re-run anyway** (e.g. a crash between the migration and
 *   its ledger write): step 1 selects only flagged rows that are STILL NULL,
 *   and the UPDATE in step 1 is itself guarded by `transportMechanism IS
 *   NULL`. A second run redoes only the still-unmatched few and changes
 *   nothing else. Step 2 on an already-consistent table demotes nothing
 *   (already-demoted rows are no longer `isRecordHolder`, so they don't
 *   reappear in its SELECT).
 * - **Bounded.** Every statement is keyed to record-holder rows (a handful
 *   per source) or to one exact (source, pair, timestamp). There is no
 *   full-table scan of `route_segments` or `traceroutes`, no `DELETE`, no
 *   `DROP`/`CREATE TABLE`, and no rebuild. The traceroute candidate lookup is
 *   capped at `LIMIT 50` per segment and served by `idx_traceroutes_timestamp`;
 *   the record-holder lookups are served by `idx_route_segments_recordholder`.
 *
 * ## Never blocks boot
 *
 * This is a best-effort DATA step, not a schema step: correctness never
 * depends on it running (unmatched rows simply read as RF, same as before
 * this migration existed), so the whole body is wrapped in try/catch. A
 * failure here is logged and swallowed — it must not abort startup, and the
 * ledger then records the migration as done (a later boot won't keep
 * retrying it, matching the "once" idempotency rule above). A per-row
 * try/catch additionally isolates one malformed row from the rest of the
 * batch.
 *
 * Idempotent across SQLite / PostgreSQL / MySQL.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';
import {
  matchSegmentTransport,
  recordHolderIdsToDemote,
  RECLASSIFY_WINDOW_MS,
  type BackfillSegment,
  type BackfillTraceroute,
  type RecordHolderRow,
} from '../../utils/segmentTransportBackfill.js';
import { classifyNodeTransport } from '../../utils/nodeTransport.js';

const LABEL = 'Migration 171';

interface FlaggedSegmentRow extends BackfillSegment {
  id: number;
  sourceId: string | null;
}

interface ReclassifyTally {
  examined: number;
  reclassifiedRf: number;
  reclassifiedUdp: number;
  reclassifiedMqtt: number;
  unmatched: number;
  demoted: number;
}

function emptyTally(): ReclassifyTally {
  return { examined: 0, reclassifiedRf: 0, reclassifiedUdp: 0, reclassifiedMqtt: 0, unmatched: 0, demoted: 0 };
}

function tallyClass(tally: ReclassifyTally, mechanism: number | null): void {
  const cls = classifyNodeTransport({ transportMechanism: mechanism });
  if (cls === 'mqtt') tally.reclassifiedMqtt++;
  else if (cls === 'udp') tally.reclassifiedUdp++;
  else tally.reclassifiedRf++;
}

function logSummary(dialect: string, tally: ReclassifyTally): void {
  logger.info(
    `${LABEL} (${dialect}) complete: examined=${tally.examined} `
    + `reclassified(rf=${tally.reclassifiedRf} udp=${tally.reclassifiedUdp} mqtt=${tally.reclassifiedMqtt}) `
    + `unmatched=${tally.unmatched} demoted=${tally.demoted}`,
  );
}

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    try {
      runSqlite(db);
    } catch (e) {
      logger.error(`${LABEL} (SQLite): best-effort reclassify failed, continuing without it: ${(e as Error)?.message ?? e}`);
    }
  },

  down: (_db: Database): void => {
    logger.debug(`${LABEL} down: not implemented (reclassification is advisory; clear a record holder to reset it)`);
  },
};

function runSqlite(db: Database): void {
  const tally = emptyTally();

  const flagged = db.prepare(`
    SELECT id, sourceId, fromNodeNum, toNodeNum, timestamp
    FROM route_segments
    WHERE isRecordHolder = 1 AND transportMechanism IS NULL
  `).all() as FlaggedSegmentRow[];

  for (const seg of flagged) {
    tally.examined++;
    try {
      const windowStart = seg.timestamp - RECLASSIFY_WINDOW_MS;
      const candidates = (seg.sourceId === null
        ? db.prepare(`
            SELECT fromNodeNum, toNodeNum, timestamp, route, routeBack, snrTowards, snrBack, transportMechanism
            FROM traceroutes
            WHERE sourceId IS NULL AND timestamp BETWEEN ? AND ?
            ORDER BY timestamp DESC LIMIT 50
          `).all(windowStart, seg.timestamp)
        : db.prepare(`
            SELECT fromNodeNum, toNodeNum, timestamp, route, routeBack, snrTowards, snrBack, transportMechanism
            FROM traceroutes
            WHERE sourceId = ? AND timestamp BETWEEN ? AND ?
            ORDER BY timestamp DESC LIMIT 50
          `).all(seg.sourceId, windowStart, seg.timestamp)) as BackfillTraceroute[];

      const match = matchSegmentTransport(seg, candidates);
      if (match.matched && match.transportMechanism !== null) {
        const info = (seg.sourceId === null
          ? db.prepare(`
              UPDATE route_segments SET transportMechanism = ?
              WHERE sourceId IS NULL AND fromNodeNum = ? AND toNodeNum = ? AND timestamp = ? AND transportMechanism IS NULL
            `).run(match.transportMechanism, seg.fromNodeNum, seg.toNodeNum, seg.timestamp)
          : db.prepare(`
              UPDATE route_segments SET transportMechanism = ?
              WHERE sourceId = ? AND fromNodeNum = ? AND toNodeNum = ? AND timestamp = ? AND transportMechanism IS NULL
            `).run(match.transportMechanism, seg.sourceId, seg.fromNodeNum, seg.toNodeNum, seg.timestamp));
        if (info.changes > 0) tallyClass(tally, match.transportMechanism);
        else tally.unmatched++;
      } else {
        tally.unmatched++;
      }
    } catch (e) {
      logger.warn(`${LABEL} (SQLite): skipping segment id=${seg.id}: ${(e as Error)?.message ?? e}`);
      tally.unmatched++;
    }
  }

  const stillFlagged = db.prepare(`
    SELECT id, sourceId, distanceKm, timestamp, transportMechanism
    FROM route_segments
    WHERE isRecordHolder = 1
  `).all() as RecordHolderRow[];
  const toDemote = recordHolderIdsToDemote(stillFlagged);
  if (toDemote.length > 0) {
    const placeholders = toDemote.map(() => '?').join(',');
    db.prepare(`UPDATE route_segments SET isRecordHolder = 0 WHERE id IN (${placeholders})`).run(...toDemote);
    tally.demoted = toDemote.length;
  }

  logSummary('SQLite', tally);
}

// ============ PostgreSQL ============

export async function runMigration171Postgres(client: import('pg').PoolClient): Promise<void> {
  try {
    await runPostgresInner(client);
  } catch (e) {
    logger.error(`${LABEL} (PostgreSQL): best-effort reclassify failed, continuing without it: ${(e as Error)?.message ?? e}`);
  }
}

async function runPostgresInner(client: import('pg').PoolClient): Promise<void> {
  const tally = emptyTally();

  const flaggedResult = await client.query<Record<string, unknown>>(`
    SELECT id, "sourceId", "fromNodeNum", "toNodeNum", timestamp
    FROM route_segments
    WHERE "isRecordHolder" = true AND "transportMechanism" IS NULL
  `);

  for (const row of flaggedResult.rows) {
    const seg: FlaggedSegmentRow = {
      id: Number(row.id),
      sourceId: (row.sourceId as string | null) ?? null,
      fromNodeNum: Number(row.fromNodeNum),
      toNodeNum: Number(row.toNodeNum),
      timestamp: Number(row.timestamp),
    };
    tally.examined++;
    try {
      const windowStart = seg.timestamp - RECLASSIFY_WINDOW_MS;
      const candResult = seg.sourceId === null
        ? await client.query<Record<string, unknown>>(
            `SELECT "fromNodeNum", "toNodeNum", timestamp, route, "routeBack", "snrTowards", "snrBack", "transportMechanism"
             FROM traceroutes WHERE "sourceId" IS NULL AND timestamp BETWEEN $1 AND $2
             ORDER BY timestamp DESC LIMIT 50`,
            [windowStart, seg.timestamp],
          )
        : await client.query<Record<string, unknown>>(
            `SELECT "fromNodeNum", "toNodeNum", timestamp, route, "routeBack", "snrTowards", "snrBack", "transportMechanism"
             FROM traceroutes WHERE "sourceId" = $1 AND timestamp BETWEEN $2 AND $3
             ORDER BY timestamp DESC LIMIT 50`,
            [seg.sourceId, windowStart, seg.timestamp],
          );

      const candidates: BackfillTraceroute[] = candResult.rows.map((r) => ({
        fromNodeNum: Number(r.fromNodeNum),
        toNodeNum: Number(r.toNodeNum),
        timestamp: Number(r.timestamp),
        route: (r.route as string | null) ?? null,
        routeBack: (r.routeBack as string | null) ?? null,
        snrTowards: (r.snrTowards as string | null) ?? null,
        snrBack: (r.snrBack as string | null) ?? null,
        transportMechanism: r.transportMechanism === null ? null : Number(r.transportMechanism),
      }));

      const match = matchSegmentTransport(seg, candidates);
      if (match.matched && match.transportMechanism !== null) {
        const updateResult = seg.sourceId === null
          ? await client.query(
              `UPDATE route_segments SET "transportMechanism" = $1
               WHERE "sourceId" IS NULL AND "fromNodeNum" = $2 AND "toNodeNum" = $3 AND timestamp = $4 AND "transportMechanism" IS NULL`,
              [match.transportMechanism, seg.fromNodeNum, seg.toNodeNum, seg.timestamp],
            )
          : await client.query(
              `UPDATE route_segments SET "transportMechanism" = $1
               WHERE "sourceId" = $2 AND "fromNodeNum" = $3 AND "toNodeNum" = $4 AND timestamp = $5 AND "transportMechanism" IS NULL`,
              [match.transportMechanism, seg.sourceId, seg.fromNodeNum, seg.toNodeNum, seg.timestamp],
            );
        if ((updateResult.rowCount ?? 0) > 0) tallyClass(tally, match.transportMechanism);
        else tally.unmatched++;
      } else {
        tally.unmatched++;
      }
    } catch (e) {
      logger.warn(`${LABEL} (PostgreSQL): skipping segment id=${seg.id}: ${(e as Error)?.message ?? e}`);
      tally.unmatched++;
    }
  }

  const stillFlaggedResult = await client.query<Record<string, unknown>>(`
    SELECT id, "sourceId", "distanceKm", timestamp, "transportMechanism"
    FROM route_segments
    WHERE "isRecordHolder" = true
  `);
  const stillFlagged: RecordHolderRow[] = stillFlaggedResult.rows.map((r) => ({
    id: Number(r.id),
    sourceId: (r.sourceId as string | null) ?? null,
    distanceKm: Number(r.distanceKm),
    timestamp: Number(r.timestamp),
    transportMechanism: r.transportMechanism === null ? null : Number(r.transportMechanism),
  }));
  const toDemote = recordHolderIdsToDemote(stillFlagged);
  if (toDemote.length > 0) {
    await client.query(
      `UPDATE route_segments SET "isRecordHolder" = false WHERE id = ANY($1::int[])`,
      [toDemote],
    );
    tally.demoted = toDemote.length;
  }

  logSummary('PostgreSQL', tally);
}

// ============ MySQL ============

export async function runMigration171Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  try {
    await runMysqlInner(pool);
  } catch (e) {
    logger.error(`${LABEL} (MySQL): best-effort reclassify failed, continuing without it: ${(e as Error)?.message ?? e}`);
  }
}

async function runMysqlInner(pool: import('mysql2/promise').Pool): Promise<void> {
  const tally = emptyTally();

  const [flaggedRows] = await pool.query(`
    SELECT id, sourceId, fromNodeNum, toNodeNum, timestamp
    FROM route_segments
    WHERE isRecordHolder = 1 AND transportMechanism IS NULL
  `);

  for (const row of flaggedRows as Record<string, unknown>[]) {
    const seg: FlaggedSegmentRow = {
      id: Number(row.id),
      sourceId: (row.sourceId as string | null) ?? null,
      fromNodeNum: Number(row.fromNodeNum),
      toNodeNum: Number(row.toNodeNum),
      timestamp: Number(row.timestamp),
    };
    tally.examined++;
    try {
      const windowStart = seg.timestamp - RECLASSIFY_WINDOW_MS;
      const [candRows] = seg.sourceId === null
        ? await pool.query(
            `SELECT fromNodeNum, toNodeNum, timestamp, route, routeBack, snrTowards, snrBack, transportMechanism
             FROM traceroutes WHERE sourceId IS NULL AND timestamp BETWEEN ? AND ?
             ORDER BY timestamp DESC LIMIT 50`,
            [windowStart, seg.timestamp],
          )
        : await pool.query(
            `SELECT fromNodeNum, toNodeNum, timestamp, route, routeBack, snrTowards, snrBack, transportMechanism
             FROM traceroutes WHERE sourceId = ? AND timestamp BETWEEN ? AND ?
             ORDER BY timestamp DESC LIMIT 50`,
            [seg.sourceId, windowStart, seg.timestamp],
          );

      const candidates: BackfillTraceroute[] = (candRows as Record<string, unknown>[]).map((r) => ({
        fromNodeNum: Number(r.fromNodeNum),
        toNodeNum: Number(r.toNodeNum),
        timestamp: Number(r.timestamp),
        route: (r.route as string | null) ?? null,
        routeBack: (r.routeBack as string | null) ?? null,
        snrTowards: (r.snrTowards as string | null) ?? null,
        snrBack: (r.snrBack as string | null) ?? null,
        transportMechanism: r.transportMechanism === null ? null : Number(r.transportMechanism),
      }));

      const match = matchSegmentTransport(seg, candidates);
      if (match.matched && match.transportMechanism !== null) {
        const [updateResult] = seg.sourceId === null
          ? await pool.query(
              `UPDATE route_segments SET transportMechanism = ?
               WHERE sourceId IS NULL AND fromNodeNum = ? AND toNodeNum = ? AND timestamp = ? AND transportMechanism IS NULL`,
              [match.transportMechanism, seg.fromNodeNum, seg.toNodeNum, seg.timestamp],
            )
          : await pool.query(
              `UPDATE route_segments SET transportMechanism = ?
               WHERE sourceId = ? AND fromNodeNum = ? AND toNodeNum = ? AND timestamp = ? AND transportMechanism IS NULL`,
              [match.transportMechanism, seg.sourceId, seg.fromNodeNum, seg.toNodeNum, seg.timestamp],
            );
        const affected = (updateResult as { affectedRows?: number }).affectedRows ?? 0;
        if (affected > 0) tallyClass(tally, match.transportMechanism);
        else tally.unmatched++;
      } else {
        tally.unmatched++;
      }
    } catch (e) {
      logger.warn(`${LABEL} (MySQL): skipping segment id=${seg.id}: ${(e as Error)?.message ?? e}`);
      tally.unmatched++;
    }
  }

  const [stillFlaggedRows] = await pool.query(`
    SELECT id, sourceId, distanceKm, timestamp, transportMechanism
    FROM route_segments
    WHERE isRecordHolder = 1
  `);
  const stillFlagged: RecordHolderRow[] = (stillFlaggedRows as Record<string, unknown>[]).map((r) => ({
    id: Number(r.id),
    sourceId: (r.sourceId as string | null) ?? null,
    distanceKm: Number(r.distanceKm),
    timestamp: Number(r.timestamp),
    transportMechanism: r.transportMechanism === null ? null : Number(r.transportMechanism),
  }));
  const toDemote = recordHolderIdsToDemote(stillFlagged);
  if (toDemote.length > 0) {
    const placeholders = toDemote.map(() => '?').join(',');
    await pool.query(`UPDATE route_segments SET isRecordHolder = 0 WHERE id IN (${placeholders})`, toDemote);
    tally.demoted = toDemote.length;
  }

  logSummary('MySQL', tally);
}
