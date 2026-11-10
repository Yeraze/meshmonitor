/**
 * Security tab capabilities per source type (P7a, #6254, shared piece S1).
 *
 * Browser-safe and pure: the SecurityTab picks its sections from this, and the
 * routes use it as a guard, so the two never disagree about what a source can
 * do. One tab with protocol adapters, not a MeshCore copy.
 *
 * Meshtastic (and every non-MeshCore source type) keeps today's set. MeshCore
 * P7a adds dead contacts, collisions, signatures, name reuse and own-key
 * change; P7b (#6281) adds per-key rates, clock offset, the scanner and the
 * digest. `notifyDm` (a draft DM to the node's owner) needs a Companion: a
 * Repeater source or an MQTT ingest source has no way to send one.
 */
import { isAnyMeshCoreSourceType } from './nodeTypeCategory.js';

export interface SecurityCapabilities {
  lowEntropy: boolean;
  duplicateKeys: boolean;
  keyMismatchLog: boolean;
  scanner: boolean;
  spam: boolean;
  timeOffset: boolean;
  deadNodes: boolean;
  /** Bulk delete also removes the contact from the radio (MeshCore Companion, Meshtastic). */
  deviceDelete: boolean;
  pathHashCollisions: boolean;
  advertSignatures: boolean;
  nameReuse: boolean;
  ownKeyChange: boolean;
  digest: boolean;
  notifyDm: boolean;
}

/** Device kind of a MeshCore source: the manager enum (1 = companion) or its label. */
export type SecurityDeviceType = string | number | null | undefined;

function isCompanion(deviceType: SecurityDeviceType): boolean {
  if (typeof deviceType === 'number') return deviceType === 1;
  return typeof deviceType === 'string' && deviceType.toLowerCase() === 'companion';
}

function isRepeaterKind(deviceType: SecurityDeviceType): boolean {
  if (typeof deviceType === 'number') return deviceType === 2 || deviceType === 3;
  return typeof deviceType === 'string' && ['repeater', 'room_server', 'room'].includes(deviceType.toLowerCase());
}

export function securityCapabilities(
  sourceType: string | null | undefined,
  deviceType?: SecurityDeviceType,
): SecurityCapabilities {
  if (!isAnyMeshCoreSourceType(sourceType)) {
    return {
      lowEntropy: true,
      duplicateKeys: true,
      keyMismatchLog: true,
      scanner: true,
      spam: true,
      timeOffset: true,
      deadNodes: true,
      deviceDelete: true,
      pathHashCollisions: false,
      advertSignatures: false,
      nameReuse: false,
      ownKeyChange: false,
      digest: true,
      notifyDm: true,
    };
  }
  const isDevice = sourceType === 'meshcore';
  return {
    lowEntropy: false,
    duplicateKeys: false,
    keyMismatchLog: false,
    scanner: true,
    spam: true,
    timeOffset: true,
    deadNodes: true,
    // Only a connected Companion has a contact table to delete from; a
    // Repeater or an MQTT ingest source deletes from MeshMonitor only.
    deviceDelete: isDevice && isCompanion(deviceType) && !isRepeaterKind(deviceType),
    pathHashCollisions: true,
    advertSignatures: true,
    nameReuse: true,
    // An MQTT ingest source has no radio identity of its own.
    ownKeyChange: isDevice,
    digest: true,
    notifyDm: isDevice && isCompanion(deviceType) && !isRepeaterKind(deviceType),
  };
}
