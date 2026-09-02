import { useReducer, useCallback } from 'react';
import { decodePositionFlags } from '../../utils/positionFlags';

/**
 * Consolidated state management for AdminCommandsTab
 * Reduces 90+ useState calls to organized reducer-based state
 */

// LoRa Config State
export interface LoRaConfigState {
  usePreset: boolean;
  modemPreset: number;
  bandwidth: number;
  spreadFactor: number;
  codingRate: number;
  frequencyOffset: number;
  overrideFrequency: number;
  region: number;
  hopLimit: number;
  txPower: number;
  channelNum: number;
  femLnaMode: number;
  sx126xRxBoostedGain: boolean;
  ignoreMqtt: boolean;
  configOkToMqtt: boolean;
  txEnabled: boolean;
  overrideDutyCycle: boolean;
  paFanDisabled: boolean;
}

// Position Config State
export interface PositionConfigState {
  positionBroadcastSecs: number;
  positionSmartEnabled: boolean;
  fixedPosition: boolean;
  fixedLatitude: number;
  fixedLongitude: number;
  fixedAltitude: number;
  gpsUpdateInterval: number;
  rxGpio?: number;
  txGpio?: number;
  gpsEnGpio?: number;
  broadcastSmartMinimumDistance: number;
  broadcastSmartMinimumIntervalSecs: number;
  gpsMode: number;
  positionFlags: {
    altitude: boolean;
    altitudeMsl: boolean;
    geoidalSeparation: boolean;
    dop: boolean;
    hvdop: boolean;
    satinview: boolean;
    seqNo: boolean;
    timestamp: boolean;
    heading: boolean;
    speed: boolean;
  };
}

// MQTT Config State
export interface MQTTConfigState {
  enabled: boolean;
  address: string;
  username: string;
  password: string;
  encryptionEnabled: boolean;
  jsonEnabled: boolean;
  root: string;
}

// Security Config State
export interface SecurityConfigState {
  adminKeys: string[];
  isManaged: boolean;
  serialEnabled: boolean;
  debugLogApiEnabled: boolean;
  adminChannelEnabled: boolean;

  // --- Load gate (#4736) ---
  //
  // The node's keypair and packet_signature_policy are deliberately NOT held
  // here. Firmware wholesale-replaces the security struct and mints a new
  // keypair when the incoming private key is absent, so those fields must
  // survive a save — but they are merged SERVER-side from a fresh read of the
  // node, so a remote node's PRIVATE KEY never reaches the browser. That also
  // keeps the #4632 guard intact: a client-supplied private key aimed at a
  // remote node stays rejected, because an honest echo and an identity hijack
  // are indistinguishable at the server.
  //
  // What the UI still owes the user is the editable half. adminKeys and the
  // flags below are sent wholesale, so saving without having LOADED them would
  // overwrite admin keys the user never saw.

  loadedForNodeNum: number | null;
}

// Bluetooth Config State
export interface BluetoothConfigState {
  enabled: boolean;
  mode: number;
  fixedPin: number;
}

// Network Config State
export interface NetworkConfigState {
  wifiEnabled: boolean;
  wifiSsid: string;
  wifiPsk: string;
  ntpServer: string;
  addressMode: number;
  ipv4Address: string;
  ipv4Gateway: string;
  ipv4Subnet: string;
  ipv4Dns: string;
}

// NeighborInfo Config State
export interface NeighborInfoConfigState {
  enabled: boolean;
  updateInterval: number;
  transmitOverLora: boolean;
}

// Owner Config State
export interface OwnerConfigState {
  longName: string;
  shortName: string;
  isUnmessagable: boolean;
  isLicensed: boolean;
}

// Device Config State
export interface DeviceConfigState {
  role: number;
  nodeInfoBroadcastSecs: number;
  rebroadcastMode: number;
  tzdef: string;
  doubleTapAsButtonPress: boolean;
  disableTripleClick: boolean;
  ledHeartbeatDisabled: boolean;
  buzzerMode: number;
  buttonGpio: number;
  buzzerGpio: number;
}

// Telemetry Config State
export interface TelemetryConfigState {
  deviceUpdateInterval: number;
  deviceTelemetryEnabled: boolean;
  environmentUpdateInterval: number;
  environmentMeasurementEnabled: boolean;
  environmentScreenEnabled: boolean;
  environmentDisplayFahrenheit: boolean;
  airQualityEnabled: boolean;
  airQualityInterval: number;
  powerMeasurementEnabled: boolean;
  powerUpdateInterval: number;
  powerScreenEnabled: boolean;
  healthMeasurementEnabled: boolean;
  healthUpdateInterval: number;
  healthScreenEnabled: boolean;
}

// Status Message Config State
export interface StatusMessageConfigState {
  nodeStatus: string;
}

// Traffic Management Config State (v2.7.22 schema)
export interface TrafficManagementConfigState {
  enabled: boolean;
  positionDedupEnabled: boolean;
  positionPrecisionBits: number;
  positionMinIntervalSecs: number;
  nodeinfoDirectResponse: boolean;
  nodeinfoDirectResponseMaxHops: number;
  rateLimitEnabled: boolean;
  rateLimitWindowSecs: number;
  rateLimitMaxPackets: number;
  dropUnknownEnabled: boolean;
  unknownPacketThreshold: number;
  exhaustHopTelemetry: boolean;
  exhaustHopPosition: boolean;
  routerPreserveHops: boolean;
}

/**
 * One entry of the repeated `broadcast_targets` list (module_config.proto:929).
 * The broadcaster transmits one beacon copy per target, each on its own radio
 * settings. `preset`/`channelIndex` are `optional` on the wire (null = fall back
 * to the running config); `region` is a plain enum where 0/UNSET means "use the
 * running config region".
 */
export interface BroadcastTarget {
  /** Config.LoRaConfig.ModemPreset, or null to use the running config preset. */
  preset: number | null;
  /** Config.LoRaConfig.RegionCode; 0 = UNSET (use running config region). */
  region: number;
  /** Channel-table slot (0..MAX_NUM_CHANNELS-1), or null for the preset default. */
  channelIndex: number | null;
}

// MeshBeacon Config State (firmware 2.8+, #3854).
//
// The wire message packs listen/broadcast/legacy-split into a single `flags`
// bitfield (MeshBeaconConfig.Flags). We keep them as three booleans here so the
// UI can bind a checkbox each, and pack/unpack at the save/load boundary —
// see MESH_BEACON_FLAGS below.
export interface MeshBeaconConfigState {
  listenEnabled: boolean;
  broadcastEnabled: boolean;
  legacySplit: boolean;
  broadcastMessage: string;
  /** 0 = send as the local node; otherwise the node ID to send beacons as. */
  broadcastSendAsNode: number;
  /** Name of the channel advertised in offer_channel; '' = advertise none. */
  broadcastOfferChannelName: string;
  /** Base64 PSK for the advertised channel. */
  broadcastOfferChannelPsk: string;
  /** Config.LoRaConfig.RegionCode; 0 = UNSET. */
  broadcastOfferRegion: number;
  /**
   * Config.LoRaConfig.ModemPreset, or null to advertise no preset. The proto
   * field is `optional`, so null and 0 (LONG_FAST) are genuinely different.
   */
  broadcastOfferPreset: number | null;
  /**
   * How often to broadcast, in seconds. Firmware enforces a 3600s (1h) minimum
   * and defaults to 3600; the UI mirrors that floor (see MESH_BEACON_MIN_INTERVAL_SECS).
   */
  broadcastIntervalSecs: number;
  /** Single-target TX channel name (broadcast_on_channel); '' = primary channel. */
  broadcastOnChannelName: string;
  /** Base64 PSK for the single-target TX channel. */
  broadcastOnChannelPsk: string;
  /** Config.LoRaConfig.RegionCode for the single-target TX; 0 = use running config. */
  broadcastOnRegion: number;
  /** Config.LoRaConfig.ModemPreset for the single-target TX, or null = running config. */
  broadcastOnPreset: number | null;
  /**
   * Multi-target broadcast list. When non-empty the device sends one beacon per
   * entry, each on that entry's preset/region/channel; when empty the single
   * broadcast_on_* fields are used instead.
   */
  broadcastTargets: BroadcastTarget[];
}

/** Firmware minimum for broadcast_interval_secs (module_config.proto:920-923). */
export const MESH_BEACON_MIN_INTERVAL_SECS = 3600;

/** MeshBeaconConfig.Flags bit values (module_config.proto). */
export const MESH_BEACON_FLAGS = {
  NONE: 0,
  LISTEN_ENABLED: 1,
  BROADCAST_ENABLED: 2,
  LEGACY_SPLIT: 4,
} as const;

/** Pack the three booleans back into the wire `flags` bitfield. */
export function packMeshBeaconFlags(
  state: Pick<MeshBeaconConfigState, 'listenEnabled' | 'broadcastEnabled' | 'legacySplit'>
): number {
  return (state.listenEnabled ? MESH_BEACON_FLAGS.LISTEN_ENABLED : 0)
    | (state.broadcastEnabled ? MESH_BEACON_FLAGS.BROADCAST_ENABLED : 0)
    | (state.legacySplit ? MESH_BEACON_FLAGS.LEGACY_SPLIT : 0);
}

/** Unpack a wire `flags` bitfield into the three booleans. */
export function unpackMeshBeaconFlags(
  flags: number | undefined
): Pick<MeshBeaconConfigState, 'listenEnabled' | 'broadcastEnabled' | 'legacySplit'> {
  const f = flags ?? 0;
  return {
    listenEnabled: (f & MESH_BEACON_FLAGS.LISTEN_ENABLED) !== 0,
    broadcastEnabled: (f & MESH_BEACON_FLAGS.BROADCAST_ENABLED) !== 0,
    legacySplit: (f & MESH_BEACON_FLAGS.LEGACY_SPLIT) !== 0,
  };
}

/**
 * Normalise a `bytes` PSK from a decoded module config into base64 for display.
 *
 * The generic load-config route hands back the decoded protobuf object verbatim
 * (unlike the channel routes, which base64 it server-side), so the same field
 * can arrive as an already-base64 string, a JSON-serialised Uint8Array
 * (`{"0":1,"1":2,…}`), or a JSON-serialised Buffer (`{type:'Buffer',data:[…]}`).
 * Returns '' for absent/unrecognised input rather than throwing — a malformed
 * PSK should render as empty, not break the whole config load.
 */
export function pskToBase64(psk: unknown): string {
  if (!psk) return '';
  if (typeof psk === 'string') return psk;

  let bytes: number[] | null = null;
  if (Array.isArray(psk)) {
    bytes = psk as number[];
  } else if (psk instanceof Uint8Array) {
    bytes = Array.from(psk);
  } else if (typeof psk === 'object') {
    const obj = psk as Record<string, unknown>;
    if (Array.isArray(obj.data)) {
      bytes = obj.data as number[]; // {type:'Buffer', data:[…]}
    } else {
      // JSON-serialised Uint8Array: numeric keys in index order.
      const keys = Object.keys(obj);
      if (keys.length > 0 && keys.every((k) => /^\d+$/.test(k))) {
        bytes = keys
          .sort((a, b) => Number(a) - Number(b))
          .map((k) => Number(obj[k]));
      }
    }
  }

  if (!bytes || bytes.some((b) => !Number.isInteger(b) || b < 0 || b > 255)) return '';
  return btoa(String.fromCharCode(...bytes));
}

/**
 * Build the wire config object sent to `setModuleConfig('meshbeacon', ...)` from
 * the editor state. Shared by the local (ConfigurationTab) and remote-admin
 * (AdminCommandsTab) surfaces so the omit-logic lives in exactly one place.
 *
 * The omit rules mirror the proto semantics:
 * - `offer_channel` / `broadcast_on_channel` are whole ChannelSettings
 *   sub-messages: sent only when a name is present. A blank name means "no
 *   channel", not a nameless one.
 * - `offer_preset` / `broadcast_on_preset` are `optional`: null is omitted so the
 *   device reads "no preset", which differs from sending 0 (LONG_FAST).
 * - a target's `preset` / `channelIndex` are `optional`: null is dropped so the
 *   device falls back to the running config for that field.
 * - `broadcast_targets` is always included (even when empty) so removing every
 *   target actually clears the list on the device rather than leaving stale rows.
 */
export function buildMeshBeaconConfigPayload(
  beacon: MeshBeaconConfigState
): Record<string, unknown> {
  const config: Record<string, unknown> = {
    // The three checkboxes are one bitfield on the wire.
    flags: packMeshBeaconFlags(beacon),
    broadcastMessage: beacon.broadcastMessage,
    broadcastSendAsNode: beacon.broadcastSendAsNode,
    broadcastOfferRegion: beacon.broadcastOfferRegion,
    broadcastIntervalSecs: beacon.broadcastIntervalSecs,
    broadcastOnRegion: beacon.broadcastOnRegion,
    broadcastTargets: beacon.broadcastTargets.map((target) => {
      const entry: Record<string, unknown> = { region: target.region };
      if (target.preset !== null) entry.preset = target.preset;
      if (target.channelIndex !== null) entry.channelIndex = target.channelIndex;
      return entry;
    }),
  };

  if (beacon.broadcastOfferChannelName.trim().length > 0) {
    config.broadcastOfferChannel = {
      name: beacon.broadcastOfferChannelName,
      ...(beacon.broadcastOfferChannelPsk ? { psk: beacon.broadcastOfferChannelPsk } : {}),
    };
  }

  if (beacon.broadcastOnChannelName.trim().length > 0) {
    config.broadcastOnChannel = {
      name: beacon.broadcastOnChannelName,
      ...(beacon.broadcastOnChannelPsk ? { psk: beacon.broadcastOnChannelPsk } : {}),
    };
  }

  // `optional` fields: omit to advertise/use no preset. Sending 0 would mean
  // LONG_FAST, a different statement.
  if (beacon.broadcastOfferPreset !== null) {
    config.broadcastOfferPreset = beacon.broadcastOfferPreset;
  }
  if (beacon.broadcastOnPreset !== null) {
    config.broadcastOnPreset = beacon.broadcastOnPreset;
  }

  return config;
}

/**
 * Parse a decoded MeshBeacon module config (as returned by the load-config
 * route) into editor state. Shared by both surfaces. Uses `??`, not `||`, so a
 * genuine 0 (e.g. UNSET region) survives, and keeps `optional` presets as null
 * when absent rather than collapsing them to LONG_FAST.
 */
export function parseMeshBeaconConfig(
  config: Record<string, unknown> | null | undefined
): Partial<MeshBeaconConfigState> {
  if (!config) return {};
  // The decoded protobuf is loosely typed; narrow each field rather than
  // reaching through `any`. A number survives (0 included); anything else falls
  // back to the default / null.
  const num = (value: unknown, fallback: number): number =>
    typeof value === 'number' ? value : fallback;
  const numOrNull = (value: unknown): number | null =>
    typeof value === 'number' ? value : null;
  const str = (value: unknown): string => (typeof value === 'string' ? value : '');
  const asRecord = (value: unknown): Record<string, unknown> =>
    (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;

  const offerChannel = asRecord(config.broadcastOfferChannel);
  const onChannel = asRecord(config.broadcastOnChannel);
  const rawTargets: unknown[] = Array.isArray(config.broadcastTargets) ? config.broadcastTargets : [];
  return {
    ...unpackMeshBeaconFlags(num(config.flags, 0)),
    broadcastMessage: str(config.broadcastMessage),
    broadcastSendAsNode: num(config.broadcastSendAsNode, 0),
    broadcastOfferChannelName: str(offerChannel.name),
    broadcastOfferChannelPsk: pskToBase64(offerChannel.psk),
    broadcastOfferRegion: num(config.broadcastOfferRegion, 0),
    // `optional` — absent means "advertise no preset", not LONG_FAST.
    broadcastOfferPreset: numOrNull(config.broadcastOfferPreset),
    // Firmware default/minimum is 3600; absence reads as that rather than 0.
    broadcastIntervalSecs: num(config.broadcastIntervalSecs, 0) || MESH_BEACON_MIN_INTERVAL_SECS,
    broadcastOnChannelName: str(onChannel.name),
    broadcastOnChannelPsk: pskToBase64(onChannel.psk),
    broadcastOnRegion: num(config.broadcastOnRegion, 0),
    broadcastOnPreset: numOrNull(config.broadcastOnPreset),
    broadcastTargets: rawTargets.map((raw) => {
      const target = asRecord(raw);
      return {
        preset: numOrNull(target.preset),
        region: num(target.region, 0),
        channelIndex: numOrNull(target.channelIndex),
      };
    }),
  };
}

// Combined Admin Commands State
export interface AdminCommandsState {
  lora: LoRaConfigState;
  position: PositionConfigState;
  mqtt: MQTTConfigState;
  security: SecurityConfigState;
  bluetooth: BluetoothConfigState;
  network: NetworkConfigState;
  neighborInfo: NeighborInfoConfigState;
  owner: OwnerConfigState;
  device: DeviceConfigState;
  telemetry: TelemetryConfigState;
  statusMessage: StatusMessageConfigState;
  trafficManagement: TrafficManagementConfigState;
  meshBeacon: MeshBeaconConfigState;
}

// Action types
type AdminCommandsAction =
  | { type: 'SET_LORA_CONFIG'; payload: Partial<LoRaConfigState> }
  | { type: 'SET_POSITION_CONFIG'; payload: Partial<PositionConfigState> }
  | { type: 'SET_POSITION_FLAGS'; payload: Partial<PositionConfigState['positionFlags']> }
  | { type: 'SET_MQTT_CONFIG'; payload: Partial<MQTTConfigState> }
  | { type: 'SET_SECURITY_CONFIG'; payload: Partial<SecurityConfigState> }
  | { type: 'SET_BLUETOOTH_CONFIG'; payload: Partial<BluetoothConfigState> }
  | { type: 'SET_NETWORK_CONFIG'; payload: Partial<NetworkConfigState> }
  | { type: 'SET_NEIGHBORINFO_CONFIG'; payload: Partial<NeighborInfoConfigState> }
  | { type: 'SET_OWNER_CONFIG'; payload: Partial<OwnerConfigState> }
  | { type: 'SET_DEVICE_CONFIG'; payload: Partial<DeviceConfigState> }
  | { type: 'SET_TELEMETRY_CONFIG'; payload: Partial<TelemetryConfigState> }
  | { type: 'SET_STATUSMESSAGE_CONFIG'; payload: Partial<StatusMessageConfigState> }
  | { type: 'SET_TRAFFICMANAGEMENT_CONFIG'; payload: Partial<TrafficManagementConfigState> }
  | { type: 'SET_MESHBEACON_CONFIG'; payload: Partial<MeshBeaconConfigState> }
  | { type: 'SET_ADMIN_KEY'; payload: { index: number; value: string } }
  | { type: 'ADD_ADMIN_KEY' }
  | { type: 'REMOVE_ADMIN_KEY'; payload: number }
  | { type: 'RESET_ALL' };

const initialState: AdminCommandsState = {
  lora: {
    usePreset: true,
    modemPreset: 0,
    bandwidth: 250,
    spreadFactor: 11,
    codingRate: 8,
    frequencyOffset: 0,
    overrideFrequency: 0,
    region: 0,
    hopLimit: 3,
    txPower: 0,
    channelNum: 0,
    femLnaMode: 0, // FEM_LNA_Mode DISABLED (proto3 zero/default; firmware >= v2.7.20)
    sx126xRxBoostedGain: false,
    ignoreMqtt: false,
    configOkToMqtt: false,
    txEnabled: true,  // Default to true - never accidentally disable transmission
    overrideDutyCycle: false,
    paFanDisabled: false,
  },
  position: {
    positionBroadcastSecs: 900,
    positionSmartEnabled: true,
    fixedPosition: false,
    fixedLatitude: 0,
    fixedLongitude: 0,
    fixedAltitude: 0,
    gpsUpdateInterval: 30,
    rxGpio: undefined,
    txGpio: undefined,
    gpsEnGpio: undefined,
    broadcastSmartMinimumDistance: 50,
    broadcastSmartMinimumIntervalSecs: 30,
    gpsMode: 1,
    positionFlags: {
      altitude: false,
      altitudeMsl: false,
      geoidalSeparation: false,
      dop: false,
      hvdop: false,
      satinview: false,
      seqNo: false,
      timestamp: false,
      heading: false,
      speed: false,
    },
  },
  mqtt: {
    enabled: false,
    address: '',
    username: '',
    password: '',
    encryptionEnabled: true,
    jsonEnabled: false,
    root: '',
  },
  security: {
    adminKeys: [''],
    isManaged: false,
    serialEnabled: false,
    debugLogApiEnabled: false,
    adminChannelEnabled: false,
    loadedForNodeNum: null,
  },
  bluetooth: {
    enabled: false,
    mode: 0,
    fixedPin: 0,
  },
  network: {
    wifiEnabled: false,
    wifiSsid: '',
    wifiPsk: '',
    ntpServer: '',
    addressMode: 0,
    ipv4Address: '',
    ipv4Gateway: '',
    ipv4Subnet: '',
    ipv4Dns: '',
  },
  neighborInfo: {
    enabled: false,
    updateInterval: 14400,
    transmitOverLora: false,
  },
  owner: {
    longName: '',
    shortName: '',
    isUnmessagable: false,
    isLicensed: false,
  },
  device: {
    role: 0,
    nodeInfoBroadcastSecs: 3600,
    rebroadcastMode: 0,
    tzdef: '',
    doubleTapAsButtonPress: false,
    disableTripleClick: false,
    ledHeartbeatDisabled: false,
    buzzerMode: 0,
    buttonGpio: 0,
    buzzerGpio: 0,
  },
  telemetry: {
    deviceUpdateInterval: 900,
    deviceTelemetryEnabled: false,
    environmentUpdateInterval: 900,
    environmentMeasurementEnabled: false,
    environmentScreenEnabled: false,
    environmentDisplayFahrenheit: false,
    airQualityEnabled: false,
    airQualityInterval: 900,
    powerMeasurementEnabled: false,
    powerUpdateInterval: 900,
    powerScreenEnabled: false,
    healthMeasurementEnabled: false,
    healthUpdateInterval: 900,
    healthScreenEnabled: false,
  },
  statusMessage: {
    nodeStatus: '',
  },
  trafficManagement: {
    enabled: false,
    positionDedupEnabled: false,
    positionPrecisionBits: 0,
    positionMinIntervalSecs: 0,
    nodeinfoDirectResponse: false,
    nodeinfoDirectResponseMaxHops: 0,
    rateLimitEnabled: false,
    rateLimitWindowSecs: 0,
    rateLimitMaxPackets: 0,
    dropUnknownEnabled: false,
    unknownPacketThreshold: 0,
    exhaustHopTelemetry: false,
    exhaustHopPosition: false,
    routerPreserveHops: false,
  },
  meshBeacon: {
    listenEnabled: false,
    broadcastEnabled: false,
    legacySplit: false,
    broadcastMessage: '',
    broadcastSendAsNode: 0,
    broadcastOfferChannelName: '',
    broadcastOfferChannelPsk: '',
    broadcastOfferRegion: 0,
    broadcastOfferPreset: null,
    broadcastIntervalSecs: MESH_BEACON_MIN_INTERVAL_SECS,
    broadcastOnChannelName: '',
    broadcastOnChannelPsk: '',
    broadcastOnRegion: 0,
    broadcastOnPreset: null,
    broadcastTargets: [],
  },
};

function adminCommandsReducer(state: AdminCommandsState, action: AdminCommandsAction): AdminCommandsState {
  switch (action.type) {
    case 'SET_LORA_CONFIG':
      return {
        ...state,
        lora: { ...state.lora, ...action.payload },
      };
    case 'SET_POSITION_CONFIG':
      return {
        ...state,
        position: { ...state.position, ...action.payload },
      };
    case 'SET_POSITION_FLAGS':
      return {
        ...state,
        position: {
          ...state.position,
          positionFlags: { ...state.position.positionFlags, ...action.payload },
        },
      };
    case 'SET_MQTT_CONFIG':
      return {
        ...state,
        mqtt: { ...state.mqtt, ...action.payload },
      };
    case 'SET_SECURITY_CONFIG':
      return {
        ...state,
        security: { ...state.security, ...action.payload },
      };
    case 'SET_BLUETOOTH_CONFIG':
      return {
        ...state,
        bluetooth: { ...state.bluetooth, ...action.payload },
      };
    case 'SET_NETWORK_CONFIG':
      return {
        ...state,
        network: { ...state.network, ...action.payload },
      };
    case 'SET_NEIGHBORINFO_CONFIG':
      return {
        ...state,
        neighborInfo: { ...state.neighborInfo, ...action.payload },
      };
    case 'SET_OWNER_CONFIG':
      return {
        ...state,
        owner: { ...state.owner, ...action.payload },
      };
    case 'SET_DEVICE_CONFIG':
      return {
        ...state,
        device: { ...state.device, ...action.payload },
      };
    case 'SET_TELEMETRY_CONFIG':
      return {
        ...state,
        telemetry: { ...state.telemetry, ...action.payload },
      };
    case 'SET_STATUSMESSAGE_CONFIG':
      return {
        ...state,
        statusMessage: { ...state.statusMessage, ...action.payload },
      };
    case 'SET_TRAFFICMANAGEMENT_CONFIG':
      return {
        ...state,
        trafficManagement: { ...state.trafficManagement, ...action.payload },
      };
    case 'SET_MESHBEACON_CONFIG':
      return {
        ...state,
        meshBeacon: { ...state.meshBeacon, ...action.payload },
      };
    case 'SET_ADMIN_KEY':
      const newKeys = [...state.security.adminKeys];
      newKeys[action.payload.index] = action.payload.value;
      return {
        ...state,
        security: { ...state.security, adminKeys: newKeys },
      };
    case 'ADD_ADMIN_KEY':
      if (state.security.adminKeys.length < 3) {
        return {
          ...state,
          security: { ...state.security, adminKeys: [...state.security.adminKeys, ''] },
        };
      }
      return state;
    case 'REMOVE_ADMIN_KEY':
      if (state.security.adminKeys.length > 1) {
        const keys = state.security.adminKeys.filter((_, i) => i !== action.payload);
        return {
          ...state,
          security: { ...state.security, adminKeys: keys },
        };
      }
      return state;
    case 'RESET_ALL':
      return initialState;
    default:
      return state;
  }
}

/**
 * Hook to manage admin commands state with useReducer
 * Consolidates 50+ useState calls into organized state management
 */
export function useAdminCommandsState() {
  const [state, dispatch] = useReducer(adminCommandsReducer, initialState);

  // LoRa config actions
  const setLoRaConfig = useCallback((config: Partial<LoRaConfigState>) => {
    dispatch({ type: 'SET_LORA_CONFIG', payload: config });
  }, []);

  // Position config actions
  const setPositionConfig = useCallback((config: Partial<PositionConfigState>) => {
    dispatch({ type: 'SET_POSITION_CONFIG', payload: config });
  }, []);

  const setPositionFlags = useCallback((flags: Partial<PositionConfigState['positionFlags']>) => {
    dispatch({ type: 'SET_POSITION_FLAGS', payload: flags });
  }, []);

  // Helper to load position config from API response
  const loadPositionConfig = useCallback((config: any) => {
    const positionConfig: Partial<PositionConfigState> = {};
    if (config.positionBroadcastSecs !== undefined) positionConfig.positionBroadcastSecs = config.positionBroadcastSecs;
    if (config.positionBroadcastSmartEnabled !== undefined) positionConfig.positionSmartEnabled = config.positionBroadcastSmartEnabled;
    if (config.fixedPosition !== undefined) positionConfig.fixedPosition = config.fixedPosition;
    if (config.fixedLatitude !== undefined) positionConfig.fixedLatitude = config.fixedLatitude;
    if (config.fixedLongitude !== undefined) positionConfig.fixedLongitude = config.fixedLongitude;
    if (config.fixedAltitude !== undefined) positionConfig.fixedAltitude = config.fixedAltitude;
    if (config.gpsUpdateInterval !== undefined) positionConfig.gpsUpdateInterval = config.gpsUpdateInterval;
    if (config.rxGpio !== undefined) positionConfig.rxGpio = config.rxGpio;
    if (config.txGpio !== undefined) positionConfig.txGpio = config.txGpio;
    if (config.gpsEnGpio !== undefined) positionConfig.gpsEnGpio = config.gpsEnGpio;
    if (config.broadcastSmartMinimumDistance !== undefined) positionConfig.broadcastSmartMinimumDistance = config.broadcastSmartMinimumDistance;
    if (config.broadcastSmartMinimumIntervalSecs !== undefined) positionConfig.broadcastSmartMinimumIntervalSecs = config.broadcastSmartMinimumIntervalSecs;
    if (config.gpsMode !== undefined) positionConfig.gpsMode = config.gpsMode;
    if (config.positionFlags !== undefined) {
      const decodedFlags = decodePositionFlags(config.positionFlags);
      positionConfig.positionFlags = decodedFlags;
    }
    setPositionConfig(positionConfig);
  }, [setPositionConfig]);

  // MQTT config actions
  const setMQTTConfig = useCallback((config: Partial<MQTTConfigState>) => {
    dispatch({ type: 'SET_MQTT_CONFIG', payload: config });
  }, []);

  // Security config actions
  const setSecurityConfig = useCallback((config: Partial<SecurityConfigState>) => {
    dispatch({ type: 'SET_SECURITY_CONFIG', payload: config });
  }, []);

  const setAdminKey = useCallback((index: number, value: string) => {
    dispatch({ type: 'SET_ADMIN_KEY', payload: { index, value } });
  }, []);

  const addAdminKey = useCallback(() => {
    dispatch({ type: 'ADD_ADMIN_KEY' });
  }, []);

  const removeAdminKey = useCallback((index: number) => {
    dispatch({ type: 'REMOVE_ADMIN_KEY', payload: index });
  }, []);

  // Bluetooth config actions
  const setBluetoothConfig = useCallback((config: Partial<BluetoothConfigState>) => {
    dispatch({ type: 'SET_BLUETOOTH_CONFIG', payload: config });
  }, []);

  // Network config actions
  const setNetworkConfig = useCallback((config: Partial<NetworkConfigState>) => {
    dispatch({ type: 'SET_NETWORK_CONFIG', payload: config });
  }, []);

  // NeighborInfo config actions
  const setNeighborInfoConfig = useCallback((config: Partial<NeighborInfoConfigState>) => {
    dispatch({ type: 'SET_NEIGHBORINFO_CONFIG', payload: config });
  }, []);

  // Owner config actions
  const setOwnerConfig = useCallback((config: Partial<OwnerConfigState>) => {
    dispatch({ type: 'SET_OWNER_CONFIG', payload: config });
  }, []);

  // Device config actions
  const setDeviceConfig = useCallback((config: Partial<DeviceConfigState>) => {
    dispatch({ type: 'SET_DEVICE_CONFIG', payload: config });
  }, []);

  // Telemetry config actions
  const setTelemetryConfig = useCallback((config: Partial<TelemetryConfigState>) => {
    dispatch({ type: 'SET_TELEMETRY_CONFIG', payload: config });
  }, []);

  // StatusMessage config actions
  const setStatusMessageConfig = useCallback((config: Partial<StatusMessageConfigState>) => {
    dispatch({ type: 'SET_STATUSMESSAGE_CONFIG', payload: config });
  }, []);

  // TrafficManagement config actions
  const setTrafficManagementConfig = useCallback((config: Partial<TrafficManagementConfigState>) => {
    dispatch({ type: 'SET_TRAFFICMANAGEMENT_CONFIG', payload: config });
  }, []);

  // MeshBeacon config actions (firmware 2.8+, #3854)
  const setMeshBeaconConfig = useCallback((config: Partial<MeshBeaconConfigState>) => {
    dispatch({ type: 'SET_MESHBEACON_CONFIG', payload: config });
  }, []);

  // Reset all configs
  const resetAll = useCallback(() => {
    dispatch({ type: 'RESET_ALL' });
  }, []);

  return {
    state,
    // LoRa
    setLoRaConfig,
    // Position
    setPositionConfig,
    setPositionFlags,
    loadPositionConfig,
    // MQTT
    setMQTTConfig,
    // Security
    setSecurityConfig,
    setAdminKey,
    addAdminKey,
    removeAdminKey,
    // Bluetooth
    setBluetoothConfig,
    // Network
    setNetworkConfig,
    // NeighborInfo
    setNeighborInfoConfig,
    // Owner
    setOwnerConfig,
    // Device
    setDeviceConfig,
    // Telemetry
    setTelemetryConfig,
    // StatusMessage
    setStatusMessageConfig,
    // TrafficManagement
    setTrafficManagementConfig,
    // MeshBeacon
    setMeshBeaconConfig,
    // Reset
    resetAll,
  };
}

