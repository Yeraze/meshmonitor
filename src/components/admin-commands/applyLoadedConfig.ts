/**
 * One place that turns a `/api/admin/load-config` reply into form state.
 *
 * The Admin Commands tab loads a node's config two ways: "Load all configs" and
 * the per-section Load button. Each used to carry its own copy of the
 * reply-to-state mapping, and the copies drifted: `statusmessage`,
 * `trafficmanagement` and `meshbeacon` were added to "load all" only. The
 * per-section button fetched the reply, dropped it, and still marked the
 * section loaded, so the form kept its defaults and the next Save wrote them
 * over the node's real config. (#5077 was the same fault for `security`.)
 *
 * Both paths now call `applyLoadedConfig`. `CONFIG_APPLIERS` is a
 * `Record<LoadConfigType, …>`, so a section added to `LOAD_CONFIG_TYPES` with no
 * applier fails to compile, and a section with no applier is never reported as
 * loaded.
 */
import { decodePositionFlags } from '../../utils/positionFlags';
import { normalizeTakConfig } from '../../utils/takConfig';
import {
  buildSecurityConfigUpdates,
  parseMeshBeaconConfig,
  type BluetoothConfigState,
  type DeviceConfigState,
  type LoRaConfigState,
  type MeshBeaconConfigState,
  type MQTTConfigState,
  type NeighborInfoConfigState,
  type NetworkConfigState,
  type PositionConfigState,
  type SecurityConfigState,
  type StatusMessageConfigState,
  type TAKConfigState,
  type TelemetryConfigState,
  type TrafficManagementConfigState,
} from './useAdminCommandsState';

/**
 * Sections served by `/api/admin/load-config`, in the order "Load all configs"
 * asks for them.
 */
export const LOAD_CONFIG_TYPES = [
  'device',
  'lora',
  'position',
  'mqtt',
  'security',
  'bluetooth',
  'network',
  'neighborinfo',
  'telemetry',
  'statusmessage',
  'trafficmanagement',
  'meshbeacon',
  'tak',
] as const;

export type LoadConfigType = (typeof LOAD_CONFIG_TYPES)[number];

/**
 * Every section with a Load button. `owner` and `channels` have their own
 * endpoints and loaders; the rest go through `applyLoadedConfig`.
 */
export const ADMIN_LOAD_SECTIONS = [...LOAD_CONFIG_TYPES, 'owner', 'channels'] as const;

export type AdminLoadSection = (typeof ADMIN_LOAD_SECTIONS)[number];

export type SectionLoadState = 'idle' | 'loading' | 'success' | 'error';

/** A status map with every section set to `state`. */
export function allSectionStatus(state: SectionLoadState): Record<string, SectionLoadState> {
  return Object.fromEntries(ADMIN_LOAD_SECTIONS.map(section => [section, state]));
}

export function isLoadConfigType(configType: string): configType is LoadConfigType {
  return (LOAD_CONFIG_TYPES as readonly string[]).includes(configType);
}

/** The state setters from `useAdminCommandsState` that a load writes to. */
export interface LoadedConfigSetters {
  setDeviceConfig: (config: Partial<DeviceConfigState>) => void;
  setLoRaConfig: (config: Partial<LoRaConfigState>) => void;
  setPositionConfig: (config: Partial<PositionConfigState>) => void;
  setMQTTConfig: (config: Partial<MQTTConfigState>) => void;
  setSecurityConfig: (config: Partial<SecurityConfigState>) => void;
  setBluetoothConfig: (config: Partial<BluetoothConfigState>) => void;
  setNetworkConfig: (config: Partial<NetworkConfigState>) => void;
  setNeighborInfoConfig: (config: Partial<NeighborInfoConfigState>) => void;
  setTelemetryConfig: (config: Partial<TelemetryConfigState>) => void;
  setStatusMessageConfig: (config: Partial<StatusMessageConfigState>) => void;
  setTrafficManagementConfig: (config: Partial<TrafficManagementConfigState>) => void;
  setMeshBeaconConfig: (config: Partial<MeshBeaconConfigState>) => void;
  setTAKConfig: (config: Partial<TAKConfigState>) => void;
}

export interface LoadedConfigContext {
  /** The node the reply came from; stamps the security Save gate (#4736). */
  nodeNum: number | null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the load-config reply is untyped protobuf JSON
type RawConfig = any;

type ConfigApplier = (config: RawConfig, setters: LoadedConfigSetters, context: LoadedConfigContext) => void;

export const CONFIG_APPLIERS: Record<LoadConfigType, ConfigApplier> = {
  device: (config, { setDeviceConfig }) => {
    setDeviceConfig({
      role: config.role,
      nodeInfoBroadcastSecs: config.nodeInfoBroadcastSecs,
      rebroadcastMode: config.rebroadcastMode ?? 0,
      tzdef: config.tzdef ?? '',
      doubleTapAsButtonPress: config.doubleTapAsButtonPress ?? false,
      disableTripleClick: config.disableTripleClick ?? false,
      ledHeartbeatDisabled: config.ledHeartbeatDisabled ?? false,
      buzzerMode: config.buzzerMode ?? 0,
      buttonGpio: config.buttonGpio ?? 0,
      buzzerGpio: config.buzzerGpio ?? 0,
    });
  },

  lora: (config, { setLoRaConfig }) => {
    setLoRaConfig({
      usePreset: config.usePreset,
      modemPreset: config.modemPreset,
      bandwidth: config.bandwidth,
      spreadFactor: config.spreadFactor,
      codingRate: config.codingRate,
      frequencyOffset: config.frequencyOffset,
      overrideFrequency: config.overrideFrequency,
      region: config.region,
      hopLimit: config.hopLimit,
      txPower: config.txPower,
      channelNum: config.channelNum,
      // FEM_LNA_Mode: proto3 elides the zero value, so default undefined to 0 (DISABLED)
      femLnaMode: config.femLnaMode ?? 0,
      sx126xRxBoostedGain: config.sx126xRxBoostedGain,
      ignoreMqtt: config.ignoreMqtt,
      configOkToMqtt: config.configOkToMqtt,
      // Default true only when genuinely absent; reflect an explicit device `false` (#4294)
      txEnabled: config.txEnabled !== false,
      overrideDutyCycle: config.overrideDutyCycle ?? false,
      paFanDisabled: config.paFanDisabled ?? false,
    });
  },

  position: (config, { setPositionConfig }) => {
    const positionConfig: Partial<PositionConfigState> = {
      positionBroadcastSecs: config.positionBroadcastSecs,
      positionSmartEnabled: config.positionBroadcastSmartEnabled ?? config.positionSmartEnabled,
      fixedPosition: config.fixedPosition,
      fixedLatitude: config.fixedLatitude,
      fixedLongitude: config.fixedLongitude,
      fixedAltitude: config.fixedAltitude,
      gpsUpdateInterval: config.gpsUpdateInterval,
      rxGpio: config.rxGpio,
      txGpio: config.txGpio,
      broadcastSmartMinimumDistance: config.broadcastSmartMinimumDistance,
      broadcastSmartMinimumIntervalSecs: config.broadcastSmartMinimumIntervalSecs,
      gpsEnGpio: config.gpsEnGpio,
      gpsMode: config.gpsMode,
    };
    if (config.positionFlags !== undefined) {
      positionConfig.positionFlags = decodePositionFlags(config.positionFlags);
    }
    setPositionConfig(positionConfig);
  },

  mqtt: (config, { setMQTTConfig }) => {
    setMQTTConfig({
      enabled: config.enabled,
      address: config.address,
      username: config.username,
      password: config.password,
      encryptionEnabled: config.encryptionEnabled,
      jsonEnabled: config.jsonEnabled,
      root: config.root,
    });
  },

  security: (config, { setSecurityConfig }, { nodeNum }) => {
    const { adminKeys, updates } = buildSecurityConfigUpdates(config, nodeNum);
    if (adminKeys) setSecurityConfig({ adminKeys });
    setSecurityConfig(updates);
  },

  bluetooth: (config, { setBluetoothConfig }) => {
    setBluetoothConfig({
      enabled: config.enabled,
      mode: config.mode,
      fixedPin: config.fixedPin,
    });
  },

  network: (config, { setNetworkConfig }) => {
    const ipv4 = config.ipv4Config || {};
    setNetworkConfig({
      wifiEnabled: config.wifiEnabled || false,
      wifiSsid: config.wifiSsid || '',
      wifiPsk: config.wifiPsk || '',
      ntpServer: config.ntpServer || '',
      addressMode: config.addressMode || 0,
      ipv4Address: ipv4.ip || '',
      ipv4Gateway: ipv4.gateway || '',
      ipv4Subnet: ipv4.subnet || '',
      ipv4Dns: ipv4.dns || '',
    });
  },

  neighborinfo: (config, { setNeighborInfoConfig }) => {
    setNeighborInfoConfig({
      enabled: config.enabled,
      updateInterval: config.updateInterval,
      transmitOverLora: config.transmitOverLora,
    });
  },

  telemetry: (config, { setTelemetryConfig }) => {
    setTelemetryConfig({
      deviceUpdateInterval: config.deviceUpdateInterval ?? 900,
      deviceTelemetryEnabled: config.deviceTelemetryEnabled ?? false,
      environmentUpdateInterval: config.environmentUpdateInterval ?? 900,
      environmentMeasurementEnabled: config.environmentMeasurementEnabled ?? false,
      environmentScreenEnabled: config.environmentScreenEnabled ?? false,
      environmentDisplayFahrenheit: config.environmentDisplayFahrenheit ?? false,
      airQualityEnabled: config.airQualityEnabled ?? false,
      airQualityInterval: config.airQualityInterval ?? 900,
      powerMeasurementEnabled: config.powerMeasurementEnabled ?? false,
      powerUpdateInterval: config.powerUpdateInterval ?? 900,
      powerScreenEnabled: config.powerScreenEnabled ?? false,
      healthMeasurementEnabled: config.healthMeasurementEnabled ?? false,
      healthUpdateInterval: config.healthUpdateInterval ?? 900,
      healthScreenEnabled: config.healthScreenEnabled ?? false,
    });
  },

  statusmessage: (config, { setStatusMessageConfig }) => {
    setStatusMessageConfig({
      nodeStatus: config.nodeStatus ?? '',
    });
  },

  trafficmanagement: (config, { setTrafficManagementConfig }) => {
    setTrafficManagementConfig({
      positionMinIntervalSecs: config.positionMinIntervalSecs ?? 0,
      nodeinfoDirectResponseMaxHops: config.nodeinfoDirectResponseMaxHops ?? 0,
      rateLimitWindowSecs: config.rateLimitWindowSecs ?? 0,
      rateLimitMaxPackets: config.rateLimitMaxPackets ?? 0,
      unknownPacketThreshold: config.unknownPacketThreshold ?? 0,
    });
  },

  meshbeacon: (config, { setMeshBeaconConfig }) => {
    // Shared parser owns the load-time normalisation (flags, optional
    // presets, UNSET regions, targets) — see parseMeshBeaconConfig.
    setMeshBeaconConfig(parseMeshBeaconConfig(config));
  },

  tak: (config, { setTAKConfig }) => {
    setTAKConfig(normalizeTakConfig(config));
  },
};

/**
 * Write a load-config reply into form state.
 *
 * Returns `false`, and writes nothing, when there is no reply to apply or the
 * section has no applier. The caller must then leave the section not-loaded: a
 * section that shows "loaded" over default values invites a Save that wipes the
 * node's config.
 */
export function applyLoadedConfig(
  configType: string,
  config: unknown,
  setters: LoadedConfigSetters,
  context: LoadedConfigContext,
): boolean {
  if (!config || typeof config !== 'object') return false;
  if (!isLoadConfigType(configType)) return false;
  CONFIG_APPLIERS[configType](config, setters, context);
  return true;
}
