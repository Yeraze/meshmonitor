/**
 * Backup File Service
 * Handles file system operations for device backups
 * Backend-agnostic: all DB access goes through the Drizzle-backed misc
 * repository, which works for SQLite, PostgreSQL, and MySQL.
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

      await databaseService.insertBackupHistoryAsync({
        filename,
        filePath: filepath,
        timestamp: Date.now(),
        backupType: type,
        fileSize: stats.size,
      });

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
      const rows = await databaseService.misc.getBackupHistoryList();
      return rows.map(row => ({
        filename: row.filename,
        timestamp: new Date(row.timestamp).toISOString(),
        size: row.fileSize ?? 0,
        type: row.backupType as 'manual' | 'automatic',
        filepath: row.filePath
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
      const row = await databaseService.misc.getBackupByFilename(filename);
      if (!row) {
        throw new Error('Backup not found');
      }
      const filepath = row.filePath;

      if (!fs.existsSync(filepath)) {
        throw new Error('Backup file not found on disk');
      }

      return fs.readFileSync(filepath, 'utf8');
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
      const row = await databaseService.misc.getBackupByFilename(filename);
      if (!row) {
        throw new Error('Backup not found');
      }
      const filepath = row.filePath;

      // Delete file from disk
      if (fs.existsSync(filepath)) {
        fs.unlinkSync(filepath);
      }

      // Delete from database
      await databaseService.misc.deleteBackupHistory(filename);

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
      const maxBackups = await databaseService.settings.getSetting('backup_maxBackups');
      if (!maxBackups) {
        return; // No limit set
      }

      const limit = parseInt(maxBackups, 10);
      if (isNaN(limit) || limit <= 0) {
        return;
      }

      const totalBackups = await databaseService.misc.countBackups();

      if (totalBackups <= limit) {
        return; // Under the limit
      }

      // Get oldest backups to delete
      const toDelete = totalBackups - limit;
      const oldBackups = await databaseService.misc.getOldestBackups(toDelete);

      logger.info(`🧹 Purging ${oldBackups.length} old backups (max: ${limit})...`);

      for (const backup of oldBackups) {
        // Delete file from disk
        if (fs.existsSync(backup.filePath)) {
          fs.unlinkSync(backup.filePath);
        }

        // Delete from database
        await databaseService.misc.deleteBackupHistory(backup.filename);

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
      return await databaseService.getBackupStatsAsync();
    } catch (error) {
      logger.error('❌ Failed to get backup stats:', error);
      return { count: 0, totalSize: 0, oldestBackup: null, newestBackup: null };
    }
  }
}

export const backupFileService = new BackupFileService();
