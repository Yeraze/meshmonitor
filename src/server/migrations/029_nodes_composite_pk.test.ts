/**
 * Migration 029 — nodes composite PK
 *
 * Regression test for the FOREIGN KEY constraint crash on 4.0 alpha upgrade.
 * The migration performs a SQLite table rebuild (CREATE new + copy + DROP +
 * RENAME), which the SQLite docs explicitly warn must run with
 * `PRAGMA foreign_keys = OFF` — otherwise unrelated orphan rows elsewhere in
 * the database can trip the rebuild. This test reproduces that scenario by
 * seeding a pre-existing orphan row in user_notification_preferences, running
 * the migration with foreign_keys=ON, and asserting it completes successfully.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migration } from './029_nodes_composite_pk.js';

function createBaseSchema(db: Database.Database) {
  // Minimal subset of the v3.7 + migrations 020–028 schema: enough tables for
  // migration 029 to do its job, plus at least one FK-bearing table so the
  // rebuild will trip FK checks if the pragma isn't handled.
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL
    );

    CREATE TABLE nodes (
      nodeNum INTEGER PRIMARY KEY,
      nodeId TEXT UNIQUE NOT NULL,
      longName TEXT,
      shortName TEXT,
      hwModel INTEGER,
      role INTEGER,
      hopsAway INTEGER,
      lastMessageHops INTEGER,
      viaMqtt INTEGER,
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
      isFavorite INTEGER DEFAULT 0,
      favoriteLocked INTEGER DEFAULT 0,
      isIgnored INTEGER DEFAULT 0,
      mobile INTEGER DEFAULT 0,
      rebootCount INTEGER,
      publicKey TEXT,
      lastMeshReceivedKey TEXT,
      hasPKC INTEGER,
      lastPKIPacket INTEGER,
      keyIsLowEntropy INTEGER,
      duplicateKeyDetected INTEGER,
      keyMismatchDetected INTEGER,
      keySecurityIssueDetails TEXT,
      isExcessivePackets INTEGER DEFAULT 0,
      packetRatePerHour INTEGER,
      packetRateLastChecked INTEGER,
      isTimeOffsetIssue INTEGER DEFAULT 0,
      timeOffsetSeconds INTEGER,
      welcomedAt INTEGER,
      positionChannel INTEGER,
      positionPrecisionBits INTEGER,
      positionGpsAccuracy REAL,
      positionHdop REAL,
      positionTimestamp INTEGER,
      positionOverrideEnabled INTEGER DEFAULT 0,
      latitudeOverride REAL,
      longitudeOverride REAL,
      altitudeOverride REAL,
      positionOverrideIsPrivate INTEGER DEFAULT 0,
      hasRemoteAdmin INTEGER DEFAULT 0,
      lastRemoteAdminCheck INTEGER,
      remoteAdminMetadata TEXT,
      lastTimeSync INTEGER,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL,
      sourceId TEXT
    );

    CREATE TABLE sources (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      config TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL,
      createdBy INTEGER
    );

    -- FK-bearing table so the rebuild has something to trip on if the
    -- migration forgets to disable foreign_keys during DROP/RENAME.
    CREATE TABLE user_notification_preferences (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      pref TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);
}

function insertLegacyNode(db: Database.Database, nodeNum: number) {
  db.prepare(
    `INSERT INTO nodes (nodeNum, nodeId, createdAt, updatedAt) VALUES (?, ?, ?, ?)`,
  ).run(nodeNum, `!${nodeNum.toString(16).padStart(8, '0')}`, 1, 1);
}

describe('Migration 029 — nodes composite PK', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createBaseSchema(db);
  });

  it('rebuilds nodes to composite PK even with a pre-existing orphan FK row', () => {
    // Seed: one user, three legacy nodes with NULL sourceId, no sources yet.
    db.prepare(`INSERT INTO users (id, username) VALUES (1, 'admin')`).run();
    insertLegacyNode(db, 100);
    insertLegacyNode(db, 200);
    insertLegacyNode(db, 300);

    // Pre-existing orphan row referencing a user that doesn't exist. Simulates
    // drift that a long-running v3 database might accumulate. Temporarily
    // disable FKs to plant the row — we're modeling state that already exists
    // on disk, not testing the normal insert path.
    db.pragma('foreign_keys = OFF');
    db.prepare(
      `INSERT INTO user_notification_preferences (user_id, pref) VALUES (999, 'dark')`,
    ).run();
    db.pragma('foreign_keys = ON');

    // Should NOT throw. Before the fix this raised SQLITE_CONSTRAINT_FOREIGNKEY
    // during the DROP/RENAME phase of the table rebuild.
    expect(() => migration.up(db)).not.toThrow();

    // Verify the composite PK shape after rebuild.
    const tableInfo = db.prepare(`PRAGMA table_info(nodes)`).all() as Array<{ name: string; pk: number }>;
    const pkCols = tableInfo.filter(c => c.pk > 0).map(c => c.name).sort();
    expect(pkCols).toEqual(['nodeNum', 'sourceId']);

    // The synthesized default source must exist, and all legacy nodes must
    // now point at it.
    const srcCount = (db.prepare(`SELECT COUNT(*) c FROM sources`).get() as { c: number }).c;
    expect(srcCount).toBe(1);
    const nullSourceCount = (db.prepare(`SELECT COUNT(*) c FROM nodes WHERE sourceId IS NULL`).get() as { c: number }).c;
    expect(nullSourceCount).toBe(0);
    const migratedNodeCount = (db.prepare(`SELECT COUNT(*) c FROM nodes`).get() as { c: number }).c;
    expect(migratedNodeCount).toBe(3);
  });

  it('restores foreign_keys pragma after the rebuild completes', () => {
    db.prepare(`INSERT INTO users (id, username) VALUES (1, 'admin')`).run();
    insertLegacyNode(db, 100);

    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    migration.up(db);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('is idempotent when run a second time', () => {
    db.prepare(`INSERT INTO users (id, username) VALUES (1, 'admin')`).run();
    insertLegacyNode(db, 100);

    migration.up(db);
    // Second run must not throw and must not mutate the already-migrated schema.
    expect(() => migration.up(db)).not.toThrow();

    const tableInfo = db.prepare(`PRAGMA table_info(nodes)`).all() as Array<{ name: string; pk: number }>;
    const pkCount = tableInfo.filter(c => c.pk > 0).length;
    expect(pkCount).toBe(2);
  });

  // Regression: reported by MeshMATIC upgrading 3.12.0 → 4.0.0-beta6 (discussion #2619).
  // Legacy databases carry FOREIGN KEY (nodeNum) REFERENCES nodes(nodeNum) on
  // telemetry and route_segments (inherited from pre-baseline schema or an
  // older Drizzle push). Rebuilding nodes to a composite PK leaves nodeNum
  // alone no-longer-unique, which trips SQLite's RENAME-time FK compatibility
  // check ("foreign key mismatch - telemetry referencing nodes") even with
  // foreign_keys=OFF.
  it('completes when child tables carry legacy FK to nodes(nodeNum)', () => {
    db.exec(`
      CREATE TABLE telemetry (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nodeNum INTEGER NOT NULL,
        telemetryType TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        value REAL NOT NULL,
        createdAt INTEGER NOT NULL,
        FOREIGN KEY (nodeNum) REFERENCES nodes(nodeNum)
      );

      CREATE TABLE route_segments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        fromNodeNum INTEGER NOT NULL,
        toNodeNum INTEGER NOT NULL,
        fromNodeId TEXT NOT NULL,
        toNodeId TEXT NOT NULL,
        distanceKm REAL NOT NULL,
        isRecordHolder INTEGER DEFAULT 0,
        timestamp INTEGER NOT NULL,
        createdAt INTEGER NOT NULL,
        FOREIGN KEY (fromNodeNum) REFERENCES nodes(nodeNum),
        FOREIGN KEY (toNodeNum) REFERENCES nodes(nodeNum)
      );

      CREATE TABLE traceroutes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        fromNodeNum INTEGER NOT NULL,
        toNodeNum INTEGER NOT NULL,
        timestamp INTEGER NOT NULL,
        FOREIGN KEY (fromNodeNum) REFERENCES nodes(nodeNum) ON DELETE CASCADE,
        FOREIGN KEY (toNodeNum) REFERENCES nodes(nodeNum) ON DELETE CASCADE
      );
    `);

    db.prepare(`INSERT INTO users (id, username) VALUES (1, 'admin')`).run();
    insertLegacyNode(db, 100);
    insertLegacyNode(db, 200);

    db.prepare(
      `INSERT INTO telemetry (nodeNum, telemetryType, timestamp, value, createdAt)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(100, 'voltage', 1, 3.7, 1);
    db.prepare(
      `INSERT INTO route_segments (fromNodeNum, toNodeNum, fromNodeId, toNodeId, distanceKm, timestamp, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(100, 200, '!00000064', '!000000c8', 1.2, 1, 1);

    expect(() => migration.up(db)).not.toThrow();

    const tableInfo = db.prepare(`PRAGMA table_info(nodes)`).all() as Array<{ name: string; pk: number }>;
    const pkCols = tableInfo.filter(c => c.pk > 0).map(c => c.name).sort();
    expect(pkCols).toEqual(['nodeNum', 'sourceId']);

    // Child rows survive the rebuild.
    expect((db.prepare(`SELECT COUNT(*) c FROM telemetry`).get() as { c: number }).c).toBe(1);
    expect((db.prepare(`SELECT COUNT(*) c FROM route_segments`).get() as { c: number }).c).toBe(1);
  });
});
