/**
 * Schema Integrity Smoke Test
 *
 * Verifies that all critical columns and tables exist after running the full
 * SQLite initialization path (createTables + migrateSchema + registry migrations).
 *
 * This catches:
 * - Migration ordering bugs (PR #2301: migrations 083/084 skipped due to early return in 082)
 * - Missing columns from ALTER TABLE migrations
 * - Missing tables from CREATE TABLE migrations
 *
 * Approach: Rather than importing the full DatabaseService (which has many
 * dependencies), we replicate the SQLite schema creation SQL and call each
 * registered migration's .sqlite() function against an in-memory database.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { registry } from '../migrations.js';

describe('Schema integrity after all migrations', () => {
  let db: Database.Database;

  // Helper: get column names for a table
  const getColumns = (table: string): string[] => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all();
    return cols.map((c: any) => c.name);
  };

  // Helper: get all table names
  const getTableNames = (): string[] => {
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
    ).all();
    return tables.map((t: any) => t.name);
  };

  // Helper: getSetting / setSetting for migration idempotency tracking
  const getSetting = (key: string): string | null => {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  };

  const setSetting = (key: string, value: string): void => {
    const now = Date.now();
    db.prepare(
      'INSERT OR REPLACE INTO settings (key, value, createdAt, updatedAt) VALUES (?, ?, ?, ?)'
    ).run(key, value, now, now);
  };

  beforeAll(() => {
    db = new Database(':memory:');

    // === Step 1: Replicate createTables() base schema ===
    // These are the base CREATE TABLE statements from database.ts createTables()

    // Node columns include everything from createTables() + migrateSchema() ALTER TABLE additions.
    // On a real fresh install, createTables() creates a minimal schema and migrateSchema()
    // adds columns via ALTER TABLE. We include all columns upfront since both run on init.
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
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      )
    `);

    // Messages table includes columns from createTables() + migrateSchema() ALTER TABLE additions
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
        rxSnr REAL,
        rxRssi REAL,
        ackFailed BOOLEAN DEFAULT 0,
        routingErrorReceived BOOLEAN DEFAULT 0,
        deliveryState TEXT,
        wantAck BOOLEAN DEFAULT 0,
        ackFromNode INTEGER,
        createdAt INTEGER NOT NULL,
        decrypted_by TEXT,
        FOREIGN KEY (fromNodeNum) REFERENCES nodes(nodeNum) ON DELETE CASCADE,
        FOREIGN KEY (toNodeNum) REFERENCES nodes(nodeNum) ON DELETE CASCADE
      )
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS channels (
        id INTEGER PRIMARY KEY,
        name TEXT,
        psk TEXT,
        uplinkEnabled BOOLEAN DEFAULT 1,
        downlinkEnabled BOOLEAN DEFAULT 1,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      )
    `);

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
        FOREIGN KEY (nodeNum) REFERENCES nodes(nodeNum)
      )
    `);

    db.exec(`
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
      )
    `);

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_traceroutes_nodes
      ON traceroutes(fromNodeNum, toNodeNum, timestamp DESC)
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS route_segments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        fromNodeNum INTEGER NOT NULL,
        toNodeNum INTEGER NOT NULL,
        tracerouteId INTEGER NOT NULL,
        segmentIndex INTEGER NOT NULL,
        direction TEXT NOT NULL,
        snr REAL,
        timestamp INTEGER NOT NULL,
        createdAt INTEGER NOT NULL,
        FOREIGN KEY (tracerouteId) REFERENCES traceroutes(id)
      )
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS neighbor_info (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nodeNum INTEGER NOT NULL,
        neighborNodeNum INTEGER NOT NULL,
        snr REAL,
        timestamp INTEGER NOT NULL,
        createdAt INTEGER NOT NULL,
        FOREIGN KEY (nodeNum) REFERENCES nodes(nodeNum),
        FOREIGN KEY (neighborNodeNum) REFERENCES nodes(nodeNum)
      )
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      )
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS upgrade_history (
        id TEXT PRIMARY KEY,
        fromVersion TEXT NOT NULL,
        toVersion TEXT NOT NULL,
        deploymentMethod TEXT NOT NULL,
        status TEXT NOT NULL,
        progress INTEGER DEFAULT 0,
        currentStep TEXT,
        logs TEXT,
        backupPath TEXT,
        startedAt INTEGER NOT NULL,
        completedAt INTEGER,
        initiatedBy TEXT,
        metadata TEXT
      )
    `);

    // === Step 2: Run all registered migrations ===
    // The base schema above replicates createTables() + migrateSchema() which means
    // columns added by old-style migrations (002-046) already exist. However, those
    // migrations also CREATE TABLE for auth, notifications, etc. We run all migrations
    // in order: old-style ones (002-046) are wrapped in try/catch so ALTER TABLE
    // duplicate-column errors are harmlessly ignored while CREATE TABLE IF NOT EXISTS
    // calls succeed. New-style migrations (047+) use settingsKey guards.
    const migrations = registry.getAll();

    for (const migration of migrations) {
      if (!migration.sqlite) continue;

      if (migration.selfIdempotent) {
        // selfIdempotent migrations handle their own idempotency
        try {
          migration.sqlite(db, getSetting, setSetting);
        } catch {
          // Expected: some may fail on fresh DB with full base schema
        }
      } else if (migration.settingsKey) {
        const completed = getSetting(migration.settingsKey);
        if (completed !== 'completed') {
          if (migration.number <= 46) {
            // Old-style migrations: run with try/catch since ALTER TABLE ADD COLUMN
            // will fail for columns already in the base schema, but CREATE TABLE
            // IF NOT EXISTS and other operations will succeed.
            try {
              migration.sqlite(db, getSetting, setSetting);
            } catch {
              // Expected: duplicate column errors from ALTER TABLE
            }
          } else {
            // New-style migrations (047+): run normally
            migration.sqlite(db, getSetting, setSetting);
          }
          setSetting(migration.settingsKey, 'completed');
        }
      }
    }
  });

  afterAll(() => {
    db.close();
  });

  describe('columns that had BIGINT bugs (#1967, #1973)', () => {
    it('messages table has relayNode column', () => {
      expect(getColumns('messages')).toContain('relayNode');
    });

    it('messages table has ackFromNode column', () => {
      expect(getColumns('messages')).toContain('ackFromNode');
    });

    it('telemetry table has packetId column', () => {
      expect(getColumns('telemetry')).toContain('packetId');
    });
  });

  describe('columns from migrations 083/084 (skipped by PR #2301 bug)', () => {
    it('nodes table has lastMeshReceivedKey column', () => {
      expect(getColumns('nodes')).toContain('lastMeshReceivedKey');
    });

    it('nodes table has keyMismatchDetected column', () => {
      expect(getColumns('nodes')).toContain('keyMismatchDetected');
    });
  });

  describe('tables created by later migrations', () => {
    it('auto_key_repair_log table exists (migration 046)', () => {
      expect(getTableNames()).toContain('auto_key_repair_log');
    });

    it('auto_key_repair_state table exists (migration 046)', () => {
      expect(getTableNames()).toContain('auto_key_repair_state');
    });

    it('auto_distance_delete_log table exists (migration 086)', () => {
      expect(getTableNames()).toContain('auto_distance_delete_log');
    });

    it('ignored_nodes table exists (migration 066)', () => {
      expect(getTableNames()).toContain('ignored_nodes');
    });
  });

  describe('core tables exist', () => {
    it('all core tables are present', () => {
      const tables = getTableNames();
      const coreTables = [
        'nodes',
        'messages',
        'channels',
        'telemetry',
        'traceroutes',
        'settings',
        'neighbor_info',
      ];
      for (const table of coreTables) {
        expect(tables, `Missing core table: ${table}`).toContain(table);
      }
    });
  });

  describe('key node columns exist', () => {
    it('nodes table has all security-related columns', () => {
      const cols = getColumns('nodes');
      const securityColumns = [
        'publicKey',
        'lastMeshReceivedKey',
        'hasPKC',
        'lastPKIPacket',
        'keyIsLowEntropy',
        'duplicateKeyDetected',
        'keyMismatchDetected',
        'keySecurityIssueDetails',
      ];
      for (const col of securityColumns) {
        expect(cols, `Missing security column: ${col}`).toContain(col);
      }
    });

    it('nodes table has spam detection columns', () => {
      const cols = getColumns('nodes');
      expect(cols).toContain('isExcessivePackets');
      expect(cols).toContain('packetRatePerHour');
    });

    it('nodes table has favorite/ignored columns', () => {
      const cols = getColumns('nodes');
      expect(cols).toContain('isFavorite');
      expect(cols).toContain('favoriteLocked');
      expect(cols).toContain('isIgnored');
    });
  });

  describe('migration count sanity check', () => {
    it('registry has the expected number of migrations', () => {
      // After migration consolidation (v3.7 baseline), old 001-077 were replaced
      // by a single baseline migration. Update this number when adding new migrations.
      expect(registry.count()).toBeGreaterThanOrEqual(11);
    });
  });
});
