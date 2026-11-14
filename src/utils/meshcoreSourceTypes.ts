/**
 * Source-type predicates for the MQTT-fed MeshCore sources.
 *
 * Two source types carry MeshCore traffic that other observers heard, with no
 * radio of their own:
 *
 * - `meshcore_mqtt` (#5040) subscribes to an external Analyzer broker.
 * - `meshcore_mqtt_broker` (#6197) runs an embedded broker that observers
 *   publish to directly.
 *
 * Both feed the same ingest pipeline, so every read surface that handles one
 * should handle the other. Gate on these predicates instead of comparing the
 * type string by hand, so a third MQTT-fed type is one edit here.
 *
 * Never use these to grant a transmit, device or admin path: neither type can
 * transmit on RF.
 */

export const MESHCORE_MQTT_FED_SOURCE_TYPES = ['meshcore_mqtt', 'meshcore_mqtt_broker'] as const;

export type MeshCoreMqttFedSourceType = (typeof MESHCORE_MQTT_FED_SOURCE_TYPES)[number];

/** True for a radio-less MeshCore source fed by MQTT (ingest client or embedded broker). */
export function isMeshCoreMqttFedSourceType(
  type: string | undefined | null,
): type is MeshCoreMqttFedSourceType {
  return type === 'meshcore_mqtt' || type === 'meshcore_mqtt_broker';
}

/** True for the embedded MeshCore MQTT broker source (#6197). */
export function isMeshCoreMqttBrokerSourceType(type: string | undefined | null): boolean {
  return type === 'meshcore_mqtt_broker';
}
