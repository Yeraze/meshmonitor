/**
 * Node fields the dashboard bundles (GET /api/unified/dashboard and
 * GET /api/sources/:id/dashboard) leave out. No dashboard consumer reads them
 * (DashboardPage, the dashboard map and its popups, the Map Analysis layers,
 * useOwnNodePositions): they are read by the Nodes, Messages and Security
 * tabs, which load nodes from their own endpoints. On a large mesh (18k node
 * rows) they were over a third of a 36 MB response sent every 15 seconds.
 *
 * Before reading one of these in a dashboard view, remove it from this list.
 * GET /api/sources/:id/nodes still returns every field. Shared with the client
 * so its tests can check the dashboard merge gives the same result without them.
 */
export const DASHBOARD_OMITTED_NODE_FIELDS: readonly string[] = [
  // Aircraft bookkeeping the popups do not show.
  'aircraftClassifiedAt', 'aircraftFixedLatitude', 'aircraftFixedLongitude',
  // Key and packet-rate checks: Security / Nodes / Messages tabs.
  'lastMeshReceivedKey', 'duplicateKeyDetected', 'keyIsLowEntropy', 'keyMismatchDetected',
  'keySecurityIssueDetails', 'isExcessivePackets', 'packetRatePerHour', 'packetRateLastChecked',
  'isTimeOffsetIssue', 'timeOffsetSeconds', 'lastPKIPacket',
  // Position detail. The override coordinates are already applied to
  // latitude/longitude/altitude (with positionIsOverride) by buildSourceNodes.
  'positionChannel', 'positionHdop', 'positionGpsAccuracy',
  'latitudeOverride', 'longitudeOverride', 'altitudeOverride',
  'positionOverrideEnabled', 'positionOverrideIsPrivate',
  // Admin and housekeeping columns.
  'lastTimeSync', 'welcomedAt', 'nodeStatusUpdatedAt', 'lastTracerouteRequest', 'channelLocked',
  'remoteAdminMetadata', 'lastRemoteAdminCheck', 'hasRemoteAdmin', 'importedAt', 'isStoreForwardServer',
  'isLicensed', 'rebootCount', 'macaddr', 'createdAt', 'updatedAt',
];
