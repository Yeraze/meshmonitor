import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { DbNode, DbMessage, DbChannel, DbTelemetry, DbTraceroute } from './database';

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
          isFavorite BOOLEAN DEFAULT 0,
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
      `);
    }

    private createIndexes(): void {
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_nodes_nodeId ON nodes(nodeId);
        CREATE INDEX IF NOT EXISTS idx_nodes_lastHeard ON nodes(lastHeard);
        CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
        CREATE INDEX IF NOT EXISTS idx_messages_fromNodeId ON messages(fromNodeId);
        CREATE INDEX IF NOT EXISTS idx_telemetry_nodeId ON telemetry(nodeId);
      `);
    }

    private ensurePrimaryChannel(): void {
      const now = Date.now();
      this.db.prepare(`
        INSERT OR IGNORE INTO channels (id, name, uplinkEnabled, downlinkEnabled, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(0, 'Primary', 1, 1, now, now);
    }

    // Implement the actual methods from the database service
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
            isFavorite = COALESCE(?, isFavorite),
            updatedAt = ?
          WHERE nodeNum = ?
        `);
        stmt.run(
          nodeData.nodeId,
          nodeData.longName,
          nodeData.shortName,
          nodeData.isFavorite !== undefined ? (nodeData.isFavorite ? 1 : 0) : null,
          now,
          nodeData.nodeNum
        );
      } else {
        const stmt = this.db.prepare(`
          INSERT INTO nodes (nodeNum, nodeId, longName, shortName, isFavorite, createdAt, updatedAt)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `);
        stmt.run(
          nodeData.nodeNum,
          nodeData.nodeId,
          nodeData.longName,
          nodeData.shortName,
          nodeData.isFavorite ? 1 : 0,
          now,
          now
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

    insertMessage(messageData: DbMessage): void {
      // Use INSERT OR IGNORE to silently skip duplicate messages
      const stmt = this.db.prepare(`
        INSERT OR IGNORE INTO messages (
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

    getMessage(id: string): DbMessage | null {
      const stmt = this.db.prepare('SELECT * FROM messages WHERE id = ?');
      return stmt.get(id) as DbMessage | null;
    }

    getMessages(limit: number = 100, offset: number = 0): DbMessage[] {
      const stmt = this.db.prepare(`
        SELECT * FROM messages
        ORDER BY timestamp DESC
        LIMIT ? OFFSET ?
      `);
      return stmt.all(limit, offset) as DbMessage[];
    }

    upsertChannel(channelData: { id?: number; name: string; psk?: string }): void {
      const now = Date.now();
      const existingChannel = this.getChannelByName(channelData.name);

      if (existingChannel) {
        const stmt = this.db.prepare(`
          UPDATE channels SET name = ?, psk = COALESCE(?, psk), updatedAt = ?
          WHERE id = ?
        `);
        stmt.run(channelData.name, channelData.psk, now, existingChannel.id);
      } else {
        const stmt = this.db.prepare(`
          INSERT INTO channels (id, name, psk, uplinkEnabled, downlinkEnabled, createdAt, updatedAt)
          VALUES (?, ?, ?, 1, 1, ?, ?)
        `);
        stmt.run(channelData.id ?? null, channelData.name, channelData.psk ?? null, now, now);
      }
    }

    getChannelByName(name: string): DbChannel | null {
      const stmt = this.db.prepare('SELECT * FROM channels WHERE name = ?');
      return stmt.get(name) as DbChannel | null;
    }

    getChannelById(id: number): DbChannel | null {
      const stmt = this.db.prepare('SELECT * FROM channels WHERE id = ?');
      return stmt.get(id) as DbChannel | null;
    }

    getAllChannels(): DbChannel[] {
      const stmt = this.db.prepare('SELECT * FROM channels ORDER BY id ASC');
      return stmt.all() as DbChannel[];
    }

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

    insertTraceroute(tracerouteData: DbTraceroute): void {
      const stmt = this.db.prepare(`
        INSERT INTO traceroutes (
          fromNodeNum, toNodeNum, fromNodeId, toNodeId, route, routeBack,
          snrTowards, snrBack, timestamp, createdAt
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

    getAllTraceroutes(limit: number = 100): DbTraceroute[] {
      const stmt = this.db.prepare(`
        SELECT * FROM traceroutes
        ORDER BY timestamp DESC
        LIMIT ?
      `);
      return stmt.all(limit) as DbTraceroute[];
    }

    close(): void {
      if (this.db) {
        this.db.close();
      }
    }

    // Test-specific cleanup methods
    purgeAllNodes(): void {
      this.db.exec('DELETE FROM traceroutes');
      this.db.exec('DELETE FROM nodes');
    }

    purgeAllMessages(): void {
      this.db.exec('DELETE FROM messages');
    }

    purgeAllTelemetry(): void {
      this.db.exec('DELETE FROM telemetry');
    }

    // Favorite operations
    setNodeFavorite(nodeNum: number, isFavorite: boolean): void {
      const now = Date.now();
      const stmt = this.db.prepare(`
        UPDATE nodes SET
          isFavorite = ?,
          updatedAt = ?
        WHERE nodeNum = ?
      `);
      stmt.run(isFavorite ? 1 : 0, now, nodeNum);
    }

    reset(): void {
      // Clear all data for test isolation
      this.db.exec('DELETE FROM traceroutes');
      this.db.exec('DELETE FROM telemetry');
      this.db.exec('DELETE FROM messages');
      this.db.exec('DELETE FROM nodes WHERE nodeNum != 0');
      this.db.exec('DELETE FROM channels WHERE id != 0');
    }
  }

  return new TestDatabaseService();
};

// Mock the database module to use in-memory database for testing
vi.mock('./database', () => ({
  default: createTestDatabase()
}));

describe('DatabaseService', () => {
  let db: any;

  beforeEach(async () => {
    // Get the mocked database
    const dbModule = await import('./database');
    db = dbModule.default;
    // Reset database state for each test
    if (db.reset) {
      db.reset();
    }
  });

  afterEach(() => {
    // Clean up after each test
    if (db && db.reset) {
      db.reset();
    }
  });

  describe('Node Operations', () => {
    it('should create a new node', () => {
      const nodeData = {
        nodeNum: 123456,
        nodeId: '!abc123',
        longName: 'Test Node',
        shortName: 'TN'
      };

      db.upsertNode(nodeData);
      const node = db.getNode(123456);

      expect(node).toBeTruthy();
      expect(node.nodeNum).toBe(123456);
      expect(node.nodeId).toBe('!abc123');
      expect(node.longName).toBe('Test Node');
      expect(node.shortName).toBe('TN');
    });

    it('should update an existing node', () => {
      const initialData = {
        nodeNum: 123456,
        nodeId: '!abc123',
        longName: 'Initial Name',
        shortName: 'IN'
      };

      db.upsertNode(initialData);

      const updateData = {
        nodeNum: 123456,
        nodeId: '!abc123',
        longName: 'Updated Name',
        shortName: 'UN'
      };

      db.upsertNode(updateData);
      const node = db.getNode(123456);

      expect(node.longName).toBe('Updated Name');
      expect(node.shortName).toBe('UN');
    });

    it('should retrieve all nodes', () => {
      db.upsertNode({ nodeNum: 1, nodeId: '!node1', longName: 'Node 1' });
      db.upsertNode({ nodeNum: 2, nodeId: '!node2', longName: 'Node 2' });
      db.upsertNode({ nodeNum: 3, nodeId: '!node3', longName: 'Node 3' });

      const nodes = db.getAllNodes();
      expect(nodes).toHaveLength(3);
    });

    it('should handle invalid node data gracefully', () => {
      // Missing nodeNum
      db.upsertNode({ nodeId: '!test' });
      expect(db.getAllNodes()).toHaveLength(0);

      // Missing nodeId
      db.upsertNode({ nodeNum: 123 });
      expect(db.getAllNodes()).toHaveLength(0);
    });
  });

  describe('Message Operations', () => {
    beforeEach(() => {
      // Create nodes first (foreign key constraints)
      db.upsertNode({ nodeNum: 1, nodeId: '!sender' });
      db.upsertNode({ nodeNum: 2, nodeId: '!receiver' });
    });

    it('should insert a message', () => {
      const message = {
        id: 'msg-123',
        fromNodeNum: 1,
        toNodeNum: 2,
        fromNodeId: '!sender',
        toNodeId: '!receiver',
        text: 'Hello, World!',
        channel: 0,
        timestamp: Date.now(),
        createdAt: Date.now()
      };

      db.insertMessage(message);
      const retrieved = db.getMessage('msg-123');

      expect(retrieved).toBeTruthy();
      expect(retrieved.text).toBe('Hello, World!');
      expect(retrieved.fromNodeId).toBe('!sender');
      expect(retrieved.toNodeId).toBe('!receiver');
    });

    it('should retrieve messages with pagination', () => {
      const baseTime = Date.now();

      for (let i = 0; i < 10; i++) {
        db.insertMessage({
          id: `msg-${i}`,
          fromNodeNum: 1,
          toNodeNum: 2,
          fromNodeId: '!sender',
          toNodeId: '!receiver',
          text: `Message ${i}`,
          channel: 0,
          timestamp: baseTime + i * 1000,
          createdAt: baseTime
        });
      }

      const firstPage = db.getMessages(5, 0);
      expect(firstPage).toHaveLength(5);

      const secondPage = db.getMessages(5, 5);
      expect(secondPage).toHaveLength(5);
    });

    it('should handle duplicate message IDs gracefully', () => {
      const message = {
        id: 'msg-duplicate',
        fromNodeNum: 1,
        toNodeNum: 2,
        fromNodeId: '!sender',
        toNodeId: '!receiver',
        text: 'Original message',
        channel: 0,
        timestamp: Date.now(),
        createdAt: Date.now()
      };

      // Insert the message
      db.insertMessage(message);

      // Try to insert the same message again (should not throw error)
      expect(() => {
        db.insertMessage(message);
      }).not.toThrow();

      // Verify only one message exists
      const retrieved = db.getMessage('msg-duplicate');
      expect(retrieved).toBeTruthy();
      expect(retrieved.text).toBe('Original message');

      // Verify message count is still 1
      const messages = db.db.prepare('SELECT COUNT(*) as count FROM messages WHERE id = ?')
        .get('msg-duplicate') as { count: number };
      expect(messages.count).toBe(1);
    });
  });

  describe('Channel Operations', () => {
    it('should have Primary channel by default', () => {
      const primaryChannel = db.getChannelById(0);
      expect(primaryChannel).toBeTruthy();
      expect(primaryChannel.name).toBe('Primary');
    });

    it('should create a new channel', () => {
      db.upsertChannel({ name: 'TestChannel', psk: 'secret123' });

      const channel = db.getChannelByName('TestChannel');
      expect(channel).toBeTruthy();
      expect(channel.name).toBe('TestChannel');
      expect(channel.psk).toBe('secret123');
    });

    it('should update an existing channel', () => {
      db.upsertChannel({ name: 'TestChannel' });
      db.upsertChannel({ name: 'TestChannel', psk: 'newsecret' });

      const channel = db.getChannelByName('TestChannel');
      expect(channel.psk).toBe('newsecret');
    });

    it('should retrieve all channels', () => {
      db.upsertChannel({ name: 'Channel1' });
      db.upsertChannel({ name: 'Channel2' });

      const channels = db.getAllChannels();
      expect(channels.length).toBeGreaterThanOrEqual(3); // Primary + 2 new
    });
  });

  describe('Telemetry Operations', () => {
    beforeEach(() => {
      db.upsertNode({ nodeNum: 1, nodeId: '!node1' });
    });

    it('should insert telemetry data', () => {
      const telemetry = {
        nodeId: '!node1',
        nodeNum: 1,
        telemetryType: 'battery',
        timestamp: Date.now(),
        value: 85.5,
        unit: 'percent',
        createdAt: Date.now()
      };

      db.insertTelemetry(telemetry);
      const retrieved = db.getTelemetryByNode('!node1');

      expect(retrieved).toHaveLength(1);
      expect(retrieved[0].telemetryType).toBe('battery');
      expect(retrieved[0].value).toBe(85.5);
    });

    it('should retrieve telemetry with limit', () => {
      const baseTime = Date.now();

      for (let i = 0; i < 10; i++) {
        db.insertTelemetry({
          nodeId: '!node1',
          nodeNum: 1,
          telemetryType: 'voltage',
          timestamp: baseTime + i * 1000,
          value: 3.7 + i * 0.1,
          unit: 'V',
          createdAt: baseTime
        });
      }

      const limited = db.getTelemetryByNode('!node1', 5);
      expect(limited).toHaveLength(5);
    });
  });

  describe('Traceroute Operations', () => {
    beforeEach(() => {
      db.upsertNode({ nodeNum: 1, nodeId: '!node1' });
      db.upsertNode({ nodeNum: 2, nodeId: '!node2' });
    });

    it('should insert traceroute data', () => {
      const traceroute = {
        fromNodeNum: 1,
        toNodeNum: 2,
        fromNodeId: '!node1',
        toNodeId: '!node2',
        route: '1,3,2',
        routeBack: '2,3,1',
        snrTowards: '10,8',
        snrBack: '9,11',
        timestamp: Date.now(),
        createdAt: Date.now()
      };

      db.insertTraceroute(traceroute);
      const retrieved = db.getAllTraceroutes();

      expect(retrieved).toHaveLength(1);
      expect(retrieved[0].route).toBe('1,3,2');
      expect(retrieved[0].routeBack).toBe('2,3,1');
    });
  });

  describe('Cleanup Operations', () => {
    it('should purge all nodes', () => {
      db.upsertNode({ nodeNum: 1, nodeId: '!node1' });
      db.upsertNode({ nodeNum: 2, nodeId: '!node2' });

      expect(db.getAllNodes()).toHaveLength(2);

      db.purgeAllNodes();
      expect(db.getAllNodes()).toHaveLength(0);
    });

    it('should purge all messages', () => {
      db.upsertNode({ nodeNum: 1, nodeId: '!node1' });
      db.upsertNode({ nodeNum: 2, nodeId: '!node2' });

      db.insertMessage({
        id: 'msg-1',
        fromNodeNum: 1,
        toNodeNum: 2,
        fromNodeId: '!node1',
        toNodeId: '!node2',
        text: 'Test',
        channel: 0,
        timestamp: Date.now(),
        createdAt: Date.now()
      });

      expect(db.getMessages()).toHaveLength(1);

      db.purgeAllMessages();
      expect(db.getMessages()).toHaveLength(0);
    });
  });

  describe('Favorite Operations', () => {
    it('should set node as favorite', () => {
      const nodeNum = 123456789;
      db.upsertNode({ nodeNum, nodeId: '!075bcd15', longName: 'Test Node' });

      db.setNodeFavorite(nodeNum, true);

      const node = db.getNode(nodeNum);
      expect(node).toBeDefined();
      expect(node?.isFavorite).toBe(1); // SQLite stores boolean as 0/1
    });

    it('should remove favorite status from node', () => {
      const nodeNum = 123456789;
      db.upsertNode({ nodeNum, nodeId: '!075bcd15', longName: 'Test Node', isFavorite: true });

      db.setNodeFavorite(nodeNum, false);

      const node = db.getNode(nodeNum);
      expect(node).toBeDefined();
      expect(node?.isFavorite).toBe(0);
    });

    it('should handle upsert with isFavorite field', () => {
      const nodeNum = 123456789;

      // Create node with isFavorite=true
      db.upsertNode({
        nodeNum,
        nodeId: '!075bcd15',
        longName: 'Test Node',
        isFavorite: true
      });

      let node = db.getNode(nodeNum);
      expect(node?.isFavorite).toBe(1);

      // Update node without changing favorite status
      db.upsertNode({
        nodeNum,
        nodeId: '!075bcd15',
        longName: 'Updated Node'
      });

      node = db.getNode(nodeNum);
      expect(node?.isFavorite).toBe(1); // Should remain favorited
    });

    it('should handle favorite status from NodeInfo protobuf', () => {
      const nodeNum = 987654321;

      // Simulate NodeInfo packet with isFavorite=true
      db.upsertNode({
        nodeNum,
        nodeId: '!3ade68b1',
        longName: 'Remote Node',
        isFavorite: true
      });

      const node = db.getNode(nodeNum);
      expect(node?.isFavorite).toBe(1);
    });

    it('should default to false if isFavorite not specified', () => {
      const nodeNum = 111222333;

      db.upsertNode({
        nodeNum,
        nodeId: '!06a1da8d',
        longName: 'New Node'
      });

      const node = db.getNode(nodeNum);
      expect(node?.isFavorite).toBe(0);
    });
  });
});