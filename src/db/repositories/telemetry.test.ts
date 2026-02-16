/**
 * Telemetry Repository Tests
 *
 * Tests for the TelemetryRepository, particularly the deleteOldTelemetryWithFavorites method.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle, BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { telemetrySqlite } from '../schema/telemetry.js';
import { TelemetryRepository } from './telemetry.js';
import * as schema from '../schema/index.js';

describe('TelemetryRepository', () => {
  let db: Database.Database;
  let drizzleDb: BetterSQLite3Database<typeof schema>;
  let repo: TelemetryRepository;

  beforeEach(() => {
    // Create in-memory SQLite database
    db = new Database(':memory:');

    // Create telemetry table
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
        gpsAccuracy INTEGER
      )
    `);

    drizzleDb = drizzle(db, { schema });
    repo = new TelemetryRepository(drizzleDb, 'sqlite');
  });

  afterEach(() => {
    db.close();
  });

  // Helper to insert telemetry
  // Use valid hex nodeIds so they parse correctly to nodeNum
  const NODE1 = '!aabbccdd';
  const NODE1_NUM = 0xaabbccdd;
  const NODE2 = '!11223344';
  const NODE2_NUM = 0x11223344;

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
      createdAt: Date.now(),
    });
  };

  describe('deleteOldTelemetryWithFavorites', () => {
    const NOW = Date.now();
    const HOUR = 60 * 60 * 1000;
    const DAY = 24 * HOUR;

    it('should delete all old telemetry when no favorites exist', async () => {
      // Insert telemetry: 2 old (25 hours ago), 1 recent (1 hour ago)
      await insertTelemetry(NODE1, NODE1_NUM, 'battery', NOW - 25 * HOUR, 80);
      await insertTelemetry(NODE1, NODE1_NUM, 'voltage', NOW - 26 * HOUR, 3.7);
      await insertTelemetry(NODE1, NODE1_NUM, 'battery', NOW - 1 * HOUR, 90);

      const regularCutoff = NOW - 24 * HOUR;
      const favoriteCutoff = NOW - 30 * DAY;

      const result = await repo.deleteOldTelemetryWithFavorites(
        regularCutoff,
        favoriteCutoff,
        [] // No favorites
      );

      expect(result.nonFavoritesDeleted).toBe(2);
      expect(result.favoritesDeleted).toBe(0);

      // Verify only recent telemetry remains
      const remaining = await drizzleDb.select().from(telemetrySqlite);
      expect(remaining).toHaveLength(1);
      expect(remaining[0].value).toBe(90);
    });

    it('should retain favorited telemetry longer than regular telemetry', async () => {
      // Insert telemetry:
      // - Favorited (battery for node1): 10 days old - should be kept (within 30 day favorite retention)
      // - Non-favorited (voltage for node1): 10 days old - should be deleted (older than 24h regular retention)
      // - Favorited (battery for node1): 1 hour ago - should be kept
      await insertTelemetry(NODE1, NODE1_NUM, 'battery', NOW - 10 * DAY, 75); // favorited, old but within favorite retention
      await insertTelemetry(NODE1, NODE1_NUM, 'voltage', NOW - 10 * DAY, 3.5); // not favorited, old
      await insertTelemetry(NODE1, NODE1_NUM, 'battery', NOW - 1 * HOUR, 85); // favorited, recent

      const regularCutoff = NOW - 24 * HOUR;
      const favoriteCutoff = NOW - 30 * DAY;

      const result = await repo.deleteOldTelemetryWithFavorites(
        regularCutoff,
        favoriteCutoff,
        [{ nodeId: NODE1, telemetryType: 'battery' }] // battery is favorited
      );

      expect(result.nonFavoritesDeleted).toBe(1); // voltage deleted
      expect(result.favoritesDeleted).toBe(0); // battery within favorite retention

      // Verify correct telemetry remains
      const remaining = await drizzleDb.select().from(telemetrySqlite);
      expect(remaining).toHaveLength(2);
      expect(remaining.every(r => r.telemetryType === 'battery')).toBe(true);
    });

    it('should delete favorited telemetry older than favorite retention', async () => {
      // Insert favorited telemetry 40 days old (beyond 30 day favorite retention)
      await insertTelemetry(NODE1, NODE1_NUM, 'battery', NOW - 40 * DAY, 70);
      // Insert favorited telemetry 10 days old (within 30 day favorite retention)
      await insertTelemetry(NODE1, NODE1_NUM, 'battery', NOW - 10 * DAY, 80);

      const regularCutoff = NOW - 24 * HOUR;
      const favoriteCutoff = NOW - 30 * DAY;

      const result = await repo.deleteOldTelemetryWithFavorites(
        regularCutoff,
        favoriteCutoff,
        [{ nodeId: NODE1, telemetryType: 'battery' }]
      );

      expect(result.nonFavoritesDeleted).toBe(0);
      expect(result.favoritesDeleted).toBe(1); // 40 day old favorite deleted

      const remaining = await drizzleDb.select().from(telemetrySqlite);
      expect(remaining).toHaveLength(1);
      expect(remaining[0].value).toBe(80);
    });

    it('should handle multiple favorites correctly', async () => {
      // Insert various telemetry
      await insertTelemetry(NODE1, NODE1_NUM, 'battery', NOW - 10 * DAY, 80);
      await insertTelemetry(NODE1, NODE1_NUM, 'voltage', NOW - 10 * DAY, 3.7);
      await insertTelemetry(NODE2, NODE2_NUM, 'temperature', NOW - 10 * DAY, 25);
      await insertTelemetry(NODE1, NODE1_NUM, 'humidity', NOW - 10 * DAY, 60); // not favorited

      const regularCutoff = NOW - 24 * HOUR;
      const favoriteCutoff = NOW - 30 * DAY;

      const result = await repo.deleteOldTelemetryWithFavorites(
        regularCutoff,
        favoriteCutoff,
        [
          { nodeId: NODE1, telemetryType: 'battery' },
          { nodeId: NODE1, telemetryType: 'voltage' },
          { nodeId: NODE2, telemetryType: 'temperature' },
        ]
      );

      expect(result.nonFavoritesDeleted).toBe(1); // humidity deleted
      expect(result.favoritesDeleted).toBe(0);

      const remaining = await drizzleDb.select().from(telemetrySqlite);
      expect(remaining).toHaveLength(3);
      expect(remaining.some(r => r.telemetryType === 'humidity')).toBe(false);
    });

    it('should handle edge case where favoriteCutoff > regularCutoff', async () => {
      // This is a misconfiguration - favoriteCutoff (1h) should be earlier (smaller) than regularCutoff
      // The code should use the more conservative (earlier) cutoff to prevent data loss
      // Insert favorited telemetry 12 hours old - would be deleted with 1h cutoff but kept with 24h cutoff
      await insertTelemetry(NODE1, NODE1_NUM, 'battery', NOW - 12 * HOUR, 80); // favorited

      const regularCutoff = NOW - 24 * HOUR;
      const favoriteCutoff = NOW - 1 * HOUR; // Misconfigured: shorter than regular!

      const result = await repo.deleteOldTelemetryWithFavorites(
        regularCutoff,
        favoriteCutoff,
        [{ nodeId: NODE1, telemetryType: 'battery' }]
      );

      // With the edge case validation, it should use regularCutoff (24h) for favorites
      // since that's the more conservative (earlier) cutoff
      // The 12h old favorited telemetry should be kept
      expect(result.favoritesDeleted).toBe(0);

      const remaining = await drizzleDb.select().from(telemetrySqlite);
      expect(remaining).toHaveLength(1);
    });

    it('should handle empty database', async () => {
      const regularCutoff = NOW - 24 * HOUR;
      const favoriteCutoff = NOW - 30 * DAY;

      const result = await repo.deleteOldTelemetryWithFavorites(
        regularCutoff,
        favoriteCutoff,
        [{ nodeId: NODE1, telemetryType: 'battery' }]
      );

      expect(result.nonFavoritesDeleted).toBe(0);
      expect(result.favoritesDeleted).toBe(0);
    });

    it('should handle large datasets with batch processing', async () => {
      // Insert many records to test batch processing
      const insertPromises = [];
      for (let i = 0; i < 50; i++) {
        insertPromises.push(
          insertTelemetry(NODE1, NODE1_NUM, 'metric' + i, NOW - 10 * DAY, i)
        );
      }
      await Promise.all(insertPromises);

      const regularCutoff = NOW - 24 * HOUR;
      const favoriteCutoff = NOW - 30 * DAY;

      // Only favorite metric0
      const result = await repo.deleteOldTelemetryWithFavorites(
        regularCutoff,
        favoriteCutoff,
        [{ nodeId: NODE1, telemetryType: 'metric0' }]
      );

      expect(result.nonFavoritesDeleted).toBe(49); // All except metric0
      expect(result.favoritesDeleted).toBe(0);

      const remaining = await drizzleDb.select().from(telemetrySqlite);
      expect(remaining).toHaveLength(1);
      expect(remaining[0].telemetryType).toBe('metric0');
    });
  });

  describe('getLatestTelemetryForType', () => {
    const NOW = Date.now();
    const HOUR = 60 * 60 * 1000;

    it('should return the most recent telemetry entry for a given node and type', async () => {
      // Insert multiple entries for the same node and type
      await insertTelemetry(NODE1, NODE1_NUM, 'numOnlineNodes', NOW - 3 * HOUR, 10);
      await insertTelemetry(NODE1, NODE1_NUM, 'numOnlineNodes', NOW - 2 * HOUR, 15);
      await insertTelemetry(NODE1, NODE1_NUM, 'numOnlineNodes', NOW - 1 * HOUR, 20);

      const result = await repo.getLatestTelemetryForType(NODE1, 'numOnlineNodes');

      expect(result).not.toBeNull();
      expect(result!.value).toBe(20);
      expect(result!.nodeId).toBe(NODE1);
      expect(result!.telemetryType).toBe('numOnlineNodes');
    });

    it('should return null when no matching telemetry exists', async () => {
      // Insert telemetry for different type
      await insertTelemetry(NODE1, NODE1_NUM, 'battery', NOW - 1 * HOUR, 80);

      const result = await repo.getLatestTelemetryForType(NODE1, 'numOnlineNodes');

      expect(result).toBeNull();
    });

    it('should return null when node has no telemetry', async () => {
      const result = await repo.getLatestTelemetryForType(NODE1, 'numOnlineNodes');

      expect(result).toBeNull();
    });

    it('should only return telemetry for the specified node', async () => {
      // Insert telemetry for two different nodes
      await insertTelemetry(NODE1, NODE1_NUM, 'numOnlineNodes', NOW - 1 * HOUR, 10);
      await insertTelemetry(NODE2, NODE2_NUM, 'numOnlineNodes', NOW - 30 * 60 * 1000, 25);

      const result = await repo.getLatestTelemetryForType(NODE1, 'numOnlineNodes');

      expect(result).not.toBeNull();
      expect(result!.value).toBe(10);
      expect(result!.nodeId).toBe(NODE1);
    });

    it('should work with systemNodeCount telemetry type', async () => {
      await insertTelemetry(NODE1, NODE1_NUM, 'systemNodeCount', NOW - 1 * HOUR, 42);

      const result = await repo.getLatestTelemetryForType(NODE1, 'systemNodeCount');

      expect(result).not.toBeNull();
      expect(result!.value).toBe(42);
      expect(result!.telemetryType).toBe('systemNodeCount');
    });

    it('should work with systemDirectNodeCount telemetry type', async () => {
      await insertTelemetry(NODE1, NODE1_NUM, 'systemDirectNodeCount', NOW - 1 * HOUR, 15);

      const result = await repo.getLatestTelemetryForType(NODE1, 'systemDirectNodeCount');

      expect(result).not.toBeNull();
      expect(result!.value).toBe(15);
      expect(result!.telemetryType).toBe('systemDirectNodeCount');
    });
  });

  describe('packetId support', () => {
    const NOW = Date.now();
    const HOUR = 60 * 60 * 1000;

    it('should store and retrieve packetId when provided', async () => {
      await repo.insertTelemetry({
        nodeId: NODE1,
        nodeNum: NODE1_NUM,
        telemetryType: 'batteryLevel',
        timestamp: NOW,
        value: 85,
        unit: '%',
        createdAt: NOW,
        packetId: 1234567890,
      });

      const results = await repo.getTelemetryByNode(NODE1, 1);
      expect(results).toHaveLength(1);
      expect(results[0].packetId).toBe(1234567890);
    });

    it('should store null packetId when not provided', async () => {
      await repo.insertTelemetry({
        nodeId: NODE1,
        nodeNum: NODE1_NUM,
        telemetryType: 'voltage',
        timestamp: NOW,
        value: 3.7,
        unit: 'V',
        createdAt: NOW,
      });

      const results = await repo.getTelemetryByNode(NODE1, 1);
      expect(results).toHaveLength(1);
      expect(results[0].packetId).toBeNull();
    });

    it('should store null packetId when explicitly set to null', async () => {
      await repo.insertTelemetry({
        nodeId: NODE1,
        nodeNum: NODE1_NUM,
        telemetryType: 'temperature',
        timestamp: NOW,
        value: 25.5,
        unit: '°C',
        createdAt: NOW,
        packetId: null,
      });

      const results = await repo.getTelemetryByNode(NODE1, 1);
      expect(results).toHaveLength(1);
      expect(results[0].packetId).toBeNull();
    });

    it('should preserve distinct packetIds for different telemetry from the same packet', async () => {
      const packetId = 987654321;

      // Same packet produces multiple telemetry entries (e.g., device metrics)
      await repo.insertTelemetry({
        nodeId: NODE1, nodeNum: NODE1_NUM, telemetryType: 'batteryLevel',
        timestamp: NOW, value: 85, unit: '%', createdAt: NOW, packetId,
      });
      await repo.insertTelemetry({
        nodeId: NODE1, nodeNum: NODE1_NUM, telemetryType: 'voltage',
        timestamp: NOW, value: 3.7, unit: 'V', createdAt: NOW, packetId,
      });
      await repo.insertTelemetry({
        nodeId: NODE1, nodeNum: NODE1_NUM, telemetryType: 'channelUtilization',
        timestamp: NOW, value: 12.5, unit: '%', createdAt: NOW, packetId,
      });

      const results = await repo.getTelemetryByNode(NODE1, 10);
      expect(results).toHaveLength(3);
      // All entries from the same packet should share the same packetId
      expect(results.every(r => r.packetId === packetId)).toBe(true);
    });

    it('should allow querying telemetry that mixes entries with and without packetId', async () => {
      // Telemetry from a real packet (has packetId)
      await repo.insertTelemetry({
        nodeId: NODE1, nodeNum: NODE1_NUM, telemetryType: 'batteryLevel',
        timestamp: NOW, value: 85, unit: '%', createdAt: NOW, packetId: 111222333,
      });
      // Derived telemetry (no packetId)
      await repo.insertTelemetry({
        nodeId: NODE1, nodeNum: NODE1_NUM, telemetryType: 'linkQuality',
        timestamp: NOW - 1 * HOUR, value: 80, unit: 'quality', createdAt: NOW,
      });

      const results = await repo.getTelemetryByNode(NODE1, 10);
      expect(results).toHaveLength(2);

      const withPacketId = results.find(r => r.telemetryType === 'batteryLevel');
      const withoutPacketId = results.find(r => r.telemetryType === 'linkQuality');

      expect(withPacketId!.packetId).toBe(111222333);
      expect(withoutPacketId!.packetId).toBeNull();
    });

    it('should retrieve packetId through getLatestTelemetryForType', async () => {
      await repo.insertTelemetry({
        nodeId: NODE1, nodeNum: NODE1_NUM, telemetryType: 'batteryLevel',
        timestamp: NOW - 2 * HOUR, value: 80, unit: '%', createdAt: NOW, packetId: 100,
      });
      await repo.insertTelemetry({
        nodeId: NODE1, nodeNum: NODE1_NUM, telemetryType: 'batteryLevel',
        timestamp: NOW - 1 * HOUR, value: 85, unit: '%', createdAt: NOW, packetId: 200,
      });

      const result = await repo.getLatestTelemetryForType(NODE1, 'batteryLevel');
      expect(result).not.toBeNull();
      expect(result!.value).toBe(85);
      expect(result!.packetId).toBe(200);
    });
  });
});
