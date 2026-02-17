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
}

// Device Config State
export interface DeviceConfigState {
  role: number;
  nodeInfoBroadcastSecs: number;
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

// Traffic Management Config State
export interface TrafficManagementConfigState {
  enabled: boolean;
  positionDedupEnabled: boolean;
  positionDedupTimeSecs: number;
  positionDedupDistanceMeters: number;
  nodeinfoDirectResponseEnabled: boolean;
  nodeinfoDirectResponseMyNodeOnly: boolean;
  rateLimitEnabled: boolean;
  rateLimitMaxPerNode: number;
  rateLimitWindowSecs: number;
  unknownPacketDropEnabled: boolean;
  unknownPacketGracePeriodSecs: number;
  hopExhaustionEnabled: boolean;
  hopExhaustionMinHops: number;
  hopExhaustionMaxHops: number;
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
  },
  device: {
    role: 0,
    nodeInfoBroadcastSecs: 3600,
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
    positionDedupTimeSecs: 0,
    positionDedupDistanceMeters: 0,
    nodeinfoDirectResponseEnabled: false,
    nodeinfoDirectResponseMyNodeOnly: false,
    rateLimitEnabled: false,
    rateLimitMaxPerNode: 0,
    rateLimitWindowSecs: 0,
    unknownPacketDropEnabled: false,
    unknownPacketGracePeriodSecs: 0,
    hopExhaustionEnabled: false,
    hopExhaustionMinHops: 0,
    hopExhaustionMaxHops: 0,
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
    // Reset
    resetAll,
  };
}

