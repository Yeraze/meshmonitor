/**
 * Migration 165 — PostgreSQL / MySQL container behaviour (#4750).
 *
 * Two things worth pinning on the non-default backends.
 *
 * The **defaults**: `notify_on_waypoint` FALSE and a 10 km radius. An upgrade
 * must not start sending waypoint alerts to everyone who already had push
 * enabled, and a NULL radius reaching the service would read as "no filter".
 *
 * The **ledger table**, which is the safety mechanism itself. Its composite
 * primary key is what makes a second alert for the same waypoint impossible;
 * if the key were wrong, duplicate rows would accumulate and every rebroadcast
 * would alert again. MySQL is the interesting one — it cannot put a TEXT column
 * in a primary key, so `sourceId` is VARCHAR(191) there.
 *
 * **Isolation.** Own PostgreSQL schema, own MySQL database: both tables are
 * fixture tables elsewhere, and two suites creating/dropping the same name in
 * one test database is an active race (CLAUDE.md Multi-Database).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import mysql from 'mysql2/promise';
import { runMigration165Postgres, runMigration165Mysql } from './165_waypoint_notifications.js';
import { postgresAvailable, mysqlAvailable } from '../../db/repositories/test-utils.js';

const { Pool: PgPool } = pg;
const PG_SCHEMA = 'wpn_migration_165';
const MYSQL_DB = 'meshmonitor_test_wpn_165';

/** The preferences table as it stood at migration 164 — no waypoint columns. */
const PRE_PG = `
  CREATE TABLE user_notification_preferences (
    id SERIAL PRIMARY KEY,
    "userId" INTEGER NOT NULL,
    "sourceId" TEXT NOT NULL DEFAULT '',
    "notifyOnLowBattery" BOOLEAN DEFAULT FALSE
  )`;
const PRE_MYSQL = `
  CREATE TABLE user_notification_preferences (
    id SERIAL PRIMARY KEY,
    userId INT NOT NULL,
    sourceId VARCHAR(191) NOT NULL DEFAULT '',
    notifyOnLowBattery BOOLEAN DEFAULT FALSE
  )`;

describe.skipIf(!postgresAvailable)('migration 165 — PostgreSQL (container)', () => {
  let pool: InstanceType<typeof PgPool>;

  beforeAll(async () => {
    const admin = new PgPool({ host: 'localhost', port: 5433, user: 'test', password: 'test', database: 'meshmonitor_test' });
    await admin.query(`DROP SCHEMA IF EXISTS ${PG_SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${PG_SCHEMA}`);
    await admin.end();

    pool = new PgPool({
      host: 'localhost', port: 5433, user: 'test', password: 'test', database: 'meshmonitor_test',
      options: `-c search_path=${PG_SCHEMA}`,
    });
    await pool.query(PRE_PG);

    const client = await pool.connect();
    try {
      await runMigration165Postgres(client);
      // A crash between the migration and its ledger write re-runs it.
      await expect(runMigration165Postgres(client)).resolves.toBeUndefined();
    } finally {
      client.release();
    }
  }, 30_000);

  afterAll(async () => {
    if (pool) {
      await pool.query(`DROP SCHEMA IF EXISTS ${PG_SCHEMA} CASCADE`);
      await pool.end();
    }
  });

  it('defaults the flag OFF so an upgrade sends nobody new alerts', async () => {
    await pool.query(`INSERT INTO user_notification_preferences ("userId") VALUES (1)`);
    const { rows } = await pool.query(
      `SELECT "notifyOnWaypoint", "waypointRadiusKm", "waypointCenterLat", "waypointCenterLon"
         FROM user_notification_preferences WHERE "userId" = 1`,
    );
    expect(rows[0].notifyOnWaypoint).toBe(false);
    expect(Number(rows[0].waypointRadiusKm)).toBe(10);
    // A NULL centre is the "use this source's own node" signal.
    expect(rows[0].waypointCenterLat).toBeNull();
    expect(rows[0].waypointCenterLon).toBeNull();
  });

  it('round-trips an opted-in row with a custom radius and centre', async () => {
    await pool.query(
      `INSERT INTO user_notification_preferences ("userId", "notifyOnWaypoint", "waypointRadiusKm", "waypointCenterLat", "waypointCenterLon")
       VALUES (2, TRUE, 2.5, 26.12, -80.14)`,
    );
    const { rows } = await pool.query(
      `SELECT "notifyOnWaypoint", "waypointRadiusKm", "waypointCenterLat", "waypointCenterLon"
         FROM user_notification_preferences WHERE "userId" = 2`,
    );
    expect(rows[0].notifyOnWaypoint).toBe(true);
    expect(Number(rows[0].waypointRadiusKm)).toBeCloseTo(2.5);
    expect(Number(rows[0].waypointCenterLat)).toBeCloseTo(26.12);
    expect(Number(rows[0].waypointCenterLon)).toBeCloseTo(-80.14);
  });

  it('rejects a second ledger row for the same (user, source, waypoint)', async () => {
    await pool.query(
      `INSERT INTO waypoint_notifications ("userId", "sourceId", "waypointId", "notifiedAt") VALUES (1, 'src-a', 42, 1700000000000)`,
    );
    await expect(
      pool.query(
        `INSERT INTO waypoint_notifications ("userId", "sourceId", "waypointId", "notifiedAt") VALUES (1, 'src-a', 42, 1700000001000)`,
      ),
    ).rejects.toThrow();
  });

  it('keeps the same waypoint id distinct per user and per source', async () => {
    await pool.query(
      `INSERT INTO waypoint_notifications ("userId", "sourceId", "waypointId", "notifiedAt")
       VALUES (2, 'src-a', 42, 1), (1, 'src-b', 42, 1)`,
    );
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM waypoint_notifications WHERE "waypointId" = 42`,
    );
    expect(rows[0].n).toBe(3);
  });

  it('stores a waypoint id above the 32-bit signed range', async () => {
    // Waypoint ids are generated up to 1e9, comfortably inside INT, but the
    // column is BIGINT so a foreign id can never overflow into a collision.
    await pool.query(
      `INSERT INTO waypoint_notifications ("userId", "sourceId", "waypointId", "notifiedAt") VALUES (9, 'src-a', 4294967295, 1)`,
    );
    const { rows } = await pool.query(
      `SELECT "waypointId" FROM waypoint_notifications WHERE "userId" = 9`,
    );
    expect(Number(rows[0].waypointId)).toBe(4294967295);
  });
});

describe.skipIf(!mysqlAvailable)('migration 165 — MySQL (container)', () => {
  let pool: mysql.Pool;

  beforeAll(async () => {
    const admin = mysql.createPool({ host: 'localhost', port: 3307, user: 'root', password: 'root', connectionLimit: 1 });
    await admin.query(`DROP DATABASE IF EXISTS \`${MYSQL_DB}\``);
    await admin.query(`CREATE DATABASE \`${MYSQL_DB}\``);
    await admin.query(`GRANT ALL ON \`${MYSQL_DB}\`.* TO 'test'@'%'`);
    await admin.query('FLUSH PRIVILEGES');
    await admin.end();

    pool = mysql.createPool({ host: 'localhost', port: 3307, user: 'test', password: 'test', database: MYSQL_DB, connectionLimit: 5 });
    await pool.query(PRE_MYSQL);
    await runMigration165Mysql(pool);
    await expect(runMigration165Mysql(pool)).resolves.toBeUndefined();
  }, 30_000);

  afterAll(async () => {
    if (pool) await pool.end();
    const admin = mysql.createPool({ host: 'localhost', port: 3307, user: 'root', password: 'root', connectionLimit: 1 });
    await admin.query(`DROP DATABASE IF EXISTS \`${MYSQL_DB}\``);
    await admin.end();
  });

  it('defaults the flag OFF so an upgrade sends nobody new alerts', async () => {
    await pool.query(`INSERT INTO user_notification_preferences (userId) VALUES (1)`);
    const [rows] = await pool.query(
      `SELECT notifyOnWaypoint, waypointRadiusKm, waypointCenterLat, waypointCenterLon
         FROM user_notification_preferences WHERE userId = 1`,
    );
    const row = (rows as Array<Record<string, number | null>>)[0];
    // MySQL BOOLEAN is TINYINT(1); 0 is the stored FALSE.
    expect(Number(row.notifyOnWaypoint)).toBe(0);
    expect(Number(row.waypointRadiusKm)).toBe(10);
    expect(row.waypointCenterLat).toBeNull();
    expect(row.waypointCenterLon).toBeNull();
  });

  it('round-trips an opted-in row with a custom radius and centre', async () => {
    await pool.query(
      `INSERT INTO user_notification_preferences (userId, notifyOnWaypoint, waypointRadiusKm, waypointCenterLat, waypointCenterLon)
       VALUES (2, TRUE, 2.5, 26.12, -80.14)`,
    );
    const [rows] = await pool.query(
      `SELECT notifyOnWaypoint, waypointRadiusKm, waypointCenterLat, waypointCenterLon
         FROM user_notification_preferences WHERE userId = 2`,
    );
    const row = (rows as Array<Record<string, number>>)[0];
    expect(Number(row.notifyOnWaypoint)).toBe(1);
    expect(Number(row.waypointRadiusKm)).toBeCloseTo(2.5);
    expect(Number(row.waypointCenterLat)).toBeCloseTo(26.12);
    expect(Number(row.waypointCenterLon)).toBeCloseTo(-80.14);
  });

  it('rejects a second ledger row for the same (user, source, waypoint)', async () => {
    await pool.query(
      `INSERT INTO waypoint_notifications (userId, sourceId, waypointId, notifiedAt) VALUES (1, 'src-a', 42, 1700000000000)`,
    );
    await expect(
      pool.query(
        `INSERT INTO waypoint_notifications (userId, sourceId, waypointId, notifiedAt) VALUES (1, 'src-a', 42, 1700000001000)`,
      ),
    ).rejects.toThrow();
  });

  it('keeps the same waypoint id distinct per user and per source', async () => {
    await pool.query(
      `INSERT INTO waypoint_notifications (userId, sourceId, waypointId, notifiedAt)
       VALUES (2, 'src-a', 42, 1), (1, 'src-b', 42, 1)`,
    );
    const [rows] = await pool.query(
      `SELECT COUNT(*) AS n FROM waypoint_notifications WHERE waypointId = 42`,
    );
    expect(Number((rows as Array<{ n: number }>)[0].n)).toBe(3);
  });

  it('stores a waypoint id above the 32-bit signed range', async () => {
    await pool.query(
      `INSERT INTO waypoint_notifications (userId, sourceId, waypointId, notifiedAt) VALUES (9, 'src-a', 4294967295, 1)`,
    );
    const [rows] = await pool.query(
      `SELECT waypointId FROM waypoint_notifications WHERE userId = 9`,
    );
    expect(Number((rows as Array<{ waypointId: number }>)[0].waypointId)).toBe(4294967295);
  });
});
