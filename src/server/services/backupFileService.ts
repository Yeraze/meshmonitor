/**
 * Backup File Service
 * Handles file system operations for device backups
 */

import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../../utils/logger.js';
import databaseService from '../../services/database.js';

const BACKUP_DIR = process.env.BACKUP_DIR || '/data/backups';

interface BackupFile {
  filename: string;
  timestamp: string;
  size: number;
  type: 'manual' | 'automatic';
  filepath: string;
}

class BackupFileService {
  /**
   * Initialize backup directory
   */
  initializeBackupDirectory(): void {
    try {
      if (!fs.existsSync(BACKUP_DIR)) {
        fs.mkdirSync(BACKUP_DIR, { recursive: true });
        logger.info(`📁 Created backup directory: ${BACKUP_DIR}`);
      }
    } catch (error) {
      logger.error('❌ Failed to create backup directory:', error);
      throw new Error(`Failed to initialize backup directory: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Save a backup to disk
   */
  async saveBackup(content: string, type: 'manual' | 'automatic' = 'manual', nodeIdFull?: string): Promise<string> {
    this.initializeBackupDirectory();

    // Extract numeric part from node ID (e.g., "!abc123" -> "abc123")
    let nodeIdNumber = 'unknown';
    if (nodeIdFull && typeof nodeIdFull === 'string' && nodeIdFull.length > 1) {
      // Remove ! prefix if present, otherwise use the ID as-is
      nodeIdNumber = nodeIdFull.startsWith('!') ? nodeIdFull.substring(1) : nodeIdFull;
      // Sanitize to ensure filename-safe characters only
      nodeIdNumber = nodeIdNumber.replace(/[^a-zA-Z0-9]/g, '');
      // Fallback if sanitization resulted in empty string
      if (!nodeIdNumber) {
        nodeIdNumber = 'unknown';
      }
    }

    // Format: nodeidnumber-YYYY-MM-DD-HH-MM-SS
    const now = new Date();
    const date = now.toISOString().split('T')[0]; // YYYY-MM-DD
    const time = now.toTimeString().split(' ')[0].replace(/:/g, '-'); // HH-MM-SS
    const filename = `${nodeIdNumber}-${date}-${time}.yaml`;
    const filepath = path.join(BACKUP_DIR, filename);

    try {
      fs.writeFileSync(filepath, content, 'utf8');
      const stats = fs.statSync(filepath);

      // Record in database
      const db = databaseService.db;
      const stmt = db.prepare(`
        INSERT INTO backup_history (filename, filepath, timestamp, type, size, createdAt)
        VALUES (?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        filename,
        filepath,
        Date.now(),
        type,
        stats.size,
        Date.now()
      );

      logger.info(`💾 Saved ${type} backup: ${filename} (${this.formatFileSize(stats.size)})`);

      // Purge old backups if necessary
      await this.purgeOldBackups();

      return filename;
    } catch (error) {
      logger.error('❌ Failed to save backup:', error);
      throw new Error(`Failed to save backup: ${error instanceof Error ? error.message : String(error)}`);
    }
  }


  /**
   * List all backups
   */
  async listBackups(): Promise<BackupFile[]> {
    try {
      const db = databaseService.db;
      const stmt = db.prepare(`
        SELECT filename, filepath, timestamp, type, size
        FROM backup_history
        ORDER BY timestamp DESC
      `);

      const rows = stmt.all() as any[];

      return rows.map(row => ({
        filename: row.filename,
        timestamp: new Date(row.timestamp).toISOString(),
        size: row.size,
        type: row.type,
        filepath: row.filepath
      }));
    } catch (error) {
      logger.error('❌ Failed to list backups:', error);
      throw new Error(`Failed to list backups: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Get a specific backup file content
   */
  async getBackup(filename: string): Promise<string> {
    try {
      const db = databaseService.db;
      const stmt = db.prepare('SELECT filepath FROM backup_history WHERE filename = ?');
      const row = stmt.get(filename) as any;

      if (!row) {
        throw new Error('Backup not found');
      }

      if (!fs.existsSync(row.filepath)) {
        throw new Error('Backup file not found on disk');
      }

      return fs.readFileSync(row.filepath, 'utf8');
    } catch (error) {
      logger.error(`❌ Failed to get backup ${filename}:`, error);
      throw new Error(`Failed to get backup: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Delete a specific backup
   */
  async deleteBackup(filename: string): Promise<void> {
    try {
      const db = databaseService.db;
      const stmt = db.prepare('SELECT filepath FROM backup_history WHERE filename = ?');
      const row = stmt.get(filename) as any;

      if (!row) {
        throw new Error('Backup not found');
      }

      // Delete file from disk
      if (fs.existsSync(row.filepath)) {
        fs.unlinkSync(row.filepath);
      }

      // Delete from database
      const deleteStmt = db.prepare('DELETE FROM backup_history WHERE filename = ?');
      deleteStmt.run(filename);

      logger.info(`🗑️  Deleted backup: ${filename}`);
    } catch (error) {
      logger.error(`❌ Failed to delete backup ${filename}:`, error);
      throw new Error(`Failed to delete backup: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Purge old backups based on max backups setting
   */
  async purgeOldBackups(): Promise<void> {
    try {
      const maxBackups = databaseService.getSetting('backup_maxBackups');
      if (!maxBackups) {
        return; // No limit set
      }

      const limit = parseInt(maxBackups, 10);
      if (isNaN(limit) || limit <= 0) {
        return;
      }

      const db = databaseService.db;

      // Get count of backups
      const countStmt = db.prepare('SELECT COUNT(*) as count FROM backup_history');
      const countRow = countStmt.get() as any;
      const totalBackups = countRow.count;

      if (totalBackups <= limit) {
        return; // Under the limit
      }

      // Get oldest backups to delete
      const toDelete = totalBackups - limit;
      const oldBackupsStmt = db.prepare(`
        SELECT filename, filepath
        FROM backup_history
        ORDER BY timestamp ASC
        LIMIT ?
      `);

      const oldBackups = oldBackupsStmt.all(toDelete) as any[];

      logger.info(`🧹 Purging ${oldBackups.length} old backups (max: ${limit})...`);

      for (const backup of oldBackups) {
        // Delete file from disk
        if (fs.existsSync(backup.filepath)) {
          fs.unlinkSync(backup.filepath);
        }

        // Delete from database
        const deleteStmt = db.prepare('DELETE FROM backup_history WHERE filename = ?');
        deleteStmt.run(backup.filename);

        logger.debug(`  🗑️  Purged: ${backup.filename}`);
      }

      logger.info(`✅ Purged ${oldBackups.length} old backups`);
    } catch (error) {
      logger.error('❌ Failed to purge old backups:', error);
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
   * Get backup statistics
   */
  async getBackupStats(): Promise<{ count: number; totalSize: number; oldestBackup: string | null; newestBackup: string | null }> {
    try {
      const db = databaseService.db;

      const statsStmt = db.prepare(`
        SELECT
          COUNT(*) as count,
          SUM(size) as totalSize,
          MIN(timestamp) as oldestTimestamp,
          MAX(timestamp) as newestTimestamp
        FROM backup_history
      `);

      const stats = statsStmt.get() as any;

      return {
        count: stats.count || 0,
        totalSize: stats.totalSize || 0,
        oldestBackup: stats.oldestTimestamp ? new Date(stats.oldestTimestamp).toISOString() : null,
        newestBackup: stats.newestTimestamp ? new Date(stats.newestTimestamp).toISOString() : null
      };
    } catch (error) {
      logger.error('❌ Failed to get backup stats:', error);
      return { count: 0, totalSize: 0, oldestBackup: null, newestBackup: null };
    }
  }
}

export const backupFileService = new BackupFileService();
