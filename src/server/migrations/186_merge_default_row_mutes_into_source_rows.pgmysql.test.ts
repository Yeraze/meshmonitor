/**
 * Migration 186 — PostgreSQL / MySQL container behaviour (isolated DBs).
 * A silent skip still reports success; confirm via `numPendingTests`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import mysql from 'mysql2/promise';
import { runMigration186Postgres, runMigration186Mysql } from './186_merge_default_row_mutes_into_source_rows.js';
import {
  postgresAvailable,
  mysqlAvailable,
  createIsolatedPostgresDatabase,
  createIsolatedMysqlDatabase,
} from '../../db/repositories/test-utils.js';

const FUTURE = Date.now() + 24 * 60 * 60 * 1000;

const SEED: Array<[number, string, string | null, string | null]> = [
  [1, '', JSON.stringify([{ channelId: 2, muteUntil: null }]), JSON.stringify([{ nodeUuid: '!aaaa', muteUntil: FUTURE }])],
  [1, 'mt', JSON.stringify([{ channelId: 3, muteUntil: null }]), null],
  [1, 'mc', JSON.stringify([]), JSON.stringify([])],
];

describe.skipIf(!postgresAvailable)('migration 186 — PostgreSQL (container)', () => {
  let pool: pg.Pool;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedPostgresDatabase('mig186'));
    await pool.query('DROP TABLE IF EXISTS user_notification_preferences CASCADE');
    await pool.query('DROP TABLE IF EXISTS sources CASCADE');
    await pool.query(`CREATE TABLE sources (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL)`);
    await pool.query(`INSERT INTO sources VALUES ('mt', 'TCP', 'meshtastic_tcp'), ('mc', 'MC', 'meshcore')`);
    await pool.query(`
      CREATE TABLE user_notification_preferences (
        id SERIAL PRIMARY KEY,
        "userId" INTEGER NOT NULL,
        "sourceId" TEXT NOT NULL,
        "mutedChannels" TEXT,
        "mutedDMs" TEXT
      )
    `);
    for (const [u, s, c, d] of SEED) {
      await pool.query(
        `INSERT INTO user_notification_preferences ("userId", "sourceId", "mutedChannels", "mutedDMs") VALUES ($1, $2, $3, $4)`,
        [u, s, c, d],
      );
    }
  });

  afterAll(async () => {
    await cleanup?.();
  });

  it('merges into Meshtastic rows only, separately per list, idempotently', async () => {
    const client = await pool.connect();
    try {
      await runMigration186Postgres(client);
      await runMigration186Postgres(client);
    } finally {
      client.release();
    }
    const { rows } = await pool.query(
      `SELECT "sourceId", "mutedChannels", "mutedDMs" FROM user_notification_preferences ORDER BY id`,
    );
    const mt = rows.find((r) => r.sourceId === 'mt');
    expect(JSON.parse(mt.mutedChannels)).toEqual([{ channelId: 3, muteUntil: null }, { channelId: 2, muteUntil: null }]);
    expect(JSON.parse(mt.mutedDMs)).toEqual([{ nodeUuid: '!aaaa', muteUntil: FUTURE }]);
    const mc = rows.find((r) => r.sourceId === 'mc');
    expect(JSON.parse(mc.mutedChannels)).toEqual([]);
    expect(rows).toHaveLength(3);
  });
});

describe.skipIf(!mysqlAvailable)('migration 186 — MySQL (container)', () => {
  let pool: mysql.Pool;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedMysqlDatabase('mig186'));
    await pool.query('DROP TABLE IF EXISTS user_notification_preferences');
    await pool.query('DROP TABLE IF EXISTS sources');
    await pool.query(`CREATE TABLE sources (id VARCHAR(64) PRIMARY KEY, name VARCHAR(64) NOT NULL, type VARCHAR(32) NOT NULL)`);
    await pool.query(`INSERT INTO sources VALUES ('mt', 'TCP', 'meshtastic_tcp'), ('mc', 'MC', 'meshcore')`);
    await pool.query(`
      CREATE TABLE user_notification_preferences (
        id INT AUTO_INCREMENT PRIMARY KEY,
        userId INT NOT NULL,
        sourceId VARCHAR(64) NOT NULL,
        mutedChannels TEXT,
        mutedDMs TEXT
      )
    `);
    for (const [u, s, c, d] of SEED) {
      await pool.query(
        'INSERT INTO user_notification_preferences (userId, sourceId, mutedChannels, mutedDMs) VALUES (?, ?, ?, ?)',
        [u, s, c, d],
      );
    }
  });

  afterAll(async () => {
    await cleanup?.();
  });

  it('merges into Meshtastic rows only, separately per list, idempotently', async () => {
    await runMigration186Mysql(pool);
    await runMigration186Mysql(pool);
    const [rows] = await pool.query('SELECT sourceId, mutedChannels, mutedDMs FROM user_notification_preferences ORDER BY id');
    const list = rows as Array<{ sourceId: string; mutedChannels: string; mutedDMs: string }>;
    const mt = list.find((r) => r.sourceId === 'mt')!;
    expect(JSON.parse(mt.mutedChannels)).toEqual([{ channelId: 3, muteUntil: null }, { channelId: 2, muteUntil: null }]);
    expect(JSON.parse(mt.mutedDMs)).toEqual([{ nodeUuid: '!aaaa', muteUntil: FUTURE }]);
    const mc = list.find((r) => r.sourceId === 'mc')!;
    expect(JSON.parse(mc.mutedChannels)).toEqual([]);
    expect(list).toHaveLength(3);
  });
});
