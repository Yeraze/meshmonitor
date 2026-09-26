/**
 * Shared DB-node → DeviceInfo mapping for source managers.
 *
 * `MeshtasticManager.mapDbNodeToDeviceInfo` used to be private to that class,
 * but MQTT-bridge sources also expose a `getAllNodesAsync()` to the consolidated
 * /api/poll endpoint and need the same projection — DB rows are written by
 * either manager in the same shape. Lifting the mapping here keeps both
 * managers in lock-step instead of letting them drift.
 *
 * Pure function: no class state is referenced. Anything that lived on
 * MeshtasticManager (deviceNodeNums, current connection, etc.) belongs in
 * the route layer, not here.
 */

import databaseService from '../../services/database.js';
import { ALL_SOURCES } from '../../db/repositories/index.js';
import { mergeNodesAcrossSources } from './mergeNodesAcrossSources.js';
import type { DeviceInfo } from '../meshtasticManager.js';
import { logger } from '../../utils/logger.js';

export function mapDbNodeToDeviceInfo(
  node: any,
  uptimeSeconds?: number,
  noiseFloor?: number,
  /** Epoch ms of the latest device-metrics telemetry sample (#5033). */
  telemetryTimestamp?: number,
): DeviceInfo {
  const deviceInfo: any = {
    nodeNum: node.nodeNum,
    user: {
      id: node.nodeId,
      longName: node.longName || '',
      shortName: node.shortName || '',
      hwModel: node.hwModel,
      publicKey: node.publicKey,
    },
    deviceMetrics: {
      batteryLevel: node.batteryLevel,
      voltage: node.voltage,
      channelUtilization: node.channelUtilization,
      airUtilTx: node.airUtilTx,
      uptimeSeconds,
      noiseFloor,
    },
    lastHeard: node.lastHeard,
    snr: node.snr,
    rssi: node.rssi,
  };

  // #5033: how long the node's telemetry module has been quiet. Only set when
  // the node has ever reported device metrics — "never sent any" must stay
  // distinguishable from "sent some, then stopped".
  if (telemetryTimestamp !== null && telemetryTimestamp !== undefined) {
    deviceInfo.telemetryTimestamp = telemetryTimestamp;
  }

  if (node.role !== null && node.role !== undefined) {
    deviceInfo.user.role = node.role.toString();
  }
  if (node.hopsAway !== null && node.hopsAway !== undefined) {
    deviceInfo.hopsAway = node.hopsAway;
  }
  if (node.lastMessageHops !== null && node.lastMessageHops !== undefined) {
    deviceInfo.lastMessageHops = node.lastMessageHops;
  }
  if (node.viaMqtt !== null && node.viaMqtt !== undefined) {
    deviceInfo.viaMqtt = Boolean(node.viaMqtt);
  }
  if (node.isStoreForwardServer !== null && node.isStoreForwardServer !== undefined) {
    deviceInfo.isStoreForwardServer = Boolean(node.isStoreForwardServer);
  }
  if (node.isFavorite !== null && node.isFavorite !== undefined) {
    deviceInfo.isFavorite = Boolean(node.isFavorite);
  }
  if (node.favoriteLocked !== null && node.favoriteLocked !== undefined) {
    deviceInfo.favoriteLocked = Boolean(node.favoriteLocked);
  }
  if (node.isIgnored !== null && node.isIgnored !== undefined) {
    deviceInfo.isIgnored = Boolean(node.isIgnored);
  }
  if (node.channel !== null && node.channel !== undefined) {
    deviceInfo.channel = node.channel;
  }
  if (node.mobile !== null && node.mobile !== undefined) {
    deviceInfo.mobile = node.mobile;
  }
  if (node.keyIsLowEntropy !== null && node.keyIsLowEntropy !== undefined) {
    deviceInfo.keyIsLowEntropy = Boolean(node.keyIsLowEntropy);
  }
  if (node.duplicateKeyDetected !== null && node.duplicateKeyDetected !== undefined) {
    deviceInfo.duplicateKeyDetected = Boolean(node.duplicateKeyDetected);
  }
  if (node.keySecurityIssueDetails) {
    deviceInfo.keySecurityIssueDetails = node.keySecurityIssueDetails;
  }
  if (node.latitude && node.longitude) {
    deviceInfo.position = {
      latitude: node.latitude,
      longitude: node.longitude,
      altitude: node.altitude,
    };
  }
  if (node.positionPrecisionBits !== null && node.positionPrecisionBits !== undefined) {
    deviceInfo.positionPrecisionBits = node.positionPrecisionBits;
  }
  // Server-side rx time of the most recent position update, in ms (#4662). Set
  // alongside lat/lon at both POSITION_APP and NodeInfo ingest sites; distinct
  // from the generic `lastHeard` so the UI can show "position updated 3h ago"
  // even when the node is still chatty on telemetry/text.
  if (node.positionTimestamp !== null && node.positionTimestamp !== undefined) {
    deviceInfo.positionTimestamp = node.positionTimestamp;
  }
  if (node.positionGpsAccuracy !== null && node.positionGpsAccuracy !== undefined) {
    deviceInfo.positionGpsAccuracy = node.positionGpsAccuracy;
  }
  if (node.positionLocationSource !== null && node.positionLocationSource !== undefined) {
    deviceInfo.positionLocationSource = node.positionLocationSource;
  }
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
  if (node.hideFromMap !== null && node.hideFromMap !== undefined) {
    deviceInfo.hideFromMap = Boolean(node.hideFromMap);
  }
  if (node.notes !== null && node.notes !== undefined) {
    deviceInfo.notes = node.notes;
  }
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

  // #5317: imported from a contact URL and not yet heard. Carried through so
  // the node list can badge it — an imported row is otherwise identical to a
  // node that has simply gone quiet.
  if (node.importedAt !== null && node.importedAt !== undefined) {
    deviceInfo.importedAt = Number(node.importedAt);
  }

  // #5364/#5365: likely-aircraft classification. Absent = never classified /
  // unknown / detection off for this source.
  if (node.likelyAircraft !== null && node.likelyAircraft !== undefined) {
    deviceInfo.likelyAircraft = Boolean(node.likelyAircraft);
  }
  if (node.aircraftBasis !== null && node.aircraftBasis !== undefined) {
    deviceInfo.aircraftBasis = node.aircraftBasis;
  }
  if (node.groundElevation !== null && node.groundElevation !== undefined) {
    deviceInfo.groundElevation = node.groundElevation;
  }
  if (node.heightAboveGround !== null && node.heightAboveGround !== undefined) {
    deviceInfo.heightAboveGround = node.heightAboveGround;
  }
  // #5364/#5365 Phase 2: aged-out and "confirmed fixed" marks. Absent = not set.
  if (node.aircraftAgedOutAt !== null && node.aircraftAgedOutAt !== undefined) {
    deviceInfo.aircraftAgedOutAt = Number(node.aircraftAgedOutAt);
  }
  if (node.aircraftFixedAt !== null && node.aircraftFixedAt !== undefined) {
    deviceInfo.aircraftFixedAt = Number(node.aircraftFixedAt);
  }

  return deviceInfo;
}

/**
 * Load all nodes for an optional source and project them into DeviceInfo
 * shape, including the latest uptime telemetry. Without a sourceId the
 * caller wants the unified view, so per-source rows are collapsed by
 * `mergeNodesAcrossSources` (issue #3135).
 */
export async function loadAllNodesAsDeviceInfo(sourceId?: string): Promise<DeviceInfo[]> {
  // The uptime query now returns the sample's timestamp alongside its value
  // (#5033), so telemetry-recency costs no extra round trip.
  const [uptimeSamples, noiseFloorMap] = await Promise.all([
    databaseService.telemetry.getLatestTelemetrySampleForAllNodes('uptimeSeconds', sourceId),
    databaseService.telemetry.getLatestTelemetryValueForAllNodes('noiseFloor', sourceId),
  ]);
  // intentional cross-source when sourceId omitted: caller wants unified view across all sources
  const dbNodes = await databaseService.nodes.getAllNodes(sourceId ?? ALL_SOURCES);
  const effective = sourceId ? dbNodes : mergeNodesAcrossSources(dbNodes);
  return effective.map(node => {
    const uptime = uptimeSamples.get(node.nodeId);
    return mapDbNodeToDeviceInfo(
      node,
      uptime?.value,
      noiseFloorMap.get(node.nodeId),
      uptime?.timestamp,
    );
  });
}
