/**
 * Migration 228 — PostgreSQL / MySQL container behaviour (isolated DBs), same
 * scenario as the SQLite suite. A silent skip still reports success; confirm
 * via `numPendingTests` (#6308).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import mysql from 'mysql2/promise';
import { runMigration228Postgres, runMigration228Mysql } from './228_refile_meshcore_mqtt_slot_channels.js';
import {
  postgresAvailable,
  mysqlAvailable,
  createIsolatedPostgresDatabase,
  createIsolatedMysqlDatabase,
} from '../../db/repositories/test-utils.js';
import { scenario, expectedMessages, MQTT, KEYED_X, KEYED_Y, FUTURE } from '../test-helpers/migration228Fixture.js';

type Msg = { id: string; fromPublicKey: string; keyFingerprint: string | null; keySourceId: string | null; keyChannelIdx: number | null };

function checkMessages(rows: Msg[]): void {
  const by = new Map(rows.map((r) => [r.id, r]));
  for (const [id, want] of Object.entries(expectedMessages)) {
    expect(by.get(id), id).toMatchObject({ fromPublicKey: want.fromPublicKey, keyFingerprint: want.keyFingerprint });
    if (want.keySourceId) expect(by.get(id), id).toMatchObject({ keySourceId: want.keySourceId, keyChannelIdx: want.keyChannelIdx });
  }
}

function checkPrefs(rows: Array<{ userId: number; sourceId: string; enabledChannels: string | null; mutedChannels: string | null }>): void {
  const get = (u: number, s: string) => rows.find((r) => Number(r.userId) === u && r.sourceId === s)!;
  const u1 = get(1, MQTT);
  expect(JSON.parse(u1.enabledChannels!).sort((a: number, b: number) => a - b)).toEqual([3, 7, KEYED_X, KEYED_Y].sort((a, b) => a - b));
  expect(JSON.parse(u1.mutedChannels!).map((r: { channelId: number }) => r.channelId).sort((a: number, b: number) => a - b))
    .toEqual([3, KEYED_X, KEYED_Y].sort((a, b) => a - b));
  const u2 = get(2, MQTT);
  expect(u2.enabledChannels).toBeNull();
  const m2 = JSON.parse(u2.mutedChannels!) as Array<{ channelId: number; muteUntil: number | null }>;
  expect(m2).toContainEqual({ channelId: KEYED_X, muteUntil: FUTURE });
  expect(m2).toContainEqual({ channelId: 7, muteUntil: null });
  expect(get(1, 'comp1').enabledChannels).toBe(JSON.stringify([3]));
}

function checkReads(rows: Array<{ conversationKey: string; lastReadAt: number | string }>): void {
  expect(rows.map((r) => r.conversationKey).sort()).toEqual(['3', String(KEYED_X), String(KEYED_Y)].sort());
  expect(rows.every((r) => Number(r.lastReadAt) === 12345)).toBe(true);
}

describe.skipIf(!postgresAvailable)('migration 228 — PostgreSQL (container)', () => {
  let pool: pg.Pool;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedPostgresDatabase('mig228'));
    await pool.query(`CREATE TABLE sources (id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', type TEXT NOT NULL)`);
    await pool.query(`CREATE TABLE channels (pk SERIAL PRIMARY KEY, id INTEGER NOT NULL, name TEXT NOT NULL, psk TEXT, "sourceId" TEXT)`);
    await pool.query(`CREATE TABLE meshcore_messages (
      id TEXT PRIMARY KEY, "fromPublicKey" TEXT NOT NULL, text TEXT NOT NULL, timestamp BIGINT NOT NULL,
      "senderTimestamp" BIGINT, "reactionRawText" TEXT, "keySourceId" TEXT, "keyChannelIdx" INTEGER,
      "keyFingerprint" TEXT, "messageType" TEXT DEFAULT 'text', "sourceId" TEXT)`);
    await pool.query(`CREATE TABLE user_notification_preferences (
      id SERIAL PRIMARY KEY, "userId" INTEGER NOT NULL, "sourceId" TEXT NOT NULL, "enabledChannels" TEXT, "mutedChannels" TEXT)`);
    await pool.query(`CREATE TABLE conversation_read_state (
      id SERIAL PRIMARY KEY, "userId" INTEGER NOT NULL, "sourceId" TEXT NOT NULL, "conversationKind" TEXT NOT NULL,
      "conversationKey" TEXT NOT NULL, "lastReadAt" BIGINT NOT NULL,
      UNIQUE ("userId", "sourceId", "conversationKind", "conversationKey"))`);
    for (const s of scenario.sources) await pool.query('INSERT INTO sources (id, type) VALUES ($1, $2)', [s.id, s.type]);
    for (const c of scenario.channels) await pool.query('INSERT INTO channels (id, name, psk, "sourceId") VALUES ($1,$2,$3,$4)', [c.id, c.name, c.psk, c.sourceId]);
    for (const m of scenario.messages) {
      await pool.query(
        `INSERT INTO meshcore_messages (id, "fromPublicKey", text, timestamp, "senderTimestamp", "reactionRawText", "keyFingerprint", "messageType", "sourceId")
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [m.id, m.fromPublicKey, m.text, m.timestamp, m.senderTimestamp, m.reactionRawText, m.keyFingerprint, m.messageType, m.sourceId],
      );
    }
    for (const p of scenario.prefs) {
      await pool.query('INSERT INTO user_notification_preferences ("userId","sourceId","enabledChannels","mutedChannels") VALUES ($1,$2,$3,$4)',
        [p.userId, p.sourceId, p.enabledChannels, p.mutedChannels]);
    }
    for (const r of scenario.reads) {
      await pool.query(`INSERT INTO conversation_read_state ("userId","sourceId","conversationKind","conversationKey","lastReadAt") VALUES ($1,$2,'meshcore_channel',$3,$4)`,
        [r.userId, r.sourceId, r.key, r.lastReadAt]);
    }
  });

  afterAll(async () => {
    await cleanup?.();
  });

  it('re-files, fans out prefs and read markers, and a re-run is a no-op', async () => {
    const run = async () => {
      const client = await pool.connect();
      try { await runMigration228Postgres(client); } finally { client.release(); }
    };
    await run();
    const snapshot = async () => JSON.stringify([
      (await pool.query('SELECT * FROM meshcore_messages ORDER BY id')).rows,
      (await pool.query('SELECT * FROM user_notification_preferences ORDER BY id')).rows,
      (await pool.query('SELECT * FROM conversation_read_state ORDER BY id')).rows,
    ]);
    const first = await snapshot();
    checkMessages((await pool.query('SELECT * FROM meshcore_messages')).rows);
    checkPrefs((await pool.query('SELECT * FROM user_notification_preferences')).rows);
    checkReads((await pool.query(`SELECT * FROM conversation_read_state WHERE "userId" = 1 AND "sourceId" = $1`, [MQTT])).rows);
    await run();
    expect(await snapshot()).toBe(first);
  });
});

describe.skipIf(!mysqlAvailable)('migration 228 — MySQL (container)', () => {
  let pool: mysql.Pool;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedMysqlDatabase('mig228'));
    await pool.query(`CREATE TABLE sources (id VARCHAR(64) PRIMARY KEY, name VARCHAR(64) NOT NULL DEFAULT '', type VARCHAR(32) NOT NULL)`);
    await pool.query(`CREATE TABLE channels (pk INT AUTO_INCREMENT PRIMARY KEY, id INT NOT NULL, name VARCHAR(64) NOT NULL, psk TEXT, sourceId VARCHAR(64))`);
    await pool.query(`CREATE TABLE meshcore_messages (
      id VARCHAR(128) PRIMARY KEY, fromPublicKey VARCHAR(128) NOT NULL, text TEXT NOT NULL, timestamp BIGINT NOT NULL,
      senderTimestamp BIGINT, reactionRawText TEXT, keySourceId VARCHAR(64), keyChannelIdx INT,
      keyFingerprint VARCHAR(32), messageType VARCHAR(16) DEFAULT 'text', sourceId VARCHAR(64))`);
    await pool.query(`CREATE TABLE user_notification_preferences (
      id INT AUTO_INCREMENT PRIMARY KEY, userId INT NOT NULL, sourceId VARCHAR(64) NOT NULL, enabledChannels TEXT, mutedChannels TEXT)`);
    await pool.query(`CREATE TABLE conversation_read_state (
      id INT AUTO_INCREMENT PRIMARY KEY, userId INT NOT NULL, sourceId VARCHAR(64) NOT NULL, conversationKind VARCHAR(32) NOT NULL,
      conversationKey VARCHAR(128) NOT NULL, lastReadAt BIGINT NOT NULL,
      UNIQUE KEY idx_crs (userId, sourceId, conversationKind, conversationKey))`);
    for (const s of scenario.sources) await pool.query('INSERT INTO sources (id, type) VALUES (?, ?)', [s.id, s.type]);
    for (const c of scenario.channels) await pool.query('INSERT INTO channels (id, name, psk, sourceId) VALUES (?,?,?,?)', [c.id, c.name, c.psk, c.sourceId]);
    for (const m of scenario.messages) {
      await pool.query(
        `INSERT INTO meshcore_messages (id, fromPublicKey, text, timestamp, senderTimestamp, reactionRawText, keyFingerprint, messageType, sourceId)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [m.id, m.fromPublicKey, m.text, m.timestamp, m.senderTimestamp, m.reactionRawText, m.keyFingerprint, m.messageType, m.sourceId],
      );
    }
    for (const p of scenario.prefs) {
      await pool.query('INSERT INTO user_notification_preferences (userId, sourceId, enabledChannels, mutedChannels) VALUES (?,?,?,?)',
        [p.userId, p.sourceId, p.enabledChannels, p.mutedChannels]);
    }
    for (const r of scenario.reads) {
      await pool.query(`INSERT INTO conversation_read_state (userId, sourceId, conversationKind, conversationKey, lastReadAt) VALUES (?,?,'meshcore_channel',?,?)`,
        [r.userId, r.sourceId, r.key, r.lastReadAt]);
    }
  });

  afterAll(async () => {
    await cleanup?.();
  });

  it('re-files, fans out prefs and read markers, and a re-run is a no-op', async () => {
    const q = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params))[0] as Array<Record<string, any>>;
    await runMigration228Mysql(pool);
    const snapshot = async () => JSON.stringify([
      await q('SELECT * FROM meshcore_messages ORDER BY id'),
      await q('SELECT * FROM user_notification_preferences ORDER BY id'),
      await q('SELECT * FROM conversation_read_state ORDER BY id'),
    ]);
    const first = await snapshot();
    checkMessages((await q('SELECT * FROM meshcore_messages')) as Msg[]);
    checkPrefs((await q('SELECT * FROM user_notification_preferences')) as never);
    checkReads((await q('SELECT * FROM conversation_read_state WHERE userId = 1 AND sourceId = ?', [MQTT])) as never);
    await runMigration228Mysql(pool);
    expect(await snapshot()).toBe(first);
  });
});
