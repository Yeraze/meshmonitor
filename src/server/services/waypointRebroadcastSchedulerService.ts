/**
 * Waypoint Rebroadcast Scheduler
 *
 * Runs every 60 seconds and asks `waypointService.rebroadcastTick()` to pick
 * AT MOST one eligible waypoint and re-broadcast it. The hard 60s floor is
 * enforced here so the airtime budget cannot be exceeded regardless of how
 * many waypoints are configured or how short their individual
 * `rebroadcastIntervalS` values are.
 *
 * Mirrors the start/stop pattern used by the other periodic services
 * (databaseMaintenanceService, duplicateKeySchedulerService, …) so process
 * shutdown / service lifecycle behaves consistently across the server.
 */
import { logger } from '../../utils/logger.js';
import { waypointService } from './waypointService.js';

/** Hard interval — do NOT weaken. The 60s floor is the airtime guarantee. */
const TICK_INTERVAL_MS = 60_000;

class WaypointRebroadcastSchedulerService {
  private intervalId: NodeJS.Timeout | null = null;
  private inFlight = false;

  start(): void {
    if (this.intervalId) {
      logger.warn('[waypointRebroadcastScheduler] already running');
      return;
    }

    this.intervalId = setInterval(() => {
      this.runTick().catch((err) => {
        logger.error('[waypointRebroadcastScheduler] tick failed:', err);
      });
    }, TICK_INTERVAL_MS);

    logger.info('▶️ Waypoint rebroadcast scheduler started (60s tick)');
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      logger.info('⏹️ Waypoint rebroadcast scheduler stopped');
    }
  }

  /**
   * Single tick. Guarded with an in-flight flag so a slow broadcast cannot
   * stack ticks if a previous one hasn't returned yet.
   */
  async runTick(): Promise<void> {
    if (this.inFlight) {
      logger.debug('[waypointRebroadcastScheduler] previous tick still running, skipping');
      return;
    }
    this.inFlight = true;
    try {
      await waypointService.rebroadcastTick();
    } finally {
      this.inFlight = false;
    }
  }

  isRunning(): boolean {
    return this.intervalId !== null;
  }
}

export const waypointRebroadcastSchedulerService = new WaypointRebroadcastSchedulerService();
export { WaypointRebroadcastSchedulerService };
