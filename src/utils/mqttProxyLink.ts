/**
 * "Client proxy is on, but nothing carries the MQTT traffic" (#5013).
 *
 * With `mqtt.proxy_to_client_enabled` the node opens no broker connection of
 * its own; it hands every publish to its client and expects the client to feed
 * broker traffic back. MeshMonitor does that only through the source's
 * `mqttLink`. With no usable link the node hears MQTT traffic only when some
 * other node repeats it over LoRa.
 *
 * One rule, three callers, so they cannot disagree:
 *   - Device → MQTT (`MQTTConfigSection`), against the form's unsaved values;
 *   - `GET /api/sources/:id/status`, against the device's cached config, which
 *     feeds the warning on the dashboard source card;
 *   - the tests.
 *
 * Shared by the server and the browser: keep it free of imports.
 */

/** Docs section the warnings link to. */
export const MQTT_TRAFFIC_DOCS_URL = 'https://meshmonitor.org/features/mqtt-broker#why-no-mqtt-traffic';

/** The slice of a source row the rule reads. */
export interface MqttProxyLinkSource {
  id: string;
  type: string;
  /**
   * `false` = disabled, so no manager runs and a link to it attaches to
   * nothing. Absent or `null` reads as enabled: only an explicit `false`
   * makes a link target unusable.
   */
  enabled?: boolean | null;
  config?: unknown;
}

export interface MqttProxyLinkInput {
  /** `mqtt.enabled` on the device. Proxy mode does nothing while MQTT is off. */
  mqttEnabled: boolean;
  /** `mqtt.proxy_to_client_enabled` on the device. */
  proxyToClientEnabled: boolean;
  /** The node's own source. */
  sourceId: string | null | undefined;
  /** Every configured source, to resolve the link target. */
  sources: readonly MqttProxyLinkSource[];
  /**
   * True when a client on this source's Virtual Node has injected MQTT proxy
   * traffic on its current connection — the MQTT Proxy sidecar, or a phone app
   * carrying MQTT. That client carries MQTT for the node, so nothing is wrong.
   * False proves nothing: a proxy client on a quiet broker has sent nothing yet.
   */
  proxyClientAttached?: boolean;
}

/** Source types an `mqttLink` may point at (#3134). */
const LINK_TARGET_TYPES: readonly string[] = ['mqtt_broker', 'mqtt_bridge'];

function readLink(config: unknown): { enabled?: unknown; mqttBrokerSourceId?: unknown } | undefined {
  if (!config || typeof config !== 'object') return undefined;
  const link = (config as { mqttLink?: unknown }).mqttLink;
  return link && typeof link === 'object' ? (link as { enabled?: unknown; mqttBrokerSourceId?: unknown }) : undefined;
}

export function isMqttProxyLinkMisconfigured(input: MqttProxyLinkInput): boolean {
  if (!input.mqttEnabled || !input.proxyToClientEnabled) return false;
  if (!input.sourceId) return false;
  const parent = input.sources.find((s) => s.id === input.sourceId);
  // Only a Meshtastic node source can hold an mqttLink.
  if (!parent || parent.type !== 'meshtastic_tcp') return false;
  if (input.proxyClientAttached) return false;

  const link = readLink(parent.config);
  if (link?.enabled !== true) return true;
  if (typeof link.mqttBrokerSourceId !== 'string' || link.mqttBrokerSourceId === '') return true;
  const target = input.sources.find((s) => s.id === link.mqttBrokerSourceId);
  // Deleted, the wrong kind of source, or switched off.
  if (!target || !LINK_TARGET_TYPES.includes(target.type)) return true;
  return target.enabled === false;
}
