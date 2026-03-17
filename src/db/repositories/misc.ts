/**
 * Misc Repository
 *
 * Handles solar estimates and auto-traceroute nodes database operations.
 * Supports SQLite, PostgreSQL, and MySQL through Drizzle ORM.
 */
import { eq, desc, asc, and, gte, lte, lt, inArray, sql } from 'drizzle-orm';
import { BaseRepository, DrizzleDatabase } from './base.js';
import { DatabaseType, DbCustomTheme } from '../types.js';
import { logger } from '../../utils/logger.js';

export interface SolarEstimate {
  id?: number;
  timestamp: number;
  watt_hours: number;
  fetched_at: number;
  created_at?: number | null;
}

export interface AutoTracerouteNode {
  id?: number;
  nodeNum: number;
  enabled?: boolean;
  createdAt: number;
}

export interface UpgradeHistoryRecord {
  id: string;
  fromVersion: string;
  toVersion: string;
  deploymentMethod: string;
  status: string;
  progress?: number | null;
  currentStep?: string | null;
  logs?: string | null;
  backupPath?: string | null;
  startedAt?: number | null;
  completedAt?: number | null;
  initiatedBy?: string | null;
  errorMessage?: string | null;
  rollbackAvailable?: boolean | null;
}

export interface NewUpgradeHistory {
  id: string;
  fromVersion: string;
  toVersion: string;
  deploymentMethod: string;
  status: string;
  progress?: number;
  currentStep?: string;
  logs?: string;
  startedAt?: number;
  initiatedBy?: string;
  rollbackAvailable?: boolean;
}

export interface NewsCache {
  id?: number;
  feedData: string; // JSON string of full feed
  fetchedAt: number;
  sourceUrl: string;
}

export interface UserNewsStatus {
  id?: number;
  userId: number;
  lastSeenNewsId?: string | null;
  dismissedNewsIds?: string | null; // JSON array of dismissed news IDs
  updatedAt: number;
}

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

/**
 * Repository for miscellaneous operations (solar estimates, auto-traceroute nodes, news)
 */
export class MiscRepository extends BaseRepository {
  constructor(db: DrizzleDatabase, dbType: DatabaseType) {
    super(db, dbType);
  }

  // ============ SOLAR ESTIMATES ============

  /**
   * Upsert a solar estimate (insert or update on conflict).
   * Keeps branching: MySQL uses onDuplicateKeyUpdate vs onConflictDoUpdate.
   */
  async upsertSolarEstimate(estimate: SolarEstimate): Promise<void> {
    const { solarEstimates } = this.tables;
    const values = {
      timestamp: estimate.timestamp,
      watt_hours: estimate.watt_hours,
      fetched_at: estimate.fetched_at,
      created_at: estimate.created_at ?? this.now(),
    };
    const setData = {
      watt_hours: estimate.watt_hours,
      fetched_at: estimate.fetched_at,
    };

    if (this.isMySQL()) {
      const db = this.getMysqlDb();
      await db
        .insert(solarEstimates)
        .values(values)
        .onDuplicateKeyUpdate({ set: setData });
    } else {
      // SQLite and PostgreSQL both use onConflictDoUpdate
      await (this.db as any)
        .insert(solarEstimates)
        .values(values)
        .onConflictDoUpdate({
          target: solarEstimates.timestamp,
          set: setData,
        });
    }
  }

  /**
   * Get recent solar estimates
   */
  async getRecentSolarEstimates(limit: number = 100): Promise<SolarEstimate[]> {
    const { solarEstimates } = this.tables;
    const results = await this.db
      .select()
      .from(solarEstimates)
      .orderBy(desc(solarEstimates.timestamp))
      .limit(limit);
    return this.normalizeBigInts(results);
  }

  /**
   * Get solar estimates within a time range
   */
  async getSolarEstimatesInRange(startTimestamp: number, endTimestamp: number): Promise<SolarEstimate[]> {
    const { solarEstimates } = this.tables;
    const results = await this.db
      .select()
      .from(solarEstimates)
      .where(
        and(
          gte(solarEstimates.timestamp, startTimestamp),
          lte(solarEstimates.timestamp, endTimestamp)
        )
      )
      .orderBy(asc(solarEstimates.timestamp));
    return this.normalizeBigInts(results);
  }

  // ============ AUTO-TRACEROUTE NODES ============

  /**
   * Get all auto-traceroute nodes
   */
  async getAutoTracerouteNodes(): Promise<number[]> {
    const { autoTracerouteNodes } = this.tables;
    const results = await this.db
      .select({ nodeNum: autoTracerouteNodes.nodeNum })
      .from(autoTracerouteNodes)
      .orderBy(asc(autoTracerouteNodes.createdAt));
    return results.map((r: any) => Number(r.nodeNum));
  }

  /**
   * Set auto-traceroute nodes (replaces all existing entries)
   */
  async setAutoTracerouteNodes(nodeNums: number[]): Promise<void> {
    const now = this.now();
    const { autoTracerouteNodes } = this.tables;

    // Delete all existing entries
    await this.db.delete(autoTracerouteNodes);
    // Insert new entries
    for (const nodeNum of nodeNums) {
      await this.db
        .insert(autoTracerouteNodes)
        .values({ nodeNum, createdAt: now });
    }
  }

  /**
   * Add a single auto-traceroute node.
   * Keeps branching: MySQL lacks onConflictDoNothing.
   */
  async addAutoTracerouteNode(nodeNum: number): Promise<void> {
    const now = this.now();
    const { autoTracerouteNodes } = this.tables;

    if (this.isMySQL()) {
      // MySQL doesn't have onConflictDoNothing, use try/catch
      try {
        await this.db
          .insert(autoTracerouteNodes)
          .values({ nodeNum, createdAt: now });
      } catch {
        // Ignore duplicate key errors
      }
    } else {
      // SQLite and PostgreSQL support onConflictDoNothing
      await (this.db as any)
        .insert(autoTracerouteNodes)
        .values({ nodeNum, createdAt: now })
        .onConflictDoNothing();
    }
  }

  /**
   * Remove a single auto-traceroute node
   */
  async removeAutoTracerouteNode(nodeNum: number): Promise<void> {
    const { autoTracerouteNodes } = this.tables;
    await this.db.delete(autoTracerouteNodes).where(eq(autoTracerouteNodes.nodeNum, nodeNum));
  }

  // ============ UPGRADE HISTORY ============

  // Status values that indicate an upgrade is in progress
  private readonly IN_PROGRESS_STATUSES = ['pending', 'backing_up', 'downloading', 'restarting', 'health_check'];

  /**
   * Create a new upgrade history record
   */
  async createUpgradeHistory(upgrade: NewUpgradeHistory): Promise<void> {
    const { upgradeHistory } = this.tables;
    await this.db.insert(upgradeHistory).values({
      id: upgrade.id,
      fromVersion: upgrade.fromVersion,
      toVersion: upgrade.toVersion,
      deploymentMethod: upgrade.deploymentMethod,
      status: upgrade.status,
      progress: upgrade.progress ?? 0,
      currentStep: upgrade.currentStep,
      logs: upgrade.logs,
      startedAt: upgrade.startedAt,
      initiatedBy: upgrade.initiatedBy,
      rollbackAvailable: upgrade.rollbackAvailable,
    });
  }

  /**
   * Get upgrade history record by ID
   */
  async getUpgradeById(id: string): Promise<UpgradeHistoryRecord | null> {
    const { upgradeHistory } = this.tables;
    const results = await this.db
      .select()
      .from(upgradeHistory)
      .where(eq(upgradeHistory.id, id))
      .limit(1);
    return results.length > 0 ? this.normalizeBigInts(results[0]) : null;
  }

  /**
   * Get upgrade history (most recent first)
   */
  async getUpgradeHistoryList(limit: number = 10): Promise<UpgradeHistoryRecord[]> {
    const { upgradeHistory } = this.tables;
    const results = await this.db
      .select()
      .from(upgradeHistory)
      .orderBy(desc(upgradeHistory.startedAt))
      .limit(limit);
    return this.normalizeBigInts(results);
  }

  /**
   * Get the most recent upgrade record
   */
  async getLastUpgrade(): Promise<UpgradeHistoryRecord | null> {
    const results = await this.getUpgradeHistoryList(1);
    return results.length > 0 ? results[0] : null;
  }

  /**
   * Find stale upgrades (stuck for too long)
   */
  async findStaleUpgrades(staleThreshold: number): Promise<UpgradeHistoryRecord[]> {
    const { upgradeHistory } = this.tables;
    const results = await this.db
      .select()
      .from(upgradeHistory)
      .where(
        and(
          inArray(upgradeHistory.status, this.IN_PROGRESS_STATUSES),
          lt(upgradeHistory.startedAt, staleThreshold)
        )
      );
    return this.normalizeBigInts(results);
  }

  /**
   * Count in-progress upgrades (non-stale)
   */
  async countInProgressUpgrades(staleThreshold: number): Promise<number> {
    const { upgradeHistory } = this.tables;
    const result = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(upgradeHistory)
      .where(
        and(
          inArray(upgradeHistory.status, this.IN_PROGRESS_STATUSES),
          gte(upgradeHistory.startedAt, staleThreshold)
        )
      );
    return Number(result[0]?.count ?? 0);
  }

  /**
   * Find the currently active upgrade (if any)
   */
  async findActiveUpgrade(staleThreshold: number): Promise<UpgradeHistoryRecord | null> {
    const { upgradeHistory } = this.tables;
    const results = await this.db
      .select()
      .from(upgradeHistory)
      .where(
        and(
          inArray(upgradeHistory.status, this.IN_PROGRESS_STATUSES),
          gte(upgradeHistory.startedAt, staleThreshold)
        )
      )
      .orderBy(desc(upgradeHistory.startedAt))
      .limit(1);
    return results.length > 0 ? this.normalizeBigInts(results[0]) : null;
  }

  /**
   * Mark an upgrade as failed
   */
  async markUpgradeFailed(id: string, errorMessage: string): Promise<void> {
    const now = this.now();
    const { upgradeHistory } = this.tables;
    await this.db
      .update(upgradeHistory)
      .set({
        status: 'failed',
        completedAt: now,
        errorMessage: errorMessage,
      })
      .where(eq(upgradeHistory.id, id));
  }

  /**
   * Mark an upgrade as complete
   */
  async markUpgradeComplete(id: string): Promise<void> {
    const now = this.now();
    const { upgradeHistory } = this.tables;
    await this.db
      .update(upgradeHistory)
      .set({
        status: 'complete',
        completedAt: now,
        currentStep: 'Upgrade complete',
      })
      .where(eq(upgradeHistory.id, id));
  }

  // ============ NEWS CACHE ============

  /**
   * Get the cached news feed
   */
  async getNewsCache(): Promise<NewsCache | null> {
    const { newsCache } = this.tables;
    const results = await this.db
      .select()
      .from(newsCache)
      .orderBy(desc(newsCache.fetchedAt))
      .limit(1);
    return results.length > 0 ? this.normalizeBigInts(results[0]) : null;
  }

  /**
   * Save news feed to cache (replaces any existing cache)
   */
  async saveNewsCache(cache: NewsCache): Promise<void> {
    const now = this.now();
    const { newsCache } = this.tables;
    // Delete old cache entries
    await this.db.delete(newsCache);
    // Insert new cache
    await this.db.insert(newsCache).values({
      feedData: cache.feedData,
      fetchedAt: cache.fetchedAt ?? now,
      sourceUrl: cache.sourceUrl,
    });
  }

  // ============ USER NEWS STATUS ============

  /**
   * Get user's news status
   */
  async getUserNewsStatus(userId: number): Promise<UserNewsStatus | null> {
    const { userNewsStatus } = this.tables;
    const results = await this.db
      .select()
      .from(userNewsStatus)
      .where(eq(userNewsStatus.userId, userId))
      .limit(1);
    return results.length > 0 ? this.normalizeBigInts(results[0]) : null;
  }

  /**
   * Save or update user's news status
   */
  async saveUserNewsStatus(status: UserNewsStatus): Promise<void> {
    const now = this.now();
    const { userNewsStatus } = this.tables;

    // Check if exists
    const existing = await this.db
      .select()
      .from(userNewsStatus)
      .where(eq(userNewsStatus.userId, status.userId))
      .limit(1);

    if (existing.length > 0) {
      await this.db
        .update(userNewsStatus)
        .set({
          lastSeenNewsId: status.lastSeenNewsId,
          dismissedNewsIds: status.dismissedNewsIds,
          updatedAt: now,
        })
        .where(eq(userNewsStatus.userId, status.userId));
    } else {
      await this.db.insert(userNewsStatus).values({
        userId: status.userId,
        lastSeenNewsId: status.lastSeenNewsId,
        dismissedNewsIds: status.dismissedNewsIds,
        updatedAt: now,
      });
    }
  }

  // ============ BACKUP HISTORY ============

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

  // ============ AUTO TIME SYNC NODES ============

  /**
   * Get all auto time sync nodes
   */
  async getAutoTimeSyncNodes(): Promise<number[]> {
    const { autoTimeSyncNodes } = this.tables;
    const results = await this.db
      .select({ nodeNum: autoTimeSyncNodes.nodeNum })
      .from(autoTimeSyncNodes)
      .orderBy(asc(autoTimeSyncNodes.createdAt));
    return results.map((r: any) => Number(r.nodeNum));
  }

  /**
   * Set auto time sync nodes (replaces existing)
   */
  async setAutoTimeSyncNodes(nodeNums: number[]): Promise<void> {
    const now = this.now();
    const { autoTimeSyncNodes } = this.tables;

    // Delete all existing entries
    await this.db.delete(autoTimeSyncNodes);
    // Insert new entries
    for (const nodeNum of nodeNums) {
      await this.db
        .insert(autoTimeSyncNodes)
        .values({ nodeNum, createdAt: now });
    }
  }

  /**
   * Add a single auto time sync node.
   * Keeps branching: MySQL lacks onConflictDoNothing.
   */
  async addAutoTimeSyncNode(nodeNum: number): Promise<void> {
    const now = this.now();
    const { autoTimeSyncNodes } = this.tables;

    if (this.isMySQL()) {
      // MySQL doesn't have onConflictDoNothing, use try/catch
      try {
        await this.db
          .insert(autoTimeSyncNodes)
          .values({ nodeNum, createdAt: now });
      } catch {
        // Ignore duplicate key errors
      }
    } else {
      // SQLite and PostgreSQL support onConflictDoNothing
      await (this.db as any)
        .insert(autoTimeSyncNodes)
        .values({ nodeNum, createdAt: now })
        .onConflictDoNothing();
    }
  }

  /**
   * Remove a single auto time sync node
   */
  async removeAutoTimeSyncNode(nodeNum: number): Promise<void> {
    const { autoTimeSyncNodes } = this.tables;
    await this.db.delete(autoTimeSyncNodes).where(eq(autoTimeSyncNodes.nodeNum, nodeNum));
  }

  // ============ CUSTOM THEMES ============

  /**
   * Normalize a raw theme row into DbCustomTheme format.
   * Ensures is_builtin is coerced to 0/1 for consistency across dialects.
   */
  private normalizeThemeRow(row: any): DbCustomTheme {
    return {
      id: Number(row.id),
      name: row.name,
      slug: row.slug,
      definition: row.definition,
      is_builtin: row.is_builtin ? 1 : 0,
      created_by: row.created_by != null ? Number(row.created_by) : undefined,
      created_at: Number(row.created_at),
      updated_at: Number(row.updated_at),
    };
  }

  /**
   * Get all custom themes ordered by name
   */
  async getAllCustomThemes(): Promise<DbCustomTheme[]> {
    const { customThemes } = this.tables;
    try {
      const results = await this.db
        .select()
        .from(customThemes)
        .orderBy(asc(customThemes.name));
      return results.map((row: any) => this.normalizeThemeRow(row));
    } catch (error) {
      logger.error('[MiscRepository] Failed to get custom themes:', error);
      throw error;
    }
  }

  /**
   * Get a specific custom theme by slug
   */
  async getCustomThemeBySlug(slug: string): Promise<DbCustomTheme | undefined> {
    const { customThemes } = this.tables;
    try {
      const results = await this.db
        .select()
        .from(customThemes)
        .where(eq(customThemes.slug, slug))
        .limit(1);
      if (results.length === 0) return undefined;
      return this.normalizeThemeRow(results[0]);
    } catch (error) {
      logger.error(`[MiscRepository] Failed to get custom theme ${slug}:`, error);
      throw error;
    }
  }

  /**
   * Create a new custom theme
   */
  async createCustomTheme(name: string, slug: string, definitionJson: string, userId?: number): Promise<DbCustomTheme> {
    const now = Math.floor(Date.now() / 1000);
    const { customThemes } = this.tables;

    try {
      if (this.isMySQL()) {
        // MySQL: use raw query for RETURNING-like behavior via insertId
        const db = this.getMysqlDb();
        const result = await db
          .insert(customThemes)
          .values({
            name,
            slug,
            definition: definitionJson,
            is_builtin: false,
            created_by: userId ?? null,
            created_at: now,
            updated_at: now,
          });
        const id = Number((result as any)[0].insertId);
        logger.debug(`[MiscRepository] Created custom theme: ${name} (slug: ${slug})`);
        return { id, name, slug, definition: definitionJson, is_builtin: 0, created_by: userId, created_at: now, updated_at: now };
      } else if (this.isPostgres()) {
        // PostgreSQL: use returning()
        const db = this.getPostgresDb();
        const result = await db
          .insert(customThemes)
          .values({
            name,
            slug,
            definition: definitionJson,
            is_builtin: false,
            created_by: userId ?? null,
            created_at: now,
            updated_at: now,
          })
          .returning({ id: customThemes.id });
        const id = Number(result[0].id);
        logger.debug(`[MiscRepository] Created custom theme: ${name} (slug: ${slug})`);
        return { id, name, slug, definition: definitionJson, is_builtin: 0, created_by: userId, created_at: now, updated_at: now };
      } else {
        // SQLite: use returning()
        const db = this.getSqliteDb();
        const result = await db
          .insert(customThemes)
          .values({
            name,
            slug,
            definition: definitionJson,
            is_builtin: false,
            created_by: userId ?? null,
            created_at: now,
            updated_at: now,
          })
          .returning({ id: customThemes.id });
        const id = Number(result[0].id);
        logger.debug(`[MiscRepository] Created custom theme: ${name} (slug: ${slug})`);
        return { id, name, slug, definition: definitionJson, is_builtin: 0, created_by: userId, created_at: now, updated_at: now };
      }
    } catch (error) {
      logger.error(`[MiscRepository] Failed to create custom theme ${name}:`, error);
      throw error;
    }
  }

  /**
   * Update an existing custom theme
   */
  async updateCustomTheme(slug: string, updates: Partial<{ name: string; definition: string }>): Promise<boolean> {
    const { customThemes } = this.tables;

    try {
      // Check if theme exists
      const existing = await this.getCustomThemeBySlug(slug);
      if (!existing) {
        logger.warn(`[MiscRepository] Cannot update non-existent theme: ${slug}`);
        return false;
      }

      const now = Math.floor(Date.now() / 1000);
      const setData: Record<string, any> = { updated_at: now };

      if (updates.name !== undefined) {
        setData.name = updates.name;
      }
      if (updates.definition !== undefined) {
        setData.definition = typeof updates.definition === 'string'
          ? updates.definition
          : JSON.stringify(updates.definition);
      }

      await this.db
        .update(customThemes)
        .set(setData)
        .where(eq(customThemes.slug, slug));

      logger.debug(`[MiscRepository] Updated custom theme: ${slug}`);
      return true;
    } catch (error) {
      logger.error(`[MiscRepository] Failed to update custom theme ${slug}:`, error);
      throw error;
    }
  }

  /**
   * Delete a custom theme by slug
   */
  async deleteCustomTheme(slug: string): Promise<boolean> {
    const { customThemes } = this.tables;

    try {
      // Check if theme exists and is not built-in
      const existing = await this.getCustomThemeBySlug(slug);
      if (!existing) {
        logger.warn(`[MiscRepository] Cannot delete non-existent theme: ${slug}`);
        return false;
      }
      if (existing.is_builtin) {
        throw new Error('Cannot delete built-in themes');
      }

      await this.db
        .delete(customThemes)
        .where(eq(customThemes.slug, slug));

      logger.debug(`[MiscRepository] Deleted custom theme: ${slug}`);
      return true;
    } catch (error) {
      logger.error(`[MiscRepository] Failed to delete custom theme ${slug}:`, error);
      throw error;
    }
  }

  // ============ DISTANCE DELETE LOG ============

  /**
   * Get auto-delete-by-distance log entries
   */
  async getDistanceDeleteLog(limit: number = 10): Promise<any[]> {
    const results = await this.db.execute(
      sql`SELECT * FROM auto_distance_delete_log ORDER BY timestamp DESC LIMIT ${limit}`
    );

    // MySQL returns [rows, fields], others return rows directly
    const rows = this.isMySQL() ? (results as any)[0] : (results as any).rows ?? results;
    return (rows as any[]).map((e: any) => ({
      ...e,
      details: e.details ? JSON.parse(e.details) : [],
    }));
  }

  /**
   * Add an entry to the auto-delete-by-distance log
   */
  async addDistanceDeleteLogEntry(entry: {
    timestamp: number;
    nodesDeleted: number;
    thresholdKm: number;
    details: string;
  }): Promise<void> {
    const now = Date.now();
    await this.db.execute(
      sql`INSERT INTO auto_distance_delete_log (timestamp, nodes_deleted, threshold_km, details, created_at)
          VALUES (${entry.timestamp}, ${entry.nodesDeleted}, ${entry.thresholdKm}, ${entry.details}, ${now})`
    );
  }
}
