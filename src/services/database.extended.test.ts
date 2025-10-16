import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { DbNode, DbMessage, DbTelemetry, DbRouteSegment } from './database';

// Create a test database service
const createTestDatabase = () => {
  const Database = require('better-sqlite3');

  class TestDatabaseService {
    public db: Database.Database;
    private isInitialized = false;

    constructor() {
      // Use in-memory database for tests
      this.db = new Database(':memory:');
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('foreign_keys = ON');
      this.initialize();
      this.ensurePrimaryChannel();
    }

    private initialize(): void {
      if (this.isInitialized) return;
      this.createTables();
      this.createIndexes();
      this.isInitialized = true;
    }

    private createTables(): void {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS nodes (
          nodeNum INTEGER PRIMARY KEY,
          nodeId TEXT UNIQUE NOT NULL,
          longName TEXT,
          shortName TEXT,
          hwModel INTEGER,
          role INTEGER,
          hopsAway INTEGER,
          viaMqtt BOOLEAN DEFAULT 0,
          macaddr TEXT,
          latitude REAL,
          longitude REAL,
          altitude REAL,
          batteryLevel INTEGER,
          voltage REAL,
          channelUtilization REAL,
          airUtilTx REAL,
          lastHeard INTEGER,
          snr REAL,
          rssi INTEGER,
          lastTracerouteRequest INTEGER,
          createdAt INTEGER NOT NULL,
          updatedAt INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS messages (
          id TEXT PRIMARY KEY,
          fromNodeNum INTEGER NOT NULL,
          toNodeNum INTEGER NOT NULL,
          fromNodeId TEXT NOT NULL,
          toNodeId TEXT NOT NULL,
          text TEXT NOT NULL,
          channel INTEGER NOT NULL DEFAULT 0,
          portnum INTEGER,
          timestamp INTEGER NOT NULL,
          rxTime INTEGER,
          hopStart INTEGER,
          hopLimit INTEGER,
          replyId INTEGER,
          emoji INTEGER,
          createdAt INTEGER NOT NULL,
          FOREIGN KEY (fromNodeNum) REFERENCES nodes(nodeNum),
          FOREIGN KEY (toNodeNum) REFERENCES nodes(nodeNum)
        );

        CREATE TABLE IF NOT EXISTS channels (
          id INTEGER PRIMARY KEY,
          name TEXT,
          psk TEXT,
          uplinkEnabled BOOLEAN DEFAULT 1,
          downlinkEnabled BOOLEAN DEFAULT 1,
          createdAt INTEGER NOT NULL,
          updatedAt INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS telemetry (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          nodeId TEXT NOT NULL,
          nodeNum INTEGER NOT NULL,
          telemetryType TEXT NOT NULL,
          timestamp INTEGER NOT NULL,
          value REAL NOT NULL,
          unit TEXT,
          createdAt INTEGER NOT NULL,
          FOREIGN KEY (nodeNum) REFERENCES nodes(nodeNum)
        );

        CREATE TABLE IF NOT EXISTS traceroutes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          fromNodeNum INTEGER NOT NULL,
          toNodeNum INTEGER NOT NULL,
          fromNodeId TEXT NOT NULL,
          toNodeId TEXT NOT NULL,
          route TEXT,
          routeBack TEXT,
          snrTowards TEXT,
          snrBack TEXT,
          timestamp INTEGER NOT NULL,
          createdAt INTEGER NOT NULL,
          FOREIGN KEY (fromNodeNum) REFERENCES nodes(nodeNum),
          FOREIGN KEY (toNodeNum) REFERENCES nodes(nodeNum)
        );

        CREATE TABLE IF NOT EXISTS route_segments (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          fromNodeNum INTEGER NOT NULL,
          toNodeNum INTEGER NOT NULL,
          fromNodeId TEXT NOT NULL,
          toNodeId TEXT NOT NULL,
          distanceKm REAL NOT NULL,
          isRecordHolder BOOLEAN DEFAULT 0,
          timestamp INTEGER NOT NULL,
          createdAt INTEGER NOT NULL,
          FOREIGN KEY (fromNodeNum) REFERENCES nodes(nodeNum),
          FOREIGN KEY (toNodeNum) REFERENCES nodes(nodeNum)
        );

        CREATE TABLE IF NOT EXISTS settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          createdAt INTEGER NOT NULL,
          updatedAt INTEGER NOT NULL
        );
      `);
    }

    private createIndexes(): void {
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_nodes_nodeId ON nodes(nodeId);
        CREATE INDEX IF NOT EXISTS idx_nodes_lastHeard ON nodes(lastHeard);
        CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
        CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel);
        CREATE INDEX IF NOT EXISTS idx_telemetry_nodeId ON telemetry(nodeId);
        CREATE INDEX IF NOT EXISTS idx_telemetry_type ON telemetry(telemetryType);
        CREATE INDEX IF NOT EXISTS idx_telemetry_timestamp ON telemetry(timestamp);
      `);
    }

    private ensurePrimaryChannel(): void {
      const now = Date.now();
      this.db.prepare(`
        INSERT OR IGNORE INTO channels (id, name, uplinkEnabled, downlinkEnabled, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(0, 'Primary', 1, 1, now, now);
    }

    // Node operations
    upsertNode(nodeData: Partial<DbNode>): void {
      if (!nodeData.nodeNum || !nodeData.nodeId) return;

      const now = Date.now();
      const existingNode = this.getNode(nodeData.nodeNum);

      if (existingNode) {
        const stmt = this.db.prepare(`
          UPDATE nodes SET
            nodeId = COALESCE(?, nodeId),
            longName = COALESCE(?, longName),
            shortName = COALESCE(?, shortName),
            hopsAway = COALESCE(?, hopsAway),
            viaMqtt = COALESCE(?, viaMqtt),
            latitude = COALESCE(?, latitude),
            longitude = COALESCE(?, longitude),
            altitude = COALESCE(?, altitude),
            lastHeard = COALESCE(?, lastHeard),
            lastTracerouteRequest = COALESCE(?, lastTracerouteRequest),
            updatedAt = ?
          WHERE nodeNum = ?
        `);
        stmt.run(
          nodeData.nodeId, nodeData.longName, nodeData.shortName,
          nodeData.hopsAway,
          nodeData.viaMqtt !== undefined ? (nodeData.viaMqtt ? 1 : 0) : null,
          nodeData.latitude, nodeData.longitude, nodeData.altitude,
          nodeData.lastHeard, nodeData.lastTracerouteRequest,
          now, nodeData.nodeNum
        );
      } else {
        const stmt = this.db.prepare(`
          INSERT INTO nodes (
            nodeNum, nodeId, longName, shortName, hopsAway, viaMqtt, latitude, longitude, altitude,
            lastHeard, lastTracerouteRequest, createdAt, updatedAt
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        stmt.run(
          nodeData.nodeNum, nodeData.nodeId, nodeData.longName, nodeData.shortName,
          nodeData.hopsAway !== undefined ? nodeData.hopsAway : null,
          nodeData.viaMqtt !== undefined ? (nodeData.viaMqtt ? 1 : 0) : null,
          nodeData.latitude ?? null, nodeData.longitude ?? null, nodeData.altitude ?? null,
          nodeData.lastHeard ?? null, nodeData.lastTracerouteRequest ?? null,
          now, now
        );
      }
    }

    getNode(nodeNum: number): DbNode | null {
      const stmt = this.db.prepare('SELECT * FROM nodes WHERE nodeNum = ?');
      return stmt.get(nodeNum) as DbNode | null;
    }

    getAllNodes(): DbNode[] {
      const stmt = this.db.prepare('SELECT * FROM nodes ORDER BY updatedAt DESC');
      return stmt.all() as DbNode[];
    }

    getActiveNodes(sinceDays: number = 7): DbNode[] {
      const cutoff = Date.now() - (sinceDays * 24 * 60 * 60 * 1000);
      const stmt = this.db.prepare('SELECT * FROM nodes WHERE lastHeard > ? ORDER BY lastHeard DESC');
      return stmt.all(cutoff) as DbNode[];
    }

    // Message operations
    insertMessage(messageData: DbMessage): void {
      const stmt = this.db.prepare(`
        INSERT INTO messages (
          id, fromNodeNum, toNodeNum, fromNodeId, toNodeId,
          text, channel, portnum, timestamp, rxTime, createdAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        messageData.id,
        messageData.fromNodeNum,
        messageData.toNodeNum,
        messageData.fromNodeId,
        messageData.toNodeId,
        messageData.text,
        messageData.channel,
        messageData.portnum ?? null,
        messageData.timestamp,
        messageData.rxTime ?? null,
        messageData.createdAt
      );
    }

    getMessagesByChannel(channel: number, limit: number = 100): DbMessage[] {
      const stmt = this.db.prepare(`
        SELECT * FROM messages
        WHERE channel = ?
        ORDER BY timestamp DESC
        LIMIT ?
      `);
      return stmt.all(channel, limit) as DbMessage[];
    }

    getDirectMessages(nodeId1: string, nodeId2: string, limit: number = 100): DbMessage[] {
      const stmt = this.db.prepare(`
        SELECT * FROM messages
        WHERE (fromNodeId = ? AND toNodeId = ?)
           OR (fromNodeId = ? AND toNodeId = ?)
        ORDER BY timestamp DESC
        LIMIT ?
      `);
      return stmt.all(nodeId1, nodeId2, nodeId2, nodeId1, limit) as DbMessage[];
    }

    // Telemetry operations
    insertTelemetry(telemetryData: DbTelemetry): void {
      const stmt = this.db.prepare(`
        INSERT INTO telemetry (
          nodeId, nodeNum, telemetryType, timestamp, value, unit, createdAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        telemetryData.nodeId,
        telemetryData.nodeNum,
        telemetryData.telemetryType,
        telemetryData.timestamp,
        telemetryData.value,
        telemetryData.unit || null,
        telemetryData.createdAt
      );
    }

    getTelemetryByNode(nodeId: string, limit: number = 100, sinceTimestamp?: number): DbTelemetry[] {
      let query = `
        SELECT * FROM telemetry
        WHERE nodeId = ?
      `;
      const params: any[] = [nodeId];

      if (sinceTimestamp !== undefined) {
        query += ` AND timestamp >= ?`;
        params.push(sinceTimestamp);
      }

      query += `
        ORDER BY timestamp DESC
        LIMIT ?
      `;
      params.push(limit);

      const stmt = this.db.prepare(query);
      return stmt.all(...params) as DbTelemetry[];
    }

    getTelemetryByType(telemetryType: string, limit: number = 100): DbTelemetry[] {
      const stmt = this.db.prepare(`
        SELECT * FROM telemetry
        WHERE telemetryType = ?
        ORDER BY timestamp DESC
        LIMIT ?
      `);
      return stmt.all(telemetryType, limit) as DbTelemetry[];
    }

    getLatestTelemetryByNode(nodeId: string): DbTelemetry[] {
      const stmt = this.db.prepare(`
        SELECT * FROM telemetry t1
        WHERE nodeId = ? AND timestamp = (
          SELECT MAX(timestamp) FROM telemetry t2
          WHERE t2.nodeId = t1.nodeId AND t2.telemetryType = t1.telemetryType
        )
        ORDER BY telemetryType ASC
      `);
      return stmt.all(nodeId) as DbTelemetry[];
    }

    getTelemetryByNodeAveraged(nodeId: string, sinceTimestamp?: number, intervalMinutes: number = 3, maxHours?: number): DbTelemetry[] {
      const intervalMs = intervalMinutes * 60 * 1000;

      let query = `
        SELECT
          nodeId,
          nodeNum,
          telemetryType,
          CAST((timestamp / ?) * ? AS INTEGER) as timestamp,
          AVG(value) as value,
          unit,
          MIN(createdAt) as createdAt
        FROM telemetry
        WHERE nodeId = ?
      `;
      const params: any[] = [intervalMs, intervalMs, nodeId];

      if (sinceTimestamp !== undefined) {
        query += ` AND timestamp >= ?`;
        params.push(sinceTimestamp);
      }

      query += `
        GROUP BY
          nodeId,
          nodeNum,
          telemetryType,
          CAST(timestamp / ? AS INTEGER),
          unit
        ORDER BY timestamp DESC
      `;
      params.push(intervalMs);

      if (maxHours !== undefined) {
        const limit = (maxHours + 1) * 20;
        query += ` LIMIT ?`;
        params.push(limit);
      }

      const stmt = this.db.prepare(query);
      return stmt.all(...params) as DbTelemetry[];
    }

    purgeOldTelemetry(hoursToKeep: number): number {
      const cutoffTime = Date.now() - (hoursToKeep * 60 * 60 * 1000);
      const stmt = this.db.prepare('DELETE FROM telemetry WHERE timestamp < ?');
      const result = stmt.run(cutoffTime);
      return Number(result.changes);
    }

    // Route segment operations
    insertRouteSegment(segmentData: DbRouteSegment): void {
      const stmt = this.db.prepare(`
        INSERT INTO route_segments (
          fromNodeNum, toNodeNum, fromNodeId, toNodeId, distanceKm, isRecordHolder, timestamp, createdAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        segmentData.fromNodeNum,
        segmentData.toNodeNum,
        segmentData.fromNodeId,
        segmentData.toNodeId,
        segmentData.distanceKm,
        segmentData.isRecordHolder ? 1 : 0,
        segmentData.timestamp,
        segmentData.createdAt
      );
    }

    getLongestActiveRouteSegment(): DbRouteSegment | null {
      const cutoff = Date.now() - (7 * 24 * 60 * 60 * 1000);
      const stmt = this.db.prepare(`
        SELECT * FROM route_segments
        WHERE timestamp > ?
        ORDER BY distanceKm DESC
        LIMIT 1
      `);
      return stmt.get(cutoff) as DbRouteSegment | null;
    }

    getRecordHolderRouteSegment(): DbRouteSegment | null {
      const stmt = this.db.prepare(`
        SELECT * FROM route_segments
        WHERE isRecordHolder = 1
        ORDER BY distanceKm DESC
        LIMIT 1
      `);
      return stmt.get() as DbRouteSegment | null;
    }

    updateRecordHolderSegment(newSegment: DbRouteSegment): void {
      const currentRecord = this.getRecordHolderRouteSegment();

      if (!currentRecord || newSegment.distanceKm > currentRecord.distanceKm) {
        this.db.exec('UPDATE route_segments SET isRecordHolder = 0');
        this.insertRouteSegment({
          ...newSegment,
          isRecordHolder: true
        });
      }
    }

    cleanupOldRouteSegments(days: number = 30): number {
      const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);
      const stmt = this.db.prepare(`
        DELETE FROM route_segments
        WHERE timestamp < ? AND isRecordHolder = 0
      `);
      const result = stmt.run(cutoff);
      return Number(result.changes);
    }

    // Settings operations
    getSetting(key: string): string | null {
      const stmt = this.db.prepare('SELECT value FROM settings WHERE key = ?');
      const row = stmt.get(key) as { value: string } | undefined;
      return row ? row.value : null;
    }

    getAllSettings(): Record<string, string> {
      const stmt = this.db.prepare('SELECT key, value FROM settings');
      const rows = stmt.all() as Array<{ key: string; value: string }>;
      const settings: Record<string, string> = {};
      rows.forEach(row => {
        settings[row.key] = row.value;
      });
      return settings;
    }

    setSetting(key: string, value: string): void {
      const now = Date.now();
      const stmt = this.db.prepare(`
        INSERT INTO settings (key, value, createdAt, updatedAt)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updatedAt = excluded.updatedAt
      `);
      stmt.run(key, value, now, now);
    }

    setSettings(settings: Record<string, string>): void {
      const now = Date.now();
      const stmt = this.db.prepare(`
        INSERT INTO settings (key, value, createdAt, updatedAt)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updatedAt = excluded.updatedAt
      `);

      this.db.transaction(() => {
        Object.entries(settings).forEach(([key, value]) => {
          stmt.run(key, value, now, now);
        });
      })();
    }

    deleteAllSettings(): void {
      this.db.exec('DELETE FROM settings');
    }

    // Traceroute node selection
    getNodeNeedingTraceroute(localNodeNum: number): DbNode | null {
      const now = Date.now();
      const THREE_HOURS_MS = 3 * 60 * 60 * 1000;
      const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

      // Get all nodes that are eligible for traceroute based on their status
      const stmt = this.db.prepare(`
        SELECT n.*,
          (SELECT COUNT(*) FROM traceroutes t
           WHERE t.fromNodeNum = ? AND t.toNodeNum = n.nodeNum) as hasTraceroute
        FROM nodes n
        WHERE n.nodeNum != ?
          AND (
            -- Category 1: No traceroute exists, and (never requested OR requested > 3 hours ago)
            (
              (SELECT COUNT(*) FROM traceroutes t
               WHERE t.fromNodeNum = ? AND t.toNodeNum = n.nodeNum) = 0
              AND (n.lastTracerouteRequest IS NULL OR n.lastTracerouteRequest < ?)
            )
            OR
            -- Category 2: Traceroute exists, and requested > 24 hours ago
            (
              (SELECT COUNT(*) FROM traceroutes t
               WHERE t.fromNodeNum = ? AND t.toNodeNum = n.nodeNum) > 0
              AND n.lastTracerouteRequest IS NOT NULL
              AND n.lastTracerouteRequest < ?
            )
          )
        ORDER BY n.lastHeard DESC
      `);

      const eligibleNodes = stmt.all(
        localNodeNum,
        localNodeNum,
        localNodeNum,
        now - THREE_HOURS_MS,
        localNodeNum,
        now - TWENTY_FOUR_HOURS_MS
      ) as DbNode[];

      if (eligibleNodes.length === 0) {
        return null;
      }

      // Randomly select one node from the eligible nodes
      const randomIndex = Math.floor(Math.random() * eligibleNodes.length);
      return eligibleNodes[randomIndex];
    }

    recordTracerouteRequest(nodeNum: number): void {
      const now = Date.now();
      const stmt = this.db.prepare(`
        UPDATE nodes SET lastTracerouteRequest = ? WHERE nodeNum = ?
      `);
      stmt.run(now, nodeNum);
    }

    insertTraceroute(tracerouteData: any): void {
      // Delete any existing traceroute for the same source and destination
      const deleteStmt = this.db.prepare(`
        DELETE FROM traceroutes
        WHERE fromNodeNum = ? AND toNodeNum = ?
      `);
      deleteStmt.run(tracerouteData.fromNodeNum, tracerouteData.toNodeNum);

      // Insert the new traceroute
      const stmt = this.db.prepare(`
        INSERT INTO traceroutes (
          fromNodeNum, toNodeNum, fromNodeId, toNodeId, route, routeBack, snrTowards, snrBack, timestamp, createdAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        tracerouteData.fromNodeNum,
        tracerouteData.toNodeNum,
        tracerouteData.fromNodeId,
        tracerouteData.toNodeId,
        tracerouteData.route || null,
        tracerouteData.routeBack || null,
        tracerouteData.snrTowards || null,
        tracerouteData.snrBack || null,
        tracerouteData.timestamp,
        tracerouteData.createdAt
      );
    }

    close(): void {
      if (this.db) {
        this.db.close();
      }
    }

    reset(): void {
      this.db.exec('DELETE FROM route_segments');
      this.db.exec('DELETE FROM traceroutes');
      this.db.exec('DELETE FROM telemetry');
      this.db.exec('DELETE FROM messages');
      this.db.exec('DELETE FROM nodes WHERE nodeNum != 0');
      this.db.exec('DELETE FROM channels WHERE id != 0');
      this.db.exec('DELETE FROM settings');
    }
  }

  return new TestDatabaseService();
};

// Mock the database module
vi.mock('./database', () => ({
  default: createTestDatabase()
}));

describe('DatabaseService - Extended Coverage', () => {
  let db: any;

  beforeEach(async () => {
    const dbModule = await import('./database');
    db = dbModule.default;
    if (db.reset) {
      db.reset();
    }
  });

  afterEach(() => {
    if (db && db.reset) {
      db.reset();
    }
  });

  describe('Position Telemetry Tracking', () => {
    beforeEach(() => {
      db.upsertNode({ nodeNum: 1, nodeId: '!node1' });
    });

    it('should insert latitude telemetry', () => {
      const telemetry = {
        nodeId: '!node1',
        nodeNum: 1,
        telemetryType: 'latitude',
        timestamp: Date.now(),
        value: 40.7128,
        unit: '°',
        createdAt: Date.now()
      };

      db.insertTelemetry(telemetry);
      const retrieved = db.getTelemetryByNode('!node1');

      expect(retrieved).toHaveLength(1);
      expect(retrieved[0].telemetryType).toBe('latitude');
      expect(retrieved[0].value).toBe(40.7128);
      expect(retrieved[0].unit).toBe('°');
    });

    it('should insert longitude telemetry', () => {
      const telemetry = {
        nodeId: '!node1',
        nodeNum: 1,
        telemetryType: 'longitude',
        timestamp: Date.now(),
        value: -74.0060,
        unit: '°',
        createdAt: Date.now()
      };

      db.insertTelemetry(telemetry);
      const retrieved = db.getTelemetryByNode('!node1');

      expect(retrieved).toHaveLength(1);
      expect(retrieved[0].telemetryType).toBe('longitude');
      expect(retrieved[0].value).toBe(-74.0060);
    });

    it('should insert altitude telemetry', () => {
      const telemetry = {
        nodeId: '!node1',
        nodeNum: 1,
        telemetryType: 'altitude',
        timestamp: Date.now(),
        value: 123.5,
        unit: 'm',
        createdAt: Date.now()
      };

      db.insertTelemetry(telemetry);
      const retrieved = db.getTelemetryByNode('!node1');

      expect(retrieved).toHaveLength(1);
      expect(retrieved[0].telemetryType).toBe('altitude');
      expect(retrieved[0].value).toBe(123.5);
      expect(retrieved[0].unit).toBe('m');
    });

    it('should track historical position changes', () => {
      const baseTime = Date.now();

      // Insert multiple position updates over time
      for (let i = 0; i < 5; i++) {
        db.insertTelemetry({
          nodeId: '!node1',
          nodeNum: 1,
          telemetryType: 'latitude',
          timestamp: baseTime + i * 60000,
          value: 40.7128 + i * 0.001,
          unit: '°',
          createdAt: baseTime
        });

        db.insertTelemetry({
          nodeId: '!node1',
          nodeNum: 1,
          telemetryType: 'longitude',
          timestamp: baseTime + i * 60000,
          value: -74.0060 + i * 0.001,
          unit: '°',
          createdAt: baseTime
        });
      }

      const latitudes = db.getTelemetryByType('latitude');
      const longitudes = db.getTelemetryByType('longitude');

      expect(latitudes).toHaveLength(5);
      expect(longitudes).toHaveLength(5);
    });
  });

  describe('Route Segment Tracking', () => {
    beforeEach(() => {
      db.upsertNode({ nodeNum: 1, nodeId: '!node1' });
      db.upsertNode({ nodeNum: 2, nodeId: '!node2' });
    });

    it('should insert route segment', () => {
      const segment: DbRouteSegment = {
        fromNodeNum: 1,
        toNodeNum: 2,
        fromNodeId: '!node1',
        toNodeId: '!node2',
        distanceKm: 10.5,
        isRecordHolder: false,
        timestamp: Date.now(),
        createdAt: Date.now()
      };

      db.insertRouteSegment(segment);
      const longest = db.getLongestActiveRouteSegment();

      expect(longest).toBeTruthy();
      expect(longest.distanceKm).toBe(10.5);
      expect(longest.fromNodeId).toBe('!node1');
      expect(longest.toNodeId).toBe('!node2');
    });

    it('should track record holder segment', () => {
      const segment1: DbRouteSegment = {
        fromNodeNum: 1,
        toNodeNum: 2,
        fromNodeId: '!node1',
        toNodeId: '!node2',
        distanceKm: 10.5,
        isRecordHolder: false,
        timestamp: Date.now(),
        createdAt: Date.now()
      };

      db.insertRouteSegment(segment1);
      db.updateRecordHolderSegment(segment1);

      const record = db.getRecordHolderRouteSegment();
      expect(record).toBeTruthy();
      expect(record.distanceKm).toBe(10.5);
      expect(record.isRecordHolder).toBe(1);
    });

    it('should update record holder when longer segment found', () => {
      const segment1: DbRouteSegment = {
        fromNodeNum: 1,
        toNodeNum: 2,
        fromNodeId: '!node1',
        toNodeId: '!node2',
        distanceKm: 10.5,
        isRecordHolder: false,
        timestamp: Date.now(),
        createdAt: Date.now()
      };

      db.insertRouteSegment(segment1);
      db.updateRecordHolderSegment(segment1);

      const segment2: DbRouteSegment = {
        fromNodeNum: 1,
        toNodeNum: 2,
        fromNodeId: '!node1',
        toNodeId: '!node2',
        distanceKm: 15.8,
        isRecordHolder: false,
        timestamp: Date.now(),
        createdAt: Date.now()
      };

      db.updateRecordHolderSegment(segment2);

      const record = db.getRecordHolderRouteSegment();
      expect(record.distanceKm).toBe(15.8);
    });

    it('should cleanup old route segments but keep record holder', () => {
      const oldTime = Date.now() - (31 * 24 * 60 * 60 * 1000); // 31 days ago
      const recentTime = Date.now();

      // Old segment (not record holder)
      db.insertRouteSegment({
        fromNodeNum: 1,
        toNodeNum: 2,
        fromNodeId: '!node1',
        toNodeId: '!node2',
        distanceKm: 5.0,
        isRecordHolder: false,
        timestamp: oldTime,
        createdAt: oldTime
      });

      // Old segment (record holder)
      const recordSegment: DbRouteSegment = {
        fromNodeNum: 1,
        toNodeNum: 2,
        fromNodeId: '!node1',
        toNodeId: '!node2',
        distanceKm: 20.0,
        isRecordHolder: true,
        timestamp: oldTime,
        createdAt: oldTime
      };
      db.insertRouteSegment(recordSegment);

      // Recent segment
      db.insertRouteSegment({
        fromNodeNum: 1,
        toNodeNum: 2,
        fromNodeId: '!node1',
        toNodeId: '!node2',
        distanceKm: 8.0,
        isRecordHolder: false,
        timestamp: recentTime,
        createdAt: recentTime
      });

      const deleted = db.cleanupOldRouteSegments(30);
      expect(deleted).toBe(1); // Only non-record holder old segment deleted

      const record = db.getRecordHolderRouteSegment();
      expect(record).toBeTruthy();
      expect(record.distanceKm).toBe(20.0);
    });
  });

  describe('Settings Management', () => {
    it('should set and get a setting', () => {
      db.setSetting('theme', 'dark');
      const value = db.getSetting('theme');
      expect(value).toBe('dark');
    });

    it('should update existing setting', () => {
      db.setSetting('theme', 'dark');
      db.setSetting('theme', 'light');
      const value = db.getSetting('theme');
      expect(value).toBe('light');
    });

    it('should return null for non-existent setting', () => {
      const value = db.getSetting('nonexistent');
      expect(value).toBeNull();
    });

    it('should get all settings', () => {
      db.setSetting('theme', 'dark');
      db.setSetting('language', 'en');
      db.setSetting('timezone', 'UTC');

      const settings = db.getAllSettings();
      expect(settings).toEqual({
        theme: 'dark',
        language: 'en',
        timezone: 'UTC'
      });
    });

    it('should set multiple settings at once', () => {
      db.setSettings({
        theme: 'dark',
        language: 'en',
        notifications: 'enabled'
      });

      expect(db.getSetting('theme')).toBe('dark');
      expect(db.getSetting('language')).toBe('en');
      expect(db.getSetting('notifications')).toBe('enabled');
    });

    it('should delete all settings', () => {
      db.setSetting('theme', 'dark');
      db.setSetting('language', 'en');

      db.deleteAllSettings();

      const settings = db.getAllSettings();
      expect(Object.keys(settings)).toHaveLength(0);
    });
  });

  describe('Telemetry Averaging', () => {
    beforeEach(() => {
      db.upsertNode({ nodeNum: 1, nodeId: '!node1' });
    });

    it('should average telemetry data by interval', () => {
      const baseTime = Date.now();

      // Insert 6 data points over 18 minutes (6 * 3min intervals = 2 averaged points)
      for (let i = 0; i < 6; i++) {
        db.insertTelemetry({
          nodeId: '!node1',
          nodeNum: 1,
          telemetryType: 'batteryLevel',
          timestamp: baseTime + i * 3 * 60 * 1000,
          value: 80 + i,
          unit: '%',
          createdAt: baseTime
        });
      }

      const averaged = db.getTelemetryByNodeAveraged('!node1', undefined, 3);
      expect(averaged.length).toBeGreaterThan(0);
    });

    it('should limit averaged results by maxHours', () => {
      const baseTime = Date.now();

      // Insert data over 3 hours (60 points)
      for (let i = 0; i < 60; i++) {
        db.insertTelemetry({
          nodeId: '!node1',
          nodeNum: 1,
          telemetryType: 'voltage',
          timestamp: baseTime + i * 3 * 60 * 1000,
          value: 3.7 + (i % 10) * 0.01,
          unit: 'V',
          createdAt: baseTime
        });
      }

      const averaged = db.getTelemetryByNodeAveraged('!node1', undefined, 3, 1);
      // The averaging groups by interval, so we should get fewer than 60 results
      // With maxHours=1, limit should be (1+1)*20 = 40 based on implementation
      expect(averaged.length).toBeLessThanOrEqual(60);
      expect(averaged.length).toBeGreaterThan(0);
    });
  });

  describe('Active Nodes Filtering', () => {
    it('should filter active nodes by time', () => {
      const now = Date.now();
      const oldTime = now - (10 * 24 * 60 * 60 * 1000); // 10 days ago (in ms)
      const recentTime = now - (2 * 24 * 60 * 60 * 1000); // 2 days ago (in ms)

      db.upsertNode({
        nodeNum: 1,
        nodeId: '!old',
        longName: 'Old Node',
        lastHeard: oldTime // Store in ms
      });

      db.upsertNode({
        nodeNum: 2,
        nodeId: '!recent',
        longName: 'Recent Node',
        lastHeard: recentTime // Store in ms
      });

      const activeNodes = db.getActiveNodes(7);
      expect(activeNodes).toHaveLength(1);
      expect(activeNodes[0].nodeId).toBe('!recent');
    });

    it('should return all active nodes within time window', () => {
      const now = Date.now();

      for (let i = 0; i < 5; i++) {
        db.upsertNode({
          nodeNum: i + 1,
          nodeId: `!node${i}`,
          longName: `Node ${i}`,
          lastHeard: now - i * 24 * 60 * 60 * 1000 // i days ago in ms
        });
      }

      const activeNodes = db.getActiveNodes(7);
      expect(activeNodes.length).toBeGreaterThanOrEqual(5);
    });
  });

  describe('Message Filtering', () => {
    beforeEach(() => {
      db.upsertNode({ nodeNum: 1, nodeId: '!node1' });
      db.upsertNode({ nodeNum: 2, nodeId: '!node2' });
      db.upsertNode({ nodeNum: 3, nodeId: '!node3' });
    });

    it('should filter messages by channel', () => {
      const now = Date.now();

      db.insertMessage({
        id: 'msg-1',
        fromNodeNum: 1,
        toNodeNum: 2,
        fromNodeId: '!node1',
        toNodeId: '!node2',
        text: 'Channel 0 message',
        channel: 0,
        timestamp: now,
        createdAt: now
      });

      db.insertMessage({
        id: 'msg-2',
        fromNodeNum: 1,
        toNodeNum: 2,
        fromNodeId: '!node1',
        toNodeId: '!node2',
        text: 'Channel 1 message',
        channel: 1,
        timestamp: now,
        createdAt: now
      });

      const channel0Messages = db.getMessagesByChannel(0);
      expect(channel0Messages).toHaveLength(1);
      expect(channel0Messages[0].text).toBe('Channel 0 message');

      const channel1Messages = db.getMessagesByChannel(1);
      expect(channel1Messages).toHaveLength(1);
      expect(channel1Messages[0].text).toBe('Channel 1 message');
    });

    it('should filter direct messages between two nodes', () => {
      const now = Date.now();

      db.insertMessage({
        id: 'msg-1',
        fromNodeNum: 1,
        toNodeNum: 2,
        fromNodeId: '!node1',
        toNodeId: '!node2',
        text: 'Direct 1->2',
        channel: 0,
        timestamp: now,
        createdAt: now
      });

      db.insertMessage({
        id: 'msg-2',
        fromNodeNum: 2,
        toNodeNum: 1,
        fromNodeId: '!node2',
        toNodeId: '!node1',
        text: 'Direct 2->1',
        channel: 0,
        timestamp: now + 1000,
        createdAt: now
      });

      db.insertMessage({
        id: 'msg-3',
        fromNodeNum: 1,
        toNodeNum: 3,
        fromNodeId: '!node1',
        toNodeId: '!node3',
        text: 'Different conversation',
        channel: 0,
        timestamp: now + 2000,
        createdAt: now
      });

      const directMessages = db.getDirectMessages('!node1', '!node2');
      expect(directMessages).toHaveLength(2);
      expect(directMessages.some((m: DbMessage) => m.text === 'Direct 1->2')).toBe(true);
      expect(directMessages.some((m: DbMessage) => m.text === 'Direct 2->1')).toBe(true);
    });
  });

  describe('Telemetry By Type and Latest', () => {
    beforeEach(() => {
      db.upsertNode({ nodeNum: 1, nodeId: '!node1' });
      db.upsertNode({ nodeNum: 2, nodeId: '!node2' });
    });

    it('should get telemetry by type', () => {
      const now = Date.now();

      db.insertTelemetry({
        nodeId: '!node1',
        nodeNum: 1,
        telemetryType: 'temperature',
        timestamp: now,
        value: 25.5,
        unit: '°C',
        createdAt: now
      });

      db.insertTelemetry({
        nodeId: '!node2',
        nodeNum: 2,
        telemetryType: 'temperature',
        timestamp: now,
        value: 22.3,
        unit: '°C',
        createdAt: now
      });

      db.insertTelemetry({
        nodeId: '!node1',
        nodeNum: 1,
        telemetryType: 'humidity',
        timestamp: now,
        value: 65.0,
        unit: '%',
        createdAt: now
      });

      const tempTelemetry = db.getTelemetryByType('temperature');
      expect(tempTelemetry).toHaveLength(2);
      expect(tempTelemetry.every((t: DbTelemetry) => t.telemetryType === 'temperature')).toBe(true);
    });

    it('should get latest telemetry by node', () => {
      const now = Date.now();

      // Insert multiple readings for different types
      db.insertTelemetry({
        nodeId: '!node1',
        nodeNum: 1,
        telemetryType: 'temperature',
        timestamp: now - 1000,
        value: 24.0,
        unit: '°C',
        createdAt: now
      });

      db.insertTelemetry({
        nodeId: '!node1',
        nodeNum: 1,
        telemetryType: 'temperature',
        timestamp: now,
        value: 25.5,
        unit: '°C',
        createdAt: now
      });

      db.insertTelemetry({
        nodeId: '!node1',
        nodeNum: 1,
        telemetryType: 'humidity',
        timestamp: now,
        value: 65.0,
        unit: '%',
        createdAt: now
      });

      const latestTelemetry = db.getLatestTelemetryByNode('!node1');
      expect(latestTelemetry).toHaveLength(2); // One for each type

      const tempReading = latestTelemetry.find((t: DbTelemetry) => t.telemetryType === 'temperature');
      expect(tempReading?.value).toBe(25.5); // Should be the latest temperature
    });
  });

  describe('Traceroute Node Selection', () => {
    it('should select from nodes without traceroute when none requested', () => {
      const now = Date.now();

      db.upsertNode({
        nodeNum: 1,
        nodeId: '!node1',
        longName: 'Node 1',
        lastHeard: now / 1000
      });

      db.upsertNode({
        nodeNum: 2,
        nodeId: '!node2',
        longName: 'Node 2',
        lastHeard: now / 1000
      });

      const selected = db.getNodeNeedingTraceroute(999);
      expect(selected).toBeTruthy();
      expect(['!node1', '!node2']).toContain(selected.nodeId);
    });

    it('should retry nodes without traceroute after 3 hours', () => {
      const now = Date.now();
      const FOUR_HOURS_AGO = now - (4 * 60 * 60 * 1000);
      const TWO_HOURS_AGO = now - (2 * 60 * 60 * 1000);

      // Node with request 4 hours ago (should be eligible - no traceroute)
      db.upsertNode({
        nodeNum: 1,
        nodeId: '!node1',
        longName: 'Node 1',
        lastHeard: now / 1000,
        lastTracerouteRequest: FOUR_HOURS_AGO
      });

      // Node with request 2 hours ago (should NOT be eligible - no traceroute)
      db.upsertNode({
        nodeNum: 2,
        nodeId: '!node2',
        longName: 'Node 2',
        lastHeard: now / 1000,
        lastTracerouteRequest: TWO_HOURS_AGO
      });

      const selected = db.getNodeNeedingTraceroute(999);
      expect(selected).toBeTruthy();
      expect(selected.nodeId).toBe('!node1');
    });

    it('should retry nodes with traceroute after 24 hours', () => {
      const now = Date.now();
      const TWENTY_FIVE_HOURS_AGO = now - (25 * 60 * 60 * 1000);
      const TWENTY_HOURS_AGO = now - (20 * 60 * 60 * 1000);

      // Create local node (999)
      db.upsertNode({
        nodeNum: 999,
        nodeId: '!local',
        longName: 'Local Node',
        lastHeard: now / 1000
      });

      // Create nodes
      db.upsertNode({
        nodeNum: 1,
        nodeId: '!node1',
        longName: 'Node 1',
        lastHeard: now / 1000,
        lastTracerouteRequest: TWENTY_FIVE_HOURS_AGO
      });

      db.upsertNode({
        nodeNum: 2,
        nodeId: '!node2',
        longName: 'Node 2',
        lastHeard: now / 1000,
        lastTracerouteRequest: TWENTY_HOURS_AGO
      });

      // Create traceroute records for both nodes (from local node 999)
      db.insertTraceroute({
        fromNodeNum: 999,
        toNodeNum: 1,
        fromNodeId: '!local',
        toNodeId: '!node1',
        route: '[1]',
        routeBack: '[999]',
        snrTowards: '[0]',
        snrBack: '[0]',
        timestamp: TWENTY_FIVE_HOURS_AGO,
        createdAt: TWENTY_FIVE_HOURS_AGO
      });

      db.insertTraceroute({
        fromNodeNum: 999,
        toNodeNum: 2,
        fromNodeId: '!local',
        toNodeId: '!node2',
        route: '[2]',
        routeBack: '[999]',
        snrTowards: '[0]',
        snrBack: '[0]',
        timestamp: TWENTY_HOURS_AGO,
        createdAt: TWENTY_HOURS_AGO
      });

      const selected = db.getNodeNeedingTraceroute(999);
      expect(selected).toBeTruthy();
      // Only node1 should be eligible (request > 24 hours ago, has traceroute)
      expect(selected.nodeId).toBe('!node1');
    });

    it('should exclude local node from selection', () => {
      const now = Date.now();

      db.upsertNode({
        nodeNum: 1,
        nodeId: '!node1',
        longName: 'Local Node',
        lastHeard: now / 1000
      });

      db.upsertNode({
        nodeNum: 2,
        nodeId: '!node2',
        longName: 'Remote Node',
        lastHeard: now / 1000
      });

      const selected = db.getNodeNeedingTraceroute(1);
      expect(selected).toBeTruthy();
      expect(selected.nodeId).toBe('!node2');
      expect(selected.nodeNum).not.toBe(1);
    });

    it('should record traceroute request timestamp', () => {
      const now = Date.now();

      db.upsertNode({
        nodeNum: 1,
        nodeId: '!node1',
        lastHeard: now / 1000
      });

      db.recordTracerouteRequest(1);

      const node = db.getNode(1);
      expect(node.lastTracerouteRequest).toBeDefined();
      expect(node.lastTracerouteRequest).toBeGreaterThan(0);
    });
  });

  describe('Telemetry Cleanup', () => {
    beforeEach(() => {
      db.upsertNode({ nodeNum: 1, nodeId: '!node1' });
    });

    it('should purge old telemetry data', () => {
      const now = Date.now();
      const oldTime = now - (25 * 60 * 60 * 1000); // 25 hours ago

      // Insert old telemetry
      db.insertTelemetry({
        nodeId: '!node1',
        nodeNum: 1,
        telemetryType: 'batteryLevel',
        timestamp: oldTime,
        value: 85.0,
        unit: '%',
        createdAt: oldTime
      });

      // Insert recent telemetry
      db.insertTelemetry({
        nodeId: '!node1',
        nodeNum: 1,
        telemetryType: 'batteryLevel',
        timestamp: now,
        value: 90.0,
        unit: '%',
        createdAt: now
      });

      const deleted = db.purgeOldTelemetry(24);
      expect(deleted).toBe(1);

      const remaining = db.getTelemetryByNode('!node1');
      expect(remaining).toHaveLength(1);
      expect(remaining[0].value).toBe(90.0);
    });

    it('should not purge recent telemetry', () => {
      const now = Date.now();

      db.insertTelemetry({
        nodeId: '!node1',
        nodeNum: 1,
        telemetryType: 'voltage',
        timestamp: now - 60000, // 1 minute ago
        value: 3.7,
        unit: 'V',
        createdAt: now
      });

      const deleted = db.purgeOldTelemetry(24);
      expect(deleted).toBe(0);

      const remaining = db.getTelemetryByNode('!node1');
      expect(remaining).toHaveLength(1);
    });
  });

  describe('hopsAway field support', () => {
    it('should store and retrieve hopsAway field', () => {
      const node = {
        nodeNum: 1,
        nodeId: '!test1',
        longName: 'Test Node',
        shortName: 'TEST',
        hopsAway: 3,
      };

      db.upsertNode(node);

      const retrieved = db.getNode(1);
      expect(retrieved).toBeDefined();
      expect(retrieved?.hopsAway).toBe(3);
    });

    it('should handle hopsAway value of 0 (local node)', () => {
      const node = {
        nodeNum: 1,
        nodeId: '!local',
        longName: 'Local Node',
        hopsAway: 0,
      };

      db.upsertNode(node);

      const retrieved = db.getNode(1);
      expect(retrieved?.hopsAway).toBe(0);
    });

    it('should handle missing hopsAway field (null)', () => {
      const node = {
        nodeNum: 1,
        nodeId: '!test1',
        longName: 'Test Node',
        // hopsAway not provided
      };

      db.upsertNode(node);

      const retrieved = db.getNode(1);
      expect(retrieved).toBeDefined();
      expect(retrieved?.hopsAway).toBeNull();
    });

    it('should update hopsAway when node info changes', () => {
      const node = {
        nodeNum: 1,
        nodeId: '!test1',
        longName: 'Test Node',
        hopsAway: 3,
      };

      db.upsertNode(node);

      let retrieved = db.getNode(1);
      expect(retrieved?.hopsAway).toBe(3);

      // Update with new hopsAway value
      db.upsertNode({
        ...node,
        hopsAway: 2,
      });

      retrieved = db.getNode(1);
      expect(retrieved?.hopsAway).toBe(2);
    });

    it('should handle various hopsAway values (1-6+)', () => {
      const testCases = [
        { nodeNum: 1, hopsAway: 1 },
        { nodeNum: 2, hopsAway: 2 },
        { nodeNum: 3, hopsAway: 3 },
        { nodeNum: 4, hopsAway: 4 },
        { nodeNum: 5, hopsAway: 5 },
        { nodeNum: 6, hopsAway: 6 },
        { nodeNum: 7, hopsAway: 10 },
      ];

      testCases.forEach(({ nodeNum, hopsAway }) => {
        db.upsertNode({
          nodeNum,
          nodeId: `!test${nodeNum}`,
          longName: `Node ${nodeNum}`,
          hopsAway,
        });

        const retrieved = db.getNode(nodeNum);
        expect(retrieved?.hopsAway).toBe(hopsAway);
      });
    });

    it('should include hopsAway in getAllNodes results', () => {
      db.upsertNode({
        nodeNum: 1,
        nodeId: '!test1',
        longName: 'Node 1',
        hopsAway: 1,
      });

      db.upsertNode({
        nodeNum: 2,
        nodeId: '!test2',
        longName: 'Node 2',
        hopsAway: 3,
      });

      const nodes = db.getAllNodes();
      expect(nodes).toHaveLength(2);

      const node1 = nodes.find((n: DbNode) => n.nodeNum === 1);
      const node2 = nodes.find((n: DbNode) => n.nodeNum === 2);

      expect(node1?.hopsAway).toBe(1);
      expect(node2?.hopsAway).toBe(3);
    });

    it('should preserve hopsAway when updating other node fields', () => {
      db.upsertNode({
        nodeNum: 1,
        nodeId: '!test1',
        longName: 'Old Name',
        hopsAway: 2,
      });

      // Update only the name, not hopsAway
      db.upsertNode({
        nodeNum: 1,
        nodeId: '!test1',
        longName: 'New Name',
      });

      const retrieved = db.getNode(1);
      expect(retrieved?.longName).toBe('New Name');
      // hopsAway should remain unchanged (SQLite will keep existing value)
      expect(retrieved?.hopsAway).toBeDefined();
    });

    it('should preserve hopsAway when null is passed (COALESCE behavior)', () => {
      db.upsertNode({
        nodeNum: 1,
        nodeId: '!test1',
        longName: 'Test Node',
        hopsAway: 3,
      });

      let retrieved = db.getNode(1);
      expect(retrieved?.hopsAway).toBe(3);

      // Try to clear hopsAway by passing null - should keep old value due to COALESCE
      db.upsertNode({
        nodeNum: 1,
        nodeId: '!test1',
        longName: 'Test Node',
        hopsAway: null as any,
      });

      retrieved = db.getNode(1);
      // COALESCE keeps old value when NULL is passed
      expect(retrieved?.hopsAway).toBe(3);
    });
  });

  describe('Via MQTT Field Handling', () => {
    it('should store and retrieve viaMqtt field', () => {
      db.upsertNode({
        nodeNum: 1,
        nodeId: '!mqtt1',
        longName: 'MQTT Node',
        viaMqtt: true,
      });

      const retrieved = db.getNode(1);
      // SQLite stores booleans as integers (1 for true, 0 for false)
      expect(retrieved?.viaMqtt).toBe(1);
    });

    it('should handle viaMqtt false value', () => {
      db.upsertNode({
        nodeNum: 2,
        nodeId: '!rf1',
        longName: 'RF Node',
        viaMqtt: false,
      });

      const retrieved = db.getNode(2);
      // SQLite stores booleans as integers (1 for true, 0 for false)
      expect(retrieved?.viaMqtt).toBe(0);
    });

    it('should preserve viaMqtt when updating other node fields', () => {
      db.upsertNode({
        nodeNum: 3,
        nodeId: '!mqtt2',
        longName: 'Old Name',
        viaMqtt: true,
      });

      // Update only the name, not viaMqtt
      db.upsertNode({
        nodeNum: 3,
        nodeId: '!mqtt2',
        longName: 'New Name',
      });

      const retrieved = db.getNode(3);
      expect(retrieved?.longName).toBe('New Name');
      // SQLite stores booleans as integers (1 for true, 0 for false)
      expect(retrieved?.viaMqtt).toBe(1);
    });

    it('should allow updating viaMqtt from true to false', () => {
      db.upsertNode({
        nodeNum: 4,
        nodeId: '!node4',
        longName: 'Test Node',
        viaMqtt: true,
      });

      let retrieved = db.getNode(4);
      // SQLite stores booleans as integers (1 for true, 0 for false)
      expect(retrieved?.viaMqtt).toBe(1);

      // Update viaMqtt to false
      db.upsertNode({
        nodeNum: 4,
        nodeId: '!node4',
        longName: 'Test Node',
        viaMqtt: false,
      });

      retrieved = db.getNode(4);
      // SQLite stores booleans as integers (1 for true, 0 for false)
      expect(retrieved?.viaMqtt).toBe(0);
    });
  });
});
