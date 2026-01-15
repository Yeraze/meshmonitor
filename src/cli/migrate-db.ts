#!/usr/bin/env node
/**
 * Database Migration CLI Tool
 *
 * Migrates data from SQLite to PostgreSQL or MySQL database.
 *
 * Usage:
 *   npx ts-node src/cli/migrate-db.ts --from sqlite:/data/meshmonitor.db --to postgres://user:pass@host/db
 *   npx ts-node src/cli/migrate-db.ts --from sqlite:/data/meshmonitor.db --to mysql://user:pass@host/db
 *
 * Options:
 *   --from    Source database connection string (sqlite:path)
 *   --to      Target database connection string (postgres://... or mysql://...)
 *   --dry-run Show what would be migrated without making changes
 *   --verbose Enable verbose logging
 */

import Database from 'better-sqlite3';
import { Pool } from 'pg';
import mysql from 'mysql2/promise';
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import { drizzle as drizzleSqlite } from 'drizzle-orm/better-sqlite3';
import { drizzle as drizzleMysql } from 'drizzle-orm/mysql2';
import * as schema from '../db/schema/index.js';

// Table migration order (respects foreign key dependencies)
// Tables not in this list will be migrated at the end
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
  'auto_traceroute_nodes',
  'key_repair_state',
  'auto_key_repair_state',
  'auto_key_repair_log',
  'solar_estimates',
  'system_backup_history',
];

// Column name mappings from SQLite (snake_case) to PostgreSQL (camelCase)
// Only needed for tables where SQLite uses different naming conventions
const COLUMN_MAPPINGS: Record<string, Record<string, string>> = {
  users: {
    password_hash: 'passwordHash',
    display_name: 'displayName',
    auth_provider: 'authMethod',
    oidc_subject: 'oidcSubject',
    is_admin: 'isAdmin',
    is_active: 'isActive',
    created_at: 'createdAt',
    last_login_at: 'lastLoginAt',
    updated_at: 'updatedAt',
    password_locked: 'passwordLocked',
  },
  permissions: {
    user_id: 'userId',
    can_read: 'canRead',
    can_write: 'canWrite',
    can_delete: 'canDelete',
  },
  api_tokens: {
    user_id: 'userId',
    token_hash: 'tokenHash',
    is_active: 'isActive',
    created_at: 'createdAt',
    last_used_at: 'lastUsedAt',
    created_by: 'createdBy',
    revoked_at: 'revokedAt',
    revoked_by: 'revokedBy',
    expires_at: 'expiresAt',
  },
  read_messages: {
    message_id: 'messageId',
    user_id: 'userId',
    read_at: 'readAt',
  },
  push_subscriptions: {
    user_id: 'userId',
    p256dh_key: 'p256dhKey',
    auth_key: 'authKey',
    user_agent: 'userAgent',
    created_at: 'createdAt',
    updated_at: 'updatedAt',
    last_used_at: 'lastUsedAt',
  },
  user_notification_preferences: {
    user_id: 'userId',
    // Old SQLite column names → New PostgreSQL column names
    enable_web_push: 'notifyOnMessage',           // Old: enable_web_push → New: notifyOnMessage
    enable_direct_messages: 'notifyOnDirectMessage', // Old: enable_direct_messages → New: notifyOnDirectMessage
    // enabled_channels is handled specially in transformValue (JSON array → boolean)
    enabled_channels: 'notifyOnChannelMessage',   // Old: enabled_channels (JSON) → New: notifyOnChannelMessage (bool)
    notify_on_emoji: 'notifyOnEmoji',
    notify_on_new_node: 'notifyOnNewNode',        // Old: notify_on_new_node → New: notifyOnNewNode
    notify_on_traceroute: 'notifyOnTraceroute',   // Old: notify_on_traceroute → New: notifyOnTraceroute
    notify_on_inactive_node: 'notifyOnInactiveNode',
    notify_on_server_events: 'notifyOnServerEvents',
    prefix_with_node_name: 'prefixWithNodeName',
    enable_apprise: 'appriseEnabled',             // Old: enable_apprise → New: appriseEnabled
    apprise_urls: 'appriseUrls',
    notify_on_mqtt: 'notifyOnMqtt',
    created_at: 'createdAt',
    updated_at: 'updatedAt',
  },
  packet_log: {
    packet_id: 'packetId',
    from_node: 'fromNodeNum',
    to_node: 'toNodeNum',
    hop_limit: 'hopLimit',
    hop_start: 'hopStart',
    want_ack: 'wantAck',
    via_mqtt: 'viaMqtt',
    rx_time: 'rxTime',
    rx_snr: 'rxSnr',
    rx_rssi: 'rxRssi',
    created_at: 'createdAt',
  },
  audit_log: {
    user_id: 'userId',
    ip_address: 'ipAddress',
    user_agent: 'userAgent',
  },
  sessions: {
    // Sessions use different column names
  },
};

// Columns to skip during migration (removed or incompatible)
// NOTE: Be careful not to skip columns that should be migrated!
// user_notification_preferences columns were previously skipped but are now migrated via COLUMN_MAPPINGS:
// - enable_web_push -> notifyOnMessage
// - enable_direct_messages -> notifyOnDirectMessage
// - enabled_channels -> notifyOnChannelMessage (JSON array transformed to boolean)
// - enable_apprise -> appriseEnabled
// - apprise_urls -> appriseUrls
const SKIP_COLUMNS: Record<string, Set<string>> = {
  users: new Set(['created_by']),
  permissions: new Set(['granted_at', 'granted_by']),
  // Only skip columns that don't have PostgreSQL equivalents
  user_notification_preferences: new Set([
    'whitelist', // Different schema - JSON format differs, not supported in new schema
    'blacklist', // Different schema - JSON format differs, not supported in new schema
    'monitored_nodes', // Different schema - JSON format differs, not supported in new schema
    // notify_on_new_node and notify_on_traceroute are now migrated via COLUMN_MAPPINGS
  ]),
};

// Tables to skip entirely during migration (incompatible schemas or non-essential)
const SKIP_TABLES = new Set([
  'packet_log', // Debug logging - schema incompatible and data is transient
  'sqlite_sequence', // SQLite internal table
  'backup_history', // Schema mismatch - null filePath values
  'upgrade_history', // Schema mismatch - UUID in integer column
  'auto_traceroute_log', // Non-essential logging
  'auto_traceroute_nodes', // Non-essential
  'auto_key_repair_state', // Non-essential
  'auto_key_repair_log', // Non-essential logging
  // solar_estimates - REMOVED: Users want historical solar data preserved
  'system_backup_history', // Non-essential
  'user_map_preferences', // Column mapping issues
]);

// Value transformations needed during migration
function transformValue(tableName: string, column: string, value: unknown): unknown {
  // Transform auth_provider 'local' to authMethod 'local', 'oidc' to 'oidc'
  if (tableName === 'users' && column === 'authMethod' && value === 'oidc') {
    return 'oidc';
  }

  // Transform enabled_channels JSON array to notifyOnChannelMessage boolean
  // If the array has any channels, notifications are enabled for channels
  if (tableName === 'user_notification_preferences' && column === 'notifyOnChannelMessage') {
    if (typeof value === 'string') {
      try {
        const channels = JSON.parse(value);
        return Array.isArray(channels) && channels.length > 0;
      } catch {
        return false;
      }
    }
    if (Array.isArray(value)) {
      return value.length > 0;
    }
    return false;
  }

  // Transform SQLite integers (0/1) to booleans for specific columns
  const booleanColumns = new Set([
    'isAdmin', 'isActive', 'passwordLocked', 'canRead', 'canWrite', 'canDelete',
    'wantAck', 'viaMqtt', 'notifyOnMessage', 'notifyOnDirectMessage', 'notifyOnChannelMessage',
    'notifyOnEmoji', 'notifyOnInactiveNode', 'notifyOnServerEvents', 'prefixWithNodeName',
    'appriseEnabled', 'notifyOnMqtt',
  ]);
  if (booleanColumns.has(column)) {
    return value === 1 || value === '1' || value === true;
  }
  return value;
}

// Default values for required columns that may not exist in source
const DEFAULT_VALUES: Record<string, Record<string, () => unknown>> = {
  users: {
    updatedAt: () => Date.now(),
  },
  permissions: {
    canDelete: () => false,
  },
  user_notification_preferences: {
    notifyOnMessage: () => true,
    notifyOnDirectMessage: () => true,
    notifyOnChannelMessage: () => false,
  },
};

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
                    mysql://user:pass@localhost:3306/meshmonitor
                    mariadb://user:pass@host/db

  --dry-run       Show what would be migrated without making changes
  --verbose       Enable verbose logging
  --help, -h      Show this help message

Examples:
  # Migrate from SQLite to PostgreSQL
  npx ts-node src/cli/migrate-db.ts \\
    --from sqlite:/data/meshmonitor.db \\
    --to postgres://meshmonitor:password@localhost:5432/meshmonitor

  # Migrate from SQLite to MySQL
  npx ts-node src/cli/migrate-db.ts \\
    --from sqlite:/data/meshmonitor.db \\
    --to mysql://meshmonitor:password@localhost:3306/meshmonitor

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

/**
 * Parse a MySQL URL to extract components
 */
function parseMySQLUrl(url: string): {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
} | null {
  try {
    const normalizedUrl = url.replace(/^(mysql|mariadb):\/\//, 'http://');
    const parsed = new URL(normalizedUrl);
    return {
      host: parsed.hostname,
      port: parseInt(parsed.port || '3306', 10),
      database: parsed.pathname.slice(1),
      user: decodeURIComponent(parsed.username),
      password: decodeURIComponent(parsed.password),
    };
  } catch {
    return null;
  }
}

async function connectMySQL(url: string): Promise<{ db: any; pool: mysql.Pool }> {
  console.log(`🐬 Connecting to MySQL: ${url.replace(/:[^:@]+@/, ':****@')}`);

  const parsed = parseMySQLUrl(url);
  if (!parsed) {
    throw new Error('Invalid MySQL connection string');
  }

  const pool = mysql.createPool({
    host: parsed.host,
    port: parsed.port,
    user: parsed.user,
    password: parsed.password,
    database: parsed.database,
    connectionLimit: 10,
  });

  // Test connection
  const connection = await pool.getConnection();
  await connection.query('SELECT NOW()');
  connection.release();

  const db = drizzleMysql(pool, { schema, mode: 'default' });

  return { db, pool };
}

/**
 * Reset PostgreSQL sequences to max ID values after migration
 * This prevents primary key conflicts when new rows are inserted
 */
async function resetPostgresSequences(pool: Pool): Promise<void> {
  console.log('\n🔄 Resetting PostgreSQL sequences...');

  const sequenceTables = [
    { table: 'audit_log', sequence: 'audit_log_id_seq' },
    { table: 'telemetry', sequence: 'telemetry_id_seq' },
    { table: 'traceroutes', sequence: 'traceroutes_id_seq' },
    { table: 'route_segments', sequence: 'route_segments_id_seq' },
    { table: 'neighbor_info', sequence: 'neighbor_info_id_seq' },
    { table: 'users', sequence: 'users_id_seq' },
    { table: 'permissions', sequence: 'permissions_id_seq' },
    { table: 'api_tokens', sequence: 'api_tokens_id_seq' },
    { table: 'push_subscriptions', sequence: 'push_subscriptions_id_seq' },
    { table: 'user_notification_preferences', sequence: 'user_notification_preferences_id_seq' },
    { table: 'packet_log', sequence: 'packet_log_id_seq' },
    { table: 'backup_history', sequence: 'backup_history_id_seq' },
    { table: 'upgrade_history', sequence: 'upgrade_history_id_seq' },
    { table: 'custom_themes', sequence: 'custom_themes_id_seq' },
  ];

  const client = await pool.connect();
  try {
    for (const { table, sequence } of sequenceTables) {
      try {
        await client.query(`SELECT setval('${sequence}', COALESCE((SELECT MAX(id) FROM ${table}), 1))`);
      } catch {
        // Sequence or table may not exist, skip silently
      }
    }
    console.log('  ✅ Sequences reset to match migrated data');
  } finally {
    client.release();
  }
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

/**
 * Get column types for a PostgreSQL table
 */
async function getPostgresColumnTypes(client: import('pg').PoolClient, table: string): Promise<Map<string, string>> {
  // Query with schema qualification to avoid ambiguity
  const result = await client.query(`
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = $1
  `, [table]);

  const typeMap = new Map<string, string>();
  for (const row of result.rows) {
    typeMap.set(row.column_name, row.data_type);
  }
  return typeMap;
}

/**
 * Sanitize a value based on PostgreSQL target type
 * Handles SQLite's loose typing (floats in INTEGER columns, etc.)
 */
function sanitizeValue(value: unknown, pgType: string): unknown {
  if (value === null || value === undefined) return value;

  // Handle integer types - truncate floats
  if (pgType === 'bigint' || pgType === 'integer' || pgType === 'smallint') {
    if (typeof value === 'number' && !Number.isInteger(value)) {
      return Math.trunc(value);
    }
    // Handle string numbers that might be floats
    if (typeof value === 'string' && value.includes('.')) {
      const num = parseFloat(value);
      if (!isNaN(num)) {
        return Math.trunc(num);
      }
    }
  }

  // Handle boolean - SQLite stores as 0/1
  if (pgType === 'boolean') {
    if (value === 0 || value === '0' || value === 'false') return false;
    if (value === 1 || value === '1' || value === 'true') return true;
    return Boolean(value);
  }

  return value;
}

async function insertIntoPostgres(pool: Pool, table: string, rows: unknown[]): Promise<number> {
  if (rows.length === 0) return 0;

  const client = await pool.connect();
  let inserted = 0;
  let columnTypes: Map<string, string> | null = null;
  const tableMapping = COLUMN_MAPPINGS[table] || {};
  const skipCols = SKIP_COLUMNS[table] || new Set();

  try {
    // Get column types for this table
    columnTypes = await getPostgresColumnTypes(client, table);

    // Log column diagnostics for nodes table (helps debug welcomedAt migration issues)
    if (table === 'nodes' && rows.length > 0) {
      const sampleRow = rows[0] as Record<string, unknown>;
      const sourceColumns = Object.keys(sampleRow);
      const targetColumns = Array.from(columnTypes.keys());
      const missingInTarget = sourceColumns.filter(col => !columnTypes!.has(col) && !skipCols.has(col));

      if (missingInTarget.length > 0) {
        console.log(`  ⚠️  Nodes table: ${missingInTarget.length} source columns not found in target: ${missingInTarget.join(', ')}`);
      }

      // Specifically check for welcomedAt
      const hasWelcomedAtSource = sourceColumns.includes('welcomedAt');
      const hasWelcomedAtTarget = targetColumns.includes('welcomedAt');
      console.log(`  📊 welcomedAt: source=${hasWelcomedAtSource}, target=${hasWelcomedAtTarget}`);

      // Count how many nodes have welcomedAt set
      const nodesWithWelcome = rows.filter((r: any) => r.welcomedAt !== null && r.welcomedAt !== undefined);
      console.log(`  📊 Nodes with welcomedAt set: ${nodesWithWelcome.length} / ${rows.length}`);
    }

    // Log column diagnostics for user_notification_preferences table
    if (table === 'user_notification_preferences' && rows.length > 0) {
      const sampleRow = rows[0] as Record<string, unknown>;
      const sourceColumns = Object.keys(sampleRow);
      const targetColumns = Array.from(columnTypes.keys());
      console.log(`  📊 Source columns: ${sourceColumns.join(', ')}`);
      console.log(`  📊 Target columns: ${targetColumns.join(', ')}`);

      // Show what mappings will be applied
      const appliedMappings: string[] = [];
      for (const srcCol of sourceColumns) {
        if (skipCols.has(srcCol)) continue;
        const targetCol = tableMapping[srcCol] || srcCol;
        if (srcCol !== targetCol) {
          appliedMappings.push(`${srcCol} → ${targetCol}`);
        }
      }
      if (appliedMappings.length > 0) {
        console.log(`  📊 Column mappings: ${appliedMappings.join(', ')}`);
      }

      // Show sample data for first row
      console.log(`  📊 Sample row: enable_web_push=${sampleRow.enable_web_push}, enable_direct_messages=${sampleRow.enable_direct_messages}, enabled_channels=${sampleRow.enabled_channels}, enable_apprise=${sampleRow.enable_apprise}`);
    }

    await client.query('BEGIN');

    for (const row of rows) {
      const obj = row as Record<string, unknown>;
      const sourceColumns = Object.keys(obj);

      // Map column names and filter out columns that don't exist in target
      const mappedData: Array<{ targetCol: string; value: unknown }> = [];
      const mappedColumns = new Set<string>();

      for (const srcCol of sourceColumns) {
        // Skip columns that should be excluded
        if (skipCols.has(srcCol)) continue;

        const targetCol = tableMapping[srcCol] || srcCol;
        // Check if target column exists
        if (!columnTypes?.has(targetCol)) {
          continue; // Skip columns that don't exist in target schema
        }

        const pgType = columnTypes.get(targetCol) || 'text';
        // Transform first (handles special cases like JSON array → boolean)
        // Then sanitize based on target type
        let value = transformValue(table, targetCol, obj[srcCol]);
        value = sanitizeValue(value, pgType);
        mappedData.push({ targetCol, value });
        mappedColumns.add(targetCol);
      }

      // Add default values for required columns that are missing from source
      const tableDefaults = DEFAULT_VALUES[table];
      if (tableDefaults) {
        for (const [col, defaultFn] of Object.entries(tableDefaults)) {
          if (!mappedColumns.has(col) && columnTypes?.has(col)) {
            mappedData.push({ targetCol: col, value: defaultFn() });
          }
        }
      }

      if (mappedData.length === 0) continue;

      const placeholders = mappedData.map((_, i) => `$${i + 1}`).join(', ');
      const quotedColumns = mappedData.map((d) => `"${d.targetCol}"`).join(', ');
      const values = mappedData.map((d) => d.value);

      const query = `INSERT INTO "${table}" (${quotedColumns}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`;

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

/**
 * Get column types for a MySQL table
 */
async function getMySQLColumnTypes(connection: mysql.PoolConnection, table: string, database: string): Promise<Map<string, string>> {
  const [rows] = await connection.query(`
    SELECT COLUMN_NAME, DATA_TYPE
    FROM information_schema.columns
    WHERE table_schema = ? AND table_name = ?
  `, [database, table]);

  const typeMap = new Map<string, string>();
  for (const row of rows as Array<{ COLUMN_NAME: string; DATA_TYPE: string }>) {
    typeMap.set(row.COLUMN_NAME, row.DATA_TYPE);
  }
  return typeMap;
}

/**
 * Sanitize a value based on MySQL target type
 */
function sanitizeMySQLValue(value: unknown, mysqlType: string): unknown {
  if (value === null || value === undefined) return value;

  // Handle integer types - truncate floats
  if (mysqlType === 'bigint' || mysqlType === 'int' || mysqlType === 'smallint' || mysqlType === 'tinyint') {
    if (typeof value === 'number' && !Number.isInteger(value)) {
      return Math.trunc(value);
    }
    if (typeof value === 'string' && value.includes('.')) {
      const num = parseFloat(value);
      if (!isNaN(num)) {
        return Math.trunc(num);
      }
    }
  }

  // Handle boolean - MySQL stores as TINYINT(1)
  if (mysqlType === 'tinyint') {
    if (value === 0 || value === '0' || value === 'false' || value === false) return 0;
    if (value === 1 || value === '1' || value === 'true' || value === true) return 1;
    return value ? 1 : 0;
  }

  return value;
}

async function insertIntoMySQL(pool: mysql.Pool, table: string, rows: unknown[], database: string): Promise<number> {
  if (rows.length === 0) return 0;

  const connection = await pool.getConnection();
  let inserted = 0;
  let columnTypes: Map<string, string> | null = null;
  const tableMapping = COLUMN_MAPPINGS[table] || {};
  const skipCols = SKIP_COLUMNS[table] || new Set();

  try {
    // Get column types for this table
    columnTypes = await getMySQLColumnTypes(connection, table, database);

    await connection.beginTransaction();

    for (const row of rows) {
      const obj = row as Record<string, unknown>;
      const sourceColumns = Object.keys(obj);

      // Map column names and filter out columns that don't exist in target
      const mappedData: Array<{ targetCol: string; value: unknown }> = [];
      const mappedColumns = new Set<string>();

      for (const srcCol of sourceColumns) {
        // Skip columns that should be excluded
        if (skipCols.has(srcCol)) continue;

        const targetCol = tableMapping[srcCol] || srcCol;
        // Check if target column exists
        if (!columnTypes?.has(targetCol)) {
          continue; // Skip columns that don't exist in target schema
        }

        const mysqlType = columnTypes.get(targetCol) || 'text';
        // Transform first (handles special cases like JSON array → boolean)
        // Then sanitize based on target type
        let value = transformValue(table, targetCol, obj[srcCol]);
        value = sanitizeMySQLValue(value, mysqlType);
        mappedData.push({ targetCol, value });
        mappedColumns.add(targetCol);
      }

      // Add default values for required columns that are missing from source
      const tableDefaults = DEFAULT_VALUES[table];
      if (tableDefaults) {
        for (const [col, defaultFn] of Object.entries(tableDefaults)) {
          if (!mappedColumns.has(col) && columnTypes?.has(col)) {
            mappedData.push({ targetCol: col, value: defaultFn() });
          }
        }
      }

      if (mappedData.length === 0) continue;

      const placeholders = mappedData.map(() => '?').join(', ');
      // Quote column names for MySQL (use backticks)
      const quotedColumns = mappedData.map((d) => `\`${d.targetCol}\``).join(', ');
      const values = mappedData.map((d) => d.value);

      const query = `INSERT IGNORE INTO \`${table}\` (${quotedColumns}) VALUES (${placeholders})`;

      try {
        await connection.execute(query, values);
        inserted++;
      } catch (err) {
        // Log but continue - some rows may have FK issues
        console.warn(`  ⚠️  Failed to insert row: ${(err as Error).message}`);
      }
    }

    await connection.commit();
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }

  return inserted;
}

async function createPostgresSchemaFromApp(pool: Pool): Promise<void> {
  console.log('📋 Creating PostgreSQL schema from application definitions...');

  // Dynamically import to avoid circular dependencies at module load time
  const { POSTGRES_SCHEMA_SQL, POSTGRES_TABLE_NAMES } = await import('../db/schema/postgres-create.js');

  const client = await pool.connect();

  try {
    await client.query(POSTGRES_SCHEMA_SQL);

    for (const tableName of POSTGRES_TABLE_NAMES) {
      console.log(`  ✅ Created table: ${tableName}`);
    }

    console.log('✅ PostgreSQL schema created');
  } finally {
    client.release();
  }
}

async function createMySQLSchemaFromApp(pool: mysql.Pool): Promise<void> {
  console.log('📋 Creating MySQL schema from application definitions...');

  const { MYSQL_SCHEMA_SQL, MYSQL_TABLE_NAMES } = await import('../db/schema/mysql-create.js');

  const connection = await pool.getConnection();
  try {
    // Split by semicolon and execute each statement
    const statements = MYSQL_SCHEMA_SQL.split(';').filter((s: string) => s.trim());
    for (const stmt of statements) {
      try {
        await connection.execute(stmt);
      } catch {
        // Table may already exist, skip
      }
    }
    for (const tableName of MYSQL_TABLE_NAMES) {
      console.log(`  ✅ Created table: ${tableName}`);
    }
    console.log('✅ MySQL schema created');
  } finally {
    connection.release();
  }
}

/**
 * Reset MySQL auto_increment values to max ID after migration
 * This prevents primary key conflicts when new rows are inserted
 */
async function resetMySQLAutoIncrement(pool: mysql.Pool): Promise<void> {
  console.log('\n🔄 Resetting MySQL auto_increment values...');

  const autoIncrementTables = [
    'audit_log',
    'telemetry',
    'traceroutes',
    'route_segments',
    'neighbor_info',
    'users',
    'permissions',
    'api_tokens',
    'push_subscriptions',
    'user_notification_preferences',
    'packet_log',
    'backup_history',
    'upgrade_history',
    'custom_themes',
  ];

  const connection = await pool.getConnection();
  try {
    for (const table of autoIncrementTables) {
      try {
        const [rows] = await connection.execute(`SELECT COALESCE(MAX(id), 0) + 1 as next_id FROM ${table}`);
        const nextId = (rows as Array<{ next_id: number }>)[0]?.next_id || 1;
        await connection.execute(`ALTER TABLE ${table} AUTO_INCREMENT = ${nextId}`);
      } catch {
        // Table may not exist, skip silently
      }
    }
    console.log('  ✅ Auto_increment values reset to match migrated data');
  } finally {
    connection.release();
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

  const isPostgresTarget = options.to.startsWith('postgres://') || options.to.startsWith('postgresql://');
  const isMySQLTarget = options.to.startsWith('mysql://') || options.to.startsWith('mariadb://');

  if (!isPostgresTarget && !isMySQLTarget) {
    console.error('❌ Error: Target must be a PostgreSQL (postgres://...) or MySQL (mysql://...) database');
    process.exit(1);
  }

  if (options.dryRun) {
    console.log('🔍 DRY RUN MODE - No changes will be made\n');
  }

  const stats: MigrationStats[] = [];
  let sourceDb: { db: ReturnType<typeof drizzleSqlite>; rawDb: Database.Database } | null = null;
  let targetPgDb: { db: ReturnType<typeof drizzlePg>; pool: Pool } | null = null;
  let targetMySQLDb: { db: any; pool: mysql.Pool } | null = null;

  // Get MySQL database name for insertIntoMySQL
  let mysqlDatabase = '';
  if (isMySQLTarget) {
    const parsed = parseMySQLUrl(options.to);
    if (parsed) {
      mysqlDatabase = parsed.database;
    }
  }

  try {
    // Connect to databases
    sourceDb = await connectSqlite(options.from);

    if (isPostgresTarget) {
      targetPgDb = await connectPostgres(options.to);
    } else {
      targetMySQLDb = await connectMySQL(options.to);
    }

    console.log('✅ Connected to both databases\n');

    // Create schema using application definitions (ensures all columns exist)
    if (!options.dryRun) {
      if (isPostgresTarget && targetPgDb) {
        await createPostgresSchemaFromApp(targetPgDb.pool);
      } else if (isMySQLTarget && targetMySQLDb) {
        await createMySQLSchemaFromApp(targetMySQLDb.pool);
      }
    }

    console.log('\n📊 Migration Progress:\n');

    // Get all tables from SQLite
    const allTables = sourceDb.rawDb.prepare(`
      SELECT name FROM sqlite_master
      WHERE type='table' AND name NOT LIKE 'sqlite_%'
    `).all() as Array<{ name: string }>;
    const allTableNames = allTables.map((t) => t.name);

    // Migrate tables in order, then any remaining tables (excluding skipped tables)
    const orderedTables = TABLE_ORDER.filter((t) => allTableNames.includes(t) && !SKIP_TABLES.has(t));
    const remainingTables = allTableNames.filter((t) => !TABLE_ORDER.includes(t) && !SKIP_TABLES.has(t));
    const tablesToMigrate = [...orderedTables, ...remainingTables];

    // Migrate each table
    for (const table of tablesToMigrate) {
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
      let migratedCount = 0;

      if (isPostgresTarget && targetPgDb) {
        migratedCount = await insertIntoPostgres(targetPgDb.pool, table, rows);
      } else if (isMySQLTarget && targetMySQLDb) {
        migratedCount = await insertIntoMySQL(targetMySQLDb.pool, table, rows, mysqlDatabase);
      }

      const duration = Date.now() - startTime;

      console.log(`✅ ${migratedCount} migrated (${duration}ms)`);

      stats.push({
        table,
        sourceCount,
        migratedCount,
        duration,
      });
    }

    // Reset PostgreSQL sequences to prevent primary key conflicts
    if (isPostgresTarget && targetPgDb && !options.dryRun) {
      await resetPostgresSequences(targetPgDb.pool);
    }

    // Reset MySQL auto_increment values to prevent primary key conflicts
    if (isMySQLTarget && targetMySQLDb && !options.dryRun) {
      await resetMySQLAutoIncrement(targetMySQLDb.pool);
    }

    // Ensure auto_welcome_first_enabled setting exists to prevent mass re-welcoming
    // The app checks this setting on startup - if missing, it assumes auto-welcome was
    // never enabled and marks all nodes without welcomedAt as welcomed (thundering herd prevention)
    // For migrated databases, we want to preserve the existing welcomedAt values
    if (!options.dryRun) {
      console.log('\n🔧 Adding migration-specific settings...');
      const now = Date.now();
      if (isPostgresTarget && targetPgDb) {
        const client = await targetPgDb.pool.connect();
        try {
          await client.query(`
            INSERT INTO settings (key, value, "createdAt", "updatedAt")
            VALUES ('auto_welcome_first_enabled', 'completed', $1, $1)
            ON CONFLICT (key) DO NOTHING
          `, [now]);
          console.log('  ✅ Added auto_welcome_first_enabled setting (prevents mass re-welcoming)');
        } finally {
          client.release();
        }
      } else if (isMySQLTarget && targetMySQLDb) {
        const connection = await targetMySQLDb.pool.getConnection();
        try {
          await connection.execute(`
            INSERT IGNORE INTO settings (\`key\`, value, createdAt, updatedAt)
            VALUES ('auto_welcome_first_enabled', 'completed', ?, ?)
          `, [now, now]);
          console.log('  ✅ Added auto_welcome_first_enabled setting (prevents mass re-welcoming)');
        } finally {
          connection.release();
        }
      }
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
    if (targetPgDb) {
      await targetPgDb.pool.end();
    }
    if (targetMySQLDb) {
      await targetMySQLDb.pool.end();
    }
  }
}

// Run migration
const options = parseArgs();
migrate(options).catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
