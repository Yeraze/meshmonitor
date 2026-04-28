/**
 * Telemetry Repository - Expanded Tests
 *
 * Covers the many methods not tested in telemetry.test.ts:
 *   insertTelemetry, getTelemetryCount, getTelemetryCountByNode,
 *   getTelemetryByNode, getPositionTelemetryByNode, getTelemetryByType,
 *   getLatestTelemetryForType, getLatestTelemetryByNode, getNodeTelemetryTypes,
 *   getLatestTelemetryValueForAllNodes (SQLite path),
 *   deleteTelemetryByNodeAndType, purgeNodeTelemetry, purgePositionHistory,
 *   cleanupOldTelemetry, deleteOldTelemetry, deleteTelemetryByNode,
 *   deleteAllTelemetry, getRecentEstimatedPositions
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle, BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { TelemetryRepository } from './telemetry.js';
import * as schema from '../schema/index.js';

// ---------------------------------------------------------------------------
// Shared constants & helpers
// ---------------------------------------------------------------------------

const NODE1 = '!aabbccdd';
const NODE1_NUM = 0xaabbccdd;
const NODE2 = '!11223344';
const NODE2_NUM = 0x11223344;

const NOW = Date.now();
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe('TelemetryRepository (expanded)', () => {
  let db: Database.Database;
  let drizzleDb: BetterSQLite3Database<typeof schema>;
  let repo: TelemetryRepository;

  beforeEach(() => {
    db = new Database(':memory:');

    db.exec(`
      CREATE TABLE IF NOT EXISTS telemetry (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nodeId TEXT NOT NULL,
        nodeNum INTEGER NOT NULL,
        telemetryType TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        value REAL NOT NULL,
        unit TEXT,
        createdAt INTEGER NOT NULL,
        packetTimestamp INTEGER,
        packetId INTEGER,
        channel INTEGER,
        precisionBits INTEGER,
        gpsAccuracy INTEGER,
        sourceId TEXT
      )
    `);

    // Mirror the migration 032 partial unique index so repo-level dedupe
    // behavior matches production. NULL packetId rows bypass the constraint.
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS telemetry_source_packet_type_uniq
        ON telemetry(sourceId, nodeNum, packetId, telemetryType)
        WHERE packetId IS NOT NULL
    `);

    drizzleDb = drizzle(db, { schema });
    repo = new TelemetryRepository(drizzleDb, 'sqlite');
  });

  afterEach(() => {
    db.close();
  });

  const insertTelemetry = async (
    nodeId: string,
    nodeNum: number,
    telemetryType: string,
    timestamp: number,
    value: number = 50
  ) => {
    await repo.insertTelemetry({
      nodeId,
      nodeNum,
      telemetryType,
      timestamp,
      value,
      unit: '%',
      createdAt: NOW,
    });
  };

  // -------------------------------------------------------------------------
  // insertTelemetry
  // -------------------------------------------------------------------------
  describe('insertTelemetry', () => {
    it('inserts a record that can be retrieved afterwards', async () => {
      await insertTelemetry(NODE1, NODE1_NUM, 'battery', NOW - HOUR, 77);

      const results = await repo.getTelemetryByNode(NODE1, 10);
      expect(results).toHaveLength(1);
      expect(results[0].nodeId).toBe(NODE1);
      expect(results[0].nodeNum).toBe(NODE1_NUM);
      expect(results[0].telemetryType).toBe('battery');
      expect(results[0].value).toBe(77);
    });

    it('stores all optional fields when provided', async () => {
      await repo.insertTelemetry({
        nodeId: NODE1,
        nodeNum: NODE1_NUM,
        telemetryType: 'latitude',
        timestamp: NOW,
        value: 37.7749,
        unit: 'deg',
        createdAt: NOW,
        packetTimestamp: NOW - 100,
        packetId: 99999,
        channel: 3,
        precisionBits: 12,
        gpsAccuracy: 5,
      });

      const results = await repo.getTelemetryByNode(NODE1, 1);
      expect(results).toHaveLength(1);
      const r = results[0];
      expect(r.unit).toBe('deg');
      expect(r.packetTimestamp).toBe(NOW - 100);
      expect(r.packetId).toBe(99999);
      expect(r.channel).toBe(3);
      expect(r.precisionBits).toBe(12);
      expect(r.gpsAccuracy).toBe(5);
    });

    it('stores null for optional fields when omitted', async () => {
      await repo.insertTelemetry({
        nodeId: NODE1,
        nodeNum: NODE1_NUM,
        telemetryType: 'voltage',
        timestamp: NOW,
        value: 3.7,
        createdAt: NOW,
      });

      const results = await repo.getTelemetryByNode(NODE1, 1);
      const r = results[0];
      expect(r.unit).toBeNull();
      expect(r.packetTimestamp).toBeNull();
      expect(r.packetId).toBeNull();
      expect(r.channel).toBeNull();
      expect(r.precisionBits).toBeNull();
      expect(r.gpsAccuracy).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // getTelemetryCount
  // -------------------------------------------------------------------------
  describe('getTelemetryCount', () => {
    it('returns 0 when the table is empty', async () => {
      expect(await repo.getTelemetryCount()).toBe(0);
    });

    it('returns the total number of records across all nodes and types', async () => {
      await insertTelemetry(NODE1, NODE1_NUM, 'battery', NOW - HOUR);
      await insertTelemetry(NODE1, NODE1_NUM, 'voltage', NOW - 2 * HOUR);
      await insertTelemetry(NODE2, NODE2_NUM, 'temperature', NOW - 3 * HOUR);

      expect(await repo.getTelemetryCount()).toBe(3);
    });
  });

  // -------------------------------------------------------------------------
  // getTelemetryCountByNode
  // -------------------------------------------------------------------------
  describe('getTelemetryCountByNode', () => {
    beforeEach(async () => {
      // NODE1: battery x3, voltage x1
      await insertTelemetry(NODE1, NODE1_NUM, 'battery', NOW - 1 * HOUR, 80);
      await insertTelemetry(NODE1, NODE1_NUM, 'battery', NOW - 3 * HOUR, 75);
      await insertTelemetry(NODE1, NODE1_NUM, 'battery', NOW - 5 * HOUR, 70);
      await insertTelemetry(NODE1, NODE1_NUM, 'voltage', NOW - 2 * HOUR, 3.7);
      // NODE2: temperature x1
      await insertTelemetry(NODE2, NODE2_NUM, 'temperature', NOW - 1 * HOUR, 25);
    });

    it('counts all records for a node when no filters are applied', async () => {
      expect(await repo.getTelemetryCountByNode(NODE1)).toBe(4);
    });

    it('counts 0 for a node that has no records', async () => {
      expect(await repo.getTelemetryCountByNode('!ffffffff')).toBe(0);
    });

    it('applies sinceTimestamp filter (inclusive)', async () => {
      // Only records at or after NOW - 2h
      const count = await repo.getTelemetryCountByNode(NODE1, NOW - 2 * HOUR);
      expect(count).toBe(2); // battery@1h and voltage@2h
    });

    it('applies beforeTimestamp filter (exclusive)', async () => {
      // Records strictly before NOW - 2h
      const count = await repo.getTelemetryCountByNode(NODE1, undefined, NOW - 2 * HOUR);
      expect(count).toBe(2); // battery@3h and battery@5h
    });

    it('applies telemetryType filter', async () => {
      const count = await repo.getTelemetryCountByNode(NODE1, undefined, undefined, 'battery');
      expect(count).toBe(3);
    });

    it('combines all filters together', async () => {
      // battery, between 4h ago and 1.5h ago => only battery@3h
      const count = await repo.getTelemetryCountByNode(
        NODE1,
        NOW - 4 * HOUR,
        NOW - 1.5 * HOUR,
        'battery'
      );
      expect(count).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // getTelemetryByNode
  // -------------------------------------------------------------------------
  describe('getTelemetryByNode', () => {
    beforeEach(async () => {
      // Insert 5 battery records for NODE1 spread over 5 hours (most recent first when sorted)
      for (let i = 1; i <= 5; i++) {
        await insertTelemetry(NODE1, NODE1_NUM, 'battery', NOW - i * HOUR, i * 10);
      }
      // One voltage record
      await insertTelemetry(NODE1, NODE1_NUM, 'voltage', NOW - 6 * HOUR, 3.7);
      // NODE2 record (should never appear in NODE1 queries)
      await insertTelemetry(NODE2, NODE2_NUM, 'battery', NOW - HOUR, 99);
    });

    it('returns records ordered by timestamp descending', async () => {
      const results = await repo.getTelemetryByNode(NODE1, 10);
      const timestamps = results.map(r => r.timestamp);
      for (let i = 1; i < timestamps.length; i++) {
        expect(timestamps[i]).toBeLessThanOrEqual(timestamps[i - 1]);
      }
    });

    it('respects the limit parameter', async () => {
      const results = await repo.getTelemetryByNode(NODE1, 2);
      expect(results).toHaveLength(2);
    });

    it('respects the offset parameter', async () => {
      const all = await repo.getTelemetryByNode(NODE1, 10);
      const paged = await repo.getTelemetryByNode(NODE1, 10, undefined, undefined, 2);
      expect(paged).toHaveLength(all.length - 2);
      expect(paged[0].timestamp).toBe(all[2].timestamp);
    });

    it('filters by sinceTimestamp', async () => {
      // Only the most recent 3 battery records (within last 3.5h)
      const results = await repo.getTelemetryByNode(NODE1, 100, NOW - 3.5 * HOUR);
      expect(results.every(r => r.timestamp >= NOW - 3.5 * HOUR)).toBe(true);
    });

    it('filters by beforeTimestamp', async () => {
      const results = await repo.getTelemetryByNode(NODE1, 100, undefined, NOW - 3 * HOUR);
      expect(results.every(r => r.timestamp < NOW - 3 * HOUR)).toBe(true);
    });

    it('filters by telemetryType', async () => {
      const results = await repo.getTelemetryByNode(NODE1, 100, undefined, undefined, 0, 'voltage');
      expect(results).toHaveLength(1);
      expect(results[0].telemetryType).toBe('voltage');
    });

    it('only returns records for the requested node', async () => {
      const results = await repo.getTelemetryByNode(NODE1, 100);
      expect(results.every(r => r.nodeId === NODE1)).toBe(true);
    });

    it('returns empty array for unknown node', async () => {
      const results = await repo.getTelemetryByNode('!00000000', 10);
      expect(results).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // getPositionTelemetryByNode
  // -------------------------------------------------------------------------
  describe('getPositionTelemetryByNode', () => {
    const POSITION_TYPES = ['latitude', 'longitude', 'altitude', 'ground_speed', 'ground_track'];

    beforeEach(async () => {
      for (const type of POSITION_TYPES) {
        await insertTelemetry(NODE1, NODE1_NUM, type, NOW - HOUR);
      }
      // Non-position type that should NOT be returned
      await insertTelemetry(NODE1, NODE1_NUM, 'battery', NOW - HOUR);
      // NODE2 position that should NOT be returned
      await insertTelemetry(NODE2, NODE2_NUM, 'latitude', NOW - HOUR);
    });

    it('only returns the 5 position telemetry types', async () => {
      const results = await repo.getPositionTelemetryByNode(NODE1);
      const types = new Set(results.map(r => r.telemetryType));
      for (const t of POSITION_TYPES) {
        expect(types.has(t)).toBe(true);
      }
      expect(types.has('battery')).toBe(false);
    });

    it('only returns records for the requested node', async () => {
      const results = await repo.getPositionTelemetryByNode(NODE1);
      expect(results.every(r => r.nodeId === NODE1)).toBe(true);
    });

    it('respects the limit parameter', async () => {
      // Insert more latitude records
      for (let i = 2; i <= 5; i++) {
        await insertTelemetry(NODE1, NODE1_NUM, 'latitude', NOW - i * HOUR);
      }
      const results = await repo.getPositionTelemetryByNode(NODE1, 3);
      expect(results).toHaveLength(3);
    });

    it('filters by sinceTimestamp', async () => {
      // Add an old record
      await insertTelemetry(NODE1, NODE1_NUM, 'latitude', NOW - 10 * HOUR);

      const results = await repo.getPositionTelemetryByNode(NODE1, 100, NOW - 2 * HOUR);
      expect(results.every(r => r.timestamp >= NOW - 2 * HOUR)).toBe(true);
    });

    it('returns empty array when node has no position telemetry', async () => {
      const results = await repo.getPositionTelemetryByNode('!00000000');
      expect(results).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // getTelemetryByType
  // -------------------------------------------------------------------------
  describe('getTelemetryByType', () => {
    beforeEach(async () => {
      // battery for both nodes
      await insertTelemetry(NODE1, NODE1_NUM, 'battery', NOW - HOUR, 80);
      await insertTelemetry(NODE2, NODE2_NUM, 'battery', NOW - 2 * HOUR, 60);
      // voltage only for NODE1
      await insertTelemetry(NODE1, NODE1_NUM, 'voltage', NOW - HOUR, 3.7);
    });

    it('returns records for all nodes matching the type', async () => {
      const results = await repo.getTelemetryByType('battery');
      expect(results).toHaveLength(2);
      const nodeIds = results.map(r => r.nodeId);
      expect(nodeIds).toContain(NODE1);
      expect(nodeIds).toContain(NODE2);
    });

    it('returns records ordered by timestamp descending', async () => {
      const results = await repo.getTelemetryByType('battery', 10);
      expect(results[0].timestamp).toBeGreaterThanOrEqual(results[1].timestamp);
    });

    it('respects the limit parameter', async () => {
      // Insert extra battery records
      for (let i = 3; i <= 6; i++) {
        await insertTelemetry(NODE1, NODE1_NUM, 'battery', NOW - i * HOUR);
      }
      const results = await repo.getTelemetryByType('battery', 3);
      expect(results).toHaveLength(3);
    });

    it('returns empty array for an unknown type', async () => {
      const results = await repo.getTelemetryByType('nonexistent_type');
      expect(results).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // getLatestTelemetryForType
  // -------------------------------------------------------------------------
  describe('getLatestTelemetryForType', () => {
    it('returns null when no records exist for the node', async () => {
      const result = await repo.getLatestTelemetryForType(NODE1, 'battery');
      expect(result).toBeNull();
    });

    it('returns null when the node has records but not for the requested type', async () => {
      await insertTelemetry(NODE1, NODE1_NUM, 'voltage', NOW - HOUR);
      const result = await repo.getLatestTelemetryForType(NODE1, 'battery');
      expect(result).toBeNull();
    });

    it('returns the single record when only one exists', async () => {
      await insertTelemetry(NODE1, NODE1_NUM, 'battery', NOW - HOUR, 85);
      const result = await repo.getLatestTelemetryForType(NODE1, 'battery');
      expect(result).not.toBeNull();
      expect(result!.value).toBe(85);
    });

    it('returns the most recent record when multiple exist', async () => {
      await insertTelemetry(NODE1, NODE1_NUM, 'battery', NOW - 3 * HOUR, 70);
      await insertTelemetry(NODE1, NODE1_NUM, 'battery', NOW - 2 * HOUR, 75);
      await insertTelemetry(NODE1, NODE1_NUM, 'battery', NOW - 1 * HOUR, 80);

      const result = await repo.getLatestTelemetryForType(NODE1, 'battery');
      expect(result!.value).toBe(80);
      expect(result!.timestamp).toBe(NOW - 1 * HOUR);
    });

    it('does not return records from a different node', async () => {
      await insertTelemetry(NODE2, NODE2_NUM, 'battery', NOW - HOUR, 55);
      const result = await repo.getLatestTelemetryForType(NODE1, 'battery');
      expect(result).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // getLatestTelemetryByNode
  // -------------------------------------------------------------------------
  describe('getLatestTelemetryByNode', () => {
    it('returns an empty array when node has no telemetry', async () => {
      const results = await repo.getLatestTelemetryByNode(NODE1);
      expect(results).toHaveLength(0);
    });

    it('returns one entry per distinct type', async () => {
      await insertTelemetry(NODE1, NODE1_NUM, 'battery', NOW - 3 * HOUR, 70);
      await insertTelemetry(NODE1, NODE1_NUM, 'battery', NOW - 1 * HOUR, 80); // newer
      await insertTelemetry(NODE1, NODE1_NUM, 'voltage', NOW - 2 * HOUR, 3.6);
      await insertTelemetry(NODE1, NODE1_NUM, 'temperature', NOW - 4 * HOUR, 22);

      const results = await repo.getLatestTelemetryByNode(NODE1);
      expect(results).toHaveLength(3);

      const types = results.map(r => r.telemetryType).sort();
      expect(types).toEqual(['battery', 'temperature', 'voltage']);
    });

    it('returns the latest value for each type', async () => {
      await insertTelemetry(NODE1, NODE1_NUM, 'battery', NOW - 3 * HOUR, 70);
      await insertTelemetry(NODE1, NODE1_NUM, 'battery', NOW - 1 * HOUR, 90);

      const results = await repo.getLatestTelemetryByNode(NODE1);
      const battery = results.find(r => r.telemetryType === 'battery');
      expect(battery!.value).toBe(90);
    });

    it('does not include records from other nodes', async () => {
      await insertTelemetry(NODE1, NODE1_NUM, 'battery', NOW - HOUR, 80);
      await insertTelemetry(NODE2, NODE2_NUM, 'battery', NOW - HOUR, 50);

      const results = await repo.getLatestTelemetryByNode(NODE1);
      expect(results.every(r => r.nodeId === NODE1)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // getNodeTelemetryTypes
  // -------------------------------------------------------------------------
  describe('getNodeTelemetryTypes', () => {
    it('returns an empty array when node has no telemetry', async () => {
      const types = await repo.getNodeTelemetryTypes(NODE1);
      expect(types).toHaveLength(0);
    });

    it('returns distinct types for a node', async () => {
      await insertTelemetry(NODE1, NODE1_NUM, 'battery', NOW - 3 * HOUR);
      await insertTelemetry(NODE1, NODE1_NUM, 'battery', NOW - 1 * HOUR); // duplicate type
      await insertTelemetry(NODE1, NODE1_NUM, 'voltage', NOW - 2 * HOUR);
      await insertTelemetry(NODE1, NODE1_NUM, 'temperature', NOW - 4 * HOUR);

      const types = await repo.getNodeTelemetryTypes(NODE1);
      expect(types.sort()).toEqual(['battery', 'temperature', 'voltage']);
    });

    it('does not include types from other nodes', async () => {
      await insertTelemetry(NODE1, NODE1_NUM, 'battery', NOW - HOUR);
      await insertTelemetry(NODE2, NODE2_NUM, 'humidity', NOW - HOUR);

      const types = await repo.getNodeTelemetryTypes(NODE1);
      expect(types).not.toContain('humidity');
    });
  });

  // -------------------------------------------------------------------------
  // getLatestTelemetryValueForAllNodes  (SQLite path)
  // -------------------------------------------------------------------------
  describe('getLatestTelemetryValueForAllNodes', () => {
    it('returns an empty Map when no records exist', async () => {
      const map = await repo.getLatestTelemetryValueForAllNodes('battery');
      expect(map.size).toBe(0);
    });

    it('returns a Map with one entry per node', async () => {
      await insertTelemetry(NODE1, NODE1_NUM, 'battery', NOW - 2 * HOUR, 70);
      await insertTelemetry(NODE1, NODE1_NUM, 'battery', NOW - 1 * HOUR, 80); // latest for NODE1
      await insertTelemetry(NODE2, NODE2_NUM, 'battery', NOW - 1 * HOUR, 55); // latest for NODE2

      const map = await repo.getLatestTelemetryValueForAllNodes('battery');
      expect(map.size).toBe(2);
      expect(map.get(NODE1)).toBe(80);
      expect(map.get(NODE2)).toBe(55);
    });

    it('returns the most recent value when a node has multiple records', async () => {
      await insertTelemetry(NODE1, NODE1_NUM, 'battery', NOW - 5 * HOUR, 50);
      await insertTelemetry(NODE1, NODE1_NUM, 'battery', NOW - 3 * HOUR, 60);
      await insertTelemetry(NODE1, NODE1_NUM, 'battery', NOW - 1 * HOUR, 90);

      const map = await repo.getLatestTelemetryValueForAllNodes('battery');
      expect(map.get(NODE1)).toBe(90);
    });

    it('ignores records of a different type', async () => {
      await insertTelemetry(NODE1, NODE1_NUM, 'voltage', NOW - HOUR, 3.7);

      const map = await repo.getLatestTelemetryValueForAllNodes('battery');
      expect(map.size).toBe(0);
    });

    it('scopes results to the requested sourceId (issue #2831)', async () => {
      // Same node has telemetry from two different sources. Without sourceId,
      // we'd see whichever source has the most recent record. With sourceId,
      // we should get exactly that source's most recent record.
      const SOURCE_A = 'src-a';
      const SOURCE_B = 'src-b';

      await repo.insertTelemetry({
        nodeId: NODE1,
        nodeNum: NODE1_NUM,
        telemetryType: 'battery',
        timestamp: NOW - 2 * HOUR,
        value: 70,
        unit: '%',
        createdAt: NOW - 2 * HOUR,
      }, SOURCE_A);
      await repo.insertTelemetry({
        nodeId: NODE1,
        nodeNum: NODE1_NUM,
        telemetryType: 'battery',
        timestamp: NOW - 1 * HOUR, // newest overall — would dominate without scope
        value: 90,
        unit: '%',
        createdAt: NOW - 1 * HOUR,
      }, SOURCE_B);

      const mapA = await repo.getLatestTelemetryValueForAllNodes('battery', SOURCE_A);
      expect(mapA.get(NODE1)).toBe(70);

      const mapB = await repo.getLatestTelemetryValueForAllNodes('battery', SOURCE_B);
      expect(mapB.get(NODE1)).toBe(90);

      // Unfiltered behaviour preserved (latest across all sources).
      const mapAll = await repo.getLatestTelemetryValueForAllNodes('battery');
      expect(mapAll.get(NODE1)).toBe(90);
    });
  });

  // -------------------------------------------------------------------------
  // deleteTelemetryByNodeAndType
  // -------------------------------------------------------------------------
  describe('deleteTelemetryByNodeAndType', () => {
    it('returns false when no matching records exist', async () => {
      const result = await repo.deleteTelemetryByNodeAndType(NODE1, 'battery');
      expect(result).toBe(false);
    });

    it('returns false when the node exists but the type does not', async () => {
      await insertTelemetry(NODE1, NODE1_NUM, 'voltage', NOW - HOUR);
      const result = await repo.deleteTelemetryByNodeAndType(NODE1, 'battery');
      expect(result).toBe(false);
    });

    it('returns true and deletes all matching records', async () => {
      await insertTelemetry(NODE1, NODE1_NUM, 'battery', NOW - 2 * HOUR);
      await insertTelemetry(NODE1, NODE1_NUM, 'battery', NOW - 1 * HOUR);
      await insertTelemetry(NODE1, NODE1_NUM, 'voltage', NOW - HOUR); // should remain

      const result = await repo.deleteTelemetryByNodeAndType(NODE1, 'battery');
      expect(result).toBe(true);

      const remaining = await repo.getTelemetryByNode(NODE1, 100);
      expect(remaining).toHaveLength(1);
      expect(remaining[0].telemetryType).toBe('voltage');
    });

    it('does not delete records for a different node', async () => {
      await insertTelemetry(NODE1, NODE1_NUM, 'battery', NOW - HOUR);
      await insertTelemetry(NODE2, NODE2_NUM, 'battery', NOW - HOUR);

      await repo.deleteTelemetryByNodeAndType(NODE1, 'battery');

      const node2Records = await repo.getTelemetryByNode(NODE2, 100);
      expect(node2Records).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // purgeNodeTelemetry
  // -------------------------------------------------------------------------
  describe('purgeNodeTelemetry', () => {
    it('returns 0 when there is nothing to delete', async () => {
      const count = await repo.purgeNodeTelemetry(NODE1_NUM);
      expect(count).toBe(0);
    });

    it('deletes all telemetry for the given nodeNum and returns the count', async () => {
      await insertTelemetry(NODE1, NODE1_NUM, 'battery', NOW - HOUR);
      await insertTelemetry(NODE1, NODE1_NUM, 'voltage', NOW - 2 * HOUR);
      await insertTelemetry(NODE2, NODE2_NUM, 'battery', NOW - HOUR); // should remain

      const count = await repo.purgeNodeTelemetry(NODE1_NUM);
      expect(count).toBe(2);

      const total = await repo.getTelemetryCount();
      expect(total).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // purgePositionHistory
  // -------------------------------------------------------------------------
  describe('purgePositionHistory', () => {
    const POSITION_TYPES = [
      'latitude', 'longitude', 'altitude',
      'ground_speed', 'ground_track',
      'estimated_latitude', 'estimated_longitude',
    ];

    it('returns 0 when there is nothing to delete', async () => {
      const count = await repo.purgePositionHistory(NODE1_NUM);
      expect(count).toBe(0);
    });

    it('deletes only position-related types', async () => {
      for (const type of POSITION_TYPES) {
        await insertTelemetry(NODE1, NODE1_NUM, type, NOW - HOUR);
      }
      // Non-position types that must remain
      await insertTelemetry(NODE1, NODE1_NUM, 'battery', NOW - HOUR);
      await insertTelemetry(NODE1, NODE1_NUM, 'temperature', NOW - HOUR);

      const count = await repo.purgePositionHistory(NODE1_NUM);
      expect(count).toBe(POSITION_TYPES.length);

      const remaining = await repo.getTelemetryByNode(NODE1, 100);
      expect(remaining).toHaveLength(2);
      expect(remaining.every(r => !POSITION_TYPES.includes(r.telemetryType))).toBe(true);
    });

    it('does not delete position records for a different nodeNum', async () => {
      await insertTelemetry(NODE1, NODE1_NUM, 'latitude', NOW - HOUR);
      await insertTelemetry(NODE2, NODE2_NUM, 'latitude', NOW - HOUR);

      await repo.purgePositionHistory(NODE1_NUM);

      const node2Records = await repo.getTelemetryByNode(NODE2, 100);
      expect(node2Records).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // deleteOldTelemetry
  // -------------------------------------------------------------------------
  describe('deleteOldTelemetry', () => {
    it('returns 0 when there is nothing older than the cutoff', async () => {
      await insertTelemetry(NODE1, NODE1_NUM, 'battery', NOW - HOUR);
      const count = await repo.deleteOldTelemetry(NOW - 2 * HOUR);
      expect(count).toBe(0);
    });

    it('deletes records older than the cutoff and returns the count', async () => {
      await insertTelemetry(NODE1, NODE1_NUM, 'battery', NOW - 3 * HOUR); // old
      await insertTelemetry(NODE1, NODE1_NUM, 'battery', NOW - 2 * HOUR); // old
      await insertTelemetry(NODE1, NODE1_NUM, 'battery', NOW - 1 * HOUR); // recent

      const cutoff = NOW - 90 * 60 * 1000; // 1.5 hours ago
      const count = await repo.deleteOldTelemetry(cutoff);
      expect(count).toBe(2);

      const remaining = await repo.getTelemetryCount();
      expect(remaining).toBe(1);
    });

    it('returns 0 when the table is empty', async () => {
      const count = await repo.deleteOldTelemetry(NOW);
      expect(count).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // cleanupOldTelemetry
  // -------------------------------------------------------------------------
  describe('cleanupOldTelemetry', () => {
    it('deletes records older than the specified number of days', async () => {
      // Insert a record 31 days old (should be deleted with default 30-day cutoff)
      await insertTelemetry(NODE1, NODE1_NUM, 'battery', NOW - 31 * DAY);
      // Insert a recent record (should survive)
      await insertTelemetry(NODE1, NODE1_NUM, 'battery', NOW - HOUR);

      const count = await repo.cleanupOldTelemetry(30);
      expect(count).toBe(1);

      const remaining = await repo.getTelemetryCount();
      expect(remaining).toBe(1);
    });

    it('uses 30 days as the default retention period', async () => {
      await insertTelemetry(NODE1, NODE1_NUM, 'battery', NOW - 31 * DAY); // should be deleted
      await insertTelemetry(NODE1, NODE1_NUM, 'battery', NOW - 29 * DAY); // should remain

      const count = await repo.cleanupOldTelemetry();
      expect(count).toBe(1);
    });

    it('returns 0 when nothing is old enough to delete', async () => {
      await insertTelemetry(NODE1, NODE1_NUM, 'battery', NOW - HOUR);
      const count = await repo.cleanupOldTelemetry(30);
      expect(count).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // deleteTelemetryByNode
  // -------------------------------------------------------------------------
  describe('deleteTelemetryByNode', () => {
    it('returns 0 when there are no records for the node', async () => {
      const count = await repo.deleteTelemetryByNode(NODE1_NUM);
      expect(count).toBe(0);
    });

    it('deletes all records for the given nodeNum and returns the count', async () => {
      await insertTelemetry(NODE1, NODE1_NUM, 'battery', NOW - HOUR);
      await insertTelemetry(NODE1, NODE1_NUM, 'voltage', NOW - 2 * HOUR);
      await insertTelemetry(NODE2, NODE2_NUM, 'battery', NOW - HOUR); // should survive

      const count = await repo.deleteTelemetryByNode(NODE1_NUM);
      expect(count).toBe(2);

      expect(await repo.getTelemetryCount()).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // deleteAllTelemetry
  // -------------------------------------------------------------------------
  describe('deleteAllTelemetry', () => {
    it('returns 0 when the table is already empty', async () => {
      const count = await repo.deleteAllTelemetry();
      expect(count).toBe(0);
    });

    it('deletes every record and returns the total count', async () => {
      await insertTelemetry(NODE1, NODE1_NUM, 'battery', NOW - HOUR);
      await insertTelemetry(NODE1, NODE1_NUM, 'voltage', NOW - 2 * HOUR);
      await insertTelemetry(NODE2, NODE2_NUM, 'temperature', NOW - HOUR);

      const count = await repo.deleteAllTelemetry();
      expect(count).toBe(3);

      expect(await repo.getTelemetryCount()).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // getRecentEstimatedPositions
  // -------------------------------------------------------------------------
  describe('getRecentEstimatedPositions', () => {
    it('returns an empty array when there are no estimated_latitude records', async () => {
      await insertTelemetry(NODE1, NODE1_NUM, 'estimated_longitude', NOW - HOUR, -122.4);
      const results = await repo.getRecentEstimatedPositions(NODE1);
      expect(results).toHaveLength(0);
    });

    it('returns an empty array when there are no estimated_longitude records', async () => {
      await insertTelemetry(NODE1, NODE1_NUM, 'estimated_latitude', NOW - HOUR, 37.7);
      const results = await repo.getRecentEstimatedPositions(NODE1);
      expect(results).toHaveLength(0);
    });

    it('returns an empty array when there are no records for the node', async () => {
      const results = await repo.getRecentEstimatedPositions(NODE1);
      expect(results).toHaveLength(0);
    });

    it('pairs latitude and longitude records with matching timestamps', async () => {
      const ts1 = NOW - 2 * HOUR;
      const ts2 = NOW - 1 * HOUR;

      await repo.insertTelemetry({
        nodeId: NODE1, nodeNum: NODE1_NUM,
        telemetryType: 'estimated_latitude', timestamp: ts1,
        value: 37.7749, createdAt: NOW,
      });
      await repo.insertTelemetry({
        nodeId: NODE1, nodeNum: NODE1_NUM,
        telemetryType: 'estimated_longitude', timestamp: ts1,
        value: -122.4194, createdAt: NOW,
      });
      await repo.insertTelemetry({
        nodeId: NODE1, nodeNum: NODE1_NUM,
        telemetryType: 'estimated_latitude', timestamp: ts2,
        value: 37.8, createdAt: NOW,
      });
      await repo.insertTelemetry({
        nodeId: NODE1, nodeNum: NODE1_NUM,
        telemetryType: 'estimated_longitude', timestamp: ts2,
        value: -122.5, createdAt: NOW,
      });

      const results = await repo.getRecentEstimatedPositions(NODE1, 10);
      expect(results).toHaveLength(2);

      const byTs = new Map(results.map(r => [r.timestamp, r]));
      const pos1 = byTs.get(ts1)!;
      expect(pos1.latitude).toBe(37.7749);
      expect(pos1.longitude).toBe(-122.4194);

      const pos2 = byTs.get(ts2)!;
      expect(pos2.latitude).toBe(37.8);
      expect(pos2.longitude).toBe(-122.5);
    });

    it('omits latitude records that have no matching longitude timestamp', async () => {
      const ts1 = NOW - 2 * HOUR;
      const ts2 = NOW - 1 * HOUR;

      // latitude at ts1 and ts2, longitude only at ts2
      await repo.insertTelemetry({
        nodeId: NODE1, nodeNum: NODE1_NUM,
        telemetryType: 'estimated_latitude', timestamp: ts1,
        value: 10.0, createdAt: NOW,
      });
      await repo.insertTelemetry({
        nodeId: NODE1, nodeNum: NODE1_NUM,
        telemetryType: 'estimated_latitude', timestamp: ts2,
        value: 20.0, createdAt: NOW,
      });
      await repo.insertTelemetry({
        nodeId: NODE1, nodeNum: NODE1_NUM,
        telemetryType: 'estimated_longitude', timestamp: ts2,
        value: 50.0, createdAt: NOW,
      });

      const results = await repo.getRecentEstimatedPositions(NODE1, 10);
      expect(results).toHaveLength(1);
      expect(results[0].latitude).toBe(20.0);
      expect(results[0].timestamp).toBe(ts2);
    });

    it('respects the limit parameter', async () => {
      // Insert 5 matching pairs
      for (let i = 1; i <= 5; i++) {
        const ts = NOW - i * HOUR;
        await repo.insertTelemetry({
          nodeId: NODE1, nodeNum: NODE1_NUM,
          telemetryType: 'estimated_latitude', timestamp: ts,
          value: i * 1.0, createdAt: NOW,
        });
        await repo.insertTelemetry({
          nodeId: NODE1, nodeNum: NODE1_NUM,
          telemetryType: 'estimated_longitude', timestamp: ts,
          value: i * 2.0, createdAt: NOW,
        });
      }

      const results = await repo.getRecentEstimatedPositions(NODE1, 3);
      expect(results).toHaveLength(3);
    });

    it('does not include estimated positions from another node', async () => {
      const ts = NOW - HOUR;
      await repo.insertTelemetry({
        nodeId: NODE2, nodeNum: NODE2_NUM,
        telemetryType: 'estimated_latitude', timestamp: ts,
        value: 55.0, createdAt: NOW,
      });
      await repo.insertTelemetry({
        nodeId: NODE2, nodeNum: NODE2_NUM,
        telemetryType: 'estimated_longitude', timestamp: ts,
        value: 10.0, createdAt: NOW,
      });

      const results = await repo.getRecentEstimatedPositions(NODE1, 10);
      expect(results).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // getTelemetryByNodeAveragedSqlite — regression for issue #2631
  // The pre-Drizzle raw SQL used `source_id` while the schema column is
  // `sourceId`, so any call with a sourceId parameter crashed on SQLite. These
  // tests exercise the Drizzle-backed sync helper with sourceId scoping to
  // prevent recurrence.
  // -------------------------------------------------------------------------
  describe('getTelemetryByNodeAveragedSqlite', () => {
    const insertWithSource = async (
      nodeId: string,
      nodeNum: number,
      telemetryType: string,
      timestamp: number,
      value: number,
      sourceId: string | undefined
    ) => {
      await repo.insertTelemetry(
        { nodeId, nodeNum, telemetryType, timestamp, value, unit: '%', createdAt: NOW },
        sourceId
      );
    };

    it('does not throw when called with a sourceId (issue #2631 regression)', async () => {
      await insertWithSource(NODE1, NODE1_NUM, 'voltage', NOW - HOUR, 3.7, 'src-a');
      expect(() =>
        repo.getTelemetryByNodeAveragedSqlite(NODE1, undefined, 3, undefined, 'src-a')
      ).not.toThrow();
    });

    it('scopes averaged results to the provided sourceId', async () => {
      // Same node in two sources with different voltages
      await insertWithSource(NODE1, NODE1_NUM, 'voltage', NOW - HOUR, 3.7, 'src-a');
      await insertWithSource(NODE1, NODE1_NUM, 'voltage', NOW - 30 * 60 * 1000, 3.8, 'src-a');
      await insertWithSource(NODE1, NODE1_NUM, 'voltage', NOW - HOUR, 4.1, 'src-b');

      const fromA = repo.getTelemetryByNodeAveragedSqlite(NODE1, undefined, 3, undefined, 'src-a');
      const fromB = repo.getTelemetryByNodeAveragedSqlite(NODE1, undefined, 3, undefined, 'src-b');

      expect(fromA.length).toBeGreaterThan(0);
      expect(fromB.length).toBeGreaterThan(0);
      // src-a averages 3.7 and 3.8; src-b has only 4.1
      const aValues = fromA.map(r => r.value);
      const bValues = fromB.map(r => r.value);
      expect(aValues.every(v => v < 4.0)).toBe(true);
      expect(bValues.every(v => v > 4.0)).toBe(true);
    });

    it('returns rows from all sources when sourceId is undefined', async () => {
      await insertWithSource(NODE1, NODE1_NUM, 'voltage', NOW - HOUR, 3.7, 'src-a');
      await insertWithSource(NODE1, NODE1_NUM, 'voltage', NOW - 30 * 60 * 1000, 4.1, 'src-b');

      const all = repo.getTelemetryByNodeAveragedSqlite(NODE1, undefined, 3, undefined, undefined);
      // Both sources contribute (different time buckets → separate rows)
      expect(all.length).toBeGreaterThanOrEqual(2);
    });

    it('fetches raw-value types unaveraged under sourceId scope', async () => {
      // batteryLevel is in RAW_VALUE_TYPES — should come through raw, scoped to source
      await insertWithSource(NODE1, NODE1_NUM, 'batteryLevel', NOW - HOUR, 80, 'src-a');
      await insertWithSource(NODE1, NODE1_NUM, 'batteryLevel', NOW - HOUR, 20, 'src-b');

      const results = repo.getTelemetryByNodeAveragedSqlite(NODE1, undefined, 3, undefined, 'src-a');
      const battery = results.filter(r => r.telemetryType === 'batteryLevel');
      expect(battery.length).toBe(1);
      expect(battery[0].value).toBe(80);
    });

    it('respects sinceTimestamp together with sourceId', async () => {
      const oldTs = NOW - 48 * HOUR;
      const recentTs = NOW - HOUR;
      await insertWithSource(NODE1, NODE1_NUM, 'voltage', oldTs, 3.0, 'src-a');
      await insertWithSource(NODE1, NODE1_NUM, 'voltage', recentTs, 3.7, 'src-a');

      const results = repo.getTelemetryByNodeAveragedSqlite(
        NODE1, NOW - 24 * HOUR, 3, undefined, 'src-a'
      );
      expect(results.length).toBe(1);
      expect(results[0].value).toBe(3.7);
    });
  });

  // -------------------------------------------------------------------------
  // insertTelemetry dedup — regression for issue #2629
  // Same packet arriving via multiple mesh routers must not produce duplicate
  // rows. Migration 032 adds a partial unique index on
  // (sourceId, nodeNum, packetId, telemetryType) WHERE packetId IS NOT NULL,
  // and insertTelemetry uses insertIgnore so collisions become silent no-ops.
  // -------------------------------------------------------------------------
  describe('insertTelemetry dedup (issue #2629)', () => {
    const baseRow = (overrides: Partial<any> = {}) => ({
      nodeId: NODE1,
      nodeNum: NODE1_NUM,
      telemetryType: 'batteryLevel',
      timestamp: NOW - HOUR,
      value: 80,
      unit: '%',
      createdAt: NOW,
      packetId: 12345,
      ...overrides,
    });

    it('silently skips duplicate (sourceId, nodeNum, packetId, telemetryType)', async () => {
      const first = await repo.insertTelemetry(baseRow(), 'src-a');
      const second = await repo.insertTelemetry(baseRow(), 'src-a');

      expect(first).toBe(true);
      expect(second).toBe(false);

      const rows = await repo.getTelemetryByNode(NODE1, 10, undefined, undefined, 0, undefined, 'src-a');
      expect(rows).toHaveLength(1);
      expect(rows[0].packetId).toBe(12345);
    });

    it('allows the same packetId with a different telemetryType (single packet, multiple metrics)', async () => {
      // A single Meshtastic telemetry packet commonly produces multiple rows —
      // one per metric type — all sharing the same packetId.
      const a = await repo.insertTelemetry(baseRow({ telemetryType: 'batteryLevel', value: 80 }), 'src-a');
      const b = await repo.insertTelemetry(baseRow({ telemetryType: 'voltage', value: 3.7 }), 'src-a');
      const c = await repo.insertTelemetry(baseRow({ telemetryType: 'channelUtilization', value: 12 }), 'src-a');

      expect(a).toBe(true);
      expect(b).toBe(true);
      expect(c).toBe(true);

      const rows = await repo.getTelemetryByNode(NODE1, 10, undefined, undefined, 0, undefined, 'src-a');
      expect(rows).toHaveLength(3);
      const types = new Set(rows.map(r => r.telemetryType));
      expect(types.has('batteryLevel')).toBe(true);
      expect(types.has('voltage')).toBe(true);
      expect(types.has('channelUtilization')).toBe(true);
    });

    it('allows the same packetId under different sourceIds (independent meshes)', async () => {
      const a = await repo.insertTelemetry(baseRow(), 'src-a');
      const b = await repo.insertTelemetry(baseRow(), 'src-b');

      expect(a).toBe(true);
      expect(b).toBe(true);

      const rowsA = await repo.getTelemetryByNode(NODE1, 10, undefined, undefined, 0, undefined, 'src-a');
      const rowsB = await repo.getTelemetryByNode(NODE1, 10, undefined, undefined, 0, undefined, 'src-b');
      expect(rowsA).toHaveLength(1);
      expect(rowsB).toHaveLength(1);
    });

    it('allows multiple NULL-packetId rows (legacy / synthesized telemetry bypasses the constraint)', async () => {
      // packetId is left unset on both inserts → stored as NULL.
      // The partial index has WHERE packetId IS NOT NULL so neither row
      // participates in the uniqueness check.
      const a = await repo.insertTelemetry({
        nodeId: NODE1,
        nodeNum: NODE1_NUM,
        telemetryType: 'batteryLevel',
        timestamp: NOW - HOUR,
        value: 80,
        unit: '%',
        createdAt: NOW,
      }, 'src-a');
      const b = await repo.insertTelemetry({
        nodeId: NODE1,
        nodeNum: NODE1_NUM,
        telemetryType: 'batteryLevel',
        timestamp: NOW - 2 * HOUR,
        value: 75,
        unit: '%',
        createdAt: NOW,
      }, 'src-a');

      expect(a).toBe(true);
      expect(b).toBe(true);

      const rows = await repo.getTelemetryByNode(NODE1, 10, undefined, undefined, 0, 'batteryLevel', 'src-a');
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.packetId).toBeNull();
      }
    });

    it('allows the same packetId across different nodeNums within the same source', async () => {
      const a = await repo.insertTelemetry(baseRow({ nodeId: NODE1, nodeNum: NODE1_NUM }), 'src-a');
      const b = await repo.insertTelemetry(baseRow({ nodeId: NODE2, nodeNum: NODE2_NUM }), 'src-a');

      expect(a).toBe(true);
      expect(b).toBe(true);

      const rows1 = await repo.getTelemetryByNode(NODE1, 10, undefined, undefined, 0, undefined, 'src-a');
      const rows2 = await repo.getTelemetryByNode(NODE2, 10, undefined, undefined, 0, undefined, 'src-a');
      expect(rows1).toHaveLength(1);
      expect(rows2).toHaveLength(1);
    });
  });
});
