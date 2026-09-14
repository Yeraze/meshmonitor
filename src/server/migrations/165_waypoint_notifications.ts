/**
 * Migration 165: waypoint arrival notifications (#4750).
 *
 * Two pieces.
 *
 * 1. Four columns on `user_notification_preferences`, the per-(user, source)
 *    table every other `notify_on_*` flag already lives in:
 *
 *      notify_on_waypoint     BOOLEAN  DEFAULT FALSE
 *      waypoint_radius_km     REAL     DEFAULT 10
 *      waypoint_center_lat    REAL     NULL
 *      waypoint_center_lon    REAL     NULL
 *
 *    Defaulting FALSE matches `notify_on_inactive_node` and
 *    `notify_on_low_battery` — the opt-in alerts — rather than the
 *    message/new-node flags that default TRUE. Nobody gets waypoint alerts
 *    from an upgrade they did not ask for.
 *
 *    A NULL centre means "use this source's own node position", which is the
 *    normal case; the columns exist for an operator whose server node sits
 *    somewhere other than the area they care about.
 *
 * 2. `waypoint_notifications`, the dedupe ledger: one row per
 *    (user, source, waypoint) that has already been alerted on.
 *
 *    This is a TABLE and not an in-memory Map on purpose. Waypoints
 *    rebroadcast on a schedule, so "have I already told this user about this
 *    waypoint?" is the only thing standing between the feature and an alert
 *    every few minutes forever. In-memory state answers "no" to every question
 *    after a container restart, and the next rebroadcast sweep would re-alert
 *    every waypoint in range at once. See the "does a save reset a safety
 *    timer?" section of CLAUDE.md's mesh impact checklist.
 *
 * Idempotent across SQLite / PostgreSQL / MySQL.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';
import {
  addColumnIfMissing,
  addColumnIfMissingPostgres,
  addColumnIfMissingMysql,
  createTableIfMissingMysql,
  createIndexIfMissingMysql,
} from './helpers.js';

const LABEL = 'Migration 165';
const PREFS = 'user_notification_preferences';
const LEDGER = 'waypoint_notifications';

/** Kilometres. A LongFast neighbourhood rather than a whole region (#4750). */
const DEFAULT_RADIUS_KM = 10;

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): adding waypoint notification preferences...`);
    addColumnIfMissing(db, PREFS, 'notify_on_waypoint', 'notify_on_waypoint INTEGER DEFAULT 0');
    addColumnIfMissing(
      db,
      PREFS,
      'waypoint_radius_km',
      `waypoint_radius_km REAL DEFAULT ${DEFAULT_RADIUS_KM}`,
    );
    addColumnIfMissing(db, PREFS, 'waypoint_center_lat', 'waypoint_center_lat REAL');
    addColumnIfMissing(db, PREFS, 'waypoint_center_lon', 'waypoint_center_lon REAL');

    logger.info(`${LABEL} (SQLite): creating ${LEDGER}...`);
    db.exec(`
      CREATE TABLE IF NOT EXISTS ${LEDGER} (
        user_id INTEGER NOT NULL,
        source_id TEXT NOT NULL,
        waypoint_id INTEGER NOT NULL,
        notified_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, source_id, waypoint_id)
      )
    `);
    // Cleanup deletes by (source, waypoint) across all users when a waypoint
    // is removed or expires, which the primary key's leading user_id cannot
    // serve.
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_waypoint_notifications_source_waypoint
        ON ${LEDGER} (source_id, waypoint_id)
    `);
  },

  down: (_db: Database): void => {
    logger.debug(`${LABEL} down: not implemented (column drops are destructive)`);
  },
};

// ============ PostgreSQL ============

export async function runMigration165Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): adding waypoint notification preferences...`);
  await addColumnIfMissingPostgres(client, PREFS, 'notifyOnWaypoint', '"notifyOnWaypoint" BOOLEAN DEFAULT FALSE');
  await addColumnIfMissingPostgres(
    client,
    PREFS,
    'waypointRadiusKm',
    `"waypointRadiusKm" DOUBLE PRECISION DEFAULT ${DEFAULT_RADIUS_KM}`,
  );
  await addColumnIfMissingPostgres(client, PREFS, 'waypointCenterLat', '"waypointCenterLat" DOUBLE PRECISION');
  await addColumnIfMissingPostgres(client, PREFS, 'waypointCenterLon', '"waypointCenterLon" DOUBLE PRECISION');

  logger.info(`${LABEL} (PostgreSQL): creating ${LEDGER}...`);
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${LEDGER} (
      "userId" INTEGER NOT NULL,
      "sourceId" TEXT NOT NULL,
      "waypointId" BIGINT NOT NULL,
      "notifiedAt" BIGINT NOT NULL,
      PRIMARY KEY ("userId", "sourceId", "waypointId")
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_waypoint_notifications_source_waypoint
      ON ${LEDGER} ("sourceId", "waypointId")
  `);
}

// ============ MySQL ============

export async function runMigration165Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info(`${LABEL} (MySQL): adding waypoint notification preferences...`);
  await addColumnIfMissingMysql(pool, PREFS, 'notifyOnWaypoint', 'notifyOnWaypoint BOOLEAN DEFAULT FALSE');
  await addColumnIfMissingMysql(
    pool,
    PREFS,
    'waypointRadiusKm',
    `waypointRadiusKm DOUBLE DEFAULT ${DEFAULT_RADIUS_KM}`,
  );
  await addColumnIfMissingMysql(pool, PREFS, 'waypointCenterLat', 'waypointCenterLat DOUBLE');
  await addColumnIfMissingMysql(pool, PREFS, 'waypointCenterLon', 'waypointCenterLon DOUBLE');

  logger.info(`${LABEL} (MySQL): creating ${LEDGER}...`);
  // `sourceId` is VARCHAR(191) rather than TEXT because it is part of the
  // primary key, and MySQL cannot index a TEXT column without a prefix length.
  await createTableIfMissingMysql(
    pool,
    LEDGER,
    `CREATE TABLE ${LEDGER} (
      userId INT NOT NULL,
      sourceId VARCHAR(191) NOT NULL,
      waypointId BIGINT NOT NULL,
      notifiedAt BIGINT NOT NULL,
      PRIMARY KEY (userId, sourceId, waypointId),
      INDEX idx_waypoint_notifications_source_waypoint (sourceId, waypointId)
    )`,
  );
  // Only reached when the table predates this migration without the index.
  await createIndexIfMissingMysql(
    pool,
    LEDGER,
    'idx_waypoint_notifications_source_waypoint',
    `CREATE INDEX idx_waypoint_notifications_source_waypoint ON ${LEDGER} (sourceId, waypointId)`,
  );
}
