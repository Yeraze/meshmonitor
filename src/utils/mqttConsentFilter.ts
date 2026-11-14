/**
 * Shared bits of the per-source anonymous-viewer MQTT-consent filter (#5156).
 * Server: src/server/utils/mqttConsentVisibility.ts. UI:
 * src/components/settings/AnonMqttConsentSection.tsx.
 */

/** Per-source setting key. Default off (no row). */
export const ANON_HIDE_MQTT_NO_CONSENT_SETTING = 'anonHideMqttNoConsent';

/** True when a stored setting value means "on". */
export function isAnonHideFlagOn(raw: string | null | undefined): boolean {
  return raw === '1' || raw === 'true';
}

/**
 * Source types the filter can act on: the Meshtastic ones, where packets
 * carry an `ok_to_mqtt` bit. MeshCore and Reticulum have no such bit.
 */
export function isMqttConsentFilterSourceType(sourceType: string | null | undefined): boolean {
  if (!sourceType) return false;
  return !['meshcore', 'meshcore_mqtt', 'reticulum'].includes(sourceType);
}
