/**
 * MapPreferences Repository
 *
 * Handles user map preferences database operations.
 * Supports SQLite, PostgreSQL, and MySQL through Drizzle ORM.
 */
import { eq } from 'drizzle-orm';
import { BaseRepository, DrizzleDatabase } from './base.js';
import { DatabaseType } from '../types.js';
import { logger } from '../../utils/logger.js';

export class MapPreferencesRepository extends BaseRepository {
  constructor(db: DrizzleDatabase, dbType: DatabaseType) {
    super(db, dbType);
  }

  // ============ USER MAP PREFERENCES ============

  /**
   * Get map preferences for a user
   */
  async getMapPreferences(userId: number): Promise<Record<string, any> | null> {
    try {
      const table = this.tables.userMapPreferences;
      const rows = await this.db
        .select()
        .from(table)
        .where(eq(table.userId, userId))
        .limit(1);

      if (rows.length === 0) return null;
      const row = rows[0] as any;

      return {
        mapTileset: row.mapTileset ?? null,
        mapTilesetLight: row.mapTilesetLight ?? null,
        mapTilesetDark: row.mapTilesetDark ?? null,
        showPaths: row.showPaths ?? false,
        showNeighborInfo: row.showNeighborInfo ?? false,
        showRoute: row.showRoute ?? true,
        showMotion: row.showMotion ?? true,
        showMqttNodes: row.showMqttNodes ?? true,
        showUdpNodes: row.showUdpNodes ?? false,
        showRfNodes: row.showRfNodes ?? true,
        showMeshCoreNodes: row.showMeshcoreNodes ?? true,
        showWaypoints: row.showWaypoints ?? true,
        showAnimations: row.showAnimations ?? false,
        showAccuracyRegions: row.showAccuracyRegions ?? false,
        showEstimatedPositions: row.showEstimatedPositions ?? false,
        positionHistoryHours: row.positionHistoryHours ?? null,
        mapMaxAgeHours: row.mapMaxAgeHours ?? null,
        positionHistoryPointsOnly: row.positionHistoryPointsOnly ?? false,
      };
    } catch (error) {
      logger.error('[MapPreferencesRepository] Failed to get map preferences:', error);
      return null;
    }
  }

  /**
   * Save map preferences for a user (upsert).
   */
  async saveMapPreferences(userId: number, preferences: {
    mapTileset?: string | null;
    mapTilesetLight?: string | null;
    mapTilesetDark?: string | null;
    showPaths?: boolean;
    showNeighborInfo?: boolean;
    showRoute?: boolean;
    showMotion?: boolean;
    showMqttNodes?: boolean;
    showUdpNodes?: boolean;
    showRfNodes?: boolean;
    showMeshCoreNodes?: boolean;
    showWaypoints?: boolean;
    showAnimations?: boolean;
    showAccuracyRegions?: boolean;
    showEstimatedPositions?: boolean;
    positionHistoryHours?: number | null;
    mapMaxAgeHours?: number | null;
    positionHistoryPointsOnly?: boolean;
  }): Promise<void> {
    try {
      const table = this.tables.userMapPreferences;
      const existing = await this.db
        .select({ id: table.id })
        .from(table)
        .where(eq(table.userId, userId))
        .limit(1);

      if (existing.length > 0) {
        const set: Record<string, any> = {};
        if (preferences.mapTileset !== undefined) set.mapTileset = preferences.mapTileset;
        if (preferences.mapTilesetLight !== undefined) set.mapTilesetLight = preferences.mapTilesetLight;
        if (preferences.mapTilesetDark !== undefined) set.mapTilesetDark = preferences.mapTilesetDark;
        if (preferences.showPaths !== undefined) set.showPaths = preferences.showPaths;
        if (preferences.showNeighborInfo !== undefined) set.showNeighborInfo = preferences.showNeighborInfo;
        if (preferences.showRoute !== undefined) set.showRoute = preferences.showRoute;
        if (preferences.showMotion !== undefined) set.showMotion = preferences.showMotion;
        if (preferences.showMqttNodes !== undefined) set.showMqttNodes = preferences.showMqttNodes;
        if (preferences.showUdpNodes !== undefined) set.showUdpNodes = preferences.showUdpNodes;
        if (preferences.showRfNodes !== undefined) set.showRfNodes = preferences.showRfNodes;
        if (preferences.showMeshCoreNodes !== undefined) set.showMeshcoreNodes = preferences.showMeshCoreNodes;
        if (preferences.showWaypoints !== undefined) set.showWaypoints = preferences.showWaypoints;
        if (preferences.showAnimations !== undefined) set.showAnimations = preferences.showAnimations;
        if (preferences.showAccuracyRegions !== undefined) set.showAccuracyRegions = preferences.showAccuracyRegions;
        if (preferences.showEstimatedPositions !== undefined) set.showEstimatedPositions = preferences.showEstimatedPositions;
        if (preferences.positionHistoryHours !== undefined) set.positionHistoryHours = preferences.positionHistoryHours;
        if (preferences.mapMaxAgeHours !== undefined) set.mapMaxAgeHours = preferences.mapMaxAgeHours;
        if (preferences.positionHistoryPointsOnly !== undefined) set.positionHistoryPointsOnly = preferences.positionHistoryPointsOnly;

        if (Object.keys(set).length > 0) {
          await this.db.update(table).set(set).where(eq(table.userId, userId));
        }
      } else {
        const now = Date.now();
        await this.db.insert(table).values({
          userId,
          mapTileset: preferences.mapTileset ?? null,
          mapTilesetLight: preferences.mapTilesetLight ?? null,
          mapTilesetDark: preferences.mapTilesetDark ?? null,
          showPaths: preferences.showPaths ?? false,
          showNeighborInfo: preferences.showNeighborInfo ?? false,
          showRoute: preferences.showRoute ?? true,
          showMotion: preferences.showMotion ?? true,
          showMqttNodes: preferences.showMqttNodes ?? false,
          showUdpNodes: preferences.showUdpNodes ?? false,
          showRfNodes: preferences.showRfNodes ?? true,
          showMeshcoreNodes: preferences.showMeshCoreNodes ?? true,
          showWaypoints: preferences.showWaypoints ?? true,
          showAnimations: preferences.showAnimations ?? false,
          showAccuracyRegions: preferences.showAccuracyRegions ?? false,
          showEstimatedPositions: preferences.showEstimatedPositions ?? true,
          positionHistoryHours: preferences.positionHistoryHours ?? null,
          mapMaxAgeHours: preferences.mapMaxAgeHours ?? null,
          positionHistoryPointsOnly: preferences.positionHistoryPointsOnly ?? false,
          createdAt: now,
          updatedAt: now,
        });
      }
    } catch (error) {
      logger.error('[MapPreferencesRepository] Failed to save map preferences:', error);
      throw error;
    }
  }
}
