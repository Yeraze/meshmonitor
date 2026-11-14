/**
 * Wire format for MQTT-native send (#4305).
 *
 * A send is one `meshtastic.ServiceEnvelope` published (not retained) to
 *   `{root}/2/e/{channelId}/{gatewayId}`
 * where `channelId` is the channel NAME for a channel packet, or `PKI` for a
 * PKI direct message, and `gatewayId` is our own `!xxxxxxxx` node id — the
 * same topic a firmware gateway uses when it uplinks its own packet with
 * MQTT encryption on. The envelope carries the encrypted `MeshPacket`:
 *   from = our node num, to, id (random 32-bit), channel = channel hash (0 for
 *   PKI), hop_limit = hop_start = the configured hop limit, want_ack = false
 *   (no radio here to retry), pki_encrypted for DMs, encrypted = ciphertext.
 * `via_mqtt` stays unset: the downlinking gateway sets it, as for any packet
 * it pulls off the broker.
 */
import { getProtobufRoot } from '../../protobufLoader.js';
import meshtasticProtobufService from '../../meshtasticProtobufService.js';
import {
  DATA_BITFIELD_OK_TO_MQTT,
  DEVICE_ROLE_CLIENT_MUTE,
  HW_MODEL_PRIVATE_HW,
} from '../../constants/meshtastic.js';

/** `!xxxxxxxx` for a node number. */
export function nodeIdFromNum(nodeNum: number): string {
  return `!${(nodeNum >>> 0).toString(16).padStart(8, '0')}`;
}

/**
 * Normalize an admin-supplied MQTT root (`msh/US/FL`). Trims, drops trailing
 * slashes and a trailing `/2/e` or `/2/e/...`, and refuses wildcards, empty
 * values, and anything with a NUL. Returns null when unusable.
 */
export function normalizeRootTopic(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let root = raw.trim();
  if (!root || root.length > 200 || root.includes('\0')) return null;
  if (root.includes('+') || root.includes('#')) return null;
  root = root.replace(/\/+$/, '');
  const idx = root.indexOf('/2/e');
  if (idx >= 0 && (root.length === idx + 4 || root[idx + 4] === '/')) root = root.slice(0, idx);
  root = root.replace(/\/+$/, '');
  if (!root || root.startsWith('/') || root.includes('//')) return null;
  return root;
}

/**
 * Best-effort root from a bridge's subscription list: the part of the first
 * subscription before `/#`, `/2/...`, or a `+` level. `msh/US/FL/#` gives
 * `msh/US/FL`. Null when nothing usable is there; the admin then sets the
 * root explicitly.
 */
export function deriveRootTopicFromSubscriptions(subscriptions: readonly string[] | undefined): string | null {
  const first = subscriptions?.find((s) => typeof s === 'string' && s.trim().length > 0);
  if (!first) return null;
  const levels = first.trim().split('/');
  const kept: string[] = [];
  for (const level of levels) {
    if (level === '#' || level === '+' || level === '2') break;
    kept.push(level);
  }
  return normalizeRootTopic(kept.join('/'));
}

/** Topic a send is published on. */
export function buildMqttNativeTopic(root: string, channelId: string, gatewayId: string): string {
  return `${root}/2/e/${channelId}/${gatewayId}`;
}

function requireRoot() {
  const root = getProtobufRoot();
  if (!root) throw new Error('Protobuf definitions not loaded');
  return root;
}

/** Serialize a `meshtastic.Data`. ok_to_mqtt is set: we originate on MQTT. */
export function encodeDataMessage(input: {
  portnum: number;
  payload: Uint8Array;
  replyId?: number;
  emoji?: number;
}): Uint8Array {
  const Data = requireRoot().lookupType('meshtastic.Data');
  const fields: Record<string, unknown> = {
    portnum: input.portnum,
    payload: input.payload,
    bitfield: DATA_BITFIELD_OK_TO_MQTT,
  };
  if (input.replyId) fields.replyId = input.replyId >>> 0;
  if (input.emoji) fields.emoji = input.emoji;
  return Data.encode(Data.create(fields)).finish();
}

/** Serialize the `meshtastic.User` our NodeInfo announce carries. */
export function encodeUserMessage(input: {
  nodeNum: number;
  longName: string;
  shortName: string;
  publicKey: Buffer;
}): Uint8Array {
  const User = requireRoot().lookupType('meshtastic.User');
  return User.encode(
    User.create({
      id: nodeIdFromNum(input.nodeNum),
      longName: input.longName,
      shortName: input.shortName,
      hwModel: HW_MODEL_PRIVATE_HW,
      role: DEVICE_ROLE_CLIENT_MUTE,
      publicKey: input.publicKey,
    }),
  ).finish();
}

export interface MqttNativeEnvelopeInput {
  from: number;
  to: number;
  id: number;
  /** Channel hash (0-255) for a channel packet, 0 for PKI. */
  channel: number;
  hopLimit: number;
  encrypted: Uint8Array;
  pkiEncrypted: boolean;
  /** ServiceEnvelope.channel_id: channel name, or `PKI`. */
  channelId: string;
  /** ServiceEnvelope.gateway_id: our own node id. */
  gatewayId: string;
}

/** Serialize the ServiceEnvelope a send publishes. */
export function encodeMqttNativeEnvelope(input: MqttNativeEnvelopeInput): Buffer {
  const packet: Record<string, unknown> = {
    from: input.from >>> 0,
    to: input.to >>> 0,
    id: input.id >>> 0,
    channel: input.channel,
    encrypted: input.encrypted,
    hopLimit: input.hopLimit,
    hopStart: input.hopLimit,
    wantAck: false,
  };
  if (input.pkiEncrypted) packet.pkiEncrypted = true;
  const bytes = meshtasticProtobufService.encodeServiceEnvelope({
    packet,
    channelId: input.channelId,
    gatewayId: input.gatewayId,
  });
  if (!bytes) throw new Error('Failed to encode ServiceEnvelope');
  return Buffer.from(bytes);
}
