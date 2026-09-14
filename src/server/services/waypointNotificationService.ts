/**
 * Waypoint arrival notifications (#4750).
 *
 * Alerts a user when a waypoint arrives from the mesh inside a radius they
 * care about. Three rules shape the whole thing:
 *
 * 1. **Only waypoints that arrive FROM the mesh.** This is called from
 *    `waypointService.handleIncoming` and nowhere else. Waypoints the user
 *    places themselves, edits, or that our own rebroadcast scheduler refreshes
 *    all go through other paths, and telling somebody about a pin they just
 *    dropped is noise. (It also keeps our own sends from re-entering as
 *    notifications — the self-origin problem the automation engine hit in
 *    #3914.)
 *
 * 2. **A radius, measured per user.** Each user has their own centre and
 *    radius, so the filter runs per user rather than once for the broadcast.
 *    The centre is the user's explicit lat/lon when set, else the source's own
 *    node position. When neither exists the user is SKIPPED — failing open
 *    here would alert on every waypoint anywhere on the mesh, which is the one
 *    outcome the radius exists to prevent.
 *
 * 3. **Dedupe on waypoint id, persisted.** Waypoints rebroadcast on a
 *    schedule, so without a record every rebroadcast is another alert. The
 *    record keys on the id alone: waypoints do not move, and a "moved"
 *    waypoint is a new one with a fresh id that SHOULD alert again. See
 *    `waypointNotifications` repository for why it is a table and not a Map.
 *
 * Airtime cost: zero. Nothing here transmits — it reacts to a packet already
 * received.
 */
import { logger } from '../../utils/logger.js';
import databaseService from '../../services/database.js';
import { calculateDistance } from '../../utils/distance.js';
import { notificationService } from './notificationService.js';
import { sourceManagerRegistry } from '../sourceManagerRegistry.js';

/** The waypoint fields this service needs. */
export interface NotifiableWaypoint {
  waypointId: number;
  latitude: number;
  longitude: number;
  name: string;
  description: string;
  iconEmoji?: string | null;
}

/** Matches the migration's column default. */
const DEFAULT_RADIUS_KM = 10;

/** One user's resolved waypoint-alert settings, merged across their rows. */
interface ResolvedUserSettings {
  userId: number;
  radiusKm: number;
  centerLat: number | null;
  centerLon: number | null;
}

/**
 * Merge a user's preference rows into one setting set for `sourceId`.
 *
 * Mirrors §1 Rule A of the #4020 split-row design used by the inactive-node and
 * low-battery services: eligibility is "any row true", and a per-source value
 * comes from the exact-source row, else the legacy '' row, else the first row.
 */
export function resolveUserSettings(
  rows: Array<{
    userId: number;
    sourceId: string;
    notifyOnWaypoint: boolean;
    waypointRadiusKm: number | null;
    waypointCenterLat: number | null;
    waypointCenterLon: number | null;
  }>,
  sourceId: string,
): ResolvedUserSettings[] {
  const byUser = new Map<number, typeof rows>();
  for (const row of rows) {
    const list = byUser.get(row.userId);
    if (list) list.push(row);
    else byUser.set(row.userId, [row]);
  }

  const resolved: ResolvedUserSettings[] = [];
  for (const [userId, userRows] of byUser) {
    if (!userRows.some((r) => r.notifyOnWaypoint)) continue;
    const preferred =
      userRows.find((r) => r.sourceId === sourceId) ??
      userRows.find((r) => r.sourceId === '') ??
      userRows[0];

    const radiusKm =
      preferred.waypointRadiusKm != null && preferred.waypointRadiusKm > 0
        ? preferred.waypointRadiusKm
        : DEFAULT_RADIUS_KM;

    // A half-set centre is not usable; treat it as unset and fall through to
    // the source's own node.
    const hasCenter = preferred.waypointCenterLat != null && preferred.waypointCenterLon != null;

    resolved.push({
      userId,
      radiusKm,
      centerLat: hasCenter ? preferred.waypointCenterLat : null,
      centerLon: hasCenter ? preferred.waypointCenterLon : null,
    });
  }
  return resolved;
}

class WaypointNotificationService {
  /**
   * The source's own node position, or null when it has none.
   *
   * Read fresh per waypoint rather than cached: on a mobile node this is the
   * whole point of defaulting to it, and waypoints arrive rarely enough that a
   * single indexed row read costs nothing.
   */
  private async getSourceNodePosition(
    sourceId: string,
  ): Promise<{ latitude: number; longitude: number } | null> {
    try {
      const manager = sourceManagerRegistry.getManager(sourceId);
      const localNode = manager?.getLocalNodeInfo();
      if (!localNode?.nodeNum) return null;
      const node = await databaseService.nodes.getNode(Number(localNode.nodeNum), sourceId);
      if (node?.latitude == null || node?.longitude == null) return null;
      return { latitude: Number(node.latitude), longitude: Number(node.longitude) };
    } catch (error) {
      logger.debug(`[waypointNotification] Could not resolve node position for ${sourceId}:`, error);
      return null;
    }
  }

  /** The source's display name, falling back to its id. */
  private async resolveSourceName(sourceId: string): Promise<string> {
    try {
      const source = await databaseService.sources.getSource(sourceId);
      return source?.name || sourceId;
    } catch {
      return sourceId;
    }
  }

  /**
   * Alert every eligible user for whom this waypoint is in range and new.
   *
   * Never throws: a notification failure must not break waypoint ingest, which
   * is the caller's actual job.
   */
  async notifyIfInRange(waypoint: NotifiableWaypoint, sourceId: string): Promise<void> {
    try {
      const rows = await databaseService.notifications.getUsersWithWaypointNotifications();
      const users = resolveUserSettings(rows, sourceId);
      // The overwhelmingly common case — nobody has opted in — costs one
      // indexed read and stops here, before any position or name lookup.
      if (users.length === 0) return;

      // Only looked up when somebody actually needs it.
      const needsNodePosition = users.some((u) => u.centerLat == null);
      const nodePosition = needsNodePosition ? await this.getSourceNodePosition(sourceId) : null;

      const inRange: ResolvedUserSettings[] = [];
      for (const user of users) {
        const lat = user.centerLat ?? nodePosition?.latitude;
        const lon = user.centerLon ?? nodePosition?.longitude;
        if (lat == null || lon == null) {
          // No reference point: skip rather than alert. See rule 2 above.
          continue;
        }
        const distanceKm = calculateDistance(lat, lon, waypoint.latitude, waypoint.longitude);
        if (distanceKm <= user.radiusKm) inRange.push(user);
      }
      if (inRange.length === 0) return;

      const alreadyNotified = await databaseService.waypointNotifications.getNotifiedUserIdsAsync(
        sourceId,
        waypoint.waypointId,
        inRange.map((u) => u.userId),
      );
      const targets = inRange.filter((u) => !alreadyNotified.has(u.userId));
      if (targets.length === 0) return;

      const sourceName = await this.resolveSourceName(sourceId);
      const icon = waypoint.iconEmoji || '📍';
      const label = waypoint.name || `Waypoint ${waypoint.waypointId}`;
      const payload = {
        title: `[${sourceName}] ${icon} ${label}`,
        body: waypoint.description
          ? `[${sourceName}] ${waypoint.description}`
          : `[${sourceName}] Waypoint received at ${waypoint.latitude.toFixed(5)}, ${waypoint.longitude.toFixed(5)}`,
        type: 'info' as const,
        sourceId,
        sourceName,
      };

      for (const user of targets) {
        // Per-user rather than one broadcast: the radius already picked who is
        // eligible, so the fan-out must not re-broaden to everyone with the flag.
        await notificationService.broadcastToPreferenceUsers('notifyOnWaypoint', payload, user.userId);
        // Recorded AFTER the send, so a crash mid-send re-alerts rather than
        // silently swallowing the only notification for this waypoint.
        await databaseService.waypointNotifications.markNotifiedAsync(
          user.userId,
          sourceId,
          waypoint.waypointId,
        );
      }

      logger.info(
        `📤 Sent waypoint notification for ${label} (${waypoint.waypointId}) on ${sourceId} to ${targets.length} user(s)`,
      );
    } catch (error) {
      logger.error('❌ Error sending waypoint notification:', error);
    }
  }

  /**
   * Forget a waypoint, so a recycled id can alert again.
   *
   * Never throws. Its callers are the delete and expire paths, whose actual job
   * is removing the waypoint; a failure to tidy the alert ledger must not turn
   * a successful delete into an error.
   */
  async forgetWaypoint(sourceId: string, waypointId: number): Promise<void> {
    try {
      await databaseService.waypointNotifications.clearForWaypointAsync(sourceId, waypointId);
    } catch (error) {
      logger.error(`[waypointNotification] Failed to forget waypoint ${waypointId}:`, error);
    }
  }
}

export const waypointNotificationService = new WaypointNotificationService();
