export interface DeviceInfo {
  nodeNum: number;
  user?: {
    id: string;
    longName?: string;
    shortName?: string;
    hwModel?: number;
    role?: string;
    publicKey?: string;
    // #4244: the Copy NodeInfo modal diffs all eight NODE_INFO_FIELDS. These
    // three were absent from this type, so its "Current" column rendered them
    // as "—" no matter what was stored — making macaddr look copyable when the
    // server would then refuse to overwrite the real value.
    macaddr?: string | null;
    hasPKC?: boolean | null;
    firmwareVersion?: string | null;
  };
  position?: {
    latitude: number;
    longitude: number;
    altitude?: number;
  };
  deviceMetrics?: {
    batteryLevel?: number;
    voltage?: number;
    channelUtilization?: number;
    airUtilTx?: number;
    uptimeSeconds?: number;
    /** Radio noise floor in dBm, from LocalStats telemetry (#3396). */
    noiseFloor?: number;
  };
  hopsAway?: number;
  lastMessageHops?: number; // Hops from most recent packet (hopStart - hopLimit)
  viaMqtt?: boolean;
  /**
   * Most-recent meshtastic.MeshPacket.TransportMechanism this node was
   * heard via. Map filters (Show RF / UDP / MQTT) classify markers off
   * this column. 0=INTERNAL, 1=LORA, 2-4=LORA_ALT*, 5=MQTT,
   * 6=MULTICAST_UDP, 7=API. Migration 066 adds the column + backfills
   * MQTT(5) for `viaMqtt=true` rows and LORA(1) for the rest.
   */
  transportMechanism?: number | null;
  /**
   * #4240: unix seconds this node was last heard over each transport (NULL =
   * never). Map visibility ORs these against the Show RF/UDP/MQTT toggles and
   * applies the user's active window, so a node reachable both ways stays
   * visible under either toggle and a transport that goes quiet decays out.
   * Prefer these over `transportMechanism`, which is last-wins and gets
   * overwritten by MQTT echoes.
   */
  transportLastRf?: number | null;
  transportLastMqtt?: number | null;
  transportLastUdp?: number | null;
  isStoreForwardServer?: boolean;
  lastHeard?: number;
  snr?: number;
  rssi?: number;
  firmwareVersion?: string;
  isMobile?: boolean;
  mobile?: number; // Database field: 0 = not mobile, 1 = mobile (moved >100m)
  isFavorite?: boolean;
  favoriteLocked?: boolean;
  isIgnored?: boolean;
  hideFromMap?: boolean; // #3549: suppress this node's marker on maps only
  notes?: string; // #3921: free-text per-node MeshMonitor-local annotation
  isUnmessagable?: boolean; // #3684: User.is_unmessagable — node won't receive DMs
  isLicensed?: boolean; // #3684: User.is_licensed — amateur-radio licensed operator
  keyIsLowEntropy?: boolean;
  duplicateKeyDetected?: boolean;
  keyMismatchDetected?: boolean;
  keySecurityIssueDetails?: string;
  channel?: number;
  // Position precision fields
  positionPrecisionBits?: number; // Position precision (0-32 bits, higher = more precise)
  positionGpsAccuracy?: number; // GPS accuracy in meters
  // Meshtastic Position.location_source (LocSource): 0=UNSET, 1=MANUAL,
  // 2=INTERNAL GPS, 3=EXTERNAL GPS (#4176)
  positionLocationSource?: number;
  // Position override fields
  positionOverrideEnabled?: boolean;
  latitudeOverride?: number;
  longitudeOverride?: number;
  altitudeOverride?: number;
  positionOverrideIsPrivate?: boolean;
  positionIsOverride?: boolean;
  // Remote admin discovery
  hasRemoteAdmin?: boolean;
  lastRemoteAdminCheck?: number;
  remoteAdminMetadata?: string;
}

export interface Channel {
  id: number;
  name: string;
  /**
   * User-facing channel name with the modem-preset / "Primary" fallback
   * applied by `transformChannel` on the server. For slot 0 with an empty
   * `name` column this surfaces the firmware-derived label (e.g.
   * `"MediumFast"`, `"LongFast"`) so per-source views match the unified
   * picker and the label MQTT gateways publish under. Always present on
   * server-projected channel rows; clients should prefer this over `name`
   * for display purposes. Falls back to `"Primary"` if the source's modem
   * preset hasn't been received yet.
   */
  displayName?: string;
  /**
   * Raw base64 PSK. Only populated by the API for admins or callers with
   * `channel_${id}:write` permission for this channel (MM-SEC-2 / #2951).
   * Read-only consumers should rely on `encryptionStatus` / `pskSet` instead.
   */
  psk?: string | null;
  /** Server-derived: whether a PSK is configured (safe for all viewers). */
  pskSet?: boolean;
  /** Server-derived encryption status (safe for all viewers). */
  encryptionStatus?: 'none' | 'default' | 'secure';
  role?: number; // 0=Disabled, 1=Primary, 2=Secondary
  roleName?: string;
  uplinkEnabled: boolean;
  downlinkEnabled: boolean;
  positionPrecision?: number; // Location precision bits (0-32)
  createdAt?: number;
  updatedAt?: number;
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
  snr?: number;
  rssi?: number;
  position?: {
    latitude?: number;
    longitude?: number;
    altitude?: number;
  };
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
  nodeId?: string;
  longName?: string;
  shortName?: string;
  macaddr?: string;
  latitude?: number;
  longitude?: number;
  altitude?: number;
  batteryLevel?: number;
  voltage?: number;
  channelUtilization?: number;
  airUtilTx?: number;
  channel?: number;
  mobile?: number; // 0 = not mobile, 1 = mobile (moved >100m)
  createdAt?: number;
  updatedAt?: number;
  lastTracerouteRequest?: number;
  // Position override fields (stored in database)
  positionOverrideEnabled?: boolean;
  latitudeOverride?: number;
  longitudeOverride?: number;
  altitudeOverride?: number;
  positionOverrideIsPrivate?: boolean;
  // Remote admin discovery
  hasRemoteAdmin?: boolean;
  lastRemoteAdminCheck?: number;
  remoteAdminMetadata?: string;
}
