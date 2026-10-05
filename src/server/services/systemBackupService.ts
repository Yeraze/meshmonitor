/* eslint-disable no-restricted-syntax -- TODO(remediation 6.3): retire generic queryRows/queryOne/executeStatement helpers in favor of typed Drizzle selectors per BACKUP_TABLES, then remove this disable. */
/**
 * System Backup Service
 * Exports complete database to JSON format for disaster recovery and migration
 * Supports SQLite, PostgreSQL, and MySQL backends
 */

import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../../utils/logger.js';
import databaseService from '../../services/database.js';
import {
  BACKUP_TABLES,
  BACKUP_EXCLUDED_TABLES,
  BACKUP_SECRET_TABLES,
  planRestoreTables,
} from './systemBackupTables.js';
import {
  BACKUP_DIR_MODE,
  BACKUP_FILE_MODE,
  checksumFile,
  inBatches,
  openBackupReadSession,
  writeTableFile,
  BACKUP_BATCH_ROWS,
  type BackupDatabase,
  type BackupReadSession,
  type BackupRow,
} from './systemBackupIo.js';

const SYSTEM_BACKUP_DIR = process.env.SYSTEM_BACKUP_DIR || '/data/system-backups';

/**
 * 1.0: each table file is the whole array, pretty-printed.
 * 1.1: one row per line (see systemBackupIo.ts), and every schema table that
 *      is not on the exclusion list. Restore reads both.
 */
const BACKUP_FORMAT_VERSION = '1.1';

// The table lists live in systemBackupTables.ts (no imports, so the drift test
// and the restore allowlist can read them without a database). Re-exported
// because this is where callers have always imported BACKUP_TABLES from.
export { BACKUP_TABLES, BACKUP_EXCLUDED_TABLES, BACKUP_SECRET_TABLES };

/**
 * Per-table exporter overrides (#5277 P4b WP2, spec §2b.6, decision U3).
 *
 * `coverage_receptions` is excluded from the generic `SELECT * FROM
 * coverage_receptions` path below: the table can be arbitrarily large (every
 * RF reception ever recorded, bounded only by the retention sweep), while a
 * backup only needs the rows inside a saved survey's window. Reads through
 * `databaseService.coverageSurveys.getExemptionWindows` and the reception
 * repository's `exportSurveyReceptions` (spec §2b.4).
 *
 * `id` is intentionally omitted from the exported rows by
 * `exportSurveyReceptions` itself (not here) — see `systemRestoreService.ts`
 * and spec §2b.6 for the PG-sequence-trap rationale: restore never resets a
 * PostgreSQL serial sequence, and `insertIgnore`'s target-less
 * `onConflictDoNothing()` would otherwise silently drop future receptions
 * whose fresh id collides with a restored one.
 */
const FILTERED_EXPORTERS: Record<string, () => Promise<unknown[]>> = {
  coverage_receptions: async () => {
    const windows = await databaseService.coverageSurveys.getExemptionWindows(Date.now());
    return databaseService.coverageReceptions.exportSurveyReceptions(windows);
  },
};

interface SystemBackupMetadata {
  backupVersion: string;
  meshmonitorVersion: string;
  timestamp: string;
  timestampUnix: number;
  schemaVersion: number;
  tables: string[];
  tableCount: number;
  checksums: Record<string, string>;
}

interface SystemBackupInfo {
  dirname: string;
  timestamp: string;
  timestampUnix: number;
  type: 'manual' | 'automatic';
  size: number;
  tableCount: number;
  meshmonitorVersion: string;
  schemaVersion: number;
}

/** Thrown by createBackup when another backup is still being written. */
export class SystemBackupInProgressError extends Error {
  constructor() {
    super('A system backup is already running');
    this.name = 'SystemBackupInProgressError';
  }
}

class SystemBackupService {
  /**
   * A backup of a large database runs for minutes. A second one started
   * meanwhile (a double click, the nightly schedule) would double the disk and
   * database load for no gain, so it is refused.
   */
  private backupRunning = false;

  /**
   * Initialize system backup directory
   */
  initializeBackupDirectory(): void {
    try {
      if (!fs.existsSync(SYSTEM_BACKUP_DIR)) {
        fs.mkdirSync(SYSTEM_BACKUP_DIR, { recursive: true, mode: BACKUP_DIR_MODE });
        logger.info(`📁 Created system backup directory: ${SYSTEM_BACKUP_DIR}`);
      }
    } catch (error) {
      logger.error('❌ Failed to create system backup directory:', error);
      throw new Error(`Failed to initialize system backup directory: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Create a complete system backup
   */
  async createBackup(type: 'manual' | 'automatic' = 'manual'): Promise<string> {
    if (this.backupRunning) {
      throw new SystemBackupInProgressError();
    }
    this.backupRunning = true;
    try {
      return await this.writeBackup(type);
    } finally {
      this.backupRunning = false;
    }
  }

  private async writeBackup(type: 'manual' | 'automatic'): Promise<string> {
    this.initializeBackupDirectory();

    const startTime = Date.now();
    logger.debug(`📦 Starting ${type} system backup...`);
    let partialBackupPath: string | null = null;

    try {
      // Create timestamped directory for this backup
      const now = new Date();
      const dirname = this.formatBackupDirname(now);
      const backupPath = path.join(SYSTEM_BACKUP_DIR, dirname);

      // A backup holds keys, password hashes and tokens: keep it private to
      // the server's user.
      fs.mkdirSync(backupPath, { recursive: true, mode: BACKUP_DIR_MODE });
      partialBackupPath = backupPath;
      logger.debug(`📁 Created backup directory: ${dirname}`);

      // Get MeshMonitor version from package.json
      const packageJson = JSON.parse(
        fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')
      );
      const meshmonitorVersion = packageJson.version || 'unknown';

      // Get current schema version (migration 021 = schema version 21)
      const schemaVersion = this.getCurrentSchemaVersion();

      // Export each table to JSON, streamed: rows go from the database to the
      // file in batches, so a table of any size costs one batch of memory.
      const checksums: Record<string, string> = {};
      let totalSize = 0;
      let totalRows = 0;

      const session = await openBackupReadSession(this.backupDatabase());
      try {
        for (const tableName of BACKUP_TABLES) {
          const tableFile = path.join(backupPath, `${tableName}.json`);
          const written = await writeTableFile(tableFile, this.exportTable(session, tableName));

          checksums[tableName] = written.checksum;
          totalSize += written.bytes;
          totalRows += written.rows;

          logger.debug(`  ✅ Exported ${tableName}: ${written.rows} rows, ${this.formatFileSize(written.bytes)}`);
        }
      } finally {
        await session.close();
      }

      // Create metadata file
      const metadata: SystemBackupMetadata = {
        backupVersion: BACKUP_FORMAT_VERSION,
        meshmonitorVersion,
        timestamp: now.toISOString(),
        timestampUnix: now.getTime(),
        schemaVersion,
        tables: BACKUP_TABLES,
        tableCount: BACKUP_TABLES.length,
        checksums
      };

      const metadataFile = path.join(backupPath, 'metadata.json');
      const metadataJson = JSON.stringify(metadata, null, 2);
      fs.writeFileSync(metadataFile, metadataJson, { encoding: 'utf8', mode: BACKUP_FILE_MODE });
      totalSize += Buffer.byteLength(metadataJson, 'utf8');

      // Record in database
      await this.recordBackupInDatabase(
        dirname,
        now.getTime(),
        type,
        totalSize,
        BACKUP_TABLES.length,
        meshmonitorVersion,
        schemaVersion
      );

      // Recorded: from here the retention purge owns the directory.
      partialBackupPath = null;

      const duration = ((Date.now() - startTime) / 1000).toFixed(2);
      logger.info(`💾 System backup completed: ${dirname} (${BACKUP_TABLES.length} tables, ${totalRows} rows, ${this.formatFileSize(totalSize)}, ${duration}s)`);

      // Purge old backups if necessary
      await this.purgeOldBackups();

      return dirname;
    } catch (error) {
      logger.error('❌ Failed to create system backup:', error);
      // A half-written backup is not in the history table, so nothing would
      // ever purge it, and it can be gigabytes. Remove it.
      if (partialBackupPath) {
        try {
          fs.rmSync(partialBackupPath, { recursive: true, force: true });
        } catch (cleanupError) {
          logger.warn(`⚠️  Could not remove the partial backup at ${partialBackupPath}:`, cleanupError);
        }
      }
      throw new Error(`Failed to create system backup: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** The live database, in the shape the streaming reader takes. */
  private backupDatabase(): BackupDatabase {
    const dbType = databaseService.getDatabaseType();
    if (dbType === 'postgres') {
      const pool = databaseService.getPostgresPool();
      if (!pool) throw new Error('PostgreSQL pool not initialized');
      return { type: 'postgres', pool };
    }
    if (dbType === 'mysql') {
      const pool = databaseService.getMySQLPool();
      if (!pool) throw new Error('MySQL pool not initialized');
      return { type: 'mysql', pool };
    }
    return { type: 'sqlite', db: databaseService.db };
  }

  /**
   * One table's rows, in batches. Never the whole table at once: the generic
   * path reads `BACKUP_BATCH_ROWS` rows at a time from the database (see
   * systemBackupIo.ts for how each backend does it).
   */
  private async *exportTable(session: BackupReadSession, tableName: string): AsyncGenerator<BackupRow[]> {
    try {
      const filteredExporter = FILTERED_EXPORTERS[tableName];
      if (filteredExporter) {
        // Bounded by the saved surveys' windows, not by the table.
        yield* inBatches((await filteredExporter()) as BackupRow[], BACKUP_BATCH_ROWS);
        return;
      }
      yield* session.batches(tableName);
    } catch (error) {
      logger.error(`❌ Failed to export table ${tableName}:`, error);
      throw error;
    }
  }

  /**
   * Record a backup in the database
   * Supports SQLite, PostgreSQL, and MySQL
   */
  private async recordBackupInDatabase(
    dirname: string,
    timestamp: number,
    type: string,
    size: number,
    tableCount: number,
    meshmonitorVersion: string,
    schemaVersion: number
  ): Promise<void> {
    const dbType = databaseService.getDatabaseType();

    if (dbType === 'postgres') {
      const pool = databaseService.getPostgresPool();
      if (!pool) throw new Error('PostgreSQL pool not initialized');
      await pool.query(
        `INSERT INTO system_backup_history
         ("backupPath", timestamp, "backupType", "totalSize", "tableCount", "appVersion", "schemaVersion", "createdAt")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [dirname, timestamp, type, size, tableCount, meshmonitorVersion, schemaVersion, Date.now()]
      );
    } else if (dbType === 'mysql') {
      const pool = databaseService.getMySQLPool();
      if (!pool) throw new Error('MySQL pool not initialized');
      await pool.execute(
        `INSERT INTO system_backup_history
         (backupPath, timestamp, backupType, totalSize, tableCount, appVersion, schemaVersion, createdAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [dirname, timestamp, type, size, tableCount, meshmonitorVersion, schemaVersion, Date.now()]
      );
    } else {
      const db = databaseService.db;
      const stmt = db.prepare(`
        INSERT INTO system_backup_history
        (backupPath, timestamp, backupType, totalSize, tableCount, appVersion, schemaVersion, createdAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run(dirname, timestamp, type, size, tableCount, meshmonitorVersion, schemaVersion, Date.now());
    }
  }

  /**
   * Execute a query and return rows
   * Supports SQLite, PostgreSQL, and MySQL
   */
  private async queryRows(sql: string, params: any[] = []): Promise<any[]> {
    const dbType = databaseService.getDatabaseType();

    if (dbType === 'postgres') {
      const pool = databaseService.getPostgresPool();
      if (!pool) throw new Error('PostgreSQL pool not initialized');
      const result = await pool.query(sql, params);
      return result.rows;
    } else if (dbType === 'mysql') {
      const pool = databaseService.getMySQLPool();
      if (!pool) throw new Error('MySQL pool not initialized');
      const [rows] = await pool.execute(sql, params);
      return rows as any[];
    } else {
      const db = databaseService.db;
      const stmt = db.prepare(sql);
      return params.length > 0 ? stmt.all(...params) : stmt.all();
    }
  }

  /**
   * Execute a query that returns a single row
   * Supports SQLite, PostgreSQL, and MySQL
   */
  private async queryOne(sql: string, params: any[] = []): Promise<any> {
    const dbType = databaseService.getDatabaseType();

    if (dbType === 'postgres') {
      const pool = databaseService.getPostgresPool();
      if (!pool) throw new Error('PostgreSQL pool not initialized');
      const result = await pool.query(sql, params);
      return result.rows[0] || null;
    } else if (dbType === 'mysql') {
      const pool = databaseService.getMySQLPool();
      if (!pool) throw new Error('MySQL pool not initialized');
      const [rows] = await pool.execute(sql, params);
      return (rows as any[])[0] || null;
    } else {
      const db = databaseService.db;
      const stmt = db.prepare(sql);
      return params.length > 0 ? stmt.get(...params) : stmt.get();
    }
  }

  /**
   * Execute a statement (INSERT, UPDATE, DELETE)
   * Supports SQLite, PostgreSQL, and MySQL
   */
  private async executeStatement(sql: string, params: any[] = []): Promise<void> {
    const dbType = databaseService.getDatabaseType();

    if (dbType === 'postgres') {
      const pool = databaseService.getPostgresPool();
      if (!pool) throw new Error('PostgreSQL pool not initialized');
      await pool.query(sql, params);
    } else if (dbType === 'mysql') {
      const pool = databaseService.getMySQLPool();
      if (!pool) throw new Error('MySQL pool not initialized');
      await pool.execute(sql, params);
    } else {
      const db = databaseService.db;
      const stmt = db.prepare(sql);
      if (params.length > 0) {
        stmt.run(...params);
      } else {
        stmt.run();
      }
    }
  }

  /**
   * Get current schema version based on latest migration
   */
  private getCurrentSchemaVersion(): number {
    // Schema version matches the highest migration number
    // Migration 021 = schema version 21
    return 21;
  }

  /**
   * Format backup directory name with timestamp
   */
  private formatBackupDirname(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');

    return `${year}-${month}-${day}_${hours}${minutes}${seconds}`;
  }

  /**
   * List all system backups
   * Supports SQLite, PostgreSQL, and MySQL
   */
  async listBackups(): Promise<SystemBackupInfo[]> {
    try {
      const dbType = databaseService.drizzleDbType;
      const col = (name: string) => dbType === 'postgres' ? `"${name}"` : name;

      const rows = await this.queryRows(`
        SELECT ${col('backupPath')}, timestamp, ${col('backupType')}, ${col('totalSize')}, ${col('tableCount')}, ${col('appVersion')}, ${col('schemaVersion')}
        FROM system_backup_history
        ORDER BY timestamp DESC
      `);

      return rows.map(row => {
        // PostgreSQL returns bigint as strings, so we need to parse them
        const timestampNum = typeof row.timestamp === 'string' ? parseInt(row.timestamp, 10) : row.timestamp;
        return {
          dirname: row.backupPath,
          timestamp: new Date(timestampNum).toISOString(),
          timestampUnix: timestampNum,
          type: row.backupType,
          size: typeof row.totalSize === 'string' ? parseInt(row.totalSize, 10) : row.totalSize,
          tableCount: row.tableCount,
          meshmonitorVersion: row.appVersion,
          schemaVersion: row.schemaVersion
        };
      });
    } catch (error) {
      logger.error('❌ Failed to list system backups:', error);
      throw new Error(`Failed to list system backups: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Get backup metadata
   */
  async getBackupMetadata(dirname: string): Promise<SystemBackupMetadata | null> {
    try {
      const backupPath = path.join(SYSTEM_BACKUP_DIR, dirname);
      const metadataFile = path.join(backupPath, 'metadata.json');

      if (!fs.existsSync(metadataFile)) {
        return null;
      }

      const metadata: unknown = JSON.parse(fs.readFileSync(metadataFile, 'utf8'));
      // Valid JSON is not yet a metadata object (`null`, a list, a number).
      if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
        return null;
      }
      return metadata as SystemBackupMetadata;
    } catch (error) {
      logger.error(`❌ Failed to get backup metadata for ${dirname}:`, error);
      return null;
    }
  }

  /**
   * Validate backup integrity
   */
  async validateBackup(dirname: string): Promise<{ valid: boolean; errors: string[] }> {
    const errors: string[] = [];

    try {
      const backupPath = path.join(SYSTEM_BACKUP_DIR, dirname);

      // Check if backup directory exists
      if (!fs.existsSync(backupPath)) {
        errors.push('Backup directory not found');
        return { valid: false, errors };
      }

      // Read metadata
      const metadata = await this.getBackupMetadata(dirname);
      if (!metadata) {
        errors.push('metadata.json not found or invalid');
        return { valid: false, errors };
      }

      // Only names on the allowlist are looked at. `metadata.tables` comes
      // from the backup file, and each name becomes a file path here and SQL
      // text in restore; an unknown name is skipped, as restore skips it.
      const { tables, skipped } = planRestoreTables(metadata.tables);
      for (const name of skipped) {
        logger.warn(`⚠️  Ignoring table not in backup allowlist: ${name}`);
      }
      const checksums = metadata.checksums ?? {};

      // Validate all table files exist
      for (const tableName of tables) {
        const tableFile = path.join(backupPath, `${tableName}.json`);
        if (!fs.existsSync(tableFile)) {
          errors.push(`Missing table file: ${tableName}.json`);
          continue;
        }

        // Verify checksum, streamed: table files can be large.
        if (checksums[tableName] !== (await checksumFile(tableFile))) {
          errors.push(`Checksum mismatch for table: ${tableName}`);
        }
      }

      return { valid: errors.length === 0, errors };
    } catch (error) {
      errors.push(`Validation error: ${error instanceof Error ? error.message : String(error)}`);
      return { valid: false, errors };
    }
  }

  /**
   * Delete a specific backup
   * Supports SQLite, PostgreSQL, and MySQL
   */
  async deleteBackup(dirname: string): Promise<void> {
    try {
      const dbType = databaseService.getDatabaseType();
      const backupPath = path.join(SYSTEM_BACKUP_DIR, dirname);

      // Check if backup exists either in database or on disk
      const bpCol = dbType === 'postgres' ? '"backupPath"' : 'backupPath';
      const row = await this.queryOne(
        dbType === 'postgres'
          ? `SELECT ${bpCol} FROM system_backup_history WHERE ${bpCol} = $1`
          : `SELECT ${bpCol} FROM system_backup_history WHERE ${bpCol} = ?`,
        [dirname]
      );

      const existsOnDisk = fs.existsSync(backupPath);

      if (!row && !existsOnDisk) {
        throw new Error('Backup not found');
      }

      // Delete directory from disk
      if (existsOnDisk) {
        fs.rmSync(backupPath, { recursive: true, force: true });
      }

      // Delete from database if record exists
      if (row) {
        await this.executeStatement(
          dbType === 'postgres'
            ? `DELETE FROM system_backup_history WHERE ${bpCol} = $1`
            : `DELETE FROM system_backup_history WHERE ${bpCol} = ?`,
          [dirname]
        );
      }

      logger.info(`🗑️  Deleted system backup: ${dirname}`);
    } catch (error) {
      logger.error(`❌ Failed to delete system backup ${dirname}:`, error);
      throw new Error(`Failed to delete system backup: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Purge old backups based on max backups setting
   * Supports SQLite, PostgreSQL, and MySQL
   */
  async purgeOldBackups(): Promise<void> {
    try {
      const maxBackups = await databaseService.settings.getSetting('system_backup_maxBackups');
      if (!maxBackups) {
        return; // No limit set
      }

      const limit = parseInt(maxBackups, 10);
      if (isNaN(limit) || limit <= 0) {
        return;
      }

      const dbType = databaseService.getDatabaseType();

      // Get count of backups
      const countRow = await this.queryOne('SELECT COUNT(*) as count FROM system_backup_history');
      const totalBackups = parseInt(countRow.count, 10);

      if (totalBackups <= limit) {
        return; // Under the limit
      }

      // Get oldest backups to delete
      const toDelete = totalBackups - limit;
      const bpCol = dbType === 'postgres' ? '"backupPath"' : 'backupPath';
      const oldBackups = await this.queryRows(
        dbType === 'postgres'
          ? `SELECT ${bpCol} FROM system_backup_history ORDER BY timestamp ASC LIMIT $1`
          : `SELECT ${bpCol} FROM system_backup_history ORDER BY timestamp ASC LIMIT ?`,
        [toDelete]
      );

      logger.debug(`🧹 Purging ${oldBackups.length} old system backups (max: ${limit})...`);

      for (const backup of oldBackups) {
        // Delete directory from disk
        const backupPath = path.join(SYSTEM_BACKUP_DIR, backup.backupPath);
        if (fs.existsSync(backupPath)) {
          fs.rmSync(backupPath, { recursive: true, force: true });
        }

        // Delete from database
        await this.executeStatement(
          dbType === 'postgres'
            ? `DELETE FROM system_backup_history WHERE ${bpCol} = $1`
            : `DELETE FROM system_backup_history WHERE ${bpCol} = ?`,
          [backup.backupPath]
        );

        logger.debug(`  🗑️  Purged: ${backup.backupPath}`);
      }

      logger.info(`✅ Purged ${oldBackups.length} old system backups`);
    } catch (error) {
      logger.error('❌ Failed to purge old system backups:', error);
    }
  }

  /**
   * Format file size for display
   */
  private formatFileSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  /**
   * Get backup directory path (for external access)
   */
  getBackupPath(dirname: string): string {
    return path.join(SYSTEM_BACKUP_DIR, dirname);
  }

  /**
   * Get backup statistics
   * Supports SQLite, PostgreSQL, and MySQL
   */
  async getBackupStats(): Promise<{
    count: number;
    totalSize: number;
    oldestBackup: string | null;
    newestBackup: string | null;
  }> {
    try {
      const dbType = databaseService.getDatabaseType();

      const stats = await this.queryOne(`
        SELECT
          COUNT(*) as count,
          COALESCE(SUM(${dbType === 'postgres' ? '"totalSize"' : 'totalSize'}), 0) as "totalSize",
          MIN(timestamp) as "oldestTimestamp",
          MAX(timestamp) as "newestTimestamp"
        FROM system_backup_history
      `);

      return {
        count: parseInt(stats.count, 10) || 0,
        totalSize: parseInt(stats.totalSize, 10) || 0,
        oldestBackup: stats.oldestTimestamp ? new Date(parseInt(stats.oldestTimestamp, 10)).toISOString() : null,
        newestBackup: stats.newestTimestamp ? new Date(parseInt(stats.newestTimestamp, 10)).toISOString() : null
      };
    } catch (error) {
      logger.error('❌ Failed to get system backup stats:', error);
      return { count: 0, totalSize: 0, oldestBackup: null, newestBackup: null };
    }
  }
}

export const systemBackupService = new SystemBackupService();
