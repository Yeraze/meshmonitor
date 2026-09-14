/**
 * Dedupe ledger for waypoint arrival notifications (#4750).
 *
 * One row per (user, source, waypoint) that has already been alerted on.
 *
 * This exists because waypoints rebroadcast on a schedule. Without a record of
 * what has already been sent, every rebroadcast of the same waypoint is another
 * notification, forever. The record is a table rather than an in-memory Map on
 * purpose: in-memory state forgets everything on restart, and the next
 * rebroadcast sweep would then re-alert every waypoint in range at once. See
 * the "does a save reset a safety timer?" section of CLAUDE.md's mesh impact
 * checklist.
 *
 * The key is the waypoint id alone. Waypoints do not move — a "moved" waypoint
 * is a new one with a fresh id, and should alert again — so there is
 * deliberately no name or position comparison here.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { BaseRepository } from './base.js';
import { logger } from '../../utils/logger.js';

export class WaypointNotificationsRepository extends BaseRepository {
  /**
   * Of `userIds`, those already alerted about this waypoint.
   *
   * Asked once per arriving waypoint rather than once per user, so a mesh with
   * many notification users still costs one query per waypoint.
   */
  async getNotifiedUserIdsAsync(
    sourceId: string,
    waypointId: number,
    userIds: number[],
  ): Promise<Set<number>> {
    if (userIds.length === 0) return new Set();
    try {
      const { waypointNotifications: t } = this.tables;
      const rows = await this.db
        .select({ userId: t.userId })
        .from(t)
        .where(
          and(
            eq(t.sourceId, sourceId),
            eq(t.waypointId, waypointId),
            inArray(t.userId, userIds),
          ),
        );
      return new Set(rows.map((r: { userId: number }) => Number(r.userId)));
    } catch (error) {
      // Fail CLOSED: an unreadable ledger must read as "already notified", not
      // as "notify everyone". A silent gap is better than a notification storm.
      logger.error('[waypointNotifications] Failed to read ledger, suppressing alerts:', error);
      return new Set(userIds);
    }
  }

  /** Record that `userId` has been alerted about this waypoint. */
  async markNotifiedAsync(userId: number, sourceId: string, waypointId: number): Promise<void> {
    try {
      const { waypointNotifications: t } = this.tables;
      // A concurrent insert for the same key is not an error — the existing row
      // already says what we were about to say. `insertIgnore` normalizes the
      // three dialects (MySQL has no ON CONFLICT DO NOTHING).
      await this.insertIgnore(t, { userId, sourceId, waypointId, notifiedAt: Date.now() });
    } catch (error) {
      logger.error(
        `[waypointNotifications] Failed to record notification for user ${userId} waypoint ${waypointId}:`,
        error,
      );
    }
  }

  /**
   * Drop every user's row for one waypoint.
   *
   * Called when a waypoint is deleted or expires. It bounds the table, and it
   * is what lets a recycled waypoint id alert again rather than being
   * permanently silenced by a row about a waypoint that no longer exists.
   */
  async clearForWaypointAsync(sourceId: string, waypointId: number): Promise<void> {
    try {
      const { waypointNotifications: t } = this.tables;
      await this.db
        .delete(t)
        .where(and(eq(t.sourceId, sourceId), eq(t.waypointId, waypointId)));
    } catch (error) {
      logger.error(
        `[waypointNotifications] Failed to clear ledger for waypoint ${waypointId}:`,
        error,
      );
    }
  }
}
