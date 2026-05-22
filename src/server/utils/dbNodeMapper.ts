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
import { mergeNodesAcrossSources } from './mergeNodesAcrossSources.js';
import type { DeviceInfo } from '../meshtasticManager.js';
import { logger } from '../../utils/logger.js';

export function mapDbNodeToDeviceInfo(node: any, uptimeSeconds?: number): DeviceInfo {
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
    },
    lastHeard: node.lastHeard,
    snr: node.snr,
    rssi: node.rssi,
  };

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
  if (node.positionGpsAccuracy !== null && node.positionGpsAccuracy !== undefined) {
    deviceInfo.positionGpsAccuracy = node.positionGpsAccuracy;
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

/**
 * Load all nodes for an optional source and project them into DeviceInfo
 * shape, including the latest uptime telemetry. Without a sourceId the
 * caller wants the unified view, so per-source rows are collapsed by
 * `mergeNodesAcrossSources` (issue #3135).
 */
export async function loadAllNodesAsDeviceInfo(sourceId?: string): Promise<DeviceInfo[]> {
  const uptimeMap = await databaseService.telemetry.getLatestTelemetryValueForAllNodes(
    'uptimeSeconds',
    sourceId,
  );
  const dbNodes = await databaseService.nodes.getAllNodes(sourceId);
  const effective = sourceId ? dbNodes : mergeNodesAcrossSources(dbNodes);
  return effective.map(node => mapDbNodeToDeviceInfo(node, uptimeMap.get(node.nodeId)));
}
