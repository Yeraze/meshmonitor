/**
 * Shared types for ConfigurationTab components
 */

export interface RoleOption {
  value: number;
  name: string;
  shortDesc: string;
  description: string;
}

export interface ModemPresetOption {
  value: number;
  name: string;
  description: string;
  params: string;
}

export interface RegionOption {
  value: number;
  label: string;
}

export interface ConfigSectionProps {
  isSaving: boolean;
  onSave: () => Promise<void>;
}

export interface NodeIdentityData {
  longName: string;
  shortName: string;
}

export interface DeviceConfigData {
  role: number;
  nodeInfoBroadcastSecs: number;
}

export interface LoRaConfigData {
  usePreset: boolean;
  modemPreset: number;
  region: number;
  hopLimit: number;
}

export interface PositionConfigData {
  positionBroadcastSecs: number;
  positionSmartEnabled: boolean;
  fixedPosition: boolean;
  fixedLatitude: number;
  fixedLongitude: number;
  fixedAltitude: number;
}

export interface MQTTConfigData {
  mqttEnabled: boolean;
  mqttAddress: string;
  mqttUsername: string;
  mqttPassword: string;
  mqttEncryptionEnabled: boolean;
  mqttJsonEnabled: boolean;
  mqttRoot: string;
}

export interface NeighborInfoConfigData {
  neighborInfoEnabled: boolean;
  neighborInfoInterval: number;
}
