import { logger } from '../../utils/logger.js';
import databaseService from '../../services/database.js';
import { calculateDistance } from '../../utils/distance.js';

interface DeletedNodeInfo {
  nodeId: string;
  nodeName: string;
  distanceKm: number;
}

class AutoDeleteByDistanceService {
  private checkInterval: NodeJS.Timeout | null = null;
  private lastRunAt: number | null = null;
  private isRunning = false;

  /**
   * Start the auto-delete-by-distance service
   */
  public start(intervalHours: number): void {
    this.stop();

    logger.info(`🗑️ Starting auto-delete-by-distance service (interval: ${intervalHours} hours)`);

    // Run initial check after 2 minutes
    setTimeout(() => {
      this.runDeleteCycle();
    }, 120_000);

    this.checkInterval = setInterval(() => {
      this.runDeleteCycle();
    }, intervalHours * 60 * 60 * 1000);
  }

  /**
   * Stop the service (does not abort in-progress runs)
   */
  public stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
      logger.info('⏹️ Auto-delete-by-distance service stopped');
    }
  }

  /**
   * Run now (manual trigger from API)
   */
  public async runNow(sourceId?: string): Promise<{ deletedCount: number }> {
    return this.runDeleteCycle(sourceId);
  }

  /**
   * Get service status
   */
  public getStatus(): { running: boolean; lastRunAt?: number } {
    return {
      running: this.checkInterval !== null,
      lastRunAt: this.lastRunAt ?? undefined,
    };
  }

  /**
   * Core deletion logic
   */
  private async runDeleteCycle(sourceId?: string): Promise<{ deletedCount: number }> {
    if (this.isRunning) {
      logger.debug('⏭️ Auto-delete-by-distance: skipping, already running');
      return { deletedCount: 0 };
    }

    this.isRunning = true;
    const deletedNodes: DeletedNodeInfo[] = [];

    try {
      // Read settings
      const homeLat = parseFloat(await databaseService.settings.getSetting('autoDeleteByDistanceLat') || '');
      const homeLon = parseFloat(await databaseService.settings.getSetting('autoDeleteByDistanceLon') || '');
      const thresholdKm = parseFloat(await databaseService.settings.getSetting('autoDeleteByDistanceThresholdKm') || '100');

      if (isNaN(homeLat) || isNaN(homeLon)) {
        logger.debug('⏭️ Auto-delete-by-distance: no home coordinate configured, skipping');
        return { deletedCount: 0 };
      }

      // Get local node number to protect it
      const localNodeNumStr = await databaseService.settings.getSetting('localNodeNum');
      const localNodeNum = localNodeNumStr ? Number(localNodeNumStr) : null;

      // Get all nodes (must use async for PostgreSQL/MySQL)
      // If sourceId provided, scope to that source; otherwise scan all sources
      const allNodes = await databaseService.nodes.getAllNodes(sourceId);

      for (const node of allNodes) {
        // Protect local node
        if (localNodeNum != null && Number(node.nodeNum) === localNodeNum) {
          continue;
        }

        // Protect favorited nodes
        if (node.isFavorite) {
          continue;
        }

        // Skip nodes without position
        if (node.latitude == null || node.longitude == null) {
          continue;
        }

        // Calculate distance
        const distance = calculateDistance(homeLat, homeLon, node.latitude, node.longitude);

        if (distance > thresholdKm) {
          try {
            await databaseService.deleteNodeAsync(Number(node.nodeNum));
            deletedNodes.push({
              nodeId: node.nodeId || `!${Number(node.nodeNum).toString(16)}`,
              nodeName: node.longName || node.shortName || `Node ${node.nodeNum}`,
              distanceKm: Math.round(distance * 10) / 10,
            });
          } catch (error) {
            logger.error(`❌ Auto-delete-by-distance: failed to delete node ${node.nodeNum}:`, error);
          }
        }
      }

      // Log results
      const now = Date.now();
      this.lastRunAt = now;

      await this.logRunAsync(now, deletedNodes.length, thresholdKm, deletedNodes);

      if (deletedNodes.length > 0) {
        logger.info(`🗑️ Auto-delete-by-distance: deleted ${deletedNodes.length} node(s) beyond ${thresholdKm} km`);
      } else {
        logger.debug('✅ Auto-delete-by-distance: no nodes beyond threshold');
      }

      return { deletedCount: deletedNodes.length };
    } catch (error) {
      logger.error('❌ Auto-delete-by-distance: error during run:', error);
      return { deletedCount: 0 };
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Log a run to the auto_distance_delete_log table via DatabaseService
   */
  private async logRunAsync(
    timestamp: number,
    nodesDeleted: number,
    thresholdKm: number,
    details: DeletedNodeInfo[]
  ): Promise<void> {
    try {
      await databaseService.misc.addDistanceDeleteLogEntry({
        timestamp,
        nodesDeleted,
        thresholdKm,
        details: JSON.stringify(details),
      });
    } catch (error) {
      logger.error('❌ Auto-delete-by-distance: failed to log run:', error);
    }
  }
}

export const autoDeleteByDistanceService = new AutoDeleteByDistanceService();
