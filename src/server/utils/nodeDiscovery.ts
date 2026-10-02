/**
 * "Is this a genuine new-node discovery?" (#5534, trigger.nodeDiscovered).
 *
 * A node is discovered when it is heard LIVE and the source has no row for it.
 * Device syncs must never count, or every reconnect would fire the trigger for
 * the whole node list:
 *
 *  - Meshtastic: the connect-time NodeDB dump arrives as FromRadio.node_info and
 *    goes through processNodeInfoProtobuf, never through this check. Firmware
 *    2.8's PhoneAPI also replays cached position/telemetry as fake MeshPackets
 *    (on reconnect and ~hourly) that DO reach processMeshPacket; those keep the
 *    original rx_time, so `isLiveReception`'s 120s window rejects them.
 *  - MeshCore: see MeshCoreManager — the contact-list sync never calls the
 *    discovery path, and adverts racing the sync are suppressed.
 *
 * There is no "ever seen" memory: a node deleted from MeshMonitor and then
 * heard again has no row, so it is discovered again.
 */
import { isLiveReception } from './replayGuard.js';

export interface LiveNodeDiscoveryInput {
  /** A row for this node already exists on this source. */
  existsOnSource: boolean;
  fromNum: number;
  /** This source's own node number, when known. */
  localNodeNum: number | null | undefined;
  /** MeshPacket.rx_time (epoch seconds), when present. */
  rxTimeSec: number | undefined;
  nowMs: number;
}

/** Meshtastic: true when a received packet first discovers its sender on this source. */
export function isLiveNodeDiscovery(input: LiveNodeDiscoveryInput): boolean {
  if (input.existsOnSource) return false;
  if (!Number.isFinite(input.fromNum) || input.fromNum === 0) return false;
  // #3914: our own node is never "discovered".
  if (input.localNodeNum != null && Number(input.localNodeNum) === input.fromNum) return false;
  return isLiveReception(input.rxTimeSec, input.nowMs);
}

/** Fields of a MeshCore contact that make a nodeUpdated trigger worth firing. */
export interface MeshCoreTriggerFields {
  advName?: string;
  name?: string;
  latitude?: number;
  longitude?: number;
  advType?: number;
  outPath?: string | null;
  pathLen?: number | null;
}

/**
 * MeshCore: which automation-relevant fields differ between two snapshots of a
 * contact (#5534). Only name, position, node type and path count; lastSeen /
 * lastAdvert / signal never do, so a re-advert that changes nothing returns [].
 *
 * A field missing from `after` (undefined) is "not reported", not "cleared" —
 * adverts that omit a field keep the stored value — so it never counts as a
 * change. `outPath`/`pathLen` use null for "route unknown", which IS a value.
 */
export function meshCoreTriggerChanges(
  before: MeshCoreTriggerFields | undefined,
  after: MeshCoreTriggerFields,
): string[] {
  if (!before) return [];
  const changed: string[] = [];
  const beforeName = before.advName || before.name || undefined;
  const afterName = after.advName || after.name || undefined;
  if (afterName !== undefined && afterName !== beforeName) changed.push('name');
  if (after.latitude !== undefined && after.latitude !== before.latitude) changed.push('latitude');
  if (after.longitude !== undefined && after.longitude !== before.longitude) changed.push('longitude');
  if (after.advType !== undefined && after.advType !== before.advType) changed.push('advType');
  if (after.outPath !== undefined && (after.outPath ?? null) !== (before.outPath ?? null)) changed.push('outPath');
  if (after.pathLen !== undefined && (after.pathLen ?? null) !== (before.pathLen ?? null)) changed.push('pathLen');
  return changed;
}
