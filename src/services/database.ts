import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import { calculateDistance } from '../utils/distance.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface DbNode {
  nodeNum: number;
  nodeId: string;
  longName: string;
  shortName: string;
  hwModel: number;
  role?: number;
  hopsAway?: number;
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
  lastTracerouteRequest?: number;
  firmwareVersion?: string;
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
  hopStart?: number;
  hopLimit?: number;
  replyId?: number;
  emoji?: number;
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

export interface DbTelemetry {
  id?: number;
  nodeId: string;
  nodeNum: number;
  telemetryType: string;
  timestamp: number;
  value: number;
  unit?: string;
  createdAt: number;
}

export interface DbTraceroute {
  id?: number;
  fromNodeNum: number;
  toNodeNum: number;
  fromNodeId: string;
  toNodeId: string;
  route: string;
  routeBack: string;
  snrTowards: string;
  snrBack: string;
  timestamp: number;
  createdAt: number;
}

export interface DbRouteSegment {
  id?: number;
  fromNodeNum: number;
  toNodeNum: number;
  fromNodeId: string;
  toNodeId: string;
  distanceKm: number;
  isRecordHolder: boolean;
  timestamp: number;
  createdAt: number;
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
    this.migrateSchema();
    this.createIndexes();
    this.runDataMigrations();
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
        firmwareVersion TEXT,
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
        hopStart INTEGER,
        hopLimit INTEGER,
        replyId INTEGER,
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

    this.db.exec(`
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
    `);

    this.db.exec(`
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

    this.db.exec(`
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
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
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

  private migrateSchema(): void {
    console.log('Running database migrations...');

    try {
      this.db.exec(`
        ALTER TABLE messages ADD COLUMN hopStart INTEGER;
      `);
      console.log('✅ Added hopStart column');
    } catch (error: any) {
      if (!error.message?.includes('duplicate column')) {
        console.log('⚠️ hopStart column already exists or other error:', error.message);
      }
    }

    try {
      this.db.exec(`
        ALTER TABLE messages ADD COLUMN hopLimit INTEGER;
      `);
      console.log('✅ Added hopLimit column');
    } catch (error: any) {
      if (!error.message?.includes('duplicate column')) {
        console.log('⚠️ hopLimit column already exists or other error:', error.message);
      }
    }

    try {
      this.db.exec(`
        ALTER TABLE messages ADD COLUMN replyId INTEGER;
      `);
      console.log('✅ Added replyId column');
    } catch (error: any) {
      if (!error.message?.includes('duplicate column')) {
        console.log('⚠️ replyId column already exists or other error:', error.message);
      }
    }

    try {
      this.db.exec(`
        ALTER TABLE nodes ADD COLUMN role INTEGER;
      `);
      console.log('✅ Added role column');
    } catch (error: any) {
      if (!error.message?.includes('duplicate column')) {
        console.log('⚠️ role column already exists or other error:', error.message);
      }
    }

    try {
      this.db.exec(`
        ALTER TABLE nodes ADD COLUMN hopsAway INTEGER;
      `);
      console.log('✅ Added hopsAway column');
    } catch (error: any) {
      if (!error.message?.includes('duplicate column')) {
        console.log('⚠️ hopsAway column already exists or other error:', error.message);
      }
    }

    try {
      this.db.exec(`
        ALTER TABLE nodes ADD COLUMN lastTracerouteRequest INTEGER;
      `);
      console.log('✅ Added lastTracerouteRequest column');
    } catch (error: any) {
      if (!error.message?.includes('duplicate column')) {
        console.log('⚠️ lastTracerouteRequest column already exists or other error:', error.message);
      }
    }

    try {
      this.db.exec(`
        ALTER TABLE nodes ADD COLUMN firmwareVersion TEXT;
      `);
      console.log('✅ Added firmwareVersion column');
    } catch (error: any) {
      if (!error.message?.includes('duplicate column')) {
        console.log('⚠️ firmwareVersion column already exists or other error:', error.message);
      }
    }

    try {
      this.db.exec(`
        ALTER TABLE messages ADD COLUMN emoji INTEGER;
      `);
      console.log('✅ Added emoji column');
    } catch (error: any) {
      if (!error.message?.includes('duplicate column')) {
        console.log('⚠️ emoji column already exists or other error:', error.message);
      }
    }

    console.log('Database migrations completed');
  }

  private createIndexes(): void {
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_nodes_nodeId ON nodes(nodeId);
      CREATE INDEX IF NOT EXISTS idx_nodes_lastHeard ON nodes(lastHeard);
      CREATE INDEX IF NOT EXISTS idx_nodes_updatedAt ON nodes(updatedAt);

      CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
      CREATE INDEX IF NOT EXISTS idx_messages_fromNodeId ON messages(fromNodeId);
      CREATE INDEX IF NOT EXISTS idx_telemetry_nodeId ON telemetry(nodeId);
      CREATE INDEX IF NOT EXISTS idx_telemetry_timestamp ON telemetry(timestamp);
      CREATE INDEX IF NOT EXISTS idx_telemetry_type ON telemetry(telemetryType);
      CREATE INDEX IF NOT EXISTS idx_messages_toNodeId ON messages(toNodeId);
      CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel);
      CREATE INDEX IF NOT EXISTS idx_messages_createdAt ON messages(createdAt);

      CREATE INDEX IF NOT EXISTS idx_route_segments_distance ON route_segments(distanceKm DESC);
      CREATE INDEX IF NOT EXISTS idx_route_segments_timestamp ON route_segments(timestamp);
      CREATE INDEX IF NOT EXISTS idx_route_segments_recordholder ON route_segments(isRecordHolder);
    `);
  }

  private runDataMigrations(): void {
    // Migration: Calculate distances for all existing traceroutes
    const migrationKey = 'route_segments_migration_v1';
    const migrationCompleted = this.getSetting(migrationKey);

    if (migrationCompleted === 'completed') {
      console.log('✅ Route segments migration already completed');
      return;
    }

    console.log('🔄 Running route segments migration...');

    try {
      // Get ALL traceroutes from the database
      const stmt = this.db.prepare('SELECT * FROM traceroutes ORDER BY timestamp ASC');
      const allTraceroutes = stmt.all() as DbTraceroute[];

      console.log(`📊 Processing ${allTraceroutes.length} traceroutes for distance calculation...`);

      let processedCount = 0;
      let segmentsCreated = 0;

      for (const traceroute of allTraceroutes) {
        try {
          // Parse the route arrays
          const route = traceroute.route ? JSON.parse(traceroute.route) : [];
          const routeBack = traceroute.routeBack ? JSON.parse(traceroute.routeBack) : [];

          // Process forward route segments
          for (let i = 0; i < route.length - 1; i++) {
            const fromNodeNum = route[i];
            const toNodeNum = route[i + 1];

            const fromNode = this.getNode(fromNodeNum);
            const toNode = this.getNode(toNodeNum);

            // Only calculate distance if both nodes have position data
            if (fromNode?.latitude && fromNode?.longitude &&
                toNode?.latitude && toNode?.longitude) {

              const distanceKm = calculateDistance(
                fromNode.latitude, fromNode.longitude,
                toNode.latitude, toNode.longitude
              );

              const segment: DbRouteSegment = {
                fromNodeNum,
                toNodeNum,
                fromNodeId: fromNode.nodeId,
                toNodeId: toNode.nodeId,
                distanceKm,
                isRecordHolder: false,
                timestamp: traceroute.timestamp,
                createdAt: Date.now()
              };

              this.insertRouteSegment(segment);
              this.updateRecordHolderSegment(segment);
              segmentsCreated++;
            }
          }

          // Process return route segments
          for (let i = 0; i < routeBack.length - 1; i++) {
            const fromNodeNum = routeBack[i];
            const toNodeNum = routeBack[i + 1];

            const fromNode = this.getNode(fromNodeNum);
            const toNode = this.getNode(toNodeNum);

            // Only calculate distance if both nodes have position data
            if (fromNode?.latitude && fromNode?.longitude &&
                toNode?.latitude && toNode?.longitude) {

              const distanceKm = calculateDistance(
                fromNode.latitude, fromNode.longitude,
                toNode.latitude, toNode.longitude
              );

              const segment: DbRouteSegment = {
                fromNodeNum,
                toNodeNum,
                fromNodeId: fromNode.nodeId,
                toNodeId: toNode.nodeId,
                distanceKm,
                isRecordHolder: false,
                timestamp: traceroute.timestamp,
                createdAt: Date.now()
              };

              this.insertRouteSegment(segment);
              this.updateRecordHolderSegment(segment);
              segmentsCreated++;
            }
          }

          processedCount++;

          // Log progress every 100 traceroutes
          if (processedCount % 100 === 0) {
            console.log(`   Processed ${processedCount}/${allTraceroutes.length} traceroutes...`);
          }
        } catch (error) {
          console.error(`   Error processing traceroute ${traceroute.id}:`, error);
          // Continue with next traceroute
        }
      }

      // Mark migration as completed
      this.setSetting(migrationKey, 'completed');
      console.log(`✅ Migration completed! Processed ${processedCount} traceroutes, created ${segmentsCreated} route segments`);

    } catch (error) {
      console.error('❌ Error during route segments migration:', error);
      // Don't mark as completed if there was an error
    }
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
          role = COALESCE(?, role),
          hopsAway = COALESCE(?, hopsAway),
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
          firmwareVersion = COALESCE(?, firmwareVersion),
          updatedAt = ?
        WHERE nodeNum = ?
      `);

      stmt.run(
        nodeData.nodeId,
        nodeData.longName,
        nodeData.shortName,
        nodeData.hwModel,
        nodeData.role,
        nodeData.hopsAway,
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
        nodeData.firmwareVersion || null,
        now,
        nodeData.nodeNum
      );
    } else {
      const stmt = this.db.prepare(`
        INSERT INTO nodes (
          nodeNum, nodeId, longName, shortName, hwModel, role, hopsAway, macaddr,
          latitude, longitude, altitude, batteryLevel, voltage,
          channelUtilization, airUtilTx, lastHeard, snr, rssi, firmwareVersion,
          createdAt, updatedAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        nodeData.nodeNum,
        nodeData.nodeId,
        nodeData.longName || null,
        nodeData.shortName || null,
        nodeData.hwModel || null,
        nodeData.role || null,
        nodeData.hopsAway || null,
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
        nodeData.firmwareVersion || null,
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
        text, channel, portnum, timestamp, rxTime, hopStart, hopLimit, replyId, emoji, createdAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      messageData.hopStart ?? null,
      messageData.hopLimit ?? null,
      messageData.replyId ?? null,
      messageData.emoji ?? null,
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
    const telemetry = stmt.all(...params) as DbTelemetry[];
    return telemetry.map(t => this.normalizeBigInts(t));
  }

  getTelemetryByNodeAveraged(nodeId: string, sinceTimestamp?: number, intervalMinutes: number = 3, maxHours?: number): DbTelemetry[] {
    // Calculate the interval in milliseconds
    const intervalMs = intervalMinutes * 60 * 1000;

    // Build the query to group and average telemetry data by time intervals
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

    // Add limit based on max hours if specified
    // With 3-minute intervals: 20 points per hour, add 1 hour padding
    if (maxHours !== undefined) {
      const limit = (maxHours + 1) * 20;
      query += ` LIMIT ?`;
      params.push(limit);
    }

    const stmt = this.db.prepare(query);
    const telemetry = stmt.all(...params) as DbTelemetry[];
    return telemetry.map(t => this.normalizeBigInts(t));
  }

  insertTraceroute(tracerouteData: DbTraceroute): void {
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

  getTraceroutesByNodes(fromNodeNum: number, toNodeNum: number, limit: number = 10): DbTraceroute[] {
    const stmt = this.db.prepare(`
      SELECT * FROM traceroutes
      WHERE fromNodeNum = ? AND toNodeNum = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `);
    const traceroutes = stmt.all(fromNodeNum, toNodeNum, limit) as DbTraceroute[];
    return traceroutes.map(t => this.normalizeBigInts(t));
  }

  getAllTraceroutes(limit: number = 100): DbTraceroute[] {
    const stmt = this.db.prepare(`
      SELECT t.* FROM traceroutes t
      INNER JOIN (
        SELECT fromNodeNum, toNodeNum, MAX(timestamp) as maxTimestamp
        FROM traceroutes
        GROUP BY fromNodeNum, toNodeNum
      ) latest ON t.fromNodeNum = latest.fromNodeNum
        AND t.toNodeNum = latest.toNodeNum
        AND t.timestamp = latest.maxTimestamp
      ORDER BY t.timestamp DESC
      LIMIT ?
    `);
    const traceroutes = stmt.all(limit) as DbTraceroute[];
    return traceroutes.map(t => this.normalizeBigInts(t));
  }

  getNodeNeedingTraceroute(localNodeNum: number): DbNode | null {
    // First, try to find a node that has never been requested for a traceroute
    const stmtNoRequest = this.db.prepare(`
      SELECT n.* FROM nodes n
      WHERE n.nodeNum != ? AND n.lastTracerouteRequest IS NULL
      ORDER BY n.lastHeard DESC
      LIMIT 1
    `);
    const nodeWithoutRequest = stmtNoRequest.get(localNodeNum) as DbNode | null;

    if (nodeWithoutRequest) {
      return this.normalizeBigInts(nodeWithoutRequest);
    }

    // If all nodes have been requested, find the one with the oldest request
    const stmtOldestRequest = this.db.prepare(`
      SELECT n.* FROM nodes n
      WHERE n.nodeNum != ?
      ORDER BY n.lastTracerouteRequest ASC, n.lastHeard DESC
      LIMIT 1
    `);
    const nodeWithOldestRequest = stmtOldestRequest.get(localNodeNum) as DbNode | null;

    return nodeWithOldestRequest ? this.normalizeBigInts(nodeWithOldestRequest) : null;
  }

  recordTracerouteRequest(nodeNum: number): void {
    const now = Date.now();
    const stmt = this.db.prepare(`
      UPDATE nodes SET lastTracerouteRequest = ? WHERE nodeNum = ?
    `);
    stmt.run(now, nodeNum);
  }

  getTelemetryByType(telemetryType: string, limit: number = 100): DbTelemetry[] {
    const stmt = this.db.prepare(`
      SELECT * FROM telemetry
      WHERE telemetryType = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `);
    const telemetry = stmt.all(telemetryType, limit) as DbTelemetry[];
    return telemetry.map(t => this.normalizeBigInts(t));
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
    const telemetry = stmt.all(nodeId) as DbTelemetry[];
    return telemetry.map(t => this.normalizeBigInts(t));
  }

  // Danger zone operations
  purgeAllNodes(): void {
    console.log('⚠️ PURGING all nodes and related data from database');
    // Delete in order to respect foreign key constraints
    // First delete all child records that reference nodes
    this.db.exec('DELETE FROM messages');
    this.db.exec('DELETE FROM telemetry');
    this.db.exec('DELETE FROM traceroutes');
    this.db.exec('DELETE FROM route_segments');
    // Finally delete the nodes themselves
    this.db.exec('DELETE FROM nodes');
    console.log('✅ Successfully purged all nodes and related data');
  }

  purgeAllTelemetry(): void {
    console.log('⚠️ PURGING all telemetry from database');
    this.db.exec('DELETE FROM telemetry');
  }

  purgeOldTelemetry(hoursToKeep: number): number {
    const cutoffTime = Date.now() - (hoursToKeep * 60 * 60 * 1000);
    const stmt = this.db.prepare('DELETE FROM telemetry WHERE timestamp < ?');
    const result = stmt.run(cutoffTime);
    console.log(`🧹 Purged ${result.changes} old telemetry records (keeping last ${hoursToKeep} hours)`);
    return Number(result.changes);
  }

  purgeAllMessages(): void {
    console.log('⚠️ PURGING all messages from database');
    this.db.exec('DELETE FROM messages');
  }

  // Settings methods
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
    console.log('🔄 Resetting all settings to defaults');
    this.db.exec('DELETE FROM settings');
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
    // Get the longest segment from recent traceroutes (within last 7 days)
    const cutoff = Date.now() - (7 * 24 * 60 * 60 * 1000);
    const stmt = this.db.prepare(`
      SELECT * FROM route_segments
      WHERE timestamp > ?
      ORDER BY distanceKm DESC
      LIMIT 1
    `);
    const segment = stmt.get(cutoff) as DbRouteSegment | null;
    return segment ? this.normalizeBigInts(segment) : null;
  }

  getRecordHolderRouteSegment(): DbRouteSegment | null {
    const stmt = this.db.prepare(`
      SELECT * FROM route_segments
      WHERE isRecordHolder = 1
      ORDER BY distanceKm DESC
      LIMIT 1
    `);
    const segment = stmt.get() as DbRouteSegment | null;
    return segment ? this.normalizeBigInts(segment) : null;
  }

  updateRecordHolderSegment(newSegment: DbRouteSegment): void {
    const currentRecord = this.getRecordHolderRouteSegment();

    // If no current record or new segment is longer, update
    if (!currentRecord || newSegment.distanceKm > currentRecord.distanceKm) {
      // Clear all existing record holders
      this.db.exec('UPDATE route_segments SET isRecordHolder = 0');

      // Insert new record holder
      this.insertRouteSegment({
        ...newSegment,
        isRecordHolder: true
      });

      console.log(`🏆 New record holder route segment: ${newSegment.distanceKm.toFixed(2)} km from ${newSegment.fromNodeId} to ${newSegment.toNodeId}`);
    }
  }

  clearRecordHolderSegment(): void {
    this.db.exec('UPDATE route_segments SET isRecordHolder = 0');
    console.log('🗑️ Cleared record holder route segment');
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
}

export default new DatabaseService();