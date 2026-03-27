/**
 * Misc Repository - Packet Log Query Tests
 *
 * Tests the refactored Drizzle JOIN queries for packet log methods.
 * Verifies that column references are correctly quoted across database backends.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle, BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { MiscRepository } from './misc.js';
import * as schema from '../schema/index.js';

describe('MiscRepository - Packet Log Queries', () => {
  let db: Database.Database;
  let drizzleDb: BetterSQLite3Database<typeof schema>;
  let repo: MiscRepository;

  beforeEach(() => {
    db = new Database(':memory:');

    // Create tables needed for JOIN queries
    db.exec(`
      CREATE TABLE IF NOT EXISTS nodes (
        nodeNum INTEGER PRIMARY KEY,
        nodeId TEXT,
        longName TEXT,
        shortName TEXT,
        lastHeard INTEGER,
        hopsAway INTEGER
      )
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS packet_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        packet_id INTEGER,
        timestamp INTEGER NOT NULL,
        from_node INTEGER NOT NULL,
        from_node_id TEXT,
        to_node INTEGER,
        to_node_id TEXT,
        channel INTEGER,
        portnum INTEGER NOT NULL,
        portnum_name TEXT,
        encrypted INTEGER DEFAULT 0,
        snr REAL,
        rssi INTEGER,
        hop_limit INTEGER,
        hop_start INTEGER,
        relay_node INTEGER,
        payload_size INTEGER,
        want_ack INTEGER DEFAULT 0,
        priority INTEGER,
        payload_preview TEXT,
        metadata TEXT,
        direction TEXT DEFAULT 'rx',
        created_at INTEGER,
        transport_mechanism TEXT,
        decrypted_by TEXT,
        decrypted_channel_id INTEGER
      )
    `);

    // Create settings table (needed by MiscRepository)
    db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT
      )
    `);

    drizzleDb = drizzle(db, { schema });
    repo = new MiscRepository(drizzleDb as any, 'sqlite');

    // Insert test nodes
    db.exec(`INSERT INTO nodes (nodeNum, nodeId, longName, shortName, hopsAway) VALUES (100, '!00000064', 'Node Alpha', 'ALPH', 0)`);
    db.exec(`INSERT INTO nodes (nodeNum, nodeId, longName, shortName, hopsAway) VALUES (200, '!000000c8', 'Node Beta', 'BETA', 1)`);
    db.exec(`INSERT INTO nodes (nodeNum, nodeId, longName, shortName, hopsAway) VALUES (300, '!0000012c', 'Node Gamma', 'GAMM', 0)`);

    // Insert test packets (timestamps in milliseconds)
    const now = Date.now();
    db.exec(`INSERT INTO packet_log (packet_id, timestamp, from_node, from_node_id, to_node, to_node_id, portnum, portnum_name, direction, created_at, relay_node) VALUES (1, ${now}, 100, '!00000064', 200, '!000000c8', 1, 'TEXT_MESSAGE_APP', 'rx', ${now}, 100)`);
    db.exec(`INSERT INTO packet_log (packet_id, timestamp, from_node, from_node_id, to_node, to_node_id, portnum, portnum_name, direction, created_at, relay_node) VALUES (2, ${now}, 200, '!000000c8', 100, '!00000064', 1, 'TEXT_MESSAGE_APP', 'rx', ${now + 1}, 200)`);
    db.exec(`INSERT INTO packet_log (packet_id, timestamp, from_node, from_node_id, to_node, to_node_id, portnum, portnum_name, direction, created_at) VALUES (3, ${now - 60000}, 100, '!00000064', 4294967295, '!ffffffff', 3, 'POSITION_APP', 'rx', ${now - 60000})`);
  });

  afterEach(() => {
    db.close();
  });

  describe('getPacketLogs', () => {
    it('returns packets with joined node names', async () => {
      const packets = await repo.getPacketLogs({});
      expect(packets.length).toBe(3);

      // Check that longName was joined from nodes table
      const pkt1 = packets.find(p => p.packet_id === 1);
      expect(pkt1).toBeDefined();
      expect(pkt1!.from_node_longName).toBe('Node Alpha');
      expect(pkt1!.to_node_longName).toBe('Node Beta');
    });

    it('returns null longName for unknown nodes', async () => {
      // Insert packet from unknown node
      const now = Date.now();
      db.exec(`INSERT INTO packet_log (packet_id, timestamp, from_node, from_node_id, to_node, portnum, direction, created_at) VALUES (99, ${now}, 999, '!000003e7', NULL, 1, 'rx', ${now})`);

      const packets = await repo.getPacketLogs({});
      const unknownPkt = packets.find(p => p.packet_id === 99);
      expect(unknownPkt).toBeDefined();
      expect(unknownPkt!.from_node_longName).toBeNull();
    });

    it('respects limit and offset', async () => {
      const packets = await repo.getPacketLogs({ limit: 2, offset: 0 });
      expect(packets.length).toBe(2);
    });

    it('orders by timestamp DESC then created_at DESC', async () => {
      const packets = await repo.getPacketLogs({});
      // First two packets have same timestamp, ordered by created_at DESC
      expect(packets[0].packet_id).toBe(2); // higher created_at
      expect(packets[1].packet_id).toBe(1);
      expect(packets[2].packet_id).toBe(3); // older timestamp
    });
  });

  describe('getPacketLogById', () => {
    it('returns a single packet with joined node names', async () => {
      const packets = await repo.getPacketLogs({});
      const firstId = packets[0].id;

      const pkt = await repo.getPacketLogById(firstId!);
      expect(pkt).not.toBeNull();
      expect(pkt!.from_node_longName).toBeDefined();
    });

    it('returns null for non-existent id', async () => {
      const pkt = await repo.getPacketLogById(99999);
      expect(pkt).toBeNull();
    });
  });

  describe('getPacketCountsByNode', () => {
    it('returns counts with joined node names', async () => {
      const counts = await repo.getPacketCountsByNode({});
      expect(counts.length).toBeGreaterThan(0);

      const alpha = counts.find(c => c.from_node === 100);
      expect(alpha).toBeDefined();
      expect(alpha!.from_node_longName).toBe('Node Alpha');
      expect(alpha!.count).toBe(2); // packets 1 and 3
    });

    it('respects limit', async () => {
      const counts = await repo.getPacketCountsByNode({ limit: 1 });
      expect(counts.length).toBe(1);
    });
  });

  describe('getDistinctRelayNodes', () => {
    it('returns relay nodes with matched node names', async () => {
      const relays = await repo.getDistinctRelayNodes();
      expect(relays.length).toBeGreaterThan(0);

      // relay_node 100 & 0xFF = 100, matches node 100 (Node Alpha)
      const relay100 = relays.find(r => r.relay_node === 100);
      expect(relay100).toBeDefined();
      expect(relay100!.matching_nodes.length).toBeGreaterThan(0);
      expect(relay100!.matching_nodes[0].longName).toBe('Node Alpha');
    });
  });
});
