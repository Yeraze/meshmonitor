import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { migration as migration121 } from './121_mqtt_packet_log.js';
import {
  migration,
  runMigration128Postgres,
  runMigration128Mysql,
} from './128_mqtt_oktomqtt_violations.js';

describe('Migration 128 — ok_to_mqtt violation detection', () => {
  describe('SQLite', () => {
    function setup(): Database.Database {
      const db = new Database(':memory:');
      migration121.up(db); // mqtt_packet_log must exist first
      return db;
    }

    it('adds the three mqtt_packet_log columns and creates mqtt_ok_to_mqtt_violations', () => {
      const db = setup();

      migration.up(db);

      const packetLogCols = (db.prepare(`PRAGMA table_info(mqtt_packet_log)`).all() as Array<{ name: string }>)
        .map((c) => c.name);
      expect(packetLogCols).toContain('bitfield');
      expect(packetLogCols).toContain('okToMqttViolation');
      expect(packetLogCols).toContain('topic');

      const table = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name = 'mqtt_ok_to_mqtt_violations'`
      ).get();
      expect(table).toBeTruthy();

      db.close();
    });

    it('is idempotent (second up() does not throw)', () => {
      const db = setup();

      migration.up(db);
      expect(() => migration.up(db)).not.toThrow();

      const packetLogCols = (db.prepare(`PRAGMA table_info(mqtt_packet_log)`).all() as Array<{ name: string }>)
        .map((c) => c.name);
      expect(packetLogCols.filter((c) => c === 'bitfield')).toHaveLength(1);
      expect(packetLogCols.filter((c) => c === 'okToMqttViolation')).toHaveLength(1);
      expect(packetLogCols.filter((c) => c === 'topic')).toHaveLength(1);

      db.close();
    });

    it('round-trips a full violation row insert/read', () => {
      const db = setup();
      migration.up(db);

      const now = Date.now();
      db.prepare(`
        INSERT INTO mqtt_ok_to_mqtt_violations (
          sourceId, packetId, fromNode, fromNodeId, gatewayId, gatewayNodeNum,
          channelId, portnum, portnumName, bitfield, topic, rxTime, timestamp, createdAt
        ) VALUES (
          @sourceId, @packetId, @fromNode, @fromNodeId, @gatewayId, @gatewayNodeNum,
          @channelId, @portnum, @portnumName, @bitfield, @topic, @rxTime, @timestamp, @createdAt
        )
      `).run({
        sourceId: 'source-a',
        packetId: 123456,
        fromNode: 0xaabbccdd,
        fromNodeId: '!aabbccdd',
        gatewayId: '!433e0f28',
        gatewayNodeNum: 0x433e0f28,
        channelId: 'LongFast',
        portnum: 1,
        portnumName: 'TEXT_MESSAGE_APP',
        bitfield: 0,
        topic: 'msh/US/2/e/LongFast/!433e0f28',
        rxTime: now - 500,
        timestamp: now,
        createdAt: now,
      });

      const row = db.prepare(`SELECT * FROM mqtt_ok_to_mqtt_violations WHERE sourceId = 'source-a'`).get() as {
        packetId: number;
        fromNodeId: string;
        gatewayId: string;
        bitfield: number;
        topic: string;
      };
      expect(row).toBeTruthy();
      expect(row.packetId).toBe(123456);
      expect(row.fromNodeId).toBe('!aabbccdd');
      expect(row.gatewayId).toBe('!433e0f28');
      expect(row.bitfield).toBe(0);
      expect(row.topic).toBe('msh/US/2/e/LongFast/!433e0f28');

      db.close();
    });

    it('enforces the dedupe unique index at the raw-SQL level', () => {
      const db = setup();
      migration.up(db);

      const now = Date.now();
      const insert = () =>
        db.prepare(`
          INSERT INTO mqtt_ok_to_mqtt_violations (
            sourceId, packetId, fromNode, gatewayNodeNum, timestamp, createdAt
          ) VALUES (@sourceId, @packetId, @fromNode, @gatewayNodeNum, @timestamp, @createdAt)
        `).run({
          sourceId: 'source-a',
          packetId: 42,
          fromNode: 10,
          gatewayNodeNum: 20,
          timestamp: now,
          createdAt: now,
        });

      insert();
      expect(() => insert()).toThrow(/UNIQUE constraint failed/);

      db.close();
    });
  });

  describe('PostgreSQL', () => {
    it('issues ADD COLUMN IF NOT EXISTS for the three mqtt_packet_log columns, then creates the table and indexes', async () => {
      const client = { query: vi.fn().mockResolvedValue({ rows: [] }) } as unknown as import('pg').PoolClient;

      await runMigration128Postgres(client);

      const calls = (client.query as unknown as { mock: { calls: unknown[][] } }).mock.calls;
      expect(calls.length).toBe(7);
      expect(calls[0][0]).toContain('ADD COLUMN IF NOT EXISTS "bitfield"');
      expect(calls[1][0]).toContain('ADD COLUMN IF NOT EXISTS "okToMqttViolation"');
      expect(calls[2][0]).toContain('ADD COLUMN IF NOT EXISTS "topic"');
      expect(calls[3][0]).toContain('CREATE TABLE IF NOT EXISTS mqtt_ok_to_mqtt_violations');
      expect(calls[4][0]).toContain('CREATE INDEX IF NOT EXISTS idx_mqtt_v_source_ts');
      expect(calls[5][0]).toContain('CREATE INDEX IF NOT EXISTS idx_mqtt_v_source_gw_ts');
      expect(calls[6][0]).toContain('CREATE UNIQUE INDEX IF NOT EXISTS idx_mqtt_v_dedupe');
    });

    it('resolves without throwing', async () => {
      const client = { query: vi.fn().mockResolvedValue({ rows: [] }) } as unknown as import('pg').PoolClient;
      await expect(runMigration128Postgres(client)).resolves.not.toThrow();
    });
  });

  describe('MySQL', () => {
    function makeConn(existRows: unknown[]) {
      return {
        query: vi.fn().mockResolvedValue([existRows, []]),
        release: vi.fn(),
      };
    }

    it('pre-checks information_schema.COLUMNS for each mqtt_packet_log column and information_schema.TABLES for the new table', async () => {
      const conn = makeConn([]);
      const pool = { getConnection: vi.fn().mockResolvedValue(conn) } as unknown as import('mysql2/promise').Pool;

      await runMigration128Mysql(pool);

      // 3 columns x (pre-check + ALTER) + 1 table x (pre-check + CREATE) = 8 queries
      expect(conn.query).toHaveBeenCalledTimes(8);
      expect(conn.query.mock.calls[0][0]).toContain('information_schema.COLUMNS');
      expect(conn.query.mock.calls[1][0]).toContain('ALTER TABLE mqtt_packet_log ADD COLUMN bitfield');
      expect(conn.query.mock.calls[6][0]).toContain('information_schema.TABLES');
      expect(conn.query.mock.calls[7][0]).toContain('CREATE TABLE mqtt_ok_to_mqtt_violations');
    });

    it('skips ALTER/CREATE when columns and table already exist', async () => {
      const conn = makeConn([{ COLUMN_NAME: 'bitfield' }]);
      // Every information_schema pre-check call returns a non-empty result so
      // every ALTER/CREATE is skipped.
      const pool = { getConnection: vi.fn().mockResolvedValue(conn) } as unknown as import('mysql2/promise').Pool;

      await runMigration128Mysql(pool);

      // Only the 3 column pre-checks + 1 table pre-check = 4 queries, no ALTER/CREATE.
      expect(conn.query).toHaveBeenCalledTimes(4);
    });
  });
});
