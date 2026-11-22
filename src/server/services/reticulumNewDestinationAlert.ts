/**
 * New-destination alerts for Reticulum sources (#6341 P3).
 *
 * Adapter over the shared `NewNodeAlertTracker` and persisted `newNodeAlertGate`
 * (48 h learning window, 10 alerts/h/source). It only decides what counts as an
 * alertable Reticulum destination and how to name it.
 *
 * Mesh impact: sends nothing over the air and arms no timer.
 */
import { logger } from '../../utils/logger.js';
import databaseService from '../../services/database.js';
import { sanitizeReticulumName, shortReticulumHash } from '../../utils/reticulumName.js';
import { isOwnReticulumAddress } from '../utils/ownNodes.js';
import { notificationService } from './notificationService.js';
import type { NewNodeAlertTracker } from './newNodeAlertTracker.js';

/** One alert per person or device: the LXMF `delivery` destination only. */
export function isAlertableReticulumDestination(d: {
  appName: string | null;
  aspects: string | null;
}): boolean {
  if (d.appName !== 'lxmf') return false;
  return (d.aspects ?? '').split('.').includes('delivery');
}

/** Never throws: an alert failure must not break announce handling. */
export async function maybeAlertReticulumNewDestination(
  tracker: NewNodeAlertTracker,
  sourceId: string,
  dest: {
    destinationHash: string;
    appName: string | null;
    aspects: string | null;
    displayName: string | null;
    hops: number | null;
  },
  inserted: boolean,
): Promise<void> {
  try {
    if (!isAlertableReticulumDestination(dest)) return;
    if (isOwnReticulumAddress(dest.destinationHash)) return;
    const hash = dest.destinationHash;
    if (!tracker.claim(hash, inserted)) return;
    try {
      // Always "named": a nameless LXMF peer is normal and never gains a name,
      // so parking it as pending would hide it for good.
      const verdict = await tracker.admitGated(sourceId, hash, true);
      tracker.notified.add(hash);
      if (!verdict.alert) return;
      const source = await databaseService.sources.getSource(sourceId);
      const sourceName = source?.name || sourceId;
      const name = sanitizeReticulumName(dest.displayName) ?? shortReticulumHash(hash);
      await notificationService.notifyNewReticulumDestination(
        hash,
        name,
        dest.hops,
        sourceId,
        sourceName,
        verdict.suppressedCount,
      );
    } finally {
      tracker.release(hash);
    }
  } catch (err) {
    logger.warn(
      `[Reticulum:${sourceId}] new-destination alert failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
