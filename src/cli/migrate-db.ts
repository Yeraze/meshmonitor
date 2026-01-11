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
};

// Value transformations needed during migration
function transformValue(tableName: string, column: string, value: unknown): unknown {
  // Transform auth_provider 'local' to authMethod 'local', 'oidc' to 'oidc'
  if (tableName === 'users' && column === 'authMethod' && value === 'oidc') {
    return 'oidc';
  }
  // Transform SQLite integers (0/1) to booleans for specific columns
  if (tableName === 'users' && (column === 'isAdmin' || column === 'isActive' || column === 'passwordLocked')) {
    return value === 1 || value === '1' || value === true;
  }
  return value;
}

// Default values for required columns that may not exist in source
const DEFAULT_VALUES: Record<string, Record<string, () => unknown>> = {
  users: {
    updatedAt: () => Date.now(),
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
  const result = await client.query(`
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_name = $1
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

  try {
    // Get column types for this table
    columnTypes = await getPostgresColumnTypes(client, table);

    await client.query('BEGIN');

    for (const row of rows) {
      const obj = row as Record<string, unknown>;
      const sourceColumns = Object.keys(obj);

      // Map column names and filter out columns that don't exist in target
      const mappedData: Array<{ targetCol: string; value: unknown }> = [];
      const mappedColumns = new Set<string>();

      for (const srcCol of sourceColumns) {
        // Skip columns that were removed (like created_by in users)
        if (srcCol === 'created_by') continue;

        const targetCol = tableMapping[srcCol] || srcCol;
        // Check if target column exists
        if (!columnTypes?.has(targetCol)) {
          continue; // Skip columns that don't exist in target schema
        }

        const pgType = columnTypes.get(targetCol) || 'text';
        let value = sanitizeValue(obj[srcCol], pgType);
        value = transformValue(table, targetCol, value);
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

  try {
    // Get column types for this table
    columnTypes = await getMySQLColumnTypes(connection, table, database);

    await connection.beginTransaction();

    for (const row of rows) {
      const obj = row as Record<string, unknown>;
      const columns = Object.keys(obj);

      // Sanitize values based on MySQL column types
      const values = columns.map((col) => {
        const mysqlType = columnTypes?.get(col) || 'text';
        return sanitizeMySQLValue(obj[col], mysqlType);
      });

      const placeholders = columns.map(() => '?').join(', ');
      // Quote column names for MySQL (use backticks)
      const quotedColumns = columns.map((c) => `\`${c}\``).join(', ');

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

/**
 * Convert SQLite type to MySQL type
 */
function sqliteToMySQLType(sqliteType: string): string {
  const type = sqliteType.toUpperCase();
  if (type.includes('INTEGER') || type.includes('INT')) return 'BIGINT';
  if (type.includes('REAL') || type.includes('FLOAT') || type.includes('DOUBLE')) return 'DOUBLE';
  if (type.includes('TEXT') || type.includes('VARCHAR') || type.includes('CHAR')) return 'TEXT';
  if (type.includes('BLOB')) return 'BLOB';
  if (type.includes('BOOLEAN') || type.includes('BOOL')) return 'TINYINT(1)';
  return 'TEXT'; // Default
}

/**
 * Parse SQLite CREATE TABLE statement and convert to MySQL
 */
function convertCreateTableForMySQL(sqliteSchema: string): string {
  // Extract table name
  const tableMatch = sqliteSchema.match(/CREATE TABLE\s+(?:IF NOT EXISTS\s+)?["']?(\w+)["']?\s*\(/i);
  if (!tableMatch) return '';

  const tableName = tableMatch[1];

  // Skip sqlite internal tables
  if (tableName === 'sqlite_sequence') return '';

  // Extract column definitions - handle multi-line
  const columnsStart = sqliteSchema.indexOf('(') + 1;
  const columnsEnd = sqliteSchema.lastIndexOf(')');
  const columnsStr = sqliteSchema.substring(columnsStart, columnsEnd);

  // Parse columns
  const columns: string[] = [];
  let currentCol = '';
  let parenDepth = 0;

  for (const char of columnsStr) {
    if (char === '(') parenDepth++;
    else if (char === ')') parenDepth--;

    if (char === ',' && parenDepth === 0) {
      if (currentCol.trim()) columns.push(currentCol.trim());
      currentCol = '';
    } else {
      currentCol += char;
    }
  }
  if (currentCol.trim()) columns.push(currentCol.trim());

  // Convert each column
  const mysqlColumns: string[] = [];
  const constraints: string[] = [];

  for (const col of columns) {
    const trimmed = col.trim();

    // Skip constraints for now (PRIMARY KEY, FOREIGN KEY, UNIQUE, CHECK)
    if (/^(PRIMARY KEY|FOREIGN KEY|UNIQUE|CHECK|CONSTRAINT)/i.test(trimmed)) {
      // Convert constraint if it's a simple UNIQUE constraint
      if (/^UNIQUE\s*\(/i.test(trimmed)) {
        constraints.push(trimmed);
      }
      continue;
    }

    // Parse column: name type [constraints]
    const colMatch = trimmed.match(/^["']?(\w+)["']?\s+(\w+)(.*)$/i);
    if (!colMatch) continue;

    const [, colName, colType, rest] = colMatch;
    let mysqlType = sqliteToMySQLType(colType);

    // Handle TEXT PRIMARY KEY - MySQL requires key length for TEXT/BLOB
    // Convert to VARCHAR(255) when used as primary key
    const isPrimaryKey = /PRIMARY KEY/i.test(rest);
    if (isPrimaryKey && mysqlType === 'TEXT') {
      mysqlType = 'VARCHAR(255)';
    }

    let mysqlCol = `\`${colName}\` ${mysqlType}`;

    // Handle constraints in column definition
    const isAutoIncrement = /AUTOINCREMENT/i.test(rest);
    if (isPrimaryKey) {
      if (isAutoIncrement) {
        mysqlCol += ' AUTO_INCREMENT PRIMARY KEY';
      } else {
        mysqlCol += ' PRIMARY KEY';
      }
    }
    if (/NOT NULL/i.test(rest) && !isPrimaryKey) {
      // PRIMARY KEY implies NOT NULL, don't duplicate
      mysqlCol += ' NOT NULL';
    }
    if (/UNIQUE/i.test(rest) && !isPrimaryKey) {
      mysqlCol += ' UNIQUE';
    }
    if (/DEFAULT/i.test(rest)) {
      // Handle DEFAULT values - need to capture parenthesized expressions too
      const defaultMatch = rest.match(/DEFAULT\s+(\([^)]+\)|'[^']*'|\S+)/i);
      if (defaultMatch) {
        let defaultVal = defaultMatch[1];
        // Convert SQLite-specific default values
        if (/strftime\s*\(\s*'%s'\s*,\s*'now'\s*\)/i.test(defaultVal)) {
          // Convert strftime('%s', 'now') to UNIX_TIMESTAMP()
          defaultVal = '(UNIX_TIMESTAMP())';
        } else if (/CURRENT_TIMESTAMP/i.test(defaultVal)) {
          defaultVal = 'CURRENT_TIMESTAMP';
        }
        mysqlCol += ` DEFAULT ${defaultVal}`;
      }
    }

    mysqlColumns.push(mysqlCol);
  }

  if (mysqlColumns.length === 0) return '';

  let createSql = `CREATE TABLE IF NOT EXISTS \`${tableName}\` (\n  ${mysqlColumns.join(',\n  ')}`;
  if (constraints.length > 0) {
    createSql += ',\n  ' + constraints.join(',\n  ');
  }
  createSql += '\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;';

  return createSql;
}

async function createMySQLSchemaFromSqlite(pool: mysql.Pool, sqliteDb: Database.Database): Promise<void> {
  console.log('📋 Creating MySQL schema from SQLite...');

  const connection = await pool.getConnection();

  try {
    // Get all table schemas from SQLite
    const tables = sqliteDb.prepare(`
      SELECT name, sql FROM sqlite_master
      WHERE type='table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `).all() as Array<{ name: string; sql: string }>;

    for (const table of tables) {
      if (!table.sql) continue;

      const mysqlSql = convertCreateTableForMySQL(table.sql);
      if (mysqlSql) {
        try {
          await connection.execute(mysqlSql);
          console.log(`  ✅ Created table: ${table.name}`);
        } catch (err) {
          console.warn(`  ⚠️  Failed to create table ${table.name}: ${(err as Error).message}`);
        }
      }
    }

    console.log('✅ MySQL schema created');
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
        await createMySQLSchemaFromSqlite(targetMySQLDb.pool, sourceDb.rawDb);
      }
    }

    console.log('\n📊 Migration Progress:\n');

    // Get all tables from SQLite
    const allTables = sourceDb.rawDb.prepare(`
      SELECT name FROM sqlite_master
      WHERE type='table' AND name NOT LIKE 'sqlite_%'
    `).all() as Array<{ name: string }>;
    const allTableNames = allTables.map((t) => t.name);

    // Migrate tables in order, then any remaining tables
    const orderedTables = TABLE_ORDER.filter((t) => allTableNames.includes(t));
    const remainingTables = allTableNames.filter((t) => !TABLE_ORDER.includes(t));
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
