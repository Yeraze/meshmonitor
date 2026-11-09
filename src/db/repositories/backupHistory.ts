/**
 * Backup History Repository
 *
 * Handles backup history database operations.
 * Supports SQLite, PostgreSQL, and MySQL through Drizzle ORM.
 *
 * Every read/write is scoped by `sourceId` (#6285). Rows with a NULL
 * `sourceId`, or one that no longer exists in `sources`, are "unowned"
 * (legacy or orphaned) and are reachable only through the explicit
 * `*Unowned*` methods, which callers must gate to admins.
 */
import { and, eq, desc, asc, sql, isNull, or, notInArray } from 'drizzle-orm';
import { BaseRepository, DrizzleDatabase } from './base.js';
import { DatabaseType } from '../types.js';

export type BackupProtocol = 'meshtastic' | 'meshcore';

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
  sourceId?: string | null;
  protocol?: BackupProtocol | string;
}

export class BackupHistoryRepository extends BaseRepository {
  constructor(db: DrizzleDatabase, dbType: DatabaseType) {
    super(db, dbType);
  }

  /** Predicate matching rows with no live owner (NULL or deleted source). */
  private unownedWhere() {
    const { backupHistory, sources } = this.tables;
    return or(
      isNull(backupHistory.sourceId),
      notInArray(backupHistory.sourceId, this.db.select({ id: sources.id }).from(sources)),
    );
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
      sourceId: backup.sourceId ?? null,
      protocol: backup.protocol ?? 'meshtastic',
    });
  }

  /** Backup rows owned by `sourceId`, newest first. */
  async getBackupHistoryList(sourceId: string): Promise<BackupHistory[]> {
    const { backupHistory } = this.tables;
    const results = await this.db
      .select()
      .from(backupHistory)
      .where(eq(backupHistory.sourceId, sourceId))
      .orderBy(desc(backupHistory.timestamp));
    return this.normalizeBigInts(results);
  }

  /** Unowned (legacy / orphaned) rows, optionally of one protocol, newest first. */
  async listUnowned(protocol?: BackupProtocol): Promise<BackupHistory[]> {
    const { backupHistory } = this.tables;
    const where = protocol ? and(this.unownedWhere(), eq(backupHistory.protocol, protocol)) : this.unownedWhere();
    const results = await this.db
      .select()
      .from(backupHistory)
      .where(where)
      .orderBy(desc(backupHistory.timestamp));
    return this.normalizeBigInts(results);
  }

  /** A row by (sourceId, filename). Never matches another source's file. */
  async getBackupByFilename(sourceId: string, filename: string): Promise<BackupHistory | null> {
    const { backupHistory } = this.tables;
    const results = await this.db
      .select()
      .from(backupHistory)
      .where(and(eq(backupHistory.sourceId, sourceId), eq(backupHistory.filename, filename)))
      .limit(1);
    return results.length > 0 ? this.normalizeBigInts(results[0]) : null;
  }

  /** An unowned row by filename (admin paths only). */
  async getUnownedByFilename(filename: string): Promise<BackupHistory | null> {
    const { backupHistory } = this.tables;
    const results = await this.db
      .select()
      .from(backupHistory)
      .where(and(this.unownedWhere(), eq(backupHistory.filename, filename)))
      .limit(1);
    return results.length > 0 ? this.normalizeBigInts(results[0]) : null;
  }

  /** Delete one row by primary key (filenames are not unique across sources). */
  async deleteBackupHistoryById(id: number): Promise<void> {
    const { backupHistory } = this.tables;
    await this.db.delete(backupHistory).where(eq(backupHistory.id, id));
  }

  /** Count the rows owned by `sourceId`. */
  async countBackups(sourceId: string): Promise<number> {
    const { backupHistory } = this.tables;
    const result = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(backupHistory)
      .where(eq(backupHistory.sourceId, sourceId));
    return Number(result[0]?.count ?? 0);
  }

  /** Oldest rows owned by `sourceId` (for purging). */
  async getOldestBackups(sourceId: string, limit: number): Promise<BackupHistory[]> {
    const { backupHistory } = this.tables;
    const results = await this.db
      .select()
      .from(backupHistory)
      .where(eq(backupHistory.sourceId, sourceId))
      .orderBy(asc(backupHistory.timestamp))
      .limit(limit);
    return this.normalizeBigInts(results);
  }

  /** Backup statistics across all rows (diagnostic; carries no filenames). */
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
