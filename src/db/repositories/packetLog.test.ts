/**
 * Packet Log Repository Tests
 *
 * Tests the Drizzle JOIN queries for packet log methods.
 * Verifies that column references are correctly quoted across database backends.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { PacketLogRepository } from './packetLog.js';
import * as schema from '../schema/index.js';
import { createTestDb } from '../../server/test-helpers/testDb.js';

describe('PacketLogRepository - Packet Log Queries', () => {
  let db: Database.Database;
  let drizzleDb: BetterSQLite3Database<typeof schema>;
  let repo: PacketLogRepository;

  beforeEach(() => {
    const t = createTestDb();
    db = t.sqlite;
    drizzleDb = t.db;
    repo = new PacketLogRepository(drizzleDb as any, 'sqlite');

    // Insert test nodes scoped to 'default' source
    const seedNow = Date.now();
    db.exec(`INSERT INTO nodes (nodeNum, sourceId, nodeId, longName, shortName, hopsAway, createdAt, updatedAt) VALUES (100, 'default', '!00000064', 'Node Alpha', 'ALPH', 0, ${seedNow}, ${seedNow})`);
    db.exec(`INSERT INTO nodes (nodeNum, sourceId, nodeId, longName, shortName, hopsAway, createdAt, updatedAt) VALUES (200, 'default', '!000000c8', 'Node Beta', 'BETA', 1, ${seedNow}, ${seedNow})`);
    db.exec(`INSERT INTO nodes (nodeNum, sourceId, nodeId, longName, shortName, hopsAway, createdAt, updatedAt) VALUES (300, 'default', '!0000012c', 'Node Gamma', 'GAMM', 0, ${seedNow}, ${seedNow})`);

    // Insert test packets with matching sourceId so the JOIN resolves longName
    const now = Date.now();
    db.exec(`INSERT INTO packet_log (packet_id, timestamp, from_node, from_node_id, to_node, to_node_id, portnum, portnum_name, direction, created_at, relay_node, sourceId, encrypted) VALUES (1, ${now}, 100, '!00000064', 200, '!000000c8', 1, 'TEXT_MESSAGE_APP', 'rx', ${now}, 100, 'default', 0)`);
    db.exec(`INSERT INTO packet_log (packet_id, timestamp, from_node, from_node_id, to_node, to_node_id, portnum, portnum_name, direction, created_at, relay_node, sourceId, encrypted) VALUES (2, ${now}, 200, '!000000c8', 100, '!00000064', 1, 'TEXT_MESSAGE_APP', 'rx', ${now + 1}, 200, 'default', 0)`);
    db.exec(`INSERT INTO packet_log (packet_id, timestamp, from_node, from_node_id, to_node, to_node_id, portnum, portnum_name, direction, created_at, sourceId, encrypted) VALUES (3, ${now - 60000}, 100, '!00000064', 4294967295, '!ffffffff', 3, 'POSITION_APP', 'rx', ${now - 60000}, 'default', 0)`);
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
      db.exec(`INSERT INTO packet_log (packet_id, timestamp, from_node, from_node_id, to_node, portnum, direction, created_at, sourceId, encrypted) VALUES (99, ${now}, 999, '!000003e7', NULL, 1, 'rx', ${now}, 'default', 0)`);

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

  describe('getPacketLogs keyset cursor (untilTs/untilId)', () => {
    // Insert a block of packets that all share the SAME millisecond timestamp,
    // straddling typical page boundaries. This is the case a bare `timestamp <`
    // cursor mishandles (the unified packet monitor relies on the composite cursor).
    const TIE_TS = 1_700_000_000_000;
    beforeEach(() => {
      // Clear seed rows so the tie-timestamp set is the only data.
      db.exec(`DELETE FROM packet_log`);
      for (let i = 0; i < 10; i++) {
        db.exec(`INSERT INTO packet_log (packet_id, timestamp, from_node, portnum, direction, created_at, sourceId, encrypted) VALUES (${i}, ${TIE_TS}, 100, 1, 'rx', ${TIE_TS}, 'default', 0)`);
      }
      // Plus a few older rows at a distinct timestamp.
      for (let i = 0; i < 3; i++) {
        db.exec(`INSERT INTO packet_log (packet_id, timestamp, from_node, portnum, direction, created_at, sourceId, encrypted) VALUES (${100 + i}, ${TIE_TS - 1000}, 100, 1, 'rx', ${TIE_TS - 1000}, 'default', 0)`);
      }
    });

    it('pages through tied timestamps without skipping or duplicating rows', async () => {
      const pageSize = 4;
      const seen: number[] = [];
      let cursor: { ts: number; id: number } | undefined;

      // Page until exhausted.
      for (let guard = 0; guard < 20; guard++) {
        const page = await repo.getPacketLogs({
          limit: pageSize,
          untilTs: cursor?.ts,
          untilId: cursor?.id,
        });
        if (page.length === 0) break;
        for (const row of page) seen.push(row.id!);
        const last = page[page.length - 1];
        cursor = { ts: last.timestamp, id: last.id! };
        if (page.length < pageSize) break;
      }

      // 13 rows total, each returned exactly once.
      expect(seen.length).toBe(13);
      expect(new Set(seen).size).toBe(13);
    });

    it('honors the composite predicate (timestamp = untilTs AND id < untilId)', async () => {
      const all = await repo.getPacketLogs({});
      // Pick a mid-point row inside the tied-timestamp block.
      const pivot = all.find(p => p.timestamp === TIE_TS && all.filter(x => x.timestamp === TIE_TS && x.id! > p.id!).length === 3)!;
      const after = await repo.getPacketLogs({ untilTs: pivot.timestamp, untilId: pivot.id! });
      // No returned row may be >= the pivot in (ts, id) order.
      for (const row of after) {
        const isOlder = row.timestamp < pivot.timestamp || (row.timestamp === pivot.timestamp && row.id! < pivot.id!);
        expect(isOlder).toBe(true);
      }
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

      const deleted = await repo.clearPacketLogs();
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

  // PR-B security fix — retroactive-decrypt per-source ACL pre-flight.
  // Distinct sourceIds across encrypted, not-yet-server-decrypted packets are
  // the set the caller must hold messages:read on before retroactive decrypt
  // can write any decrypted payloads back to packet_log.
  describe('getDistinctEncryptedPacketSourceIds', () => {
    it('returns empty when no encrypted packets exist', async () => {
      // Seeded fixture has only un-encrypted packets — ensure the helper returns []
      const result = await repo.getDistinctEncryptedPacketSourceIds();
      expect(result).toEqual([]);
    });

    it('returns distinct sourceIds for encrypted, undecoded rows', async () => {
      const now = Date.now();
      // Two sources with encrypted+undecoded packets; one source with multiple
      // rows (must dedupe); one source that is already server-decrypted (must
      // be excluded); one un-encrypted packet (must be excluded).
      db.exec(`INSERT INTO packet_log (packet_id, timestamp, from_node, encrypted, portnum, direction, created_at, sourceId, decrypted_by) VALUES (100, ${now}, 100, 1, 1, 'rx', ${now}, 'src-a', NULL)`);
      db.exec(`INSERT INTO packet_log (packet_id, timestamp, from_node, encrypted, portnum, direction, created_at, sourceId, decrypted_by) VALUES (101, ${now}, 100, 1, 1, 'rx', ${now}, 'src-a', NULL)`);
      db.exec(`INSERT INTO packet_log (packet_id, timestamp, from_node, encrypted, portnum, direction, created_at, sourceId, decrypted_by) VALUES (102, ${now}, 100, 1, 1, 'rx', ${now}, 'src-b', NULL)`);
      // already decrypted — must be excluded
      db.exec(`INSERT INTO packet_log (packet_id, timestamp, from_node, encrypted, portnum, direction, created_at, sourceId, decrypted_by) VALUES (103, ${now}, 100, 1, 1, 'rx', ${now}, 'src-c', 'server')`);
      // not encrypted — must be excluded
      db.exec(`INSERT INTO packet_log (packet_id, timestamp, from_node, encrypted, portnum, direction, created_at, sourceId, decrypted_by) VALUES (104, ${now}, 100, 0, 1, 'rx', ${now}, 'src-d', NULL)`);

      const result = await repo.getDistinctEncryptedPacketSourceIds();
      const ids = result.map((s) => s ?? '__NULL__').sort();
      expect(ids).toEqual(['src-a', 'src-b']);
    });

    it('includes null sourceId (legacy pre-multi-source bucket)', async () => {
      const now = Date.now();
      db.exec(`INSERT INTO packet_log (packet_id, timestamp, from_node, encrypted, portnum, direction, created_at, sourceId, decrypted_by) VALUES (200, ${now}, 100, 1, 1, 'rx', ${now}, NULL, NULL)`);
      db.exec(`INSERT INTO packet_log (packet_id, timestamp, from_node, encrypted, portnum, direction, created_at, sourceId, decrypted_by) VALUES (201, ${now}, 100, 1, 1, 'rx', ${now}, 'src-a', NULL)`);

      const result = await repo.getDistinctEncryptedPacketSourceIds();
      expect(result).toContain(null);
      expect(result).toContain('src-a');
      expect(result.length).toBe(2);
    });
  });
});

/**
 * Regression tests for #2794 — getPacketCountsByNode must not multiply COUNT(*)
 * by the number of sources when the same nodeNum appears in multiple rows of
 * the nodes table (per-source composite PK since migration 029).
 */
describe('PacketLogRepository - getPacketCountsByNode multi-source regression (#2794)', () => {
  let db: Database.Database;
  let drizzleDb: BetterSQLite3Database<typeof schema>;
  let repo: PacketLogRepository;

  beforeEach(() => {
    const t = createTestDb();
    db = t.sqlite;
    drizzleDb = t.db;
    repo = new PacketLogRepository(drizzleDb as any, 'sqlite');

    // Same node heard on two sources — produces two rows with the same nodeNum.
    const seedNow = Date.now();
    db.exec(`INSERT INTO nodes (nodeNum, sourceId, nodeId, longName, shortName, createdAt, updatedAt) VALUES (100, 'srcA', '!00000064', 'Node Alpha (A)', 'ALPH', ${seedNow}, ${seedNow})`);
    db.exec(`INSERT INTO nodes (nodeNum, sourceId, nodeId, longName, shortName, createdAt, updatedAt) VALUES (100, 'srcB', '!00000064', 'Node Alpha (B)', 'ALPH', ${seedNow}, ${seedNow})`);
    db.exec(`INSERT INTO nodes (nodeNum, sourceId, nodeId, longName, shortName, createdAt, updatedAt) VALUES (200, 'srcA', '!000000c8', 'Node Beta', 'BETA', ${seedNow}, ${seedNow})`);

    const now = Date.now();
    // Three packets from nodeNum 100 on srcA
    for (let i = 1; i <= 3; i++) {
      db.exec(`INSERT INTO packet_log (packet_id, timestamp, from_node, from_node_id, portnum, direction, created_at, sourceId, encrypted) VALUES (${i}, ${now - i * 1000}, 100, '!00000064', 1, 'rx', ${now}, 'srcA', 0)`);
    }
    // One packet from nodeNum 200 on srcA
    db.exec(`INSERT INTO packet_log (packet_id, timestamp, from_node, from_node_id, portnum, direction, created_at, sourceId, encrypted) VALUES (10, ${now}, 200, '!000000c8', 1, 'rx', ${now}, 'srcA', 0)`);
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
describe('PacketLogRepository - getPacketLogs / getPacketLogById multi-source dedup (#3051)', () => {
  let db: Database.Database;
  let drizzleDb: BetterSQLite3Database<typeof schema>;
  let repo: PacketLogRepository;

  beforeEach(() => {
    const t = createTestDb();
    db = t.sqlite;
    drizzleDb = t.db;
    repo = new PacketLogRepository(drizzleDb as any, 'sqlite');

    // nodeNum 100 exists in both srcA and srcB (mirrors production multi-source)
    const seedNow = Date.now();
    db.exec(`INSERT INTO nodes (nodeNum, sourceId, nodeId, longName, shortName, createdAt, updatedAt) VALUES (100, 'srcA', '!00000064', 'Node Alpha (A)', 'ALPH', ${seedNow}, ${seedNow})`);
    db.exec(`INSERT INTO nodes (nodeNum, sourceId, nodeId, longName, shortName, createdAt, updatedAt) VALUES (100, 'srcB', '!00000064', 'Node Alpha (B)', 'ALPH', ${seedNow}, ${seedNow})`);
    db.exec(`INSERT INTO nodes (nodeNum, sourceId, nodeId, longName, shortName, createdAt, updatedAt) VALUES (200, 'srcA', '!000000c8', 'Node Beta', 'BETA', ${seedNow}, ${seedNow})`);

    const now = Date.now();
    // Packet from srcA: from_node=100, to_node=200
    db.exec(`INSERT INTO packet_log (packet_id, timestamp, from_node, from_node_id, to_node, portnum, portnum_name, direction, created_at, sourceId, encrypted) VALUES (1, ${now}, 100, '!00000064', 200, 1, 'TEXT_MESSAGE_APP', 'rx', ${now}, 'srcA', 0)`);
    // Packet from srcB: from_node=100 (same nodeNum, different source)
    db.exec(`INSERT INTO packet_log (packet_id, timestamp, from_node, from_node_id, to_node, portnum, portnum_name, direction, created_at, sourceId, encrypted) VALUES (2, ${now - 1000}, 100, '!00000064', NULL, 1, 'TEXT_MESSAGE_APP', 'rx', ${now - 1000}, 'srcB', 0)`);
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
