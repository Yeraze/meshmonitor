import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface DbNode {
  nodeNum: number;
  nodeId: string;
  longName: string;
  shortName: string;
  hwModel: number;
  macaddr?: string;
  latitude?: number;
  longitude?: number;
  altitude?: number;
  batteryLevel?: number;
  voltage?: number;
  channelUtilization?: number;
  airUtilTx?: number;
  lastHeard?: number;
  snr?: number;
  rssi?: number;
  createdAt: number;
  updatedAt: number;
}

export interface DbMessage {
  id: string;
  fromNodeNum: number;
  toNodeNum: number;
  fromNodeId: string;
  toNodeId: string;
  text: string;
  channel: number;
  portnum?: number;
  timestamp: number;
  rxTime?: number;
  createdAt: number;
}

export interface DbChannel {
  id: number;
  name: string;
  psk?: string;
  uplinkEnabled: boolean;
  downlinkEnabled: boolean;
  createdAt: number;
  updatedAt: number;
}

class DatabaseService {
  public db: Database.Database;
  private isInitialized = false;

  constructor() {
    console.log('🔧🔧🔧 DatabaseService constructor called');
    const dbPath = process.env.NODE_ENV === 'production'
      ? '/data/meshmonitor.db'
      : path.join(__dirname, '../../data/meshmonitor.db');

    console.log('Initializing database at:', dbPath);
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.initialize();
    // Always ensure Primary channel exists, even if database already initialized
    this.ensurePrimaryChannel();
  }

  private initialize(): void {
    if (this.isInitialized) return;

    this.createTables();
    this.createIndexes();
    this.isInitialized = true;
  }

  private ensurePrimaryChannel(): void {
    console.log('🔍 ensurePrimaryChannel() called');
    try {
      const existingChannel0 = this.getChannelById(0);
      console.log('🔍 getChannelById(0) returned:', existingChannel0);

      if (!existingChannel0) {
        console.log('🔍 No channel 0 found, calling upsertChannel with id: 0, name: Primary');
        this.upsertChannel({ id: 0, name: 'Primary' });

        // Verify it was created
        const verify = this.getChannelById(0);
        console.log('🔍 After upsert, getChannelById(0) returns:', verify);
      } else {
        console.log(`✅ Channel 0 already exists: ${existingChannel0.name}`);
      }
    } catch (error) {
      console.error('❌ Error in ensurePrimaryChannel:', error);
    }
  }

  private createTables(): void {
    console.log('Creating database tables...');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS nodes (
        nodeNum INTEGER PRIMARY KEY,
        nodeId TEXT UNIQUE NOT NULL,
        longName TEXT,
        shortName TEXT,
        hwModel INTEGER,
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
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      );
    `);

    this.db.exec(`
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
        createdAt INTEGER NOT NULL,
        FOREIGN KEY (fromNodeNum) REFERENCES nodes(nodeNum),
        FOREIGN KEY (toNodeNum) REFERENCES nodes(nodeNum)
      );
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS channels (
        id INTEGER PRIMARY KEY,
        name TEXT,
        psk TEXT,
        uplinkEnabled BOOLEAN DEFAULT 1,
        downlinkEnabled BOOLEAN DEFAULT 1,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      );
    `);

    // Insert Primary channel with ID 0 if it doesn't exist
    const now = Date.now();
    try {
      const stmt = this.db.prepare(`
        INSERT OR IGNORE INTO channels (id, name, uplinkEnabled, downlinkEnabled, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      const result = stmt.run(0, 'Primary', 1, 1, now, now);
      console.log('✅ Primary channel INSERT result:', result);
    } catch (error) {
      console.error('❌ Error inserting Primary channel:', error);
    }

    console.log('Database tables created successfully');
  }

  private createIndexes(): void {
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_nodes_nodeId ON nodes(nodeId);
      CREATE INDEX IF NOT EXISTS idx_nodes_lastHeard ON nodes(lastHeard);
      CREATE INDEX IF NOT EXISTS idx_nodes_updatedAt ON nodes(updatedAt);

      CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
      CREATE INDEX IF NOT EXISTS idx_messages_fromNodeId ON messages(fromNodeId);
      CREATE INDEX IF NOT EXISTS idx_messages_toNodeId ON messages(toNodeId);
      CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel);
      CREATE INDEX IF NOT EXISTS idx_messages_createdAt ON messages(createdAt);
    `);
  }

  // Node operations
  upsertNode(nodeData: Partial<DbNode>): void {
    console.log(`DEBUG: upsertNode called with nodeData:`, JSON.stringify(nodeData));
    console.log(`DEBUG: nodeNum type: ${typeof nodeData.nodeNum}, value: ${nodeData.nodeNum}`);
    console.log(`DEBUG: nodeId type: ${typeof nodeData.nodeId}, value: ${nodeData.nodeId}`);
    if (nodeData.nodeNum === undefined || nodeData.nodeNum === null || !nodeData.nodeId) {
      console.error('Cannot upsert node: missing nodeNum or nodeId');
      console.error('STACK TRACE FOR FAILED UPSERT:');
      console.error(new Error().stack);
      return;
    }

    const now = Date.now();
    const existingNode = this.getNode(nodeData.nodeNum);

    if (existingNode) {
      const stmt = this.db.prepare(`
        UPDATE nodes SET
          nodeId = COALESCE(?, nodeId),
          longName = COALESCE(?, longName),
          shortName = COALESCE(?, shortName),
          hwModel = COALESCE(?, hwModel),
          macaddr = COALESCE(?, macaddr),
          latitude = COALESCE(?, latitude),
          longitude = COALESCE(?, longitude),
          altitude = COALESCE(?, altitude),
          batteryLevel = COALESCE(?, batteryLevel),
          voltage = COALESCE(?, voltage),
          channelUtilization = COALESCE(?, channelUtilization),
          airUtilTx = COALESCE(?, airUtilTx),
          lastHeard = COALESCE(?, lastHeard),
          snr = COALESCE(?, snr),
          rssi = COALESCE(?, rssi),
          updatedAt = ?
        WHERE nodeNum = ?
      `);

      stmt.run(
        nodeData.nodeId,
        nodeData.longName,
        nodeData.shortName,
        nodeData.hwModel,
        nodeData.macaddr,
        nodeData.latitude,
        nodeData.longitude,
        nodeData.altitude,
        nodeData.batteryLevel,
        nodeData.voltage,
        nodeData.channelUtilization,
        nodeData.airUtilTx,
        nodeData.lastHeard,
        nodeData.snr,
        nodeData.rssi,
        now,
        nodeData.nodeNum
      );
    } else {
      const stmt = this.db.prepare(`
        INSERT INTO nodes (
          nodeNum, nodeId, longName, shortName, hwModel, macaddr,
          latitude, longitude, altitude, batteryLevel, voltage,
          channelUtilization, airUtilTx, lastHeard, snr, rssi,
          createdAt, updatedAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        nodeData.nodeNum,
        nodeData.nodeId,
        nodeData.longName || null,
        nodeData.shortName || null,
        nodeData.hwModel || null,
        nodeData.macaddr || null,
        nodeData.latitude || null,
        nodeData.longitude || null,
        nodeData.altitude || null,
        nodeData.batteryLevel || null,
        nodeData.voltage || null,
        nodeData.channelUtilization || null,
        nodeData.airUtilTx || null,
        nodeData.lastHeard || null,
        nodeData.snr || null,
        nodeData.rssi || null,
        now,
        now
      );
    }
  }

  getNode(nodeNum: number): DbNode | null {
    const stmt = this.db.prepare('SELECT * FROM nodes WHERE nodeNum = ?');
    const node = stmt.get(nodeNum) as DbNode | null;
    return node ? this.normalizeBigInts(node) : null;
  }

  getAllNodes(): DbNode[] {
    const stmt = this.db.prepare('SELECT * FROM nodes ORDER BY updatedAt DESC');
    const nodes = stmt.all() as DbNode[];
    return nodes.map(node => this.normalizeBigInts(node));
  }

  getActiveNodes(sinceDays: number = 7): DbNode[] {
    const cutoff = Date.now() - (sinceDays * 24 * 60 * 60 * 1000);
    const stmt = this.db.prepare('SELECT * FROM nodes WHERE lastHeard > ? ORDER BY lastHeard DESC');
    const nodes = stmt.all(cutoff) as DbNode[];
    return nodes.map(node => this.normalizeBigInts(node));
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
      messageData.portnum || null,
      messageData.timestamp,
      messageData.rxTime || null,
      messageData.createdAt
    );
  }

  getMessage(id: string): DbMessage | null {
    const stmt = this.db.prepare('SELECT * FROM messages WHERE id = ?');
    const message = stmt.get(id) as DbMessage | null;
    return message ? this.normalizeBigInts(message) : null;
  }

  getMessages(limit: number = 100, offset: number = 0): DbMessage[] {
    const stmt = this.db.prepare(`
      SELECT * FROM messages
      ORDER BY timestamp DESC
      LIMIT ? OFFSET ?
    `);
    const messages = stmt.all(limit, offset) as DbMessage[];
    return messages.map(message => this.normalizeBigInts(message));
  }

  getMessagesByChannel(channel: number, limit: number = 100): DbMessage[] {
    const stmt = this.db.prepare(`
      SELECT * FROM messages
      WHERE channel = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `);
    const messages = stmt.all(channel, limit) as DbMessage[];
    return messages.map(message => this.normalizeBigInts(message));
  }

  getDirectMessages(nodeId1: string, nodeId2: string, limit: number = 100): DbMessage[] {
    const stmt = this.db.prepare(`
      SELECT * FROM messages
      WHERE (fromNodeId = ? AND toNodeId = ?)
         OR (fromNodeId = ? AND toNodeId = ?)
      ORDER BY timestamp DESC
      LIMIT ?
    `);
    const messages = stmt.all(nodeId1, nodeId2, nodeId2, nodeId1, limit) as DbMessage[];
    return messages.map(message => this.normalizeBigInts(message));
  }

  getMessagesAfterTimestamp(timestamp: number): DbMessage[] {
    const stmt = this.db.prepare(`
      SELECT * FROM messages
      WHERE timestamp > ?
      ORDER BY timestamp ASC
    `);
    const messages = stmt.all(timestamp) as DbMessage[];
    return messages.map(message => this.normalizeBigInts(message));
  }

  // Statistics
  getMessageCount(): number {
    const stmt = this.db.prepare('SELECT COUNT(*) as count FROM messages');
    const result = stmt.get() as { count: number };
    return Number(result.count);
  }

  getNodeCount(): number {
    const stmt = this.db.prepare('SELECT COUNT(*) as count FROM nodes');
    const result = stmt.get() as { count: number };
    return Number(result.count);
  }

  getMessagesByDay(days: number = 7): Array<{ date: string; count: number }> {
    const stmt = this.db.prepare(`
      SELECT
        date(timestamp/1000, 'unixepoch') as date,
        COUNT(*) as count
      FROM messages
      WHERE timestamp > ?
      GROUP BY date(timestamp/1000, 'unixepoch')
      ORDER BY date
    `);

    const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);
    const results = stmt.all(cutoff) as Array<{ date: string; count: number }>;
    return results.map(row => ({
      date: row.date,
      count: Number(row.count)
    }));
  }

  // Cleanup operations
  cleanupOldMessages(days: number = 30): number {
    const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);
    const stmt = this.db.prepare('DELETE FROM messages WHERE timestamp < ?');
    const result = stmt.run(cutoff);
    return Number(result.changes);
  }

  cleanupInactiveNodes(days: number = 30): number {
    const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);
    const stmt = this.db.prepare('DELETE FROM nodes WHERE lastHeard < ? OR lastHeard IS NULL');
    const result = stmt.run(cutoff);
    return Number(result.changes);
  }

  // Database maintenance
  vacuum(): void {
    this.db.exec('VACUUM');
  }

  // Helper function to convert BigInt values to numbers
  private normalizeBigInts(obj: any): any {
    if (obj === null || obj === undefined) return obj;

    if (typeof obj === 'bigint') {
      return Number(obj);
    }

    if (typeof obj === 'object') {
      const normalized: any = Array.isArray(obj) ? [] : {};
      for (const key in obj) {
        if (obj.hasOwnProperty(key)) {
          normalized[key] = this.normalizeBigInts(obj[key]);
        }
      }
      return normalized;
    }

    return obj;
  }

  close(): void {
    if (this.db) {
      this.db.close();
    }
  }

  // Export/Import functionality
  exportData(): { nodes: DbNode[]; messages: DbMessage[] } {
    return {
      nodes: this.getAllNodes(),
      messages: this.getMessages(10000) // Export last 10k messages
    };
  }

  importData(data: { nodes: DbNode[]; messages: DbMessage[] }): void {
    const transaction = this.db.transaction(() => {
      // Clear existing data
      this.db.exec('DELETE FROM messages');
      this.db.exec('DELETE FROM nodes');

      // Import nodes
      const nodeStmt = this.db.prepare(`
        INSERT INTO nodes (
          nodeNum, nodeId, longName, shortName, hwModel, macaddr,
          latitude, longitude, altitude, batteryLevel, voltage,
          channelUtilization, airUtilTx, lastHeard, snr, rssi,
          createdAt, updatedAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const node of data.nodes) {
        nodeStmt.run(
          node.nodeNum, node.nodeId, node.longName, node.shortName,
          node.hwModel, node.macaddr, node.latitude, node.longitude,
          node.altitude, node.batteryLevel, node.voltage,
          node.channelUtilization, node.airUtilTx, node.lastHeard,
          node.snr, node.rssi, node.createdAt, node.updatedAt
        );
      }

      // Import messages
      const msgStmt = this.db.prepare(`
        INSERT INTO messages (
          id, fromNodeNum, toNodeNum, fromNodeId, toNodeId,
          text, channel, portnum, timestamp, rxTime, createdAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const message of data.messages) {
        msgStmt.run(
          message.id, message.fromNodeNum, message.toNodeNum,
          message.fromNodeId, message.toNodeId, message.text,
          message.channel, message.portnum, message.timestamp,
          message.rxTime, message.createdAt
        );
      }
    });

    transaction();
  }

  // Channel operations
  upsertChannel(channelData: { id?: number; name: string; psk?: string }): void {
    const now = Date.now();

    console.log(`📝 upsertChannel called with:`, JSON.stringify(channelData));

    let existingChannel: DbChannel | null = null;

    // If we have an ID, check by ID FIRST (to support creating channel 0 even if "Primary" exists elsewhere)
    if (channelData.id !== undefined) {
      existingChannel = this.getChannelById(channelData.id);
      console.log(`📝 getChannelById(${channelData.id}) returned:`, existingChannel);
    }

    // Only check by name if we didn't find a channel by ID
    if (!existingChannel) {
      existingChannel = this.getChannelByName(channelData.name);
      console.log(`📝 getChannelByName(${channelData.name}) returned:`, existingChannel);
    }

    if (existingChannel) {
      // Update existing channel (by name match or ID match)
      const stmt = this.db.prepare(`
        UPDATE channels SET
          name = ?,
          psk = COALESCE(?, psk),
          updatedAt = ?
        WHERE id = ?
      `);
      stmt.run(channelData.name, channelData.psk, now, existingChannel.id);
      console.log(`Updated channel: ${channelData.name} (ID: ${existingChannel.id})`);
    } else {
      // Create new channel
      console.log(`📝 Creating new channel with ID: ${channelData.id !== undefined ? channelData.id : null}`);
      const stmt = this.db.prepare(`
        INSERT INTO channels (id, name, psk, uplinkEnabled, downlinkEnabled, createdAt, updatedAt)
        VALUES (?, ?, ?, 1, 1, ?, ?)
      `);
      const result = stmt.run(
        channelData.id !== undefined ? channelData.id : null,
        channelData.name,
        channelData.psk || null,
        now,
        now
      );
      console.log(`Created channel: ${channelData.name} (ID: ${channelData.id !== undefined ? channelData.id : 'auto'}), lastInsertRowid: ${result.lastInsertRowid}`);
    }
  }

  getChannelByName(name: string): DbChannel | null {
    const stmt = this.db.prepare('SELECT * FROM channels WHERE name = ?');
    const channel = stmt.get(name) as DbChannel | null;
    return channel ? this.normalizeBigInts(channel) : null;
  }

  getChannelById(id: number): DbChannel | null {
    const stmt = this.db.prepare('SELECT * FROM channels WHERE id = ?');
    const channel = stmt.get(id) as DbChannel | null;
    return channel ? this.normalizeBigInts(channel) : null;
  }

  getAllChannels(): DbChannel[] {
    const stmt = this.db.prepare('SELECT * FROM channels ORDER BY id ASC');
    const channels = stmt.all() as DbChannel[];
    return channels.map(channel => this.normalizeBigInts(channel));
  }

  getChannelCount(): number {
    const stmt = this.db.prepare('SELECT COUNT(*) as count FROM channels');
    const result = stmt.get() as { count: number };
    return Number(result.count);
  }

  // Clean up invalid channels that shouldn't have been created
  cleanupInvalidChannels(): number {
    const validChannelNames = ['Primary', 'admin', 'gauntlet', 'telemetry', 'Secondary', 'LongFast', 'VeryLong'];
    const placeholders = validChannelNames.map(() => '?').join(', ');
    const stmt = this.db.prepare(`DELETE FROM channels WHERE name NOT IN (${placeholders})`);
    const result = stmt.run(...validChannelNames);
    return Number(result.changes);
  }

  // Clean up channels that appear to be empty/unused
  cleanupEmptyChannels(): number {
    const stmt = this.db.prepare(`
      DELETE FROM channels
      WHERE name LIKE 'Channel %'
      AND id NOT IN (0, 1)
      AND psk IS NULL
    `);
    const result = stmt.run();
    console.log(`🧹 Cleaned up ${result.changes} empty channels`);
    return Number(result.changes);
  }
}

export default new DatabaseService();