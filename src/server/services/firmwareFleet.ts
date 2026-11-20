/**
 * Fleet firmware status (#4943, Phase 1: read-only).
 *
 * One row per Meshtastic TCP or MeshCore source: that source's OWN radio, the
 * device MeshMonitor talks to directly. Rows are built from the sources table
 * so a disabled or disconnected radio still shows (as "unknown"), with live
 * manager state layered on top.
 *
 * "Update available" is a version comparison against the newest release on
 * that source's own channel (#4943: per-source stable/alpha). Anything the
 * comparison cannot settle (no version, unparseable version, no release line
 * for the role, custom/local channel) is reported as `unknown` with a reason,
 * never as "up to date". Nothing here talks to a radio or sends a packet.
 */
import databaseService from '../../services/database.js';
import { sourceManagerRegistry } from '../sourceManagerRegistry.js';
import { isMeshCoreManager, isMeshtasticManager } from '../sourceManagerTypes.js';
import { MeshCoreDeviceType } from '../meshcoreManager.js';
import { compareFirmwareVersions } from '../../utils/firmwareVersion.js';
import { getHardwareModelName } from '../../utils/hardwareModel.js';
import { firmwareUpdateSupport } from '../../utils/firmwareHardwareMap.js';
import { firmwareUpdateService, type FirmwareChannel } from './firmwareUpdateService.js';
import {
  latestMeshCoreRelease,
  meshcoreFirmwareReleases,
  type MeshCoreFirmwareRole,
} from './meshcoreFirmwareReleases.js';

export type FirmwareFleetStatus = 'up_to_date' | 'update_available' | 'unknown';

/** Why a row's status is `unknown` (or how it can be updated). */
export type FirmwareFleetReason =
  | 'disconnected'
  | 'no_version'
  | 'unparseable_version'
  | 'no_release'
  | 'channel_has_no_feed'
  | 'unknown_role';

/** How the radio can be updated today. */
export type FirmwareFleetMethod = 'ota' | 'manual';

export interface FirmwareFleetRow {
  sourceId: string;
  sourceName: string;
  protocol: 'meshtastic' | 'meshcore';
  enabled: boolean;
  connected: boolean;
  device: string | null;
  hardware: string | null;
  /** MeshCore firmware role; null for Meshtastic. */
  role: MeshCoreFirmwareRole | null;
  installed: string | null;
  latest: string | null;
  latestUrl: string | null;
  channel: FirmwareChannel;
  status: FirmwareFleetStatus;
  reason: FirmwareFleetReason | null;
  method: FirmwareFleetMethod;
}

const MESHCORE_ROLE: Partial<Record<MeshCoreDeviceType, MeshCoreFirmwareRole>> = {
  [MeshCoreDeviceType.COMPANION]: 'companion',
  [MeshCoreDeviceType.REPEATER]: 'repeater',
  [MeshCoreDeviceType.ROOM_SERVER]: 'room-server',
};

/** Status from installed vs. latest; `unknown` (with a reason) when unsure. */
export function compareStatus(
  installed: string | null,
  latest: string | null,
): { status: FirmwareFleetStatus; reason: FirmwareFleetReason | null } {
  if (!installed) return { status: 'unknown', reason: 'no_version' };
  if (!latest) return { status: 'unknown', reason: 'no_release' };
  const cmp = compareFirmwareVersions(installed, latest);
  if (cmp === null) return { status: 'unknown', reason: 'unparseable_version' };
  return { status: cmp < 0 ? 'update_available' : 'up_to_date', reason: null };
}

export async function buildFirmwareFleet(): Promise<FirmwareFleetRow[]> {
  const sources = await databaseService.sources.getAllSources();
  const rows: FirmwareFleetRow[] = [];
  const meshcoreReleases = meshcoreFirmwareReleases.getCached();

  for (const src of sources) {
    if (src.type !== 'meshtastic_tcp' && src.type !== 'meshcore') continue;
    const channel = await firmwareUpdateService.getChannel(src.id);
    const manager = sourceManagerRegistry.getManager(src.id);
    const connected = !!manager && manager.getStatus().connected === true;
    const base = {
      sourceId: src.id,
      sourceName: src.name,
      enabled: src.enabled,
      connected,
      channel,
    };

    if (src.type === 'meshtastic_tcp') {
      const info = manager && isMeshtasticManager(manager) ? manager.getLocalNodeInfo() : null;
      const installed = info?.firmwareVersion?.trim() || null;
      const hwModel = info?.hwModel;
      // The OTA panel decides the details; here, "can this board take OTA at all".
      const otaBoard = hwModel !== undefined && hwModel !== 0 && firmwareUpdateSupport(hwModel).supported;
      const bridged = !!manager && isMeshtasticManager(manager) && manager.isLocalNodeBridged();
      let latest: string | null = null;
      let latestUrl: string | null = null;
      let verdict: ReturnType<typeof compareStatus>;
      if (channel === 'custom' || channel === 'local') {
        verdict = { status: 'unknown', reason: 'channel_has_no_feed' };
      } else {
        const releases = firmwareUpdateService.getCachedReleasesForChannel(channel);
        for (const r of releases) {
          if (!latest || (compareFirmwareVersions(r.version, latest) ?? 0) > 0) {
            latest = r.version;
            latestUrl = r.htmlUrl || null;
          }
        }
        verdict = compareStatus(installed, latest);
      }
      if (!connected && !installed) verdict = { status: 'unknown', reason: 'disconnected' };
      rows.push({
        ...base,
        protocol: 'meshtastic',
        device: info?.longName || null,
        hardware: hwModel !== undefined && hwModel !== 0 ? getHardwareModelName(hwModel) : null,
        role: null,
        installed,
        latest,
        latestUrl,
        ...verdict,
        method: otaBoard && !bridged ? 'ota' : 'manual',
      });
      continue;
    }

    // MeshCore
    const mc = manager && isMeshCoreManager(manager) ? manager : null;
    const node = mc?.getLocalNode() ?? null;
    const role = mc ? MESHCORE_ROLE[mc.getDeviceType()] ?? null : null;
    const installed = node?.ver?.trim() || null;
    const release = role ? latestMeshCoreRelease(meshcoreReleases, role, channel) : null;
    let verdict = role ? compareStatus(installed, release?.version ?? null) : { status: 'unknown' as const, reason: 'unknown_role' as const };
    if (!connected && !installed) verdict = { status: 'unknown', reason: 'disconnected' };
    rows.push({
      ...base,
      protocol: 'meshcore',
      device: node?.name || null,
      hardware: node?.model?.trim() || null,
      role,
      installed,
      latest: release?.version ?? null,
      latestUrl: release?.htmlUrl || null,
      ...verdict,
      // Phase 1 is read-only for MeshCore: no OTA/DFU yet.
      method: 'manual',
    });
  }
  return rows;
}
