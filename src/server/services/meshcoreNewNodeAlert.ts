/**
 * MeshCore "new node" alert, shared by every source that raises one: the
 * Companion contact flow, the Repeater RAW stream (#6306) and the MQTT feeds
 * (#6341). It sends NOTHING over the air.
 *
 * Imports nothing from `meshcoreManager.ts` (a value import would be a cycle).
 */
import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';
import { sanitizeMeshCoreName } from '../../utils/meshcoreName.js';
import { notificationService } from './notificationService.js';
import { verifyAdvertSignature, type IngestedAdvert } from './meshcoreFrameIngest.js';
import type { NewNodeAlertTracker } from './newNodeAlertTracker.js';

// Human-readable labels for the device types worth surfacing in a
// "new node discovered" notification (UNKNOWN is intentionally omitted so the
// notification simply shows no type rather than "Unknown"). Keys are the
// `MeshCoreDeviceType` values: Companion 1, Repeater 2, Room Server 3.
export const MESHCORE_DEVICE_TYPE_LABELS: Record<number, string> = {
  1: 'Companion',
  2: 'Repeater',
  3: 'Room Server',
};

export interface NewNodeAlertContact {
  publicKey: string;
  name?: string;
  advName?: string;
  advType?: number | null;
}

/**
 * Dedup, the nameless-key deferral, and the notification.
 *
 * `onClaimed` runs once the key is accepted (named, not yet alerted), before the
 * notification is built. Failures are logged, never thrown.
 */
export async function alertMeshCoreNewNode(
  tracker: NewNodeAlertTracker,
  sourceId: string,
  contact: NewNodeAlertContact,
  opts: { suppressedCount?: number; onClaimed?: () => void } = {},
): Promise<void> {
  try {
    const publicKey = contact.publicKey;
    if (!publicKey || tracker.notified.has(publicKey)) return;
    // `||` not `??`: firmware reports a nameless contact as "" (#3756).
    const displayName = contact.advName || contact.name || null;
    if (!displayName) {
      // Defer until a name arrives. The auto-add 0x80 push carries only the
      // pubkey; the follow-up get_contacts re-read (refreshContacts) or a
      // later named advert resolves this via the pending set (#5340).
      tracker.pending.add(publicKey);
      return;
    }
    tracker.pending.delete(publicKey);
    tracker.notified.add(publicKey);
    opts.onClaimed?.();

    const deviceTypeLabel = contact.advType != null
      ? MESHCORE_DEVICE_TYPE_LABELS[contact.advType] ?? undefined
      : undefined;

    let sourceName: string = sourceId;
    try {
      const src = await databaseService.sources.getSource(sourceId);
      if (src?.name) sourceName = src.name;
    } catch { /* fall back to id */ }

    await notificationService.notifyNewMeshCoreNode(
      publicKey,
      displayName,
      deviceTypeLabel,
      sourceId,
      sourceName,
      // Omitted when absent so a Companion alert keeps its 5-argument call.
      ...(opts.suppressedCount ? [opts.suppressedCount] as const : []),
    );
  } catch (err) {
    logger.warn(
      `[MeshCore:${sourceId}] alertNewNode(${contact.publicKey.substring(0, 16)}…) failed: ${(err as Error).message}`,
    );
  }
}

/**
 * Raise a new-node alert for an ingested advert, or not (#6306, #6341).
 *
 * Alerts only when the advert's signature verified and it created this source's
 * row (or the key waits in the nameless-pending set, #5340). Then the gate decides.
 * While it is learning the node is dropped and never parked, so it cannot alert
 * later. The name comes from the STORED row (already sanitised), never from advert
 * bytes. Auto Welcome never runs here. Never throws.
 */
export async function maybeAlertGatedMeshCoreNewNode(
  tracker: NewNodeAlertTracker,
  sourceId: string,
  ingested: IngestedAdvert,
): Promise<void> {
  const key = ingested.advert?.publicKey;
  if (!key) return;
  if (!tracker.claim(key, ingested.inserted)) return;
  try {
    // Verify before any parking or row read. A checked advert is not verified twice.
    const verified = ingested.signatureVerified
      || (!ingested.signatureChecked && await verifyAdvertSignature(ingested.advert));
    if (!verified) return;
    const row = await databaseService.meshcore.getNodeByPublicKeyAndSource(key, sourceId);
    if (!row) return;
    const name = sanitizeMeshCoreName(row.name) || undefined;
    const verdict = await tracker.admitGated(sourceId, key, !!name);
    if (!verdict.alert) return;
    await alertMeshCoreNewNode(
      tracker,
      sourceId,
      { publicKey: key, name, advName: name, advType: row.advType },
      { suppressedCount: verdict.suppressedCount },
    );
  } catch (err) {
    logger.warn(`[MeshCore:${sourceId}] New-node alert failed: ${(err as Error).message}`);
  } finally {
    tracker.release(key);
  }
}

