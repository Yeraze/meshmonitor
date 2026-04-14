/**
 * Misc Repository
 *
 * Handles solar estimates and auto-traceroute nodes database operations.
 * Supports SQLite, PostgreSQL, and MySQL through Drizzle ORM.
 */
import { eq, desc, asc, and, gte, lte, lt, inArray, sql, isNull } from 'drizzle-orm';
import { BaseRepository, DrizzleDatabase } from './base.js';
import { DatabaseType, DbCustomTheme, DbPacketLog, DbPacketCountByNode, DbPacketCountByPortnum, DbDistinctRelayNode } from '../types.js';
import { logger } from '../../utils/logger.js';
import { getPortNumName } from '../../server/constants/meshtastic.js';

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

    await this.upsert(solarEstimates, values, solarEstimates.timestamp, setData);
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
   * Get all auto-traceroute nodes.
   * When sourceId is provided, return only rows scoped to that source OR
   * legacy unscoped rows (sourceId IS NULL). When omitted, return everything.
   */
  async getAutoTracerouteNodes(sourceId?: string): Promise<number[]> {
    const { autoTracerouteNodes } = this.tables;
    const query = this.db
      .select({ nodeNum: autoTracerouteNodes.nodeNum })
      .from(autoTracerouteNodes);
    const results = sourceId
      ? await query
          .where(eq(autoTracerouteNodes.sourceId, sourceId))
          .orderBy(asc(autoTracerouteNodes.createdAt))
      : await query.orderBy(asc(autoTracerouteNodes.createdAt));
    return results.map((r: any) => Number(r.nodeNum));
  }

  /**
   * Set auto-traceroute nodes (replaces all existing entries for the given
   * source, or globally when sourceId is omitted).
   */
  async setAutoTracerouteNodes(nodeNums: number[], sourceId?: string): Promise<void> {
    const now = this.now();
    const { autoTracerouteNodes } = this.tables;

    // Delete existing entries scoped to this source (or all when unscoped).
    if (sourceId) {
      await this.db
        .delete(autoTracerouteNodes)
        .where(eq(autoTracerouteNodes.sourceId, sourceId));
    } else {
      await this.db.delete(autoTracerouteNodes);
    }
    // Insert new entries
    for (const nodeNum of nodeNums) {
      await this.db
        .insert(autoTracerouteNodes)
        .values({ nodeNum, createdAt: now, sourceId: sourceId ?? null });
    }
  }

  /**
   * Add a single auto-traceroute node.
   * Keeps branching: MySQL lacks onConflictDoNothing.
   */
  async addAutoTracerouteNode(nodeNum: number, sourceId?: string): Promise<void> {
    const now = this.now();
    const { autoTracerouteNodes } = this.tables;

    // Pre-check for the (nodeNum, sourceId) tuple. Needed because SQLite/MySQL
    // treat NULL as distinct in UNIQUE constraints, so insertIgnore would
    // allow duplicate unscoped rows.
    const whereClause = sourceId
      ? and(eq(autoTracerouteNodes.nodeNum, nodeNum), eq(autoTracerouteNodes.sourceId, sourceId))
      : and(eq(autoTracerouteNodes.nodeNum, nodeNum), isNull(autoTracerouteNodes.sourceId));
    const existing = await this.db
      .select({ id: autoTracerouteNodes.id })
      .from(autoTracerouteNodes)
      .where(whereClause)
      .limit(1);
    if (existing.length > 0) return;

    await this.insertIgnore(autoTracerouteNodes, {
      nodeNum,
      createdAt: now,
      sourceId: sourceId ?? null,
    });
  }

  /**
   * Remove a single auto-traceroute node
   */
  async removeAutoTracerouteNode(nodeNum: number, sourceId?: string): Promise<void> {
    const { autoTracerouteNodes } = this.tables;
    const where = sourceId
      ? and(
          eq(autoTracerouteNodes.nodeNum, nodeNum),
          eq(autoTracerouteNodes.sourceId, sourceId)
        )
      : eq(autoTracerouteNodes.nodeNum, nodeNum);
    await this.db.delete(autoTracerouteNodes).where(where);
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
   * Get all auto time sync nodes.
   * When sourceId is provided, return only rows scoped to that source.
   * When omitted, return everything.
   */
  async getAutoTimeSyncNodes(sourceId?: string): Promise<number[]> {
    const { autoTimeSyncNodes } = this.tables;
    const query = this.db
      .select({ nodeNum: autoTimeSyncNodes.nodeNum })
      .from(autoTimeSyncNodes);
    const results = sourceId
      ? await query
          .where(eq(autoTimeSyncNodes.sourceId, sourceId))
          .orderBy(asc(autoTimeSyncNodes.createdAt))
      : await query.orderBy(asc(autoTimeSyncNodes.createdAt));
    return results.map((r: any) => Number(r.nodeNum));
  }

  /**
   * Set auto time sync nodes (replaces all existing entries for the given
   * source, or globally when sourceId is omitted).
   */
  async setAutoTimeSyncNodes(nodeNums: number[], sourceId?: string): Promise<void> {
    const now = this.now();
    const { autoTimeSyncNodes } = this.tables;

    // Delete existing entries scoped to this source (or all when unscoped).
    if (sourceId) {
      await this.db
        .delete(autoTimeSyncNodes)
        .where(eq(autoTimeSyncNodes.sourceId, sourceId));
    } else {
      await this.db.delete(autoTimeSyncNodes);
    }
    // Insert new entries
    for (const nodeNum of nodeNums) {
      await this.db
        .insert(autoTimeSyncNodes)
        .values({ nodeNum, createdAt: now, sourceId: sourceId ?? null });
    }
  }

  /**
   * Add a single auto time sync node.
   * Keeps branching: MySQL lacks onConflictDoNothing.
   */
  async addAutoTimeSyncNode(nodeNum: number, sourceId?: string): Promise<void> {
    const now = this.now();
    const { autoTimeSyncNodes } = this.tables;

    await this.insertIgnore(autoTimeSyncNodes, {
      nodeNum,
      createdAt: now,
      sourceId: sourceId ?? null,
    });
  }

  /**
   * Remove a single auto time sync node
   */
  async removeAutoTimeSyncNode(nodeNum: number, sourceId?: string): Promise<void> {
    const { autoTimeSyncNodes } = this.tables;
    const where = sourceId
      ? and(
          eq(autoTimeSyncNodes.nodeNum, nodeNum),
          eq(autoTimeSyncNodes.sourceId, sourceId)
        )
      : eq(autoTimeSyncNodes.nodeNum, nodeNum);
    await this.db.delete(autoTimeSyncNodes).where(where);
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
   * Get auto-delete-by-distance log entries.
   * If sourceId is provided, scope to that source. NULL sourceId is the
   * legacy/unscoped bucket; an unfiltered call returns all rows.
   */
  async getDistanceDeleteLog(limit: number = 10, sourceId?: string): Promise<any[]> {
    const { autoDistanceDeleteLog } = this.tables;
    const baseQuery = (this.db as any)
      .select()
      .from(autoDistanceDeleteLog);
    const query = sourceId
      ? baseQuery.where(eq(autoDistanceDeleteLog.sourceId, sourceId))
      : baseQuery;
    const rows = await query
      .orderBy(desc(autoDistanceDeleteLog.timestamp))
      .limit(limit);
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
    sourceId?: string;
  }): Promise<void> {
    const { autoDistanceDeleteLog } = this.tables;
    const now = Date.now();
    await (this.db as any).insert(autoDistanceDeleteLog).values({
      timestamp: entry.timestamp,
      nodesDeleted: entry.nodesDeleted,
      thresholdKm: entry.thresholdKm,
      details: entry.details,
      createdAt: now,
      sourceId: entry.sourceId ?? null,
    });
  }

  // ============ PACKET LOG ============

  /**
   * Filter options for packet log queries
   */
  private buildPacketLogWhere(options: PacketLogFilterOptions): { conditions: any[]; } {
    const conditions: any[] = [];
    const { portnum, from_node, to_node, channel, encrypted, since, relay_node, sourceId } = options;

    if (sourceId !== undefined) conditions.push(sql`pl.${sql.identifier('sourceId')} = ${sourceId}`);
    if (portnum !== undefined) conditions.push(sql`pl.portnum = ${portnum}`);
    if (from_node !== undefined) conditions.push(sql`pl.from_node = ${from_node}`);
    if (to_node !== undefined) conditions.push(sql`pl.to_node = ${to_node}`);
    if (channel !== undefined) conditions.push(sql`pl.channel = ${channel}`);
    if (encrypted !== undefined) {
      if (this.isSQLite()) {
        conditions.push(sql`pl.encrypted = ${encrypted ? 1 : 0}`);
      } else {
        conditions.push(sql`pl.encrypted = ${encrypted}`);
      }
    }
    if (since !== undefined) conditions.push(sql`pl.timestamp >= ${since}`);
    if (relay_node === 'unknown') {
      conditions.push(sql`pl.relay_node IS NULL`);
    } else if (relay_node !== undefined) {
      conditions.push(sql`pl.relay_node = ${relay_node}`);
    }

    return { conditions };
  }

  /**
   * Combine SQL conditions with AND
   */
  private combineConditions(conditions: any[]): any {
    if (conditions.length === 0) return sql`1=1`;
    return conditions.reduce((acc, cond) => sql`${acc} AND ${cond}`);
  }

  /**
   * Normalize a raw packet log row — coerce BIGINT fields to number
   */
  private normalizePacketLogRow(row: any): DbPacketLog {
    return {
      ...row,
      id: row.id != null ? Number(row.id) : row.id,
      packet_id: row.packet_id != null ? Number(row.packet_id) : row.packet_id,
      timestamp: row.timestamp != null ? Number(row.timestamp) : row.timestamp,
      from_node: row.from_node != null ? Number(row.from_node) : row.from_node,
      to_node: row.to_node != null ? Number(row.to_node) : row.to_node,
      relay_node: row.relay_node != null ? Number(row.relay_node) : row.relay_node,
      created_at: row.created_at != null ? Number(row.created_at) : row.created_at,
      // PostgreSQL lowercases unquoted aliases — normalize for frontend
      from_node_longName: row.from_node_longName ?? row.from_node_longname ?? null,
      to_node_longName: row.to_node_longName ?? row.to_node_longname ?? null,
    } as DbPacketLog;
  }

  /**
   * Insert a packet log entry
   */
  async insertPacketLog(packet: Omit<DbPacketLog, 'id' | 'created_at'>, sourceId?: string): Promise<number> {
    const { packetLog } = this.tables;

    try {
      const values: any = {
        packet_id: packet.packet_id ?? null,
        timestamp: packet.timestamp,
        from_node: packet.from_node,
        from_node_id: packet.from_node_id ?? null,
        to_node: packet.to_node ?? null,
        to_node_id: packet.to_node_id ?? null,
        channel: packet.channel ?? null,
        portnum: packet.portnum,
        portnum_name: packet.portnum_name ?? null,
        encrypted: packet.encrypted,
        snr: packet.snr ?? null,
        rssi: packet.rssi ?? null,
        hop_limit: packet.hop_limit ?? null,
        hop_start: packet.hop_start ?? null,
        relay_node: packet.relay_node ?? null,
        payload_size: packet.payload_size ?? null,
        want_ack: packet.want_ack ?? false,
        priority: packet.priority ?? null,
        payload_preview: packet.payload_preview ?? null,
        metadata: packet.metadata ?? null,
        direction: packet.direction ?? 'rx',
        created_at: Date.now(),
        transport_mechanism: packet.transport_mechanism ?? null,
        decrypted_by: packet.decrypted_by ?? null,
        decrypted_channel_id: packet.decrypted_channel_id ?? null,
      };
      if (sourceId) {
        values.sourceId = sourceId;
      }

      await this.db.insert(packetLog).values(values);
      return 0;
    } catch (error) {
      logger.error(`[MiscRepository] Failed to insert packet log: ${error}`);
      return 0;
    }
  }

  /**
   * Enforce max count limit on packet logs (deletes oldest entries)
   */
  async enforcePacketLogMaxCount(maxCount: number): Promise<void> {
    try {
      const countResult = await this.db
        .select({ count: sql<number>`count(*)` })
        .from(this.tables.packetLog);
      const currentCount = Number(countResult[0]?.count ?? 0);

      if (currentCount > maxCount) {
        const deleteCount = currentCount - maxCount;
        // Use raw SQL for the DELETE with subquery — Drizzle doesn't support DELETE ... WHERE id IN (SELECT ...)
        await this.executeRun(
          sql`DELETE FROM packet_log WHERE id IN (SELECT id FROM packet_log ORDER BY timestamp ASC LIMIT ${deleteCount})`
        );
        logger.debug(`[MiscRepository] Deleted ${deleteCount} old packets to enforce max count of ${maxCount}`);
      }
    } catch (error) {
      logger.error('[MiscRepository] Failed to enforce packet log max count:', error);
    }
  }

  /**
   * Get packet logs with optional filters and pagination
   */
  async getPacketLogs(options: PacketLogFilterOptions & { offset?: number; limit?: number }): Promise<DbPacketLog[]> {
    const { offset = 0, limit = 100 } = options;
    const { conditions } = this.buildPacketLogWhere(options);
    const whereClause = this.combineConditions(conditions);

    try {
      const longName = this.col('longName');
      const nodeNum = this.col('nodeNum');

      const joinQuery = sql`
        SELECT pl.*, from_nodes.${longName} as from_node_longName, to_nodes.${longName} as to_node_longName
        FROM packet_log pl
        LEFT JOIN nodes from_nodes ON pl.from_node = from_nodes.${nodeNum}
        LEFT JOIN nodes to_nodes ON pl.to_node = to_nodes.${nodeNum}
        WHERE ${whereClause}
        ORDER BY pl.timestamp DESC, pl.id DESC LIMIT ${limit} OFFSET ${offset}
      `;

      const rows = await this.executeQuery(joinQuery);
      return (rows as any[]).map((row: any) => this.normalizePacketLogRow(row));
    } catch (error) {
      logger.error('[MiscRepository] Failed to get packet logs:', error);
      return [];
    }
  }

  /**
   * Get a single packet log entry by ID
   */
  async getPacketLogById(id: number): Promise<DbPacketLog | null> {
    try {
      const longName = this.col('longName');
      const nodeNum = this.col('nodeNum');

      const joinQuery = sql`
        SELECT pl.*, from_nodes.${longName} as from_node_longName, to_nodes.${longName} as to_node_longName
        FROM packet_log pl
        LEFT JOIN nodes from_nodes ON pl.from_node = from_nodes.${nodeNum}
        LEFT JOIN nodes to_nodes ON pl.to_node = to_nodes.${nodeNum}
        WHERE pl.id = ${id}
      `;

      const rows = await this.executeQuery(joinQuery);
      if (!rows || rows.length === 0) return null;
      return this.normalizePacketLogRow(rows[0]);
    } catch (error) {
      logger.error('[MiscRepository] Failed to get packet log by id:', error);
      return null;
    }
  }

  /**
   * Get packet log count with optional filters
   */
  async getPacketLogCount(options: PacketLogFilterOptions = {}): Promise<number> {
    const { conditions } = this.buildPacketLogWhere(options);
    const whereClause = this.combineConditions(conditions);

    try {
      const rows = await this.executeQuery(
        sql`SELECT COUNT(*) as count FROM packet_log pl WHERE ${whereClause}`
      );
      return Number(rows[0]?.count ?? 0);
    } catch (error) {
      logger.error('[MiscRepository] Failed to get packet log count:', error);
      return 0;
    }
  }

  /**
   * Clear all packet logs
   */
  async clearPacketLogs(): Promise<number> {
    try {
      const results = await this.executeRun(sql`DELETE FROM packet_log`);
      const deletedCount = this.getAffectedRows(results);
      logger.debug(`[MiscRepository] Cleared ${deletedCount} packet log entries`);
      return deletedCount;
    } catch (error) {
      logger.error('[MiscRepository] Failed to clear packet logs:', error);
      throw error;
    }
  }

  /**
   * Cleanup old packet logs based on max age
   */
  async cleanupOldPacketLogs(maxAgeHours: number): Promise<number> {
    const cutoffTimestamp = Date.now() - (maxAgeHours * 60 * 60 * 1000);

    try {
      const results = await this.executeRun(
        sql`DELETE FROM packet_log WHERE timestamp < ${cutoffTimestamp}`
      );
      const deleted = this.getAffectedRows(results);
      if (deleted > 0) {
        logger.debug(`[MiscRepository] Cleaned up ${deleted} packet log entries older than ${maxAgeHours} hours`);
      }
      return deleted;
    } catch (error) {
      logger.error('[MiscRepository] Failed to cleanup old packet logs:', error);
      return 0;
    }
  }

  /**
   * Get distinct relay_node values from packet_log for filter dropdowns.
   * relay_node is only the last byte of the node ID per the Meshtastic protobuf spec.
   * We match by (nodeNum & 0xFF) to find candidate node names.
   */
  async getDistinctRelayNodes(sourceId?: string): Promise<DbDistinctRelayNode[]> {
    const longName = this.col('longName');
    const shortName = this.col('shortName');
    const nodeNum = this.col('nodeNum');

    try {
      const conditions: any[] = [sql`relay_node IS NOT NULL`];
      if (sourceId !== undefined) conditions.push(sql`${sql.identifier('sourceId')} = ${sourceId}`);
      const whereClause = this.combineConditions(conditions);
      const distinctRows = await this.executeQuery(sql`SELECT DISTINCT relay_node FROM packet_log WHERE ${whereClause}`);
      const relayValues = (distinctRows as any[]).map((r: any) => Number(r.relay_node));

      const results: DbDistinctRelayNode[] = [];
      const hopsAway = this.col('hopsAway');
      for (const rv of relayValues) {
        // Only include nodes that could plausibly be relays:
        // direct neighbors (hopsAway <= 1) or unknown hop distance (NULL)
        const matchRows = await this.executeQuery(
          sql`SELECT ${longName}, ${shortName} FROM nodes WHERE (${nodeNum} & 255) = ${rv} AND (${hopsAway} IS NULL OR ${hopsAway} <= 1)`
        );
        results.push({
          relay_node: rv,
          matching_nodes: (matchRows as any[]).map((r: any) => ({
            longName: r.longName ?? null,
            shortName: r.shortName ?? null,
          })),
        });
      }
      return results;
    } catch (error) {
      logger.error('[MiscRepository] Failed to get distinct relay nodes:', error);
      return [];
    }
  }

  /**
   * Update packet log entry with decryption results (for retroactive decryption)
   */
  async updatePacketLogDecryption(
    id: number,
    decryptedBy: 'server' | 'node',
    decryptedChannelId: number | null,
    portnum: number,
    metadata: string
  ): Promise<void> {
    if (this.isSQLite()) {
      // SQLite uses 0 for false
      await this.executeRun(sql`
        UPDATE packet_log
        SET decrypted_by = ${decryptedBy},
            decrypted_channel_id = ${decryptedChannelId},
            portnum = ${portnum},
            encrypted = 0,
            metadata = ${metadata}
        WHERE id = ${id}
      `);
    } else {
      await this.executeRun(sql`
        UPDATE packet_log
        SET decrypted_by = ${decryptedBy},
            decrypted_channel_id = ${decryptedChannelId},
            portnum = ${portnum},
            encrypted = false,
            metadata = ${metadata}
        WHERE id = ${id}
      `);
    }
  }

  /**
   * Get packet counts grouped by from_node (for distribution charts).
   * Returns top N nodes by packet count.
   */
  async getPacketCountsByNode(options?: { since?: number; limit?: number; portnum?: number; sourceId?: string }): Promise<DbPacketCountByNode[]> {
    const { since, limit = 10, portnum, sourceId } = options || {};

    try {
      const conditions: any[] = [];
      if (sourceId !== undefined) conditions.push(sql`pl.${sql.identifier('sourceId')} = ${sourceId}`);
      if (since !== undefined) conditions.push(sql`pl.timestamp >= ${since}`);
      if (portnum !== undefined) conditions.push(sql`pl.portnum = ${portnum}`);
      const whereClause = conditions.length > 0 ? this.combineConditions(conditions) : sql`1=1`;

      const longName = this.col('longName');
      const nodeNum = this.col('nodeNum');

      const query = sql`
        SELECT pl.from_node, pl.from_node_id, n.${longName} as from_node_longName, COUNT(*) as count
        FROM packet_log pl
        LEFT JOIN nodes n ON pl.from_node = n.${nodeNum}
        WHERE ${whereClause}
        GROUP BY pl.from_node, pl.from_node_id, n.${longName}
        ORDER BY count DESC
        LIMIT ${limit}
      `;

      const rows = await this.executeQuery(query);
      return (rows as any[]).map((row: any) => ({
        from_node: Number(row.from_node),
        from_node_id: row.from_node_id,
        from_node_longName: row.from_node_longName ?? row.from_node_longname ?? null,
        count: Number(row.count),
      }));
    } catch (error) {
      logger.error('[MiscRepository] Failed to get packet counts by node:', error);
      return [];
    }
  }

  /**
   * Get packet counts grouped by portnum (for distribution charts).
   * Includes port name from meshtastic constants.
   */
  async getPacketCountsByPortnum(options?: { since?: number; from_node?: number; sourceId?: string }): Promise<DbPacketCountByPortnum[]> {
    const { since, from_node, sourceId } = options || {};

    try {
      const conditions: any[] = [];
      if (sourceId !== undefined) conditions.push(sql`${sql.identifier('sourceId')} = ${sourceId}`);
      if (since !== undefined) conditions.push(sql`timestamp >= ${since}`);
      if (from_node !== undefined) conditions.push(sql`from_node = ${from_node}`);
      const whereClause = conditions.length > 0 ? this.combineConditions(conditions) : sql`1=1`;

      const rows = await this.executeQuery(sql`
        SELECT portnum, COUNT(*) as count
        FROM packet_log
        WHERE ${whereClause}
        GROUP BY portnum
        ORDER BY count DESC
      `);

      return (rows as any[]).map((row: any) => ({
        portnum: Number(row.portnum),
        portnum_name: getPortNumName(Number(row.portnum)),
        count: Number(row.count),
      }));
    } catch (error) {
      logger.error('[MiscRepository] Failed to get packet counts by portnum:', error);
      return [];
    }
  }

  // ============ USER MAP PREFERENCES ============

  /**
   * Get map preferences for a user
   */
  async getMapPreferences(userId: number): Promise<Record<string, any> | null> {
    try {
      const userIdCol = this.dbType === 'postgres' ? '"userId"' : 'userId';
      const rows = await this.executeQuery(
        sql.raw(`SELECT * FROM user_map_preferences WHERE ${userIdCol} = ${userId} LIMIT 1`)
      );

      if (rows.length === 0) return null;
      const row = rows[0] as any;

      return {
        mapTileset: row.map_tileset ?? row.mapTileset ?? null,
        showPaths: Boolean(row.show_paths ?? row.showPaths ?? false),
        showNeighborInfo: Boolean(row.show_neighbor_info ?? row.showNeighborInfo ?? false),
        showRoute: Boolean(row.show_route ?? row.showRoute ?? true),
        showMotion: Boolean(row.show_motion ?? row.showMotion ?? true),
        showMqttNodes: Boolean(row.show_mqtt_nodes ?? row.showMqttNodes ?? true),
        showMeshCoreNodes: Boolean(row.show_meshcore_nodes ?? row.showMeshCoreNodes ?? true),
        showAnimations: Boolean(row.show_animations ?? row.showAnimations ?? false),
        showAccuracyRegions: Boolean(row.show_accuracy_regions ?? row.showAccuracyRegions ?? false),
        showEstimatedPositions: Boolean(row.show_estimated_positions ?? row.showEstimatedPositions ?? false),
        positionHistoryHours: row.position_history_hours ?? row.positionHistoryHours ?? null,
      };
    } catch (error) {
      logger.error('[MiscRepository] Failed to get map preferences:', error);
      return null;
    }
  }

  /**
   * Save map preferences for a user (upsert).
   * Uses raw SQL via Drizzle's sql template to avoid referencing columns that
   * may not exist across all upgrade paths (the schema varies by migration state).
   */
  async saveMapPreferences(userId: number, preferences: {
    mapTileset?: string;
    showPaths?: boolean;
    showNeighborInfo?: boolean;
    showRoute?: boolean;
    showMotion?: boolean;
    showMqttNodes?: boolean;
    showMeshCoreNodes?: boolean;
    showAnimations?: boolean;
    showAccuracyRegions?: boolean;
    showEstimatedPositions?: boolean;
    positionHistoryHours?: number | null;
  }): Promise<void> {
    try {
      // Use the userId column name based on database type
      // SQLite baseline uses userId (camelCase), PG/MySQL also use userId
      const userIdCol = this.dbType === 'postgres' ? '"userId"' : 'userId';

      // Check if preferences exist
      const existing = await this.executeQuery(
        sql.raw(`SELECT id FROM user_map_preferences WHERE ${userIdCol} = ${userId} LIMIT 1`)
      );
      const hasExisting = existing.length > 0;

      if (hasExisting) {
        // Build dynamic UPDATE — only set columns that were provided
        // PG uses boolean type (true/false), SQLite/MySQL use integer (1/0)
        const bv = (v: boolean) => this.dbType === 'postgres' ? String(v) : (v ? '1' : '0');
        const sets: string[] = [];
        if (preferences.mapTileset !== undefined) sets.push(`map_tileset = '${preferences.mapTileset.replace(/'/g, "''")}'`);
        if (preferences.showPaths !== undefined) sets.push(`show_paths = ${bv(preferences.showPaths)}`);
        if (preferences.showNeighborInfo !== undefined) sets.push(`show_neighbor_info = ${bv(preferences.showNeighborInfo)}`);
        if (preferences.showRoute !== undefined) sets.push(`show_route = ${bv(preferences.showRoute)}`);
        if (preferences.showMotion !== undefined) sets.push(`show_motion = ${bv(preferences.showMotion)}`);
        if (preferences.showMqttNodes !== undefined) sets.push(`show_mqtt_nodes = ${bv(preferences.showMqttNodes)}`);
        if (preferences.showMeshCoreNodes !== undefined) sets.push(`show_meshcore_nodes = ${bv(preferences.showMeshCoreNodes)}`);
        if (preferences.showAnimations !== undefined) sets.push(`show_animations = ${bv(preferences.showAnimations)}`);
        if (preferences.showAccuracyRegions !== undefined) sets.push(`show_accuracy_regions = ${bv(preferences.showAccuracyRegions)}`);
        if (preferences.showEstimatedPositions !== undefined) sets.push(`show_estimated_positions = ${bv(preferences.showEstimatedPositions)}`);
        if (preferences.positionHistoryHours !== undefined) sets.push(`position_history_hours = ${preferences.positionHistoryHours ?? 'NULL'}`);

        if (sets.length > 0) {
          await this.executeRun(
            sql.raw(`UPDATE user_map_preferences SET ${sets.join(', ')} WHERE ${userIdCol} = ${userId}`)
          );
        }
      } else {
        // INSERT — reference feature columns + createdAt/updatedAt (NOT NULL in all baselines)
        // Quote createdAt/updatedAt for Postgres (case-sensitive identifiers)
        // PG uses boolean type (true/false), SQLite/MySQL use integer (1/0)
        const boolVal = (v: boolean | undefined, def: boolean) => {
          const val = v !== undefined ? v : def;
          return this.dbType === 'postgres' ? String(val) : (val ? '1' : '0');
        };
        const now = Date.now();
        const q = this.dbType === 'postgres' ? '"' : '';
        await this.executeRun(
          sql.raw(`INSERT INTO user_map_preferences (
            ${userIdCol}, map_tileset, show_paths, show_neighbor_info, show_route, show_motion,
            show_mqtt_nodes, show_meshcore_nodes, show_animations, show_accuracy_regions,
            show_estimated_positions, position_history_hours, ${q}createdAt${q}, ${q}updatedAt${q}
          ) VALUES (
            ${userId}, ${preferences.mapTileset ? `'${preferences.mapTileset.replace(/'/g, "''")}'` : 'NULL'},
            ${boolVal(preferences.showPaths, false)}, ${boolVal(preferences.showNeighborInfo, false)},
            ${boolVal(preferences.showRoute, true)}, ${boolVal(preferences.showMotion, true)},
            ${boolVal(preferences.showMqttNodes, true)}, ${boolVal(preferences.showMeshCoreNodes, true)},
            ${boolVal(preferences.showAnimations, false)}, ${boolVal(preferences.showAccuracyRegions, false)},
            ${boolVal(preferences.showEstimatedPositions, true)}, ${preferences.positionHistoryHours ?? 'NULL'},
            ${now}, ${now}
          )`)
        );
      }
    } catch (error) {
      logger.error('[MiscRepository] Failed to save map preferences:', error);
      throw error;
    }
  }
}

/**
 * Filter options for packet log queries
 */
export interface PacketLogFilterOptions {
  portnum?: number;
  from_node?: number;
  to_node?: number;
  channel?: number;
  encrypted?: boolean;
  since?: number;
  relay_node?: number | 'unknown';
  sourceId?: string;
}
