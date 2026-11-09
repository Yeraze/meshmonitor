/**
 * Backup File Service
 * Handles file system operations for device backups.
 * Backend-agnostic: all DB access goes through the Drizzle-backed backup
 * history repository, which works for SQLite, PostgreSQL, and MySQL.
 *
 * Every operation is scoped to a source (#6285). A filename from another
 * source is "not found", never readable. Legacy / orphaned rows (no live
 * owner) are reachable only when the caller passes `includeUnowned`, which
 * callers grant to admins alone. Files hold secrets (PSKs, PINs): they are
 * written 0600 in a 0700 directory.
 */

import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../../utils/logger.js';
import { getBackupDir } from '../config/dataDir.js';
import { resolveWithinDir } from '../utils/pathContainment.js';
import databaseService from '../../services/database.js';
import type { BackupHistory, BackupProtocol } from '../../db/repositories/backupHistory.js';

export interface BackupFile {
  filename: string;
  timestamp: string;
  size: number;
  type: 'manual' | 'automatic';
  filepath: string;
  sourceId: string | null;
  protocol: BackupProtocol;
  /** True for a row with no live owning source (admin-only). */
  legacy: boolean;
}

export interface SaveBackupInput {
  content: string;
  type?: 'manual' | 'automatic';
  sourceId: string;
  protocol: BackupProtocol;
  nodeId?: string;
  nodeNum?: number | null;
}

export interface BackupLookupOptions {
  /** Also match unowned (legacy / orphaned) rows. Admins only. */
  includeUnowned?: boolean;
}

export class BackupNotFoundError extends Error {
  constructor(message = 'Backup not found') {
    super(message);
    this.name = 'BackupNotFoundError';
  }
}

const FILE_TAG: Record<BackupProtocol, string> = { meshtastic: 'mt', meshcore: 'mc' };
const DEFAULT_MAX_BACKUPS = 7;

class BackupFileService {
  private permissionsTightened = false;

  /**
   * Initialize backup directory (0700) and, once per process, tighten
   * existing `*.yaml` files to 0600 (best effort).
   */
  initializeBackupDirectory(): void {
    try {
      const dir = getBackupDir();
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        logger.info(`Created backup directory: ${dir}`);
      }
      if (!this.permissionsTightened) {
        this.permissionsTightened = true;
        this.tightenPermissions(dir);
      }
    } catch (error) {
      logger.error('Failed to create backup directory:', error);
      throw new Error(`Failed to initialize backup directory: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private tightenPermissions(dir: string): void {
    try {
      fs.chmodSync(dir, 0o700);
    } catch (err) {
      logger.warn(`Could not chmod backup directory 0700: ${err instanceof Error ? err.message : String(err)}`);
    }
    let names: string[];
    try {
      names = fs.readdirSync(dir).filter(n => n.endsWith('.yaml'));
    } catch (err) {
      logger.warn(`Could not list backup directory: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    for (const name of names) {
      try {
        fs.chmodSync(path.join(dir, name), 0o600);
      } catch (err) {
        logger.warn(`Could not chmod backup file ${name} 0600: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /** Reduce a node id to filename-safe characters ("!abc123" -> "abc123"). */
  private sanitizeNodeId(nodeIdFull?: string): string {
    if (nodeIdFull && typeof nodeIdFull === 'string' && nodeIdFull.length > 1) {
      const raw = nodeIdFull.startsWith('!') ? nodeIdFull.substring(1) : nodeIdFull;
      const clean = raw.replace(/[^a-zA-Z0-9]/g, '').slice(0, 64);
      if (clean) return clean;
    }
    return 'unknown';
  }

  /**
   * Save a backup to disk (mode 0600, never overwrites) and record it.
   * Filename: `<mt|mc>-<nodeId>-<YYYY-MM-DD>-<HH-MM-SS>.yaml` in UTC.
   */
  async saveBackup(input: SaveBackupInput): Promise<string> {
    const { content, sourceId, protocol, nodeNum } = input;
    const type = input.type ?? 'manual';
    this.initializeBackupDirectory();

    const iso = new Date().toISOString(); // 2026-11-09T12:34:56.789Z
    const date = iso.slice(0, 10);
    const time = iso.slice(11, 19).replace(/:/g, '-');
    const base = `${FILE_TAG[protocol]}-${this.sanitizeNodeId(input.nodeId)}-${date}-${time}`;

    try {
      let filename: string;
      let filepath: string;
      for (let n = 1; ; n++) {
        filename = n === 1 ? `${base}.yaml` : `${base}-${n}.yaml`;
        filepath = path.join(getBackupDir(), filename);
        try {
          fs.writeFileSync(filepath, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
          break;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'EEXIST' && n < 1000) continue;
          throw err;
        }
      }
      const stats = fs.statSync(filepath);

      await databaseService.insertBackupHistoryAsync({
        filename,
        filePath: filepath,
        timestamp: Date.now(),
        backupType: type,
        fileSize: stats.size,
        nodeId: input.nodeId ?? null,
        nodeNum: nodeNum ?? null,
        sourceId,
        protocol,
      });

      logger.info(`Saved ${type} ${protocol} backup: ${filename} (${this.formatFileSize(stats.size)})`);

      await this.purgeOldBackups(sourceId);
      return filename;
    } catch (error) {
      logger.error('Failed to save backup:', error instanceof Error ? error.message : String(error));
      throw new Error(`Failed to save backup: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private toFile(row: BackupHistory, legacy: boolean): BackupFile {
    return {
      filename: row.filename,
      timestamp: new Date(row.timestamp).toISOString(),
      size: row.fileSize ?? 0,
      type: row.backupType as 'manual' | 'automatic',
      filepath: row.filePath,
      sourceId: row.sourceId ?? null,
      protocol: (row.protocol as BackupProtocol) ?? 'meshtastic',
      legacy,
    };
  }

  /**
   * List a source's backups. With `includeUnowned`, also the unowned rows of
   * that protocol, flagged `legacy` (admins only).
   */
  async listBackups(
    sourceId: string,
    opts: BackupLookupOptions & { protocol?: BackupProtocol } = {},
  ): Promise<BackupFile[]> {
    try {
      const owned = (await databaseService.backupHistory.getBackupHistoryList(sourceId)).map(r => this.toFile(r, false));
      if (!opts.includeUnowned) return owned;
      const unowned = (await databaseService.backupHistory.listUnowned(opts.protocol)).map(r => this.toFile(r, true));
      return [...owned, ...unowned].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    } catch (error) {
      logger.error('Failed to list backups:', error);
      throw new Error(`Failed to list backups: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Find a row by (sourceId, filename); null when absent (never another source's). */
  async findBackup(
    sourceId: string,
    filename: string,
    opts: BackupLookupOptions = {},
  ): Promise<{ row: BackupHistory; legacy: boolean } | null> {
    const owned = await databaseService.backupHistory.getBackupByFilename(sourceId, filename);
    if (owned) return { row: owned, legacy: false };
    if (opts.includeUnowned) {
      const unowned = await databaseService.backupHistory.getUnownedByFilename(filename);
      if (unowned) return { row: unowned, legacy: true };
    }
    return null;
  }

  /** Read a row's file, confined to the backup directory (#6055). */
  readRow(row: BackupHistory): string {
    const filepath = resolveWithinDir(getBackupDir(), row.filePath);
    if (!fs.existsSync(filepath)) {
      throw new BackupNotFoundError('Backup file not found on disk');
    }
    return fs.readFileSync(filepath, 'utf8');
  }

  /** Get a specific backup file's content. Throws BackupNotFoundError. */
  async getBackup(sourceId: string, filename: string, opts: BackupLookupOptions = {}): Promise<string> {
    const found = await this.findBackup(sourceId, filename, opts);
    if (!found) throw new BackupNotFoundError();
    try {
      return this.readRow(found.row);
    } catch (error) {
      if (error instanceof BackupNotFoundError) throw error;
      logger.error(`Failed to get backup ${filename}:`, error instanceof Error ? error.message : String(error));
      throw new Error(`Failed to get backup: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Delete a specific backup. Throws BackupNotFoundError. */
  async deleteBackup(sourceId: string, filename: string, opts: BackupLookupOptions = {}): Promise<void> {
    const found = await this.findBackup(sourceId, filename, opts);
    if (!found) throw new BackupNotFoundError();
    try {
      // Confine the stored path to the backup directory before deleting it, so a
      // tampered filePath column cannot wipe an arbitrary file (#6054).
      const filepath = resolveWithinDir(getBackupDir(), found.row.filePath);
      if (fs.existsSync(filepath)) {
        fs.unlinkSync(filepath);
      }
      if (found.row.id !== undefined) {
        await databaseService.backupHistory.deleteBackupHistoryById(found.row.id);
      }
      logger.info(`Deleted backup: ${filename}`);
    } catch (error) {
      logger.error(`Failed to delete backup ${filename}:`, error instanceof Error ? error.message : String(error));
      throw new Error(`Failed to delete backup: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Purge-time removal: a tampered filePath that escapes the directory is
   * skipped (not wiped) but its history row is still removed (#6054).
   */
  private async removeRow(row: BackupHistory): Promise<void> {
    try {
      const filepath = resolveWithinDir(getBackupDir(), row.filePath);
      if (fs.existsSync(filepath)) {
        fs.unlinkSync(filepath);
      }
    } catch (err) {
      logger.warn(`Skipping on-disk purge of ${row.filename}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (row.id !== undefined) {
      await databaseService.backupHistory.deleteBackupHistoryById(row.id);
    }
  }

  /**
   * Purge one source's old backups past `source:<id>:backup_maxBackups`
   * (default 7). Other sources and unowned rows are never touched.
   */
  async purgeOldBackups(sourceId: string): Promise<void> {
    try {
      const raw = await databaseService.settings.getSetting(`source:${sourceId}:backup_maxBackups`);
      let limit = raw ? parseInt(raw, 10) : DEFAULT_MAX_BACKUPS;
      if (isNaN(limit) || limit <= 0) limit = DEFAULT_MAX_BACKUPS;

      const total = await databaseService.backupHistory.countBackups(sourceId);
      if (total <= limit) return;

      const oldBackups = await databaseService.backupHistory.getOldestBackups(sourceId, total - limit);
      logger.debug(`Purging ${oldBackups.length} old backups for source ${sourceId} (max: ${limit})`);
      for (const backup of oldBackups) {
        await this.removeRow(backup);
      }
      logger.info(`Purged ${oldBackups.length} old backups`);
    } catch (error) {
      logger.error('Failed to purge old backups:', error);
    }
  }

  private formatFileSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  /** Get backup statistics (all sources; no filenames). */
  async getBackupStats(): Promise<{ count: number; totalSize: number; oldestBackup: string | null; newestBackup: string | null }> {
    try {
      return await databaseService.getBackupStatsAsync();
    } catch (error) {
      logger.error('Failed to get backup stats:', error);
      return { count: 0, totalSize: 0, oldestBackup: null, newestBackup: null };
    }
  }
}

export const backupFileService = new BackupFileService();
