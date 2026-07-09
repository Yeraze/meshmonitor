import { logger } from '../../utils/logger.js';
import databaseService from '../../services/database.js';
import type { HourlyLogLimiter } from './hourlyLogLimiter.js';
import type { NotificationPreferences } from './notificationFiltering.js';

/**
 * Helpers shared by the targeted alert check services (low-battery and
 * inactive-node), which both merge a user's per-(userId, sourceId)
 * preference rows per §1 Rule A of the #4020 design. Extracted so a future
 * behaviour change can't silently apply to one service and not the other.
 */

/**
 * Parse and dedup-union the monitoredNodes JSON across all of a user's
 * preference rows. A malformed row is logged and contributes nothing
 * (rather than aborting the whole union), matching the per-row parse
 * failure handling this replaces.
 */
export function parseMonitoredUnion(
  userId: number,
  rows: Array<{ sourceId: string; monitoredNodes: string | null }>
): string[] {
  const union = new Set<string>();
  for (const row of rows) {
    if (!row.monitoredNodes) continue;
    try {
      const parsed = JSON.parse(row.monitoredNodes);
      if (Array.isArray(parsed)) {
        for (const id of parsed) union.add(id);
      }
    } catch (error) {
      logger.warn(`Failed to parse monitored_nodes for user ${userId} (source ${row.sourceId || "''"}):`, error);
    }
  }
  return Array.from(union);
}

/** Count entries in a monitoredNodes JSON column without exposing contents. */
export function countMonitoredNodes(monitoredNodes: string | null): number {
  if (!monitoredNodes) return 0;
  try {
    const parsed = JSON.parse(monitoredNodes);
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

/** Shorten a source UUID for compact diagnostic lines. */
export function truncateSourceId(sourceId: string): string {
  return sourceId.length > 8 ? `${sourceId.substring(0, 8)}…` : sourceId;
}

/** Diagnostic display form of a row's sourceId ('' shown as two quotes). */
export function formatSourceIdForLog(sourceId: string): string {
  return sourceId === '' ? "''" : truncateSourceId(sourceId);
}

/**
 * When a check cycle finds no eligible users, dump every known user's full
 * preference-row set (counts only — never URL or node-ID contents) so an
 * operator can see WHY — e.g. the flag is on one row but the channel/URLs
 * are on another (the exact #4020 failure mode). `formatRow` supplies the
 * service-specific fields (flag names, thresholds); rate limiting is per
 * user via the caller's HourlyLogLimiter.
 */
export async function logZeroEligiblePrefRows(
  hourlyLog: HourlyLogLimiter,
  logPrefix: string,
  formatRow: (sourceId: string, prefs: NotificationPreferences) => string
): Promise<void> {
  const userIds = await databaseService.notifications.getAllPreferenceUserIds();
  for (const userId of userIds) {
    const rows = await databaseService.notifications.getUserPreferenceRows(userId);
    if (rows.length === 0) continue;
    const dump = rows.map(({ sourceId, prefs }) => formatRow(sourceId, prefs)).join(' ');
    hourlyLog.log(`no-users:${userId}`, 'info', `${logPrefix} user=${userId} rows: ${dump}`);
  }
}
