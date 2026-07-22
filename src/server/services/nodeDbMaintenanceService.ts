/**
 * NodeDB maintenance operations (#3962 Phase 4.2a PR2 §4f).
 *
 * Extracted from MeshtasticManager: purging/refreshing the connected radio's
 * on-device NodeDB, removing a single node from it, and mapping DB node rows
 * into the API-facing `DeviceInfo` shape.
 *
 * Import-cycle discipline (task42a_spec.md §3): this file takes the owning
 * manager as a constructor-injected `import type` reference — never a static
 * value import of MeshtasticManager. `purgeNodeDb`/`sendRemoveNode`/
 * `refreshNodeDatabase` need a few pieces of manager state
 * (`isConnected`/`transport`/`localNodeInfo`/`deviceNodeNums`) that are
 * `private` on MeshtasticManager; three narrow public accessors were added
 * to the manager to bridge that (`isDeviceConnected`, `isTransportReady`,
 * `sendLocalAdminPacket`, `removeDeviceNodeNum`) rather than widening the
 * fields themselves or touching the protobuf-dispatch code that also writes
 * `deviceNodeNums` (out of scope per spec §10).
 *
 * `isNodeInDeviceDb`/`getDeviceNodeNums` were NOT moved here (they stay on
 * MeshtasticManager) — see the PR2 report for why: `deviceNodeNums` is
 * written by several protobuf-dispatch methods
 * (`handleConnected`/`processNodeInfoMessageProtobuf`/
 * `processNodeInfoProtobuf`/`pushContactToRadio`), which are explicitly
 * out-of-scope for this PR, so the Set stays manager-owned; only the single
 * `.delete()` call from `sendRemoveNode` was bridged via a narrow accessor.
 */
import type { MeshtasticManager, DeviceInfo } from '../meshtasticManager.js';
import databaseService from '../../services/database.js';
import { ALL_SOURCES } from '../../db/repositories/index.js';
import { mergeNodesAcrossSources } from '../utils/mergeNodesAcrossSources.js';
import protobufService from '../protobufService.js';
import { logger } from '../../utils/logger.js';

/**
 * Convert a raw DB node row into the `DeviceInfo` shape used throughout the
 * API/frontend. Pure — no manager state is referenced.
 *
 * BIGINT rule (CLAUDE.md multi-DB): `node.nodeNum` arrives here already
 * coerced to a plain JS `number` — `NodesRepository.getAllNodes()` runs
 * every row through `normalizeBigInts()` before this function ever sees it,
 * so no `Number(...)` coercion belongs in this function itself. Preserved
 * verbatim from the pre-extraction `MeshtasticManager.mapDbNodeToDeviceInfo`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- relocated verbatim; `node` is an untyped Drizzle row shape, same as the pre-extraction manager method
export function mapDbNodeToDeviceInfo(node: any, uptimeSeconds?: number, noiseFloor?: number): DeviceInfo {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- relocated verbatim; the function assigns fields (isFavorite, keyIsLowEntropy, etc.) beyond the DeviceInfo interface, same as the pre-extraction manager method
  const deviceInfo: any = {
    nodeNum: node.nodeNum,
    user: {
      id: node.nodeId,
      longName: node.longName || '',
      shortName: node.shortName || '',
      hwModel: node.hwModel,
      publicKey: node.publicKey
    },
    deviceMetrics: {
      batteryLevel: node.batteryLevel,
      voltage: node.voltage,
      channelUtilization: node.channelUtilization,
      airUtilTx: node.airUtilTx,
      uptimeSeconds,
      noiseFloor
    },
    lastHeard: node.lastHeard,
    snr: node.snr,
    rssi: node.rssi
  };

  // Add role if it exists
  if (node.role !== null && node.role !== undefined) {
    deviceInfo.user.role = node.role.toString();
  }

  // Add hopsAway if it exists
  if (node.hopsAway !== null && node.hopsAway !== undefined) {
    deviceInfo.hopsAway = node.hopsAway;
  }

  // Add lastMessageHops if it exists (for "All messages" hop calculation mode)
  if (node.lastMessageHops !== null && node.lastMessageHops !== undefined) {
    deviceInfo.lastMessageHops = node.lastMessageHops;
  }

  // Add viaMqtt if it exists
  if (node.viaMqtt !== null && node.viaMqtt !== undefined) {
    deviceInfo.viaMqtt = Boolean(node.viaMqtt);
  }

  // Add isStoreForwardServer if it exists
  if (node.isStoreForwardServer !== null && node.isStoreForwardServer !== undefined) {
    deviceInfo.isStoreForwardServer = Boolean(node.isStoreForwardServer);
  }

  // Add isFavorite if it exists
  if (node.isFavorite !== null && node.isFavorite !== undefined) {
    deviceInfo.isFavorite = Boolean(node.isFavorite);
  }

  // Add favoriteLocked if it exists
  if (node.favoriteLocked !== null && node.favoriteLocked !== undefined) {
    deviceInfo.favoriteLocked = Boolean(node.favoriteLocked);
  }

  // Add isIgnored if it exists
  if (node.isIgnored !== null && node.isIgnored !== undefined) {
    deviceInfo.isIgnored = Boolean(node.isIgnored);
  }

  // Add isUnmessagable / isLicensed if they exist (#3684). Without these
  // the client never learns a remote node is unmessagable, so the DM UI
  // (NodesTab DM button, MessagesTab compose) fails open for them (#3755).
  if (node.isUnmessagable !== null && node.isUnmessagable !== undefined) {
    deviceInfo.isUnmessagable = Boolean(node.isUnmessagable);
  }
  if (node.isLicensed !== null && node.isLicensed !== undefined) {
    deviceInfo.isLicensed = Boolean(node.isLicensed);
  }

  // Add channel if it exists
  if (node.channel !== null && node.channel !== undefined) {
    deviceInfo.channel = node.channel;
  }

  // Add mobile flag if it exists (pre-computed during packet processing)
  if (node.mobile !== null && node.mobile !== undefined) {
    deviceInfo.mobile = node.mobile;
  }

  // Add security fields for low-entropy and duplicate key detection
  if (node.keyIsLowEntropy !== null && node.keyIsLowEntropy !== undefined) {
    deviceInfo.keyIsLowEntropy = Boolean(node.keyIsLowEntropy);
  }
  if (node.duplicateKeyDetected !== null && node.duplicateKeyDetected !== undefined) {
    deviceInfo.duplicateKeyDetected = Boolean(node.duplicateKeyDetected);
  }
  if (node.keySecurityIssueDetails) {
    deviceInfo.keySecurityIssueDetails = node.keySecurityIssueDetails;
  }

  // Add position if coordinates exist
  if (node.latitude && node.longitude) {
    deviceInfo.position = {
      latitude: node.latitude,
      longitude: node.longitude,
      altitude: node.altitude
    };
  }

  // Add position precision fields for accuracy circles
  if (node.positionPrecisionBits !== null && node.positionPrecisionBits !== undefined) {
    deviceInfo.positionPrecisionBits = node.positionPrecisionBits;
  }
  if (node.positionGpsAccuracy !== null && node.positionGpsAccuracy !== undefined) {
    deviceInfo.positionGpsAccuracy = node.positionGpsAccuracy;
  }
  if (node.positionLocationSource !== null && node.positionLocationSource !== undefined) {
    deviceInfo.positionLocationSource = node.positionLocationSource;
  }

  // Add position override fields
  if (node.positionOverrideEnabled !== null && node.positionOverrideEnabled !== undefined) {
    deviceInfo.positionOverrideEnabled = Boolean(node.positionOverrideEnabled);
  }
  if (node.latitudeOverride !== null && node.latitudeOverride !== undefined) {
    deviceInfo.latitudeOverride = node.latitudeOverride;
  }
  if (node.longitudeOverride !== null && node.longitudeOverride !== undefined) {
    deviceInfo.longitudeOverride = node.longitudeOverride;
  }
  if (node.altitudeOverride !== null && node.altitudeOverride !== undefined) {
    deviceInfo.altitudeOverride = node.altitudeOverride;
  }
  if (node.positionOverrideIsPrivate !== null && node.positionOverrideIsPrivate !== undefined) {
    deviceInfo.positionOverrideIsPrivate = Boolean(node.positionOverrideIsPrivate);
  }

  // Add remote admin fields
  if (node.hasRemoteAdmin !== null && node.hasRemoteAdmin !== undefined) {
    deviceInfo.hasRemoteAdmin = Boolean(node.hasRemoteAdmin);
    logger.debug(`🔍 Node ${node.nodeNum} hasRemoteAdmin: ${node.hasRemoteAdmin}`);
  }
  if (node.lastRemoteAdminCheck !== null && node.lastRemoteAdminCheck !== undefined) {
    deviceInfo.lastRemoteAdminCheck = node.lastRemoteAdminCheck;
  }
  if (node.remoteAdminMetadata) {
    deviceInfo.remoteAdminMetadata = node.remoteAdminMetadata;
    logger.debug(`🔍 Node ${node.nodeNum} has remoteAdminMetadata`);
  }

  return deviceInfo;
}

export class NodeDbMaintenanceService {
  constructor(private readonly mgr: MeshtasticManager) {}

  /**
   * Cross-source-aware node listing. Moved verbatim from
   * `MeshtasticManager.getAllNodesAsync` — no manager-state coupling beyond
   * the (now module-level) `mapDbNodeToDeviceInfo`.
   */
  async getAllNodesAsync(sourceId?: string): Promise<DeviceInfo[]> {
    const [uptimeMap, noiseFloorMap] = await Promise.all([
      databaseService.telemetry.getLatestTelemetryValueForAllNodes('uptimeSeconds', sourceId),
      databaseService.telemetry.getLatestTelemetryValueForAllNodes('noiseFloor', sourceId),
    ]);
    // intentional cross-source when sourceId omitted: caller wants unified view across all sources
    const dbNodes = await databaseService.nodes.getAllNodes(sourceId ?? ALL_SOURCES);
    // Without a sourceId the caller wants the unified view, so collapse the
    // per-source rows into one entry per nodeNum. Issue #3135.
    const effective = sourceId ? dbNodes : mergeNodesAcrossSources(dbNodes);
    return effective.map(node =>
      mapDbNodeToDeviceInfo(node, uptimeMap.get(node.nodeId), noiseFloorMap.get(node.nodeId)),
    );
  }

  /**
   * Ask the connected radio to purge its on-device NodeDB. Local TCP
   * connections don't require a session passkey (only remote/mesh admin
   * operations do).
   */
  async purgeNodeDb(seconds: number = 0): Promise<void> {
    if (!this.mgr.isTransportReady()) {
      throw new Error('Not connected to Meshtastic node');
    }

    try {
      logger.debug(`⚙️ Sending purge node database command: will purge in ${seconds} seconds`);
      // NOTE: Session passkeys are only required for REMOTE admin operations (admin messages sent to other nodes via mesh).
      // For local TCP connections to the device itself, no session passkey is needed.
      const localNodeNum = this.mgr.getLocalNodeInfo()?.nodeNum;
      const purgeMsg = protobufService.createPurgeNodeDbMessage(seconds);
      const adminPacket = protobufService.createAdminPacket(purgeMsg, localNodeNum || 0, localNodeNum);

      await this.mgr.sendLocalAdminPacket(adminPacket);
      logger.debug('⚙️ Sent purge node database admin message (local operation, no session passkey required)');
    } catch (error) {
      logger.error('❌ Error sending purge node database command:', error);
      throw error;
    }
  }

  /**
   * Remove a single node from the connected radio's on-device NodeDB via an
   * admin `remove_by_nodenum` command, and drop it from the manager's
   * in-memory `deviceNodeNums` tracking so the UI's "not in device DB"
   * warning appears immediately (before the radio re-reports its DB).
   */
  async sendRemoveNode(nodeNum: number): Promise<void> {
    if (!this.mgr.isTransportReady()) {
      throw new Error('Not connected to Meshtastic node');
    }

    const localNodeInfo = this.mgr.getLocalNodeInfo();
    if (!localNodeInfo) {
      throw new Error('Local node information not available');
    }

    try {
      // For local TCP connections, try sending without session passkey first
      // (there's a known bug where session keys don't work properly over TCP)
      logger.debug(`🗑️ Attempting to remove node ${nodeNum} (!${nodeNum.toString(16).padStart(8, '0')}) from device NodeDB`);
      const removeNodeMsg = protobufService.createRemoveNodeMessage(nodeNum, new Uint8Array()); // empty passkey
      const adminPacket = protobufService.createAdminPacket(removeNodeMsg, localNodeInfo.nodeNum, localNodeInfo.nodeNum); // send to local node

      await this.mgr.sendLocalAdminPacket(adminPacket);
      logger.debug(`✅ Sent remove_by_nodenum admin command for node ${nodeNum} (!${nodeNum.toString(16).padStart(8, '0')})`);

      // Remove from device node tracking so the UI shows the "not in device DB" warning
      this.mgr.removeDeviceNodeNum(nodeNum);
    } catch (error) {
      logger.error('❌ Error sending remove node admin message:', error);
      throw error;
    }
  }

  /**
   * Manually refresh the node database: (re)connect if needed, clear the
   * `localNodeInfo` lock so fresh MyNodeInfo/NodeInfo can update it, then
   * request want_config_id + (1s later) all module configs.
   */
  async refreshNodeDatabase(): Promise<void> {
    logger.debug('🔄 Manually refreshing node database...');

    if (!this.mgr.isDeviceConnected()) {
      logger.debug('⚠️ Not connected, attempting to reconnect...');
      await this.mgr.connect();
    }

    // Clear isLocked so processMyNodeInfo can run (updates hwModel, rebootCount, etc.)
    // and processNodeInfoProtobuf can update localNodeInfo with fresh names.
    // The whole point of a manual refresh is to get fresh data from the device.
    const localNodeInfo = this.mgr.getLocalNodeInfo();
    if (localNodeInfo) {
      localNodeInfo.isLocked = false;
      logger.debug('🔓 Cleared localNodeInfo lock for config refresh');
    }

    // Send want_config_id to trigger node to send updated info
    await this.mgr.sendWantConfigId();

    // Also request all module configs to get fresh telemetry, mqtt, etc.
    setTimeout(async () => {
      try {
        logger.debug('📦 Requesting fresh module configs...');
        await this.mgr.requestAllModuleConfigs();
      } catch (error) {
        logger.error('❌ Failed to request module configs during refresh:', error);
      }
    }, 1000);
  }
}
