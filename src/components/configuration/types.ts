export interface DeviceConfig {
  longName: string;
  shortName: string;
  role: number;
  nodeInfoBroadcastSecs: number;
  modemPreset: number;
  region: number;
  hopLimit: number;
  fixedLatitude: number;
  fixedLongitude: number;
  fixedAltitude: number;
  positionBroadcastSecs: number;
  positionBroadcastSmartEnabled: boolean;
  mqttEnabled: boolean;
  mqttAddress: string;
  mqttUsername: string;
  mqttPassword: string;
  mqttEncryptionEnabled: boolean;
  mqttJsonEnabled: boolean;
  mqttRoot: string;
}

export interface ConfigurationSectionProps {
  onSave?: () => void;
  onError?: (error: string) => void;
}
