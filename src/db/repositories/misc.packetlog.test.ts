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

    // Mirror production schema: nodes uses composite PK (nodeNum, sourceId)
    // since migration 029; packet_log carries sourceId since migration 020.
    db.exec(`
      CREATE TABLE IF NOT EXISTS nodes (
        nodeNum INTEGER NOT NULL,
        sourceId TEXT NOT NULL,
        nodeId TEXT,
        longName TEXT,
        shortName TEXT,
        lastHeard INTEGER,
        hopsAway INTEGER,
        PRIMARY KEY (nodeNum, sourceId)
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
        decrypted_channel_id INTEGER,
        sourceId TEXT
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

    // Insert test nodes scoped to 'default' source
    db.exec(`INSERT INTO nodes (nodeNum, sourceId, nodeId, longName, shortName, hopsAway) VALUES (100, 'default', '!00000064', 'Node Alpha', 'ALPH', 0)`);
    db.exec(`INSERT INTO nodes (nodeNum, sourceId, nodeId, longName, shortName, hopsAway) VALUES (200, 'default', '!000000c8', 'Node Beta', 'BETA', 1)`);
    db.exec(`INSERT INTO nodes (nodeNum, sourceId, nodeId, longName, shortName, hopsAway) VALUES (300, 'default', '!0000012c', 'Node Gamma', 'GAMM', 0)`);

    // Insert test packets with matching sourceId so the JOIN resolves longName
    const now = Date.now();
    db.exec(`INSERT INTO packet_log (packet_id, timestamp, from_node, from_node_id, to_node, to_node_id, portnum, portnum_name, direction, created_at, relay_node, sourceId) VALUES (1, ${now}, 100, '!00000064', 200, '!000000c8', 1, 'TEXT_MESSAGE_APP', 'rx', ${now}, 100, 'default')`);
    db.exec(`INSERT INTO packet_log (packet_id, timestamp, from_node, from_node_id, to_node, to_node_id, portnum, portnum_name, direction, created_at, relay_node, sourceId) VALUES (2, ${now}, 200, '!000000c8', 100, '!00000064', 1, 'TEXT_MESSAGE_APP', 'rx', ${now + 1}, 200, 'default')`);
    db.exec(`INSERT INTO packet_log (packet_id, timestamp, from_node, from_node_id, to_node, to_node_id, portnum, portnum_name, direction, created_at, sourceId) VALUES (3, ${now - 60000}, 100, '!00000064', 4294967295, '!ffffffff', 3, 'POSITION_APP', 'rx', ${now - 60000}, 'default')`);
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
      // Insert packet from a node not present in the nodes table for this source
      const now = Date.now();
      db.exec(`INSERT INTO packet_log (packet_id, timestamp, from_node, from_node_id, to_node, portnum, direction, created_at, sourceId) VALUES (99, ${now}, 999, '!000003e7', NULL, 1, 'rx', ${now}, 'default')`);

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

  // Regression: #2637 — purgeAllNodes must also clear packet_log so the
  // Packet Monitor doesn't show ghost entries from purged nodes. These
  // tests pin the building-block deletion methods that purgeAllNodes calls.
  describe('clearPacketLogs (#2637)', () => {
    it('removes every packet_log row (async)', async () => {
      const before = await repo.getPacketLogCount();
      expect(before).toBe(3);

      const deleted = await repo.clearPacketLogs();
      expect(deleted).toBe(3);

      const after = await repo.getPacketLogCount();
      expect(after).toBe(0);
    });

    it('removes every packet_log row (sync, SQLite)', async () => {
      const before = await repo.getPacketLogCount();
      expect(before).toBe(3);

      const deleted = repo.clearPacketLogsSync();
      expect(deleted).toBe(3);

      const after = await repo.getPacketLogCount();
      expect(after).toBe(0);
    });
  });

  // Regression: discussion #2846 — MariaDB rejects
  // `DELETE ... WHERE id IN (SELECT ... LIMIT ?)` with ER_NOT_SUPPORTED_YET.
  // The implementation must be a portable two-step delete (select ids, then
  // delete by id list), not a DELETE-with-LIMIT-subquery.
  describe('enforcePacketLogMaxCount (#2846)', () => {
    it('deletes the oldest rows down to maxCount', async () => {
      const before = await repo.getPacketLogCount();
      expect(before).toBe(3);

      // Seed packet timestamps: pkt 3 is oldest (now - 60000), pkt 1 & 2 are newer.
      await repo.enforcePacketLogMaxCount(2);

      const after = await repo.getPacketLogCount();
      expect(after).toBe(2);

      // The oldest packet (packet_id 3) must be the one removed.
      const remaining = await repo.getPacketLogs({});
      const remainingIds = remaining.map((p) => p.packet_id).sort();
      expect(remainingIds).toEqual([1, 2]);
    });

    it('is a no-op when row count is at or below maxCount', async () => {
      await repo.enforcePacketLogMaxCount(3);
      expect(await repo.getPacketLogCount()).toBe(3);

      await repo.enforcePacketLogMaxCount(10);
      expect(await repo.getPacketLogCount()).toBe(3);
    });

    it('handles a maxCount of 0 by deleting every row', async () => {
      await repo.enforcePacketLogMaxCount(0);
      expect(await repo.getPacketLogCount()).toBe(0);
    });
  });
});

/**
 * Regression tests for #2794 — getPacketCountsByNode must not multiply COUNT(*)
 * by the number of sources when the same nodeNum appears in multiple rows of
 * the nodes table (per-source composite PK since migration 029).
 */
describe('MiscRepository - getPacketCountsByNode multi-source regression (#2794)', () => {
  let db: Database.Database;
  let drizzleDb: BetterSQLite3Database<typeof schema>;
  let repo: MiscRepository;

  beforeEach(() => {
    db = new Database(':memory:');

    // Mirror production composite PK (nodeNum, sourceId) so the same nodeNum
    // can exist once per source.
    db.exec(`
      CREATE TABLE IF NOT EXISTS nodes (
        nodeNum INTEGER NOT NULL,
        sourceId TEXT NOT NULL,
        nodeId TEXT,
        longName TEXT,
        shortName TEXT,
        lastHeard INTEGER,
        hopsAway INTEGER,
        PRIMARY KEY (nodeNum, sourceId)
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
        decrypted_channel_id INTEGER,
        sourceId TEXT
      )
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT
      )
    `);

    drizzleDb = drizzle(db, { schema });
    repo = new MiscRepository(drizzleDb as any, 'sqlite');

    // Same node heard on two sources — produces two rows with the same nodeNum.
    db.exec(`INSERT INTO nodes (nodeNum, sourceId, nodeId, longName, shortName) VALUES (100, 'srcA', '!00000064', 'Node Alpha (A)', 'ALPH')`);
    db.exec(`INSERT INTO nodes (nodeNum, sourceId, nodeId, longName, shortName) VALUES (100, 'srcB', '!00000064', 'Node Alpha (B)', 'ALPH')`);
    db.exec(`INSERT INTO nodes (nodeNum, sourceId, nodeId, longName, shortName) VALUES (200, 'srcA', '!000000c8', 'Node Beta', 'BETA')`);

    const now = Date.now();
    // Three packets from nodeNum 100 on srcA
    for (let i = 1; i <= 3; i++) {
      db.exec(`INSERT INTO packet_log (packet_id, timestamp, from_node, from_node_id, portnum, direction, created_at, sourceId) VALUES (${i}, ${now - i * 1000}, 100, '!00000064', 1, 'rx', ${now}, 'srcA')`);
    }
    // One packet from nodeNum 200 on srcA
    db.exec(`INSERT INTO packet_log (packet_id, timestamp, from_node, from_node_id, portnum, direction, created_at, sourceId) VALUES (10, ${now}, 200, '!000000c8', 1, 'rx', ${now}, 'srcA')`);
  });

  afterEach(() => {
    db.close();
  });

  it('does not double-count packets when a nodeNum exists in multiple sources (unscoped)', async () => {
    const counts = await repo.getPacketCountsByNode({});
    const alpha = counts.find(c => c.from_node === 100);
    expect(alpha).toBeDefined();
    // 3 packets — NOT 6 (which would be 3 × 2 sources via the old JOIN).
    expect(alpha!.count).toBe(3);
  });

  it('scopes to a single source when sourceId is provided', async () => {
    const counts = await repo.getPacketCountsByNode({ sourceId: 'srcA' });
    const alpha = counts.find(c => c.from_node === 100);
    expect(alpha).toBeDefined();
    expect(alpha!.count).toBe(3);
    // When scoped, longName comes from the matching source
    expect(alpha!.from_node_longName).toBe('Node Alpha (A)');
  });

  it('returns zero rows for a source that has no packets', async () => {
    const counts = await repo.getPacketCountsByNode({ sourceId: 'srcB' });
    expect(counts.length).toBe(0);
  });

  it('percentages against sum of counts stay <= 100%', async () => {
    const counts = await repo.getPacketCountsByNode({});
    const sum = counts.reduce((s, c) => s + c.count, 0);
    expect(sum).toBe(4); // 3 from alpha + 1 from beta
    for (const c of counts) {
      expect(c.count / sum).toBeLessThanOrEqual(1);
    }
  });
});

/**
 * Regression tests for #3051 — getPacketLogs and getPacketLogById must not
 * return duplicate rows when the same nodeNum exists in multiple sources
 * (composite PK since migration 029).
 */
describe('MiscRepository - getPacketLogs / getPacketLogById multi-source dedup (#3051)', () => {
  let db: Database.Database;
  let drizzleDb: BetterSQLite3Database<typeof schema>;
  let repo: MiscRepository;

  beforeEach(() => {
    db = new Database(':memory:');

    db.exec(`
      CREATE TABLE IF NOT EXISTS nodes (
        nodeNum INTEGER NOT NULL,
        sourceId TEXT NOT NULL,
        nodeId TEXT,
        longName TEXT,
        shortName TEXT,
        lastHeard INTEGER,
        hopsAway INTEGER,
        PRIMARY KEY (nodeNum, sourceId)
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
        decrypted_channel_id INTEGER,
        sourceId TEXT
      )
    `);

    db.exec(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`);

    drizzleDb = drizzle(db, { schema });
    repo = new MiscRepository(drizzleDb as any, 'sqlite');

    // nodeNum 100 exists in both srcA and srcB (mirrors production multi-source)
    db.exec(`INSERT INTO nodes (nodeNum, sourceId, longName, shortName) VALUES (100, 'srcA', 'Node Alpha (A)', 'ALPH')`);
    db.exec(`INSERT INTO nodes (nodeNum, sourceId, longName, shortName) VALUES (100, 'srcB', 'Node Alpha (B)', 'ALPH')`);
    db.exec(`INSERT INTO nodes (nodeNum, sourceId, longName, shortName) VALUES (200, 'srcA', 'Node Beta', 'BETA')`);

    const now = Date.now();
    // Packet from srcA: from_node=100, to_node=200
    db.exec(`INSERT INTO packet_log (packet_id, timestamp, from_node, from_node_id, to_node, portnum, portnum_name, direction, created_at, sourceId) VALUES (1, ${now}, 100, '!00000064', 200, 1, 'TEXT_MESSAGE_APP', 'rx', ${now}, 'srcA')`);
    // Packet from srcB: from_node=100 (same nodeNum, different source)
    db.exec(`INSERT INTO packet_log (packet_id, timestamp, from_node, from_node_id, to_node, portnum, portnum_name, direction, created_at, sourceId) VALUES (2, ${now - 1000}, 100, '!00000064', NULL, 1, 'TEXT_MESSAGE_APP', 'rx', ${now - 1000}, 'srcB')`);
  });

  afterEach(() => {
    db.close();
  });

  it('getPacketLogs returns exactly one row per packet_log entry (no cross-source JOIN duplication)', async () => {
    const packets = await repo.getPacketLogs({});
    // There are 2 packets; before the fix the JOIN produced 4 rows (2 packets × 2 node sources).
    expect(packets.length).toBe(2);
    // Each packet_id appears exactly once
    const ids = packets.map(p => p.packet_id);
    expect(ids).toContain(1);
    expect(ids).toContain(2);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('getPacketLogs resolves longName from the correct source', async () => {
    const packets = await repo.getPacketLogs({});
    const pktA = packets.find(p => p.packet_id === 1);
    const pktB = packets.find(p => p.packet_id === 2);
    expect(pktA!.from_node_longName).toBe('Node Alpha (A)');
    expect(pktA!.to_node_longName).toBe('Node Beta');
    expect(pktB!.from_node_longName).toBe('Node Alpha (B)');
  });

  it('getPacketLogById returns exactly one row even when nodeNum exists in multiple sources', async () => {
    const all = await repo.getPacketLogs({});
    const targetId = all.find(p => p.packet_id === 1)!.id!;

    const pkt = await repo.getPacketLogById(targetId);
    expect(pkt).not.toBeNull();
    // longName must come from the packet's own source (srcA), not duplicated
    expect(pkt!.from_node_longName).toBe('Node Alpha (A)');
  });
});
