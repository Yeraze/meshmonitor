import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { migration, runMigration121Postgres, runMigration121Mysql } from './121_mqtt_packet_log.js';

describe('Migration 121 — mqtt_packet_log table', () => {
  describe('SQLite', () => {
    it('creates the table and is idempotent (second up() does not throw)', () => {
      const db = new Database(':memory:');

      migration.up(db);
      expect(() => migration.up(db)).not.toThrow();

      const table = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name = 'mqtt_packet_log'`
      ).get();
      expect(table).toBeTruthy();

      db.close();
    });

    it('round-trips a full row insert/read', () => {
      const db = new Database(':memory:');
      migration.up(db);

      const now = Date.now();
      db.prepare(`
        INSERT INTO mqtt_packet_log (
          sourceId, packetId, fromNode, fromNodeId, toNode, toNodeId,
          channel, channelId, gatewayId, gatewayNodeNum, timestamp, rxTime,
          rxSnr, rxRssi, hopLimit, hopStart, portnum, portnumName,
          encrypted, decryptedBy, ingestOutcome, payloadSize, payloadPreview, createdAt
        ) VALUES (
          @sourceId, @packetId, @fromNode, @fromNodeId, @toNode, @toNodeId,
          @channel, @channelId, @gatewayId, @gatewayNodeNum, @timestamp, @rxTime,
          @rxSnr, @rxRssi, @hopLimit, @hopStart, @portnum, @portnumName,
          @encrypted, @decryptedBy, @ingestOutcome, @payloadSize, @payloadPreview, @createdAt
        )
      `).run({
        sourceId: 'source-a',
        packetId: 123456,
        fromNode: 0xaabbccdd,
        fromNodeId: '!aabbccdd',
        toNode: 0xffffffff,
        toNodeId: '!ffffffff',
        channel: 8,
        channelId: 'LongFast',
        gatewayId: '!433e0f28',
        gatewayNodeNum: 0x433e0f28,
        timestamp: now,
        rxTime: now - 500,
        rxSnr: 5.25,
        rxRssi: -90,
        hopLimit: 3,
        hopStart: 3,
        portnum: 1,
        portnumName: 'TEXT_MESSAGE_APP',
        encrypted: 0,
        decryptedBy: null,
        ingestOutcome: 'ingested',
        payloadSize: 12,
        payloadPreview: 'hello mesh',
        createdAt: now,
      });

      const row = db.prepare(`SELECT * FROM mqtt_packet_log WHERE sourceId = 'source-a'`).get() as any;
      expect(row).toBeTruthy();
      expect(row.packetId).toBe(123456);
      expect(row.fromNodeId).toBe('!aabbccdd');
      expect(row.gatewayId).toBe('!433e0f28');
      expect(row.encrypted).toBe(0);
      expect(row.ingestOutcome).toBe('ingested');
      expect(row.payloadPreview).toBe('hello mesh');

      db.close();
    });
  });

  describe('PostgreSQL', () => {
    it('creates the table and the three indexes with IF NOT EXISTS', async () => {
      const client = { query: vi.fn().mockResolvedValue({ rows: [] }) } as any;

      await runMigration121Postgres(client);

      expect(client.query).toHaveBeenCalledTimes(4);
      expect(client.query.mock.calls[0][0]).toContain('CREATE TABLE IF NOT EXISTS mqtt_packet_log');
      expect(client.query.mock.calls[1][0]).toContain('CREATE INDEX IF NOT EXISTS idx_mqtt_pl_source_ts');
      expect(client.query.mock.calls[2][0]).toContain('CREATE INDEX IF NOT EXISTS idx_mqtt_pl_source_pkt_from');
      expect(client.query.mock.calls[3][0]).toContain('CREATE INDEX IF NOT EXISTS idx_mqtt_pl_source_gw');
    });
  });

  describe('MySQL', () => {
    function makeConn(existRows: any[]) {
      return {
        query: vi.fn().mockResolvedValue([existRows, []]),
        release: vi.fn(),
      };
    }

    it('creates the table when absent, then skips create when present', async () => {
      // First run: table absent.
      const absentConn = makeConn([]);
      const absentPool = { getConnection: vi.fn().mockResolvedValue(absentConn) };

      await runMigration121Mysql(absentPool);

      expect(absentConn.query).toHaveBeenCalledTimes(2);
      expect(absentConn.query.mock.calls[1][0]).toContain('CREATE TABLE mqtt_packet_log');
      expect(absentConn.release).toHaveBeenCalledTimes(1);

      // Second run: table present.
      const presentConn = makeConn([{ TABLE_NAME: 'mqtt_packet_log' }]);
      const presentPool = { getConnection: vi.fn().mockResolvedValue(presentConn) };

      await runMigration121Mysql(presentPool);

      expect(presentConn.query).toHaveBeenCalledTimes(1); // only the existence check
      expect(presentConn.release).toHaveBeenCalledTimes(1);
    });
  });
});
