/**
 * Which way MQTT traffic moves through a source (#5794 Phase 2), for the
 * badge on its dashboard card.
 *
 * A bridge moves traffic only between its upstream server and what sits
 * behind it: a parent broker, or a node source whose `mqttLink` points at it.
 * With neither, everything it receives is stored and goes nowhere else, so it
 * reads "Monitor only" whatever its mode says (docs/features/mqtt-setups.md).
 *
 * The rule sees only the sources the viewer may read. A link from a hidden
 * source is not counted, so the badge never reveals that one exists.
 *
 * "Downlink" means MeshMonitor hands upstream packets to the local side. Only a
 * node with Downlink Enabled on the channel puts them on the air, and the
 * badge cannot see that setting.
 */

export type MqttBridgeModeValue = 'bidirectional' | 'publish_only' | 'subscribe_only';

export type MqttDirection = 'monitor' | 'uplink' | 'downlink' | 'both' | 'local' | 'client_proxy';

/** The slice of a source row the rule reads. */
export interface MqttDirectionSource {
  id: string;
  type: string;
  enabled?: boolean | null;
  config?: unknown;
}

const MODES: readonly string[] = ['bidirectional', 'publish_only', 'subscribe_only'];

function field(obj: unknown, key: string): unknown {
  return obj && typeof obj === 'object' ? (obj as Record<string, unknown>)[key] : undefined;
}

/** The `mqttLink` target of a node source, or null when the link is off. */
export function mqttLinkTarget(source: MqttDirectionSource): string | null {
  if (source.type !== 'meshtastic_tcp' || source.enabled === false) return null;
  const link = field(source.config, 'mqttLink');
  const target = field(link, 'mqttBrokerSourceId');
  return field(link, 'enabled') === true && typeof target === 'string' && target !== '' ? target : null;
}

/**
 * A bridge's mode, or null when the viewer cannot know it. The live status
 * carries it for every viewer. The saved config withholds it from non-admins
 * and drops it when it is the default, so a missing value means
 * `bidirectional` only for an admin.
 */
export function resolveBridgeMode(
  source: MqttDirectionSource,
  statusMode: unknown,
  isAdmin: boolean,
): MqttBridgeModeValue | null {
  if (typeof statusMode === 'string' && MODES.includes(statusMode)) return statusMode as MqttBridgeModeValue;
  if (!isAdmin) return null;
  const mode = field(source.config, 'mode');
  if (mode === undefined || mode === null) return 'bidirectional';
  return typeof mode === 'string' && MODES.includes(mode) ? (mode as MqttBridgeModeValue) : null;
}

function bridgeDirection(
  bridge: MqttDirectionSource,
  mode: MqttBridgeModeValue,
  sources: readonly MqttDirectionSource[],
): MqttDirection {
  const parent = field(bridge.config, 'brokerSourceId');
  const hasLocalSide =
    (typeof parent === 'string' && parent !== '') || sources.some((s) => mqttLinkTarget(s) === bridge.id);
  if (!hasLocalSide) return mode === 'publish_only' ? 'uplink' : 'monitor';
  if (mode === 'publish_only') return 'uplink';
  if (mode === 'subscribe_only') return 'downlink';
  return 'both';
}

/**
 * The badge for one source, or null when it has none or its direction is
 * unknown. `modeOf` returns a bridge's resolved mode (see `resolveBridgeMode`).
 */
export function getMqttDirection(
  source: MqttDirectionSource,
  sources: readonly MqttDirectionSource[],
  modeOf: (bridge: MqttDirectionSource) => MqttBridgeModeValue | null,
): MqttDirection | null {
  switch (source.type) {
    case 'meshcore_mqtt':
    case 'meshcore_mqtt_broker':
      // MeshCore MQTT sources only receive; nothing they hear can reach a radio.
      return 'monitor';
    case 'meshtastic_tcp':
      return mqttLinkTarget(source) ? 'client_proxy' : null;
    case 'mqtt_bridge': {
      const mode = modeOf(source);
      return mode ? bridgeDirection(source, mode, sources) : null;
    }
    case 'mqtt_broker': {
      // A broker relays between whatever connects to it. Its bridges decide
      // whether anything crosses to or from an upstream server.
      let up = false;
      let down = false;
      for (const s of sources) {
        if (s.type !== 'mqtt_bridge' || s.enabled === false || field(s.config, 'brokerSourceId') !== source.id) continue;
        const mode = modeOf(s);
        if (mode === null) return null;
        if (mode !== 'subscribe_only') up = true;
        if (mode !== 'publish_only') down = true;
      }
      return up && down ? 'both' : up ? 'uplink' : down ? 'downlink' : 'local';
    }
    default:
      return null;
  }
}
