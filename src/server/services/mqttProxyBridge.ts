/**
 * MQTT proxy bridge helpers (issue #3003 follow-up).
 *
 * Pure, side-effect-free helpers used by MeshtasticManager's MQTT
 * device↔broker link (`setupMqttLink`/`handleDeviceMqttProxyMessage`/
 * `handleLinkedBrokerLocalPacket`) to suppress echo loops when a device is
 * bridged to an embedded/standalone MQTT broker in both directions.
 *
 * #3962 Phase 4.2a PR2 (task42a_spec.md §4a): only the pure module-tail
 * helpers move here. The manager methods that wire event listeners on the
 * linked broker and reach back into manager packet handling stay on
 * MeshtasticManager — see the PR2 report for why the full method move was
 * not done (six private state fields + a self-referencing listener callback
 * would require exposing a wide surface of previously-private manager state).
 */
import meshtasticProtobufService from '../meshtasticProtobufService.js';
import { PortNum } from '../constants/meshtastic.js';

/**
 * Determines if a packet should be excluded from the packet log.
 * Internal packets (ADMIN_APP and ROUTING_APP) to/from the local node are excluded
 * since they are management traffic, not actual mesh traffic.
 *
 * @param fromNum - Source node number
 * @param toNum - Destination node number (null for broadcast)
 * @param portnum - Port number indicating packet type
 * @param localNodeNum - The local node's number (null if not connected)
 * @returns true if the packet should be excluded from logging
 */
export function shouldExcludeFromPacketLog(
  fromNum: number,
  toNum: number | null,
  portnum: number,
  localNodeNum: number | null
): boolean {
  // If we don't know the local node, can't determine if it's local traffic
  if (!localNodeNum) return false;

  // Check if packet is to/from the local node
  const isLocalPacket = fromNum === localNodeNum || toNum === localNodeNum;

  // Check if it's an internal portnum (ROUTING_APP or ADMIN_APP)
  const isInternalPortnum = portnum === PortNum.ROUTING_APP || portnum === PortNum.ADMIN_APP;

  return isLocalPacket && isInternalPortnum;
}

/**
 * Determines if a packet is a "phantom" internal state update from the local device.
 * These are packets the Meshtastic device sends to TCP clients to report its internal
 * state, but they are NOT actual RF transmissions. They should not be logged as "TX"
 * packets because they clutter the packet log and don't represent actual mesh traffic.
 *
 * Phantom packets are identified by:
 * - from_node === localNodeNum (originated from local device)
 * - transport_mechanism === INTERNAL (0) or undefined
 * - hop_start === 0 or undefined (hasn't traveled any hops)
 *
 * @param fromNum - Source node number
 * @param localNodeNum - The local node's number (null if not connected)
 * @param transportMechanism - Transport mechanism from the packet (0 = INTERNAL)
 * @param hopStart - Hop start value from the packet
 * @returns true if the packet is a phantom internal state update
 */
export function isPhantomInternalPacket(
  fromNum: number,
  localNodeNum: number | null,
  transportMechanism: number | undefined,
  hopStart: number | undefined
): boolean {
  // If we don't know the local node, can't determine if it's local traffic
  if (!localNodeNum) return false;

  // Must be from the local node
  if (fromNum !== localNodeNum) return false;

  // Transport mechanism must be INTERNAL (0) or undefined
  // Note: TransportMechanism.INTERNAL === 0
  const isInternalTransport = transportMechanism === undefined || transportMechanism === 0;
  if (!isInternalTransport) return false;

  // Hop start must be 0 or undefined (hasn't traveled any hops)
  const hasNotTraveled = hopStart === undefined || hopStart === 0;
  if (!hasNotTraveled) return false;

  return true;
}

/** One recorded echo: which topic/packetId pair was just sent, and when the
 *  suppression window for it expires. */
export interface MqttEchoEntry {
  topic: string;
  packetId: number;
  expiresAt: number;
}

/** Max number of in-flight echo entries retained per direction (oldest evicted first). */
export const MQTT_LINK_ECHO_MAX = 256;

/** How long an echo suppression entry remains valid. */
export const MQTT_LINK_ECHO_TTL_MS = 60_000;

/**
 * Decode a raw MQTT payload just far enough to read the packet id, without
 * emitting decode-failure warnings — proxy payloads on broad topics often
 * are not ServiceEnvelopes at all (firmware can publish to any topic), so a
 * failed decode here is an expected, quiet no-op rather than a WARN.
 */
export function peekServiceEnvelopePacketId(payload: Uint8Array): number | null {
  const decoded = meshtasticProtobufService.decodeServiceEnvelope(payload, { quiet: true });
  if (!decoded || typeof decoded.packet?.id !== 'number') return null;
  return decoded.packet.id >>> 0;
}

/**
 * Record that (topic, packetId) was just forwarded in one direction, so the
 * opposite-direction handler can recognize and drop its echo. Evicts expired
 * entries (FIFO by insertion order, since expiresAt is monotonically
 * increasing) and caps the store at {@link MQTT_LINK_ECHO_MAX}.
 */
export function recordMqttEcho(
  store: MqttEchoEntry[],
  topic: string,
  packetId: number | null,
): void {
  if (packetId === null) return;
  const now = Date.now();
  while (store.length > 0 && store[0].expiresAt < now) store.shift();
  if (store.length >= MQTT_LINK_ECHO_MAX) store.shift();
  store.push({ topic, packetId, expiresAt: now + MQTT_LINK_ECHO_TTL_MS });
}

/**
 * True if (topic, packetId) was recorded (and not yet expired) by
 * {@link recordMqttEcho} on the opposite-direction store — i.e. this message
 * is an echo of one MeshMonitor itself just forwarded, and should be dropped
 * rather than re-forwarded again (which would loop).
 */
export function matchesMqttEcho(
  store: MqttEchoEntry[],
  topic: string,
  packetId: number,
): boolean {
  const now = Date.now();
  while (store.length > 0 && store[0].expiresAt < now) store.shift();
  return store.some((e) => e.topic === topic && e.packetId === packetId);
}
