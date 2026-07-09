/**
 * Backup History Repository
 *
 * Handles backup history database operations.
 * Supports SQLite, PostgreSQL, and MySQL through Drizzle ORM.
 */
import { eq, desc, asc, sql } from 'drizzle-orm';
import { BaseRepository, DrizzleDatabase } from './base.js';
import { DatabaseType } from '../types.js';

export interface BackupHistory {
  id?: number;
  nodeId?: string | null;
  nodeNum?: number | null;
  filename: string;
  filePath: string;
  fileSize?: number | null;
  backupType: string;  // 'auto' or 'manual'
  timestamp: number;
  createdAt: number;
}

export class BackupHistoryRepository extends BaseRepository {
  constructor(db: DrizzleDatabase, dbType: DatabaseType) {
    super(db, dbType);
  }

  /**
   * Insert a new backup history record
   */
  async insertBackupHistory(backup: BackupHistory): Promise<void> {
    const { backupHistory } = this.tables;
    await this.db.insert(backupHistory).values({
      nodeId: backup.nodeId,
      nodeNum: backup.nodeNum,
      filename: backup.filename,
      filePath: backup.filePath,
      fileSize: backup.fileSize,
      backupType: backup.backupType,
      timestamp: backup.timestamp,
      createdAt: backup.createdAt,
    });
  }

  /**
   * Get all backup history records ordered by timestamp (newest first)
   */
  async getBackupHistoryList(): Promise<BackupHistory[]> {
    const { backupHistory } = this.tables;
    const results = await this.db
      .select()
      .from(backupHistory)
      .orderBy(desc(backupHistory.timestamp));
    return this.normalizeBigInts(results);
  }

  /**
   * Get a backup history record by filename
   */
  async getBackupByFilename(filename: string): Promise<BackupHistory | null> {
    const { backupHistory } = this.tables;
    const results = await this.db
      .select()
      .from(backupHistory)
      .where(eq(backupHistory.filename, filename))
      .limit(1);
    return results.length > 0 ? this.normalizeBigInts(results[0]) : null;
  }

  /**
   * Delete a backup history record by filename
   */
  async deleteBackupHistory(filename: string): Promise<void> {
    const { backupHistory } = this.tables;
    await this.db.delete(backupHistory).where(eq(backupHistory.filename, filename));
  }

  /**
   * Count total backup history records
   */
  async countBackups(): Promise<number> {
    const { backupHistory } = this.tables;
    const result = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(backupHistory);
    return Number(result[0]?.count ?? 0);
  }

  /**
   * Get oldest backup history records (for purging)
   */
  async getOldestBackups(limit: number): Promise<BackupHistory[]> {
    const { backupHistory } = this.tables;
    const results = await this.db
      .select()
      .from(backupHistory)
      .orderBy(asc(backupHistory.timestamp))
      .limit(limit);
    return this.normalizeBigInts(results);
  }

  /**
   * Get backup statistics
   */
  async getBackupStats(): Promise<{ count: number; totalSize: number; oldestTimestamp: number | null; newestTimestamp: number | null }> {
    const { backupHistory } = this.tables;
    const result = await this.db
      .select({
        count: sql<number>`count(*)`,
        totalSize: sql<number>`coalesce(sum(${backupHistory.fileSize}), 0)`,
        oldestTimestamp: sql<number>`min(${backupHistory.timestamp})`,
        newestTimestamp: sql<number>`max(${backupHistory.timestamp})`,
      })
      .from(backupHistory);
    const row = result[0];
    return {
      count: Number(row?.count ?? 0),
      totalSize: Number(row?.totalSize ?? 0),
      oldestTimestamp: row?.oldestTimestamp ? Number(row.oldestTimestamp) : null,
      newestTimestamp: row?.newestTimestamp ? Number(row.newestTimestamp) : null,
    };
  }
}
