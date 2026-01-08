#!/usr/bin/env node
/**
 * Database Migration CLI Tool
 *
 * Migrates data from SQLite to PostgreSQL database.
 *
 * Usage:
 *   npx ts-node src/cli/migrate-db.ts --from sqlite:/data/meshmonitor.db --to postgres://user:pass@host/db
 *
 * Options:
 *   --from    Source database connection string (sqlite:path or postgres://...)
 *   --to      Target database connection string (postgres://...)
 *   --dry-run Show what would be migrated without making changes
 *   --verbose Enable verbose logging
 */

import Database from 'better-sqlite3';
import { Pool } from 'pg';
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import { drizzle as drizzleSqlite } from 'drizzle-orm/better-sqlite3';
import * as schema from '../db/schema/index.js';

// Table migration order (respects foreign key dependencies)
const TABLE_ORDER = [
  // Core tables (no dependencies)
  'nodes',
  'channels',
  'settings',
  // Tables with node dependencies
  'messages',
  'telemetry',
  'neighbor_info',
  'traceroutes',
  'route_segments',
  // Auth tables
  'users',
  'permissions',
  'sessions',
  'audit_log',
  'api_tokens',
  // Notification tables
  'push_subscriptions',
  'user_notification_preferences',
  // Misc tables
  'read_messages',
  'packet_log',
  'backup_history',
  'custom_themes',
  'user_map_preferences',
  'upgrade_history',
  'auto_traceroute_log',
  'key_repair_state',
];

interface MigrationOptions {
  from: string;
  to: string;
  dryRun: boolean;
  verbose: boolean;
}

interface MigrationStats {
  table: string;
  sourceCount: number;
  migratedCount: number;
  duration: number;
}

function parseArgs(): MigrationOptions {
  const args = process.argv.slice(2);
  const options: MigrationOptions = {
    from: '',
    to: '',
    dryRun: false,
    verbose: false,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--from':
        options.from = args[++i] || '';
        break;
      case '--to':
        options.to = args[++i] || '';
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--verbose':
        options.verbose = true;
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
    }
  }

  return options;
}

function printHelp(): void {
  console.log(`
Database Migration Tool for MeshMonitor

Usage:
  npx ts-node src/cli/migrate-db.ts [options]

Options:
  --from <url>    Source database URL (required)
                  Examples:
                    sqlite:/data/meshmonitor.db
                    sqlite:./meshmonitor.db

  --to <url>      Target database URL (required)
                  Examples:
                    postgres://user:pass@localhost:5432/meshmonitor
                    postgresql://user:pass@host/db

  --dry-run       Show what would be migrated without making changes
  --verbose       Enable verbose logging
  --help, -h      Show this help message

Examples:
  # Migrate from SQLite to PostgreSQL
  npx ts-node src/cli/migrate-db.ts \\
    --from sqlite:/data/meshmonitor.db \\
    --to postgres://meshmonitor:password@localhost:5432/meshmonitor

  # Dry run to see what would be migrated
  npx ts-node src/cli/migrate-db.ts \\
    --from sqlite:/data/meshmonitor.db \\
    --to postgres://meshmonitor:password@localhost/meshmonitor \\
    --dry-run
`);
}

function log(message: string, verbose: boolean = false, options?: MigrationOptions): void {
  if (!verbose || (options && options.verbose)) {
    console.log(message);
  }
}

async function connectSqlite(url: string): Promise<{ db: ReturnType<typeof drizzleSqlite>; rawDb: Database.Database }> {
  // Parse sqlite:path format
  const path = url.replace(/^sqlite:/, '');
  console.log(`📂 Connecting to SQLite: ${path}`);

  const rawDb = new Database(path, { readonly: true });
  const db = drizzleSqlite(rawDb, { schema });

  return { db, rawDb };
}

async function connectPostgres(url: string): Promise<{ db: ReturnType<typeof drizzlePg>; pool: Pool }> {
  console.log(`🐘 Connecting to PostgreSQL: ${url.replace(/:[^:@]+@/, ':****@')}`);

  const pool = new Pool({ connectionString: url });

  // Test connection
  const client = await pool.connect();
  await client.query('SELECT NOW()');
  client.release();

  const db = drizzlePg(pool, { schema });

  return { db, pool };
}

async function getTableCount(rawDb: Database.Database, table: string): Promise<number> {
  try {
    const result = rawDb.prepare(`SELECT COUNT(*) as count FROM ${table}`).get() as { count: number };
    return result.count;
  } catch {
    return 0; // Table doesn't exist
  }
}

async function getTableData(rawDb: Database.Database, table: string): Promise<unknown[]> {
  try {
    return rawDb.prepare(`SELECT * FROM ${table}`).all();
  } catch {
    return [];
  }
}

async function insertIntoPostgres(pool: Pool, table: string, rows: unknown[]): Promise<number> {
  if (rows.length === 0) return 0;

  const client = await pool.connect();
  let inserted = 0;

  try {
    await client.query('BEGIN');

    for (const row of rows) {
      const obj = row as Record<string, unknown>;
      const columns = Object.keys(obj);
      const values = Object.values(obj);
      const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');

      const query = `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`;

      try {
        await client.query(query, values);
        inserted++;
      } catch (err) {
        // Log but continue - some rows may have FK issues
        console.warn(`  ⚠️  Failed to insert row: ${(err as Error).message}`);
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return inserted;
}

async function createPostgresSchema(pool: Pool): Promise<void> {
  console.log('📋 Creating PostgreSQL schema...');

  const client = await pool.connect();

  try {
    // Create tables in order - this is a simplified version
    // In production, you'd use Drizzle migrations
    const schemaSql = `
      -- Nodes table
      CREATE TABLE IF NOT EXISTS nodes (
        "nodeNum" INTEGER PRIMARY KEY,
        "nodeId" TEXT NOT NULL UNIQUE,
        "longName" TEXT,
        "shortName" TEXT,
        "hwModel" INTEGER,
        role INTEGER,
        "hopsAway" INTEGER,
        "lastMessageHops" INTEGER,
        "viaMqtt" BOOLEAN DEFAULT false,
        macaddr TEXT,
        latitude REAL,
        longitude REAL,
        altitude REAL,
        "batteryLevel" INTEGER,
        voltage REAL,
        "channelUtilization" REAL,
        "airUtilTx" REAL,
        "lastHeard" BIGINT,
        snr REAL,
        rssi INTEGER,
        "lastTracerouteRequest" BIGINT,
        "firmwareVersion" TEXT,
        channel INTEGER,
        "isFavorite" BOOLEAN DEFAULT false,
        "isIgnored" BOOLEAN DEFAULT false,
        mobile INTEGER DEFAULT 0,
        "rebootCount" INTEGER,
        "publicKey" TEXT,
        "hasPKC" BOOLEAN DEFAULT false,
        "lastPKIPacket" BIGINT,
        "keyIsLowEntropy" BOOLEAN DEFAULT false,
        "duplicateKeyDetected" BOOLEAN DEFAULT false,
        "keyMismatchDetected" BOOLEAN DEFAULT false,
        "keySecurityIssueDetails" TEXT,
        "welcomedAt" BIGINT,
        "positionChannel" INTEGER,
        "positionPrecisionBits" INTEGER,
        "positionGpsAccuracy" INTEGER,
        "positionHdop" REAL,
        "positionTimestamp" BIGINT,
        "positionOverrideLat" REAL,
        "positionOverrideLon" REAL,
        "positionOverrideSource" TEXT,
        "positionOverrideUpdatedAt" BIGINT,
        "positionOverridePrivacy" TEXT,
        "estimatedLatitude" REAL,
        "estimatedLongitude" REAL,
        "estimatedPositionTimestamp" BIGINT,
        "estimatedPositionConfidence" REAL,
        "createdAt" BIGINT,
        "updatedAt" BIGINT
      );

      -- Channels table
      CREATE TABLE IF NOT EXISTS channels (
        id SERIAL PRIMARY KEY,
        name TEXT,
        psk TEXT,
        role INTEGER DEFAULT 0,
        "uplinkEnabled" BOOLEAN DEFAULT false,
        "downlinkEnabled" BOOLEAN DEFAULT false,
        "positionPrecision" INTEGER
      );

      -- Messages table
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        "fromNodeId" TEXT NOT NULL,
        "toNodeId" TEXT,
        channel INTEGER,
        message TEXT,
        timestamp BIGINT NOT NULL,
        "rxTime" BIGINT,
        "rxSnr" REAL,
        "rxRssi" INTEGER,
        "hopLimit" INTEGER,
        "hopStart" INTEGER,
        "wantAck" BOOLEAN DEFAULT false,
        acknowledged BOOLEAN DEFAULT false,
        "ackFailed" BOOLEAN DEFAULT false,
        "requestId" INTEGER,
        "deliveryState" TEXT,
        "createdAt" BIGINT
      );

      -- Telemetry table
      CREATE TABLE IF NOT EXISTS telemetry (
        id SERIAL PRIMARY KEY,
        "nodeId" TEXT NOT NULL,
        "telemetryType" TEXT NOT NULL,
        "batteryLevel" INTEGER,
        voltage REAL,
        "channelUtilization" REAL,
        "airUtilTx" REAL,
        temperature REAL,
        "relativeHumidity" REAL,
        "barometricPressure" REAL,
        "gasResistance" REAL,
        iaq INTEGER,
        distance REAL,
        lux REAL,
        "whiteLux" REAL,
        ir INTEGER,
        uv REAL,
        wind_direction INTEGER,
        wind_speed REAL,
        weight REAL,
        current REAL,
        voltage1 REAL,
        voltage2 REAL,
        voltage3 REAL,
        current1 REAL,
        current2 REAL,
        current3 REAL,
        "uptimeSeconds" INTEGER,
        timestamp BIGINT NOT NULL,
        "createdAt" BIGINT
      );

      -- Settings table
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      -- Neighbor info table
      CREATE TABLE IF NOT EXISTS neighbor_info (
        id SERIAL PRIMARY KEY,
        "nodeNum" INTEGER NOT NULL,
        "neighborNodeNum" INTEGER NOT NULL,
        snr REAL,
        "lastRxTime" BIGINT,
        timestamp BIGINT NOT NULL,
        "createdAt" BIGINT
      );

      -- Traceroutes table
      CREATE TABLE IF NOT EXISTS traceroutes (
        id SERIAL PRIMARY KEY,
        "fromNodeNum" INTEGER NOT NULL,
        "toNodeNum" INTEGER NOT NULL,
        "fromNodeId" TEXT,
        "toNodeId" TEXT,
        route TEXT,
        "routeBack" TEXT,
        "snrTowards" TEXT,
        "snrBack" TEXT,
        timestamp BIGINT NOT NULL,
        "createdAt" BIGINT
      );

      -- Route segments table
      CREATE TABLE IF NOT EXISTS route_segments (
        id SERIAL PRIMARY KEY,
        "fromNodeNum" INTEGER NOT NULL,
        "toNodeNum" INTEGER NOT NULL,
        "fromNodeId" TEXT,
        "toNodeId" TEXT,
        "distanceKm" REAL,
        "isRecordHolder" BOOLEAN DEFAULT false,
        timestamp BIGINT NOT NULL,
        "createdAt" BIGINT
      );

      -- Users table
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT,
        email TEXT,
        display_name TEXT,
        auth_provider TEXT NOT NULL DEFAULT 'local',
        oidc_subject TEXT,
        is_admin BOOLEAN DEFAULT false,
        is_active BOOLEAN DEFAULT true,
        password_locked BOOLEAN DEFAULT false,
        created_at BIGINT NOT NULL,
        last_login_at BIGINT,
        created_by INTEGER
      );

      -- Permissions table
      CREATE TABLE IF NOT EXISTS permissions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        resource TEXT NOT NULL,
        can_read BOOLEAN DEFAULT false,
        can_write BOOLEAN DEFAULT false,
        granted_at BIGINT NOT NULL,
        granted_by INTEGER
      );

      -- Sessions table
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at BIGINT NOT NULL,
        created_at BIGINT NOT NULL,
        ip_address TEXT,
        user_agent TEXT
      );

      -- Audit log table
      CREATE TABLE IF NOT EXISTS audit_log (
        id SERIAL PRIMARY KEY,
        timestamp BIGINT NOT NULL,
        user_id INTEGER,
        username TEXT,
        action TEXT NOT NULL,
        resource TEXT,
        resource_id TEXT,
        details TEXT,
        ip_address TEXT,
        user_agent TEXT
      );

      -- API tokens table
      CREATE TABLE IF NOT EXISTS api_tokens (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        prefix TEXT NOT NULL,
        is_active BOOLEAN DEFAULT true,
        created_at BIGINT NOT NULL,
        last_used_at BIGINT,
        expires_at BIGINT
      );

      -- Push subscriptions table
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER,
        endpoint TEXT NOT NULL UNIQUE,
        p256dh_key TEXT NOT NULL,
        auth_key TEXT NOT NULL,
        user_agent TEXT,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        last_used_at BIGINT
      );

      -- User notification preferences table
      CREATE TABLE IF NOT EXISTS user_notification_preferences (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        channel_id INTEGER,
        notify_on_message BOOLEAN DEFAULT true,
        notify_on_emoji BOOLEAN DEFAULT true,
        notify_on_inactive_node BOOLEAN DEFAULT false,
        notify_on_server_events BOOLEAN DEFAULT false,
        prefix_with_node_name BOOLEAN DEFAULT false,
        apprise_urls TEXT,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        UNIQUE(user_id, channel_id)
      );

      -- Read messages table
      CREATE TABLE IF NOT EXISTS read_messages (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        message_id TEXT NOT NULL,
        read_at BIGINT NOT NULL,
        UNIQUE(user_id, message_id)
      );

      -- Packet log table
      CREATE TABLE IF NOT EXISTS packet_log (
        id SERIAL PRIMARY KEY,
        packet_id INTEGER,
        timestamp BIGINT NOT NULL,
        from_node INTEGER NOT NULL,
        from_node_id TEXT,
        "from_node_longName" TEXT,
        to_node INTEGER,
        to_node_id TEXT,
        "to_node_longName" TEXT,
        channel INTEGER,
        portnum INTEGER NOT NULL,
        portnum_name TEXT,
        encrypted BOOLEAN NOT NULL,
        snr REAL,
        rssi INTEGER,
        hop_limit INTEGER,
        hop_start INTEGER,
        relay_node INTEGER,
        payload_size INTEGER,
        want_ack BOOLEAN,
        priority INTEGER,
        payload_preview TEXT,
        metadata TEXT,
        direction TEXT,
        created_at BIGINT
      );

      -- Backup history table
      CREATE TABLE IF NOT EXISTS backup_history (
        id SERIAL PRIMARY KEY,
        filename TEXT NOT NULL,
        size_bytes BIGINT,
        backup_type TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at BIGINT NOT NULL,
        completed_at BIGINT,
        error_message TEXT,
        metadata TEXT
      );

      -- Custom themes table
      CREATE TABLE IF NOT EXISTS custom_themes (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT NOT NULL UNIQUE,
        definition TEXT NOT NULL,
        is_builtin BOOLEAN DEFAULT false,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      );

      -- User map preferences table
      CREATE TABLE IF NOT EXISTS user_map_preferences (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        "mapCenter" TEXT,
        "mapZoom" INTEGER,
        "mapStyle" TEXT,
        "showOfflineNodes" BOOLEAN DEFAULT true,
        "showFavoriteNodes" BOOLEAN DEFAULT true,
        "clusterNodes" BOOLEAN DEFAULT true,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        UNIQUE(user_id)
      );

      -- Upgrade history table
      CREATE TABLE IF NOT EXISTS upgrade_history (
        id SERIAL PRIMARY KEY,
        from_version TEXT NOT NULL,
        to_version TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at BIGINT NOT NULL,
        completed_at BIGINT,
        error_message TEXT,
        metadata TEXT
      );

      -- Auto traceroute log table
      CREATE TABLE IF NOT EXISTS auto_traceroute_log (
        id SERIAL PRIMARY KEY,
        "toNodeNum" INTEGER NOT NULL,
        "toNodeId" TEXT,
        "requestedAt" BIGINT NOT NULL,
        "completedAt" BIGINT,
        success BOOLEAN,
        "errorMessage" TEXT
      );

      -- Key repair state table
      CREATE TABLE IF NOT EXISTS key_repair_state (
        id SERIAL PRIMARY KEY,
        "nodeNum" INTEGER NOT NULL UNIQUE,
        state TEXT NOT NULL,
        "requestedAt" BIGINT,
        "completedAt" BIGINT,
        "attempts" INTEGER DEFAULT 0,
        "lastError" TEXT,
        "createdAt" BIGINT NOT NULL,
        "updatedAt" BIGINT NOT NULL
      );
    `;

    await client.query(schemaSql);
    console.log('✅ PostgreSQL schema created');
  } finally {
    client.release();
  }
}

async function migrate(options: MigrationOptions): Promise<void> {
  console.log('\n🚀 MeshMonitor Database Migration Tool\n');
  console.log('━'.repeat(50));

  if (!options.from || !options.to) {
    console.error('❌ Error: Both --from and --to are required');
    console.error('   Run with --help for usage information\n');
    process.exit(1);
  }

  if (!options.from.startsWith('sqlite:')) {
    console.error('❌ Error: Source must be a SQLite database (sqlite:path)');
    process.exit(1);
  }

  if (!options.to.startsWith('postgres://') && !options.to.startsWith('postgresql://')) {
    console.error('❌ Error: Target must be a PostgreSQL database (postgres://...)');
    process.exit(1);
  }

  if (options.dryRun) {
    console.log('🔍 DRY RUN MODE - No changes will be made\n');
  }

  const stats: MigrationStats[] = [];
  let sourceDb: { db: ReturnType<typeof drizzleSqlite>; rawDb: Database.Database } | null = null;
  let targetDb: { db: ReturnType<typeof drizzlePg>; pool: Pool } | null = null;

  try {
    // Connect to databases
    sourceDb = await connectSqlite(options.from);
    targetDb = await connectPostgres(options.to);

    console.log('✅ Connected to both databases\n');

    // Create schema in PostgreSQL
    if (!options.dryRun) {
      await createPostgresSchema(targetDb.pool);
    }

    console.log('\n📊 Migration Progress:\n');

    // Migrate each table
    for (const table of TABLE_ORDER) {
      const startTime = Date.now();
      const sourceCount = await getTableCount(sourceDb.rawDb, table);

      if (sourceCount === 0) {
        log(`  ⏭️  ${table}: 0 rows (skipped)`, false);
        continue;
      }

      process.stdout.write(`  📦 ${table}: ${sourceCount} rows... `);

      if (options.dryRun) {
        console.log('(dry run)');
        stats.push({
          table,
          sourceCount,
          migratedCount: sourceCount,
          duration: 0,
        });
        continue;
      }

      const rows = await getTableData(sourceDb.rawDb, table);
      const migratedCount = await insertIntoPostgres(targetDb.pool, table, rows);
      const duration = Date.now() - startTime;

      console.log(`✅ ${migratedCount} migrated (${duration}ms)`);

      stats.push({
        table,
        sourceCount,
        migratedCount,
        duration,
      });
    }

    // Summary
    console.log('\n' + '━'.repeat(50));
    console.log('\n📈 Migration Summary:\n');

    const totalSource = stats.reduce((sum, s) => sum + s.sourceCount, 0);
    const totalMigrated = stats.reduce((sum, s) => sum + s.migratedCount, 0);
    const totalDuration = stats.reduce((sum, s) => sum + s.duration, 0);

    console.log(`  Total rows in source:  ${totalSource.toLocaleString()}`);
    console.log(`  Total rows migrated:   ${totalMigrated.toLocaleString()}`);
    console.log(`  Total duration:        ${(totalDuration / 1000).toFixed(2)}s`);

    if (totalSource !== totalMigrated && !options.dryRun) {
      console.log('\n⚠️  Warning: Some rows were not migrated (likely due to conflicts)');
    }

    console.log('\n✅ Migration complete!\n');
  } catch (error) {
    console.error('\n❌ Migration failed:', (error as Error).message);
    if (options.verbose) {
      console.error(error);
    }
    process.exit(1);
  } finally {
    // Cleanup
    if (sourceDb) {
      sourceDb.rawDb.close();
    }
    if (targetDb) {
      await targetDb.pool.end();
    }
  }
}

// Run migration
const options = parseArgs();
migrate(options).catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
