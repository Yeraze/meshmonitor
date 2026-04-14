/**
 * Messages BIGINT Round-Trip Tests
 *
 * Regression tests for BIGINT overflow bugs (#1967, #1973).
 * Verifies that nodeNum values > 2^31 (signed 32-bit max) round-trip correctly
 * through SQLite. While SQLite natively supports 64-bit integers, these tests
 * ensure the Drizzle schema and repository code don't truncate or wrap values.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle, BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import { messagesSqlite } from '../schema/messages.js';
import { nodesSqlite } from '../schema/nodes.js';
import * as schema from '../schema/index.js';

const HIGH_NODE_NUM = 3_000_000_000; // > 2,147,483,647 (signed 32-bit max)
const NORMAL_NODE_NUM = 100_000;
const BROADCAST_NODE_NUM = 4294967295; // 0xFFFFFFFF - max unsigned 32-bit

describe('Messages BIGINT round-trip (SQLite)', () => {
  let db: Database.Database;
  let drizzleDb: BetterSQLite3Database<typeof schema>;

  beforeEach(() => {
    db = new Database(':memory:');

    // Create nodes table matching the full Drizzle schema (messages has FK to nodes)
    db.exec(`
      CREATE TABLE IF NOT EXISTS nodes (
        nodeNum INTEGER PRIMARY KEY,
        nodeId TEXT UNIQUE NOT NULL,
        longName TEXT,
        shortName TEXT,
        hwModel INTEGER,
        role INTEGER,
        hopsAway INTEGER,
        lastMessageHops INTEGER,
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
        firmwareVersion TEXT,
        channel INTEGER,
        isFavorite BOOLEAN DEFAULT 0,
        favoriteLocked BOOLEAN DEFAULT 0,
        isIgnored BOOLEAN DEFAULT 0,
        mobile INTEGER DEFAULT 0,
        rebootCount INTEGER,
        publicKey TEXT,
        lastMeshReceivedKey TEXT,
        hasPKC BOOLEAN DEFAULT 0,
        lastPKIPacket INTEGER,
        keyIsLowEntropy BOOLEAN DEFAULT 0,
        duplicateKeyDetected BOOLEAN DEFAULT 0,
        keyMismatchDetected BOOLEAN DEFAULT 0,
        keySecurityIssueDetails TEXT,
        isExcessivePackets BOOLEAN DEFAULT 0,
        packetRatePerHour INTEGER,
        packetRateLastChecked INTEGER,
        isTimeOffsetIssue BOOLEAN DEFAULT 0,
        timeOffsetSeconds INTEGER,
        welcomedAt INTEGER,
        positionChannel INTEGER,
        positionPrecisionBits INTEGER,
        positionGpsAccuracy REAL,
        positionHdop REAL,
        positionTimestamp INTEGER,
        positionOverrideEnabled BOOLEAN DEFAULT 0,
        latitudeOverride REAL,
        longitudeOverride REAL,
        altitudeOverride REAL,
        positionOverrideIsPrivate BOOLEAN DEFAULT 0,
        hasRemoteAdmin BOOLEAN DEFAULT 0,
        lastRemoteAdminCheck INTEGER,
        remoteAdminMetadata TEXT,
        lastTimeSync INTEGER,
        isStoreForwardServer BOOLEAN DEFAULT 0,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL,
        sourceId TEXT
      )
    `);

    // Create messages table with all columns including relayNode and ackFromNode
    db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        fromNodeNum INTEGER NOT NULL,
        toNodeNum INTEGER NOT NULL,
        fromNodeId TEXT NOT NULL,
        toNodeId TEXT NOT NULL,
        text TEXT NOT NULL,
        channel INTEGER NOT NULL DEFAULT 0,
        portnum INTEGER,
        requestId INTEGER,
        timestamp INTEGER NOT NULL,
        rxTime INTEGER,
        hopStart INTEGER,
        hopLimit INTEGER,
        relayNode INTEGER,
        replyId INTEGER,
        emoji INTEGER,
        viaMqtt BOOLEAN DEFAULT 0,
        viaStoreForward BOOLEAN DEFAULT 0,
        rxSnr REAL,
        rxRssi REAL,
        ackFailed BOOLEAN DEFAULT 0,
        routingErrorReceived BOOLEAN DEFAULT 0,
        deliveryState TEXT,
        wantAck BOOLEAN DEFAULT 0,
        ackFromNode INTEGER,
        createdAt INTEGER NOT NULL,
        decrypted_by TEXT,
        sourceId TEXT,
        FOREIGN KEY (fromNodeNum) REFERENCES nodes(nodeNum) ON DELETE CASCADE,
        FOREIGN KEY (toNodeNum) REFERENCES nodes(nodeNum) ON DELETE CASCADE
      )
    `);

    drizzleDb = drizzle(db, { schema });
  });

  afterEach(() => {
    db.close();
  });

  // Helper: insert a node with the given nodeNum
  const insertNode = (nodeNum: number, nodeId: string) => {
    const now = Date.now();
    drizzleDb.insert(nodesSqlite).values({
      nodeNum,
      nodeId,
      createdAt: now,
      updatedAt: now,
    }).run();
  };

  // Helper: insert a message and return its id
  const insertMessage = (overrides: Partial<typeof messagesSqlite.$inferInsert> = {}) => {
    const id = `msg-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const now = Date.now();
    drizzleDb.insert(messagesSqlite).values({
      id,
      fromNodeNum: NORMAL_NODE_NUM,
      toNodeNum: BROADCAST_NODE_NUM,
      fromNodeId: '!aabbccdd',
      toNodeId: '!ffffffff',
      text: 'test message',
      channel: 0,
      timestamp: now,
      createdAt: now,
      ...overrides,
    }).run();
    return id;
  };

  // Setup: insert required nodes for FK constraints
  beforeEach(() => {
    insertNode(NORMAL_NODE_NUM, '!aabbccdd');
    insertNode(BROADCAST_NODE_NUM, '!ffffffff');
    insertNode(HIGH_NODE_NUM, '!b2d05e00');
  });

  it('stores and retrieves relayNode > 2^31', () => {
    const id = insertMessage({ relayNode: HIGH_NODE_NUM });

    const rows = drizzleDb
      .select()
      .from(messagesSqlite)
      .where(eq(messagesSqlite.id, id))
      .all();

    expect(rows).toHaveLength(1);
    expect(rows[0].relayNode).toBe(HIGH_NODE_NUM);
    // Ensure no sign truncation (would be negative if treated as signed 32-bit)
    expect(rows[0].relayNode).toBeGreaterThan(2_147_483_647);
  });

  it('stores and retrieves ackFromNode > 2^31', () => {
    const id = insertMessage({ ackFromNode: HIGH_NODE_NUM });

    const rows = drizzleDb
      .select()
      .from(messagesSqlite)
      .where(eq(messagesSqlite.id, id))
      .all();

    expect(rows).toHaveLength(1);
    expect(rows[0].ackFromNode).toBe(HIGH_NODE_NUM);
    expect(rows[0].ackFromNode).toBeGreaterThan(2_147_483_647);
  });

  it('stores and retrieves max unsigned 32-bit relayNode (0xFFFFFFFF)', () => {
    const id = insertMessage({ relayNode: BROADCAST_NODE_NUM });

    const rows = drizzleDb
      .select()
      .from(messagesSqlite)
      .where(eq(messagesSqlite.id, id))
      .all();

    expect(rows).toHaveLength(1);
    expect(rows[0].relayNode).toBe(BROADCAST_NODE_NUM);
  });

  it('stores and retrieves max unsigned 32-bit ackFromNode (0xFFFFFFFF)', () => {
    const id = insertMessage({ ackFromNode: BROADCAST_NODE_NUM });

    const rows = drizzleDb
      .select()
      .from(messagesSqlite)
      .where(eq(messagesSqlite.id, id))
      .all();

    expect(rows).toHaveLength(1);
    expect(rows[0].ackFromNode).toBe(BROADCAST_NODE_NUM);
  });

  it('stores null relayNode and ackFromNode correctly', () => {
    const id = insertMessage({ relayNode: null, ackFromNode: null });

    const rows = drizzleDb
      .select()
      .from(messagesSqlite)
      .where(eq(messagesSqlite.id, id))
      .all();

    expect(rows).toHaveLength(1);
    expect(rows[0].relayNode).toBeNull();
    expect(rows[0].ackFromNode).toBeNull();
  });

  it('stores both relayNode and ackFromNode > 2^31 in same row', () => {
    const id = insertMessage({
      relayNode: HIGH_NODE_NUM,
      ackFromNode: 2_500_000_000,
    });

    const rows = drizzleDb
      .select()
      .from(messagesSqlite)
      .where(eq(messagesSqlite.id, id))
      .all();

    expect(rows).toHaveLength(1);
    expect(rows[0].relayNode).toBe(HIGH_NODE_NUM);
    expect(rows[0].ackFromNode).toBe(2_500_000_000);
  });

  it('fromNodeNum and toNodeNum handle high node numbers', () => {
    const id = insertMessage({
      fromNodeNum: HIGH_NODE_NUM,
      fromNodeId: '!b2d05e00',
      toNodeNum: BROADCAST_NODE_NUM,
      toNodeId: '!ffffffff',
    });

    const rows = drizzleDb
      .select()
      .from(messagesSqlite)
      .where(eq(messagesSqlite.id, id))
      .all();

    expect(rows).toHaveLength(1);
    expect(rows[0].fromNodeNum).toBe(HIGH_NODE_NUM);
    expect(rows[0].toNodeNum).toBe(BROADCAST_NODE_NUM);
  });
});
