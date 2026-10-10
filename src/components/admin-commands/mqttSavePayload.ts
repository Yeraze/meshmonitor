import type { MQTTConfigState } from './useAdminCommandsState';

/**
 * The MQTTConfig a Save sends: the remote-admin form (`setMQTTConfig`) and the
 * local Device Configuration form (`POST /api/config/mqtt`) both build it here.
 *
 * Firmware replaces the node's whole MQTT struct with this message, so it must
 * name every MQTTConfig field (module_config.proto, tags 1-11). A field left out
 * reaches the node as false / 0 / empty. Map report settings go out even while
 * map reporting is off, so turning it back on later finds the old values.
 */
export interface AdminMqttSavePayload {
  enabled: boolean;
  address: string;
  username: string;
  password: string;
  encryptionEnabled: boolean;
  jsonEnabled: boolean;
  tlsEnabled: boolean;
  root: string;
  proxyToClientEnabled: boolean;
  mapReportingEnabled: boolean;
  mapReportSettings: {
    publishIntervalSecs: number;
    positionPrecision: number;
    shouldReportLocation: boolean;
  };
}

/** The form fields the payload is built from (the local form has no load gate). */
export type MqttSaveFields = Omit<MQTTConfigState, 'loadedForNodeNum'>;

export function buildAdminMqttSavePayload(mqtt: MqttSaveFields): AdminMqttSavePayload {
  return {
    enabled: mqtt.enabled,
    address: mqtt.address,
    username: mqtt.username,
    password: mqtt.password,
    encryptionEnabled: mqtt.encryptionEnabled,
    jsonEnabled: mqtt.jsonEnabled,
    tlsEnabled: mqtt.tlsEnabled,
    root: mqtt.root,
    proxyToClientEnabled: mqtt.proxyToClientEnabled,
    mapReportingEnabled: mqtt.mapReportingEnabled,
    mapReportSettings: {
      publishIntervalSecs: mqtt.mapPublishIntervalSecs,
      positionPrecision: mqtt.mapPositionPrecision,
      shouldReportLocation: mqtt.mapShouldReportLocation,
    },
  };
}
