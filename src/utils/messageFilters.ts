import { MeshMessage } from '../types/message.js';

/**
 * Text patterns used to recognise MQTT/bridge status lines in messages that
 * predate the `viaMqtt` packet field. This is a heuristic of last resort — a
 * bare substring/regex match over the message body — so it is only consulted
 * for legacy messages where `viaMqtt` is absent. See {@link isMqttBridgeMessage}.
 */
const MQTT_TEXT_PATTERNS: Array<string | RegExp> = [
  'mqtt.',
  'areyoumeshingwith.us',
  /^\d+\.\d+\.\d+\.[a-f0-9]+$/, // Version patterns like "2.5.7.f77c87d"
  /^\/.*\.(js|css|proto|html)/, // File paths
  /^[A-Z]{2,3}[�\x00-\x1F\x7F-\xFF]+/, // Garbage data patterns
];

/**
 * Detect MQTT/bridge messages that should be hidden from the chat UI when the
 * user has "Show MQTT messages" disabled.
 *
 * Resolution order:
 *  1. `viaMqtt === true` → definitely a bridge message.
 *  2. Unknown sender → hide (we have no node identity to attribute it to).
 *  3. `viaMqtt` present but false → authoritative: this is a genuine mesh
 *     packet, never run the text heuristic on it.
 *  4. `viaMqtt` absent (legacy message) → fall back to the text-pattern
 *     heuristic in {@link MQTT_TEXT_PATTERNS}.
 *
 * Step 3 exists because the text heuristic does a bare substring match — e.g.
 * a body containing `areyoumeshingwith.us` — and produces false positives on
 * legitimate message text (issue #4751: `map.areyoumeshingwith.us` is a real
 * URL a user typed, not a bridge status line). Trusting the `viaMqtt` flag
 * whenever the packet carries it removes that whole class of false positives.
 */
export function isMqttBridgeMessage(msg: MeshMessage): boolean {
  // Primary check: use the viaMqtt field from the packet if available
  if (msg.viaMqtt === true) {
    return true;
  }

  // Filter messages from unknown senders
  if (msg.from === 'unknown' || msg.fromNodeId === 'unknown') {
    return true;
  }

  // A modern packet that carries viaMqtt === false is authoritative — do not
  // second-guess it with the substring heuristic below (issue #4751).
  if (msg.viaMqtt !== undefined) {
    return false;
  }

  // Legacy fallback for messages that predate the viaMqtt field.
  return MQTT_TEXT_PATTERNS.some(pattern => {
    if (typeof pattern === 'string') {
      return msg.text.includes(pattern);
    }
    return pattern.test(msg.text);
  });
}
