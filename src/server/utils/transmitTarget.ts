/**
 * Which radio a transmit request for `sourceId` would use, or why it may not
 * (#6263 S3). Generalises `checkMeshtasticDeviceSource`: a Meshtastic TCP
 * source and a device-backed MeshCore source (companion / repeater) are
 * targets; `meshcore_mqtt`, MQTT broker/bridge and Reticulum sources are
 * refused, as are sources with no live manager.
 *
 * Refusals keep the existing codes: 400 `SOURCE_NOT_MESHTASTIC` (the source
 * has no radio this surface can drive), 409 `SOURCE_NOT_CONNECTED` (a
 * transmit-capable source that is not up), 404 `SOURCE_NOT_FOUND` (no such
 * source). Connection state of a registered MeshCore manager is NOT checked
 * here (it stays registered while disconnected): handlers answer that with
 * their own 503.
 */
import { sourceManagerRegistry } from '../sourceManagerRegistry.js';
import { isMeshtasticManager, isMeshCoreManager } from '../sourceManagerTypes.js';
import type { MeshtasticManager } from '../meshtasticManager.js';
import type { MeshCoreManager } from '../meshcoreManager.js';
import databaseService from '../../services/database.js';

export interface TransmitRefusal {
  kind: 'refused';
  status: 400 | 404 | 409;
  code: 'SOURCE_NOT_MESHTASTIC' | 'SOURCE_NOT_CONNECTED' | 'SOURCE_NOT_FOUND';
  message: string;
}

export type TransmitTarget =
  | { kind: 'meshtastic'; sourceId: string; manager: MeshtasticManager }
  | { kind: 'meshcore'; sourceId: string; manager: MeshCoreManager }
  | TransmitRefusal;

const TRANSMIT_SOURCE_TYPES = new Set(['meshtastic_tcp', 'meshcore']);

export async function resolveTransmitTarget(sourceId: string): Promise<TransmitTarget> {
  const notTransmitCapable = (): TransmitRefusal => ({
    kind: 'refused',
    status: 400,
    code: 'SOURCE_NOT_MESHTASTIC',
    message: `Source "${sourceId}" has no local radio to transmit through.`,
  });
  const manager = sourceManagerRegistry.getManager(sourceId);
  if (manager) {
    if (isMeshtasticManager(manager)) return { kind: 'meshtastic', sourceId, manager };
    if (isMeshCoreManager(manager)) return { kind: 'meshcore', sourceId, manager };
    return notTransmitCapable();
  }

  let row: { type?: string } | null;
  try {
    row = await databaseService.sources.getSource(sourceId);
  } catch {
    row = null;
  }
  if (!row) {
    return { kind: 'refused', status: 404, code: 'SOURCE_NOT_FOUND', message: `Source "${sourceId}" not found.` };
  }
  if (row.type && TRANSMIT_SOURCE_TYPES.has(row.type)) {
    return {
      kind: 'refused',
      status: 409,
      code: 'SOURCE_NOT_CONNECTED',
      message: `Source "${sourceId}" is not connected; transmitting is not available until it reconnects.`,
    };
  }
  return notTransmitCapable();
}
