/**
 * Migration 235 — PostgreSQL / MySQL container behaviour (isolated DBs).
 * A silent skip still reports success; confirm via `numPendingTests`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import mysql from 'mysql2/promise';
import { runMigration235Postgres, runMigration235Mysql } from './235_unified_notification_scope.js';
import {
  postgresAvailable,
  mysqlAvailable,
  createIsolatedPostgresDatabase,
  createIsolatedMysqlDatabase,
} from '../../db/repositories/test-utils.js';

const MESH = '__mesh__';

/** (userId, sourceId, endpoint, updatedAt, p256dhKey) seeded on both backends. */
const SEED: Array<[number | null, string, string, number, string]> = [
  [1, 'src-a', 'https://push/e1', 100, 'old'],
  [1, 'src-b', 'https://push/e1', 200, 'new'],
  [1, 'src-a', 'https://push/e2', 100, 'k'],
  [2, 'src-c', 'https://push/e1', 100, 'k'],
  [null, 'src-a', 'https://push/anon', 100, 'k'],
  [null, 'src-b', 'https://push/anon', 50, 'k'],
];

const EXPECTED_SUBS = [
  { userId: 1, endpoint: 'https://push/e1', key: 'new' },
  { userId: 1, endpoint: 'https://push/e2', key: 'k' },
  { userId: 2, endpoint: 'https://push/e1', key: 'k' },
  { userId: null, endpoint: 'https://push/anon', key: 'k' },
];

describe.skipIf(!postgresAvailable)('migration 235 — PostgreSQL (container)', () => {
  let pool: pg.Pool;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedPostgresDatabase('mig235'));
    await pool.query(`
      CREATE TABLE push_subscriptions (
        id SERIAL PRIMARY KEY,
        "userId" INTEGER,
        "sourceId" TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        "p256dhKey" TEXT NOT NULL,
        "authKey" TEXT NOT NULL,
        "userAgent" TEXT,
        "createdAt" BIGINT NOT NULL,
        "updatedAt" BIGINT NOT NULL,
        "lastUsedAt" BIGINT,
        UNIQUE ("userId", endpoint, "sourceId")
      )
    `);
    await pool.query(`
      CREATE TABLE user_notification_preferences (
        id SERIAL PRIMARY KEY,
        "userId" INTEGER NOT NULL,
        "sourceId" TEXT NOT NULL,
        "notifyOnMessage" BOOLEAN DEFAULT TRUE,
        "notifyOnDirectMessage" BOOLEAN DEFAULT TRUE,
        "notifyOnChannelMessage" BOOLEAN DEFAULT FALSE,
        "notifyOnNewNode" BOOLEAN DEFAULT TRUE,
        "notifyOnTraceroute" BOOLEAN DEFAULT TRUE,
        "notifyOnInactiveNode" BOOLEAN DEFAULT FALSE,
        "notifyOnLowBattery" BOOLEAN DEFAULT FALSE,
        "notifyOnWaypoint" BOOLEAN DEFAULT FALSE,
        "appriseEnabled" BOOLEAN DEFAULT TRUE,
        "createdAt" BIGINT NOT NULL,
        "updatedAt" BIGINT NOT NULL,
        UNIQUE ("userId", "sourceId")
      )
    `);
    for (const [userId, sourceId, endpoint, updatedAt, key] of SEED) {
      await pool.query(
        `INSERT INTO push_subscriptions ("userId", "sourceId", endpoint, "p256dhKey", "authKey", "createdAt", "updatedAt")
         VALUES ($1, $2, $3, $4, 'auth', 1, $5)`,
        [userId, sourceId, endpoint, key, updatedAt],
      );
    }
    await pool.query(
      `INSERT INTO user_notification_preferences ("userId", "sourceId", "createdAt", "updatedAt") VALUES (1, 'src-a', 5, 5)`,
    );
  });

  afterAll(async () => {
    await cleanup?.();
  });

  it('collapses to one row per (user, browser), records the source lists, and is idempotent', async () => {
    const client = await pool.connect();
    try {
      await runMigration235Postgres(client);
      await runMigration235Postgres(client);
    } finally {
      client.release();
    }

    const { rows: subs } = await pool.query(
      `SELECT "userId", "sourceId", endpoint, "p256dhKey" AS key FROM push_subscriptions ORDER BY "userId" NULLS LAST, endpoint`,
    );
    expect(subs.every((r: { sourceId: string }) => r.sourceId === MESH)).toBe(true);
    expect(subs.map((r: { userId: number | null; endpoint: string; key: string }) => ({ userId: r.userId, endpoint: r.endpoint, key: r.key })))
      .toEqual(EXPECTED_SUBS);

    const { rows: mesh } = await pool.query(
      `SELECT "userId", "pushSourceIds", "meshDefaultsSaved", "notifyOnMessage", "appriseEnabled", "notifyOnNewNode"
       FROM user_notification_preferences WHERE "sourceId" = $1 ORDER BY "userId"`,
      [MESH],
    );
    expect(mesh).toEqual([
      { userId: 1, pushSourceIds: '["src-a","src-b"]', meshDefaultsSaved: false, notifyOnMessage: false, appriseEnabled: false, notifyOnNewNode: false },
      { userId: 2, pushSourceIds: '["src-c"]', meshDefaultsSaved: false, notifyOnMessage: false, appriseEnabled: false, notifyOnNewNode: false },
    ]);

    const { rows: own } = await pool.query(
      `SELECT "notifyOnMessage", "pushSourceIds", "meshDefaultsSaved" FROM user_notification_preferences WHERE "sourceId" = 'src-a'`,
    );
    expect(own).toEqual([{ notifyOnMessage: true, pushSourceIds: null, meshDefaultsSaved: false }]);
  });
});

describe.skipIf(!mysqlAvailable)('migration 235 — MySQL (container)', () => {
  let pool: mysql.Pool;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedMysqlDatabase('mig235'));
    await pool.query(`
      CREATE TABLE push_subscriptions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        userId INT NULL,
        sourceId VARCHAR(64) NOT NULL,
        endpoint TEXT NOT NULL,
        p256dhKey VARCHAR(512) NOT NULL,
        authKey VARCHAR(128) NOT NULL,
        userAgent VARCHAR(512),
        createdAt BIGINT NOT NULL,
        updatedAt BIGINT NOT NULL,
        lastUsedAt BIGINT
      )
    `);
    await pool.query(`
      CREATE TABLE user_notification_preferences (
        id INT AUTO_INCREMENT PRIMARY KEY,
        userId INT NOT NULL,
        sourceId VARCHAR(64) NOT NULL,
        notifyOnMessage BOOLEAN DEFAULT TRUE,
        notifyOnDirectMessage BOOLEAN DEFAULT TRUE,
        notifyOnChannelMessage BOOLEAN DEFAULT FALSE,
        notifyOnNewNode BOOLEAN DEFAULT TRUE,
        notifyOnTraceroute BOOLEAN DEFAULT TRUE,
        notifyOnInactiveNode BOOLEAN DEFAULT FALSE,
        notifyOnLowBattery BOOLEAN DEFAULT FALSE,
        notifyOnWaypoint BOOLEAN DEFAULT FALSE,
        appriseEnabled BOOLEAN DEFAULT TRUE,
        createdAt BIGINT NOT NULL,
        updatedAt BIGINT NOT NULL,
        UNIQUE KEY uq_user_source (userId, sourceId)
      )
    `);
    for (const [userId, sourceId, endpoint, updatedAt, key] of SEED) {
      await pool.query(
        `INSERT INTO push_subscriptions (userId, sourceId, endpoint, p256dhKey, authKey, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, 'auth', 1, ?)`,
        [userId, sourceId, endpoint, key, updatedAt],
      );
    }
    await pool.query(
      `INSERT INTO user_notification_preferences (userId, sourceId, createdAt, updatedAt) VALUES (1, 'src-a', 5, 5)`,
    );
  });

  afterAll(async () => {
    await cleanup?.();
  });

  it('collapses to one row per (user, browser), records the source lists, and is idempotent', async () => {
    await runMigration235Mysql(pool);
    await runMigration235Mysql(pool);

    const [subs] = await pool.query(
      `SELECT userId, sourceId, endpoint, p256dhKey AS \`key\` FROM push_subscriptions ORDER BY userId IS NULL, userId, endpoint`,
    );
    const subRows = subs as Array<{ userId: number | null; sourceId: string; endpoint: string; key: string }>;
    expect(subRows.every(r => r.sourceId === MESH)).toBe(true);
    expect(subRows.map(r => ({ userId: r.userId, endpoint: r.endpoint, key: r.key }))).toEqual(EXPECTED_SUBS);

    const [mesh] = await pool.query(
      `SELECT userId, pushSourceIds, meshDefaultsSaved, notifyOnMessage, appriseEnabled, notifyOnNewNode
       FROM user_notification_preferences WHERE sourceId = ? ORDER BY userId`,
      [MESH],
    );
    expect(mesh).toEqual([
      { userId: 1, pushSourceIds: '["src-a","src-b"]', meshDefaultsSaved: 0, notifyOnMessage: 0, appriseEnabled: 0, notifyOnNewNode: 0 },
      { userId: 2, pushSourceIds: '["src-c"]', meshDefaultsSaved: 0, notifyOnMessage: 0, appriseEnabled: 0, notifyOnNewNode: 0 },
    ]);

    const [own] = await pool.query(
      `SELECT notifyOnMessage, pushSourceIds, meshDefaultsSaved FROM user_notification_preferences WHERE sourceId = 'src-a'`,
    );
    expect(own).toEqual([{ notifyOnMessage: 1, pushSourceIds: null, meshDefaultsSaved: 0 }]);
  });
});
