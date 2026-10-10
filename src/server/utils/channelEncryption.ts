/**
 * Channel-encrypt an outgoing packet in MeshMonitor, before it reaches the radio
 * (Reliable PKI "Avoid PKI" mode, #5711).
 *
 * Why MeshMonitor has to do this itself: the radio PKI-encrypts every unicast it
 * originates to a node whose key it holds, except TRACEROUTE / NODEINFO /
 * ROUTING / POSITION (firmware `Router.cpp` `wouldEncryptWithPKC`). A client
 * cannot opt out: `pki_encrypted = false` is the default and is ignored, and the
 * old "secondary channel skips PKI" exception (2.5/2.6) was removed in 2.7. But
 * `Router::send` only encodes packets that arrive `decoded`; a packet handed to
 * it already `encrypted` goes out as is (the path relayed packets take). So
 * MeshMonitor encrypts the `Data` with the channel key exactly as
 * `perhapsEncode` would, and gives the radio the ciphertext.
 *
 * Everything here mirrors the firmware:
 *   - key:   `Channels::getKey` (shorthand PSK expansion, zero padding, a
 *            secondary with no PSK borrows the primary's key);
 *   - name:  `Channels::getName` (empty name -> modem preset name, or "Custom");
 *   - hash:  `Channels::generateHash` = xor(name) ^ xor(key);
 *   - cipher: AES-CTR, nonce = packetId (u64 LE) | fromNode (u32 LE) | 0
 *            (`CryptoEngine::initNonce`);
 *   - Data:  `perhapsEncode` sets `bitfield` (ok_to_mqtt, want_response) on
 *            packets we originate.
 *
 * Anything this cannot reproduce exactly returns a reason instead of a packet,
 * and the caller sends the packet the normal way.
 */
import { createCipheriv } from 'node:crypto';
import { MODEM_PRESET_CHANNEL_NAMES } from '../../utils/loraFrequency.js';

/** Firmware `defaultpsk` (Channels.h), used for every 1-byte shorthand PSK. */
const DEFAULT_PSK = Buffer.from([
  0xd4, 0xf1, 0xbb, 0x3a, 0x20, 0x29, 0x07, 0x59,
  0xf0, 0xbc, 0xff, 0xab, 0xcf, 0x4e, 0x69, 0x01,
]);

/** `meshtastic.Channel.Role` */
const ROLE_DISABLED = 0;
const ROLE_PRIMARY = 1;
const ROLE_SECONDARY = 2;

/** `Data.bitfield` bits the firmware sets on packets it originates (mesh.proto). */
const BITFIELD_OK_TO_MQTT = 1 << 0;
const BITFIELD_WANT_RESPONSE = 1 << 1;

/** One channel slot exactly as the radio reported it on this connection. */
export interface RadioChannel {
  index: number;
  role: number;
  /** Raw `ChannelSettings.name` — empty when the radio uses the default name. */
  name: string;
  /** Raw `ChannelSettings.psk` bytes (0, 1, 16 or 32 bytes; firmware pads others). */
  psk: Uint8Array;
  useAead: boolean;
}

export interface RadioLoraInfo {
  usePreset?: boolean;
  modemPreset?: number;
  configOkToMqtt?: boolean;
}

export interface ChannelKey {
  /** Expanded AES key; empty when the channel is unencrypted. */
  key: Buffer;
  /** On-air channel hash (`MeshPacket.channel` of an encrypted packet). */
  hash: number;
}

export type ChannelKeyResult = { ok: true; channelKey: ChannelKey } | { ok: false; reason: string };

function xorHash(bytes: Uint8Array): number {
  let h = 0;
  for (const b of bytes) h ^= b;
  return h & 0xff;
}

/** `Channels::getKey`. Returns null for a disabled / missing slot. */
function expandKey(index: number, channels: ReadonlyMap<number, RadioChannel>, depth = 0): Buffer | null {
  const ch = channels.get(index);
  if (!ch || ch.role === ROLE_DISABLED) return null;
  const psk = Buffer.from(ch.psk);
  if (psk.length === 0) {
    if (ch.role === ROLE_SECONDARY && depth === 0) {
      const primary = [...channels.values()].find((c) => c.role === ROLE_PRIMARY);
      const primaryIndex = primary?.index ?? 0;
      if (primaryIndex !== index) return expandKey(primaryIndex, channels, depth + 1);
    }
    return Buffer.alloc(0); // encryption turned off
  }
  if (psk.length === 1) {
    const pskIndex = psk[0];
    if (pskIndex === 0) return Buffer.alloc(0);
    const key = Buffer.from(DEFAULT_PSK);
    key[15] = (key[15] + pskIndex - 1) & 0xff;
    return key;
  }
  if (psk.length === 16 || psk.length === 32) return psk;
  // A short key is zero-padded to AES-128 / AES-256.
  const padded = Buffer.alloc(psk.length < 16 ? 16 : 32);
  psk.copy(padded, 0, 0, Math.min(psk.length, padded.length));
  return padded;
}

/** `Channels::getName`. Null when the default name cannot be worked out. */
function channelName(ch: RadioChannel, lora: RadioLoraInfo | null | undefined): string | null {
  if (ch.name) return ch.name;
  if (!lora) return null;
  if (lora.usePreset !== true) return 'Custom';
  if (typeof lora.modemPreset !== 'number') return null;
  return MODEM_PRESET_CHANNEL_NAMES[lora.modemPreset] ?? null;
}

/**
 * Key and on-air hash for channel `index`, from the radio's own channel list.
 * Fails (with a reason) for anything MeshMonitor cannot reproduce exactly.
 */
export function resolveChannelKey(
  index: number,
  channels: ReadonlyMap<number, RadioChannel>,
  lora: RadioLoraInfo | null | undefined,
): ChannelKeyResult {
  const ch = channels.get(index);
  if (!ch) return { ok: false, reason: `channel ${index} not reported by the radio on this connection` };
  if (ch.role === ROLE_DISABLED) return { ok: false, reason: `channel ${index} is disabled` };
  // AES-CCM channels (#5248) use a different cipher and hash; not reproduced here.
  if (ch.useAead) return { ok: false, reason: `channel ${index} uses AEAD` };
  const key = expandKey(index, channels);
  if (!key) return { ok: false, reason: `channel ${index} has no usable key` };
  const name = channelName(ch, lora);
  if (name === null) return { ok: false, reason: `channel ${index} name unknown (LoRa config not received)` };
  const hash = xorHash(Buffer.from(name, 'utf8')) ^ xorHash(key);
  // The radio treats channel 0 on a phone packet as "not set" and swaps in a
  // channel index (Router::sendLocal), which would corrupt the hash.
  if (hash === 0) return { ok: false, reason: `channel ${index} hashes to 0` };
  return { ok: true, channelKey: { key, hash } };
}

/** AES-CTR as `CryptoEngine::encryptPacket`. An empty key leaves the bytes as is. */
export function encryptChannelPayload(key: Buffer, packetId: number, fromNode: number, plaintext: Uint8Array): Buffer {
  if (key.length === 0) return Buffer.from(plaintext);
  const nonce = Buffer.alloc(16);
  nonce.writeUInt32LE(packetId >>> 0, 0);
  nonce.writeUInt32LE(0, 4);
  nonce.writeUInt32LE(fromNode >>> 0, 8);
  nonce.writeUInt32LE(0, 12);
  const cipher = createCipheriv(key.length === 32 ? 'aes-256-ctr' : 'aes-128-ctr', key, nonce);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

/** Minimal slice of the protobufjs root this needs. */
interface ProtoType {
  decode(data: Uint8Array): unknown;
  encode(message: unknown): { finish(): Uint8Array };
  create(props: Record<string, unknown>): unknown;
}
interface ProtoRoot {
  lookupType(name: string): ProtoType;
}

/**
 * Turn an encoded `ToRadio{ packet: { decoded } }` into the same packet with its
 * `Data` channel-encrypted. Returns null when the frame is not a decoded
 * unicast with a packet id (the nonce needs the id the radio will send).
 */
export function channelEncryptToRadio(
  root: ProtoRoot,
  toRadioBytes: Uint8Array,
  channelKey: ChannelKey,
  fromNode: number,
  okToMqtt: boolean,
): Uint8Array | null {
  const ToRadio = root.lookupType('meshtastic.ToRadio');
  const Data = root.lookupType('meshtastic.Data');
  const MeshPacket = root.lookupType('meshtastic.MeshPacket');
  const toRadio = ToRadio.decode(toRadioBytes) as { packet?: Record<string, unknown> };
  const packet = toRadio.packet;
  if (!packet || !packet.decoded) return null;
  const id = Number(packet.id ?? 0) >>> 0;
  const to = Number(packet.to ?? 0) >>> 0;
  // The radio replaces id 0 with its own, which would break the nonce.
  if (!id || !to || to === 0xffffffff) return null;

  const decoded = packet.decoded as Record<string, unknown>;
  let bitfield = Number(decoded.bitfield ?? 0) >>> 0;
  if (okToMqtt) bitfield |= BITFIELD_OK_TO_MQTT;
  if (decoded.wantResponse) bitfield |= BITFIELD_WANT_RESPONSE;
  const plaintext = Data.encode(Data.create({ ...decoded, bitfield })).finish();
  const encrypted = encryptChannelPayload(channelKey.key, id, fromNode, plaintext);

  const { decoded: _decoded, ...rest } = packet;
  const encryptedPacket = MeshPacket.create({ ...rest, channel: channelKey.hash, encrypted });
  return ToRadio.encode(ToRadio.create({ packet: encryptedPacket })).finish();
}
