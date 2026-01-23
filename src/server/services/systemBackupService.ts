/**
 * System Backup Service
 * Exports complete database to JSON format for disaster recovery and migration
 * Supports SQLite, PostgreSQL, and MySQL backends
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { logger } from '../../utils/logger.js';
import databaseService from '../../services/database.js';

const SYSTEM_BACKUP_DIR = process.env.SYSTEM_BACKUP_DIR || '/data/system-backups';

// All tables that should be backed up
// NOTE: Excluded tables per ARCHITECTURE_LESSONS.md: sessions, push_subscriptions, backup_history, sqlite_sequence
const BACKUP_TABLES = [
  'nodes',
  'messages',
  'channels',
  'telemetry',
  'traceroutes',
  'route_segments',
  'neighbor_info',
  'settings',
  'users',
  'permissions',
  'audit_log',
  'read_messages',
  'user_notification_preferences',
  'auto_traceroute_nodes',
  'packet_log',
  'solar_estimates',
  'upgrade_history',
  'system_backup_history'
];

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

class SystemBackupService {
  /**
   * Initialize system backup directory
   */
  initializeBackupDirectory(): void {
    try {
      if (!fs.existsSync(SYSTEM_BACKUP_DIR)) {
        fs.mkdirSync(SYSTEM_BACKUP_DIR, { recursive: true });
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
    this.initializeBackupDirectory();

    const startTime = Date.now();
    logger.info(`📦 Starting ${type} system backup...`);

    try {
      // Create timestamped directory for this backup
      const now = new Date();
      const dirname = this.formatBackupDirname(now);
      const backupPath = path.join(SYSTEM_BACKUP_DIR, dirname);

      fs.mkdirSync(backupPath, { recursive: true });
      logger.debug(`📁 Created backup directory: ${dirname}`);

      // Get MeshMonitor version from package.json
      const packageJson = JSON.parse(
        fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')
      );
      const meshmonitorVersion = packageJson.version || 'unknown';

      // Get current schema version (migration 021 = schema version 21)
      const schemaVersion = this.getCurrentSchemaVersion();

      // Export each table to JSON
      const checksums: Record<string, string> = {};
      let totalSize = 0;

      for (const tableName of BACKUP_TABLES) {
        const tableFile = path.join(backupPath, `${tableName}.json`);
        const data = await this.exportTable(tableName);
        const json = JSON.stringify(data, null, 2);

        fs.writeFileSync(tableFile, json, 'utf8');

        // Calculate SHA-256 checksum
        const hash = crypto.createHash('sha256');
        hash.update(json);
        checksums[tableName] = hash.digest('hex');

        const stats = fs.statSync(tableFile);
        totalSize += stats.size;

        logger.debug(`  ✅ Exported ${tableName}: ${data.length} rows, ${this.formatFileSize(stats.size)}`);
      }

      // Create metadata file
      const metadata: SystemBackupMetadata = {
        backupVersion: '1.0',
        meshmonitorVersion,
        timestamp: now.toISOString(),
        timestampUnix: now.getTime(),
        schemaVersion,
        tables: BACKUP_TABLES,
        tableCount: BACKUP_TABLES.length,
        checksums
      };

      const metadataFile = path.join(backupPath, 'metadata.json');
      fs.writeFileSync(metadataFile, JSON.stringify(metadata, null, 2), 'utf8');

      const metadataStats = fs.statSync(metadataFile);
      totalSize += metadataStats.size;

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

      const duration = ((Date.now() - startTime) / 1000).toFixed(2);
      logger.info(`💾 System backup completed: ${dirname} (${this.formatFileSize(totalSize)}, ${duration}s)`);

      // Purge old backups if necessary
      await this.purgeOldBackups();

      return dirname;
    } catch (error) {
      logger.error('❌ Failed to create system backup:', error);
      throw new Error(`Failed to create system backup: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Export a single table to array of objects
   * Supports SQLite, PostgreSQL, and MySQL
   */
  private async exportTable(tableName: string): Promise<any[]> {
    try {
      const dbType = databaseService.getDatabaseType();

      if (dbType === 'postgres') {
        // PostgreSQL: Use async query via pool
        const pool = databaseService.getPostgresPool();
        if (!pool) throw new Error('PostgreSQL pool not initialized');
        const result = await pool.query(`SELECT * FROM "${tableName}"`);
        return this.normalizeRows(result.rows);
      } else if (dbType === 'mysql') {
        // MySQL: Use async query via pool
        const pool = databaseService.getMySQLPool();
        if (!pool) throw new Error('MySQL pool not initialized');
        const [rows] = await pool.query(`SELECT * FROM \`${tableName}\``);
        return this.normalizeRows(rows as any[]);
      } else {
        // SQLite: Use synchronous query
        const db = databaseService.db;
        const stmt = db.prepare(`SELECT * FROM ${tableName}`);
        const rows = stmt.all();
        return this.normalizeRows(rows);
      }
    } catch (error) {
      logger.error(`❌ Failed to export table ${tableName}:`, error);
      throw error;
    }
  }

  /**
   * Normalize row values for JSON serialization
   */
  private normalizeRows(rows: any[]): any[] {
    return rows.map((row: any) => {
      const normalized: any = {};
      for (const [key, value] of Object.entries(row)) {
        if (typeof value === 'bigint') {
          normalized[key] = Number(value);
        } else {
          normalized[key] = value;
        }
      }
      return normalized;
    });
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
         (dirname, timestamp, type, size, table_count, meshmonitor_version, schema_version, "createdAt")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [dirname, timestamp, type, size, tableCount, meshmonitorVersion, schemaVersion, Date.now()]
      );
    } else if (dbType === 'mysql') {
      const pool = databaseService.getMySQLPool();
      if (!pool) throw new Error('MySQL pool not initialized');
      await pool.execute(
        `INSERT INTO system_backup_history
         (dirname, timestamp, type, size, table_count, meshmonitor_version, schema_version, createdAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [dirname, timestamp, type, size, tableCount, meshmonitorVersion, schemaVersion, Date.now()]
      );
    } else {
      const db = databaseService.db;
      const stmt = db.prepare(`
        INSERT INTO system_backup_history
        (dirname, timestamp, type, size, table_count, meshmonitor_version, schema_version, createdAt)
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
      const rows = await this.queryRows(`
        SELECT dirname, timestamp, type, size, table_count, meshmonitor_version, schema_version
        FROM system_backup_history
        ORDER BY timestamp DESC
      `);

      return rows.map(row => {
        // PostgreSQL returns bigint as strings, so we need to parse them
        const timestampNum = typeof row.timestamp === 'string' ? parseInt(row.timestamp, 10) : row.timestamp;
        return {
          dirname: row.dirname,
          timestamp: new Date(timestampNum).toISOString(),
          timestampUnix: timestampNum,
          type: row.type,
          size: typeof row.size === 'string' ? parseInt(row.size, 10) : row.size,
          tableCount: row.table_count,
          meshmonitorVersion: row.meshmonitor_version,
          schemaVersion: row.schema_version
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

      const metadata = JSON.parse(fs.readFileSync(metadataFile, 'utf8'));
      return metadata;
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

      // Validate all table files exist
      for (const tableName of metadata.tables) {
        const tableFile = path.join(backupPath, `${tableName}.json`);
        if (!fs.existsSync(tableFile)) {
          errors.push(`Missing table file: ${tableName}.json`);
          continue;
        }

        // Verify checksum
        const content = fs.readFileSync(tableFile, 'utf8');
        const hash = crypto.createHash('sha256');
        hash.update(content);
        const checksum = hash.digest('hex');

        if (metadata.checksums[tableName] !== checksum) {
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
      const row = await this.queryOne(
        dbType === 'postgres'
          ? 'SELECT dirname FROM system_backup_history WHERE dirname = $1'
          : 'SELECT dirname FROM system_backup_history WHERE dirname = ?',
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
            ? 'DELETE FROM system_backup_history WHERE dirname = $1'
            : 'DELETE FROM system_backup_history WHERE dirname = ?',
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
      const maxBackups = databaseService.getSetting('system_backup_maxBackups');
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
      const oldBackups = await this.queryRows(
        dbType === 'postgres'
          ? 'SELECT dirname FROM system_backup_history ORDER BY timestamp ASC LIMIT $1'
          : 'SELECT dirname FROM system_backup_history ORDER BY timestamp ASC LIMIT ?',
        [toDelete]
      );

      logger.info(`🧹 Purging ${oldBackups.length} old system backups (max: ${limit})...`);

      for (const backup of oldBackups) {
        // Delete directory from disk
        const backupPath = path.join(SYSTEM_BACKUP_DIR, backup.dirname);
        if (fs.existsSync(backupPath)) {
          fs.rmSync(backupPath, { recursive: true, force: true });
        }

        // Delete from database
        await this.executeStatement(
          dbType === 'postgres'
            ? 'DELETE FROM system_backup_history WHERE dirname = $1'
            : 'DELETE FROM system_backup_history WHERE dirname = ?',
          [backup.dirname]
        );

        logger.debug(`  🗑️  Purged: ${backup.dirname}`);
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
          ${dbType === 'sqlite' ? 'SUM(size)' : 'COALESCE(SUM(size), 0)'} as "totalSize",
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
