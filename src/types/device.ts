export interface DeviceInfo {
  nodeNum: number
  user?: {
    id: string
    longName?: string
    shortName?: string
    hwModel?: number
    role?: string
    publicKey?: string
  }
  position?: {
    latitude: number
    longitude: number
    altitude?: number
  }
  deviceMetrics?: {
    batteryLevel?: number
    voltage?: number
    channelUtilization?: number
    airUtilTx?: number
    uptimeSeconds?: number
  }
  hopsAway?: number
  viaMqtt?: boolean
  lastHeard?: number
  snr?: number
  rssi?: number
  firmwareVersion?: string
  isMobile?: boolean
  mobile?: number // Database field: 0 = not mobile, 1 = mobile (moved >100m)
  isFavorite?: boolean
  isIgnored?: boolean
  keyIsLowEntropy?: boolean
  duplicateKeyDetected?: boolean
  keySecurityIssueDetails?: string
  channel?: number
  // Position override fields (positionOverrideEnabled is 0 or 1 from database)
  positionOverrideEnabled?: number
  latitudeOverride?: number
  longitudeOverride?: number
  altitudeOverride?: number
  positionIsOverride?: boolean
}

export interface Channel {
  id: number
  name: string
  psk?: string
  role?: number // 0=Disabled, 1=Primary, 2=Secondary
  uplinkEnabled: boolean
  downlinkEnabled: boolean
  positionPrecision?: number // Location precision bits (0-32)
  createdAt: number
  updatedAt: number
}

/**
 * Local node info from device configuration
 */
export interface LocalNodeInfo {
  nodeId: string;
  longName?: string;
  shortName?: string;
}

/**
 * Basic node user info - common subset used across components
 */
export interface NodeUser {
  id: string;
  longName?: string;
  shortName?: string;
  hwModel?: number;
  role?: number | string;
}

/**
 * Basic node info for UI components (lists, modals, etc.)
 */
export interface BasicNodeInfo {
  nodeNum: number;
  user?: NodeUser;
}

/**
 * Extended node info with telemetry-related fields
 */
export interface TelemetryNodeInfo extends BasicNodeInfo {
  lastHeard?: number;
  hopsAway?: number;
}

/**
 * Node info with position data for map-related components
 */
export interface MapNodeInfo extends TelemetryNodeInfo {
  position?: {
    latitudeI?: number;
    longitudeI?: number;
    latitude?: number;
    longitude?: number;
  };
}

/**
 * Database node type with additional fields
 */
export interface DbNode extends Partial<DeviceInfo> {
  nodeId?: string
  longName?: string
  shortName?: string
  macaddr?: string
  latitude?: number
  longitude?: number
  altitude?: number
  batteryLevel?: number
  voltage?: number
  channelUtilization?: number
  airUtilTx?: number
  channel?: number
  mobile?: number // 0 = not mobile, 1 = mobile (moved >100m)
  createdAt?: number
  updatedAt?: number
  lastTracerouteRequest?: number
  // Position override fields (stored in database)
  positionOverrideEnabled?: number // 0 or 1 in SQLite
  latitudeOverride?: number
  longitudeOverride?: number
  altitudeOverride?: number
}