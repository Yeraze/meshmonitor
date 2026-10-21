/**
 * Decides whether a received MeshPacket proves which channel its sender is on
 * (#5923).
 *
 * `nodes.channel` drives the per-channel node list, the node details page,
 * `channel_N:viewOnMap` visibility, and the channel MeshMonitor picks for DMs,
 * traceroutes and position requests. It must only move when the radio
 * decrypted the sender's own traffic with that channel's key. Before #5923
 * every firmware-decoded packet moved it, but several decoded packets carry a
 * `channel` the sender never used:
 *
 *  - **PKI packets.** Firmware's `Router::perhapsDecode` leaves `chIndex` at 0
 *    after a PKI decrypt and then stores `p->channel = chIndex`, so a PKI DM or
 *    PKI ACK reports channel 0 without any channel key. A node that only talks
 *    to us by PKI was put on slot 0, which is a private channel on any radio
 *    whose primary is private.
 *  - **Firmware 2.8 NodeDB replays.** `PhoneAPI::makeReplay*Packet` fills
 *    `pkt.channel = header->channel`, the device's NodeDB value, which firmware
 *    only refreshes from NodeInfo. A replay is not a reception. The NodeInfo
 *    sync path already refuses to overwrite a stored channel with that value;
 *    a replay is the same value dressed as a packet.
 *  - **Spoofed zero-hop replies.** Firmware 2.8's TrafficManagementModule
 *    answers a NodeInfo request for a cached node itself: it sets
 *    `reply->from = p->to` (the target) and `reply->channel = p->channel`
 *    (the request's channel), with hop_start = hop_limit = 0. So a relay that
 *    holds a private key can answer, on that private channel, for a node that
 *    does not. Router::send stamps the relay's own byte into `relay_node`, so
 *    a zero-hop packet whose relay byte is not the sender's was transmitted
 *    by someone else.
 *  - **MQTT envelopes injected through the Virtual Node's MQTT proxy.** Those
 *    never touched our radio; a plaintext envelope's `channel` is the
 *    uplinking gateway's slot (or a channel hash), not ours.
 *
 * Anything outside 0..MAX_CHANNEL_INDEX is a channel hash, never an index.
 */
import { MAX_CHANNEL_INDEX } from '../constants/meshtastic.js';
import { isFirmwareReplayPacket } from './replayGuard.js';

export interface ChannelEvidencePacket {
  from?: number | string | null;
  id?: number | null;
  channel?: number | null;
  rxTime?: number | string | null;
  hopStart?: number | null;
  hopLimit?: number | null;
  relayNode?: number | null;
  viaMqtt?: boolean | null;
  pkiEncrypted?: boolean | null;
  pki_encrypted?: boolean | null;
}

export interface ChannelEvidenceContext {
  /** How the packet was decoded: only `'node'` (our radio, with a channel key) counts. */
  decryptedBy: 'node' | 'server' | null;
  /** Packet came from a Virtual Node client's MQTT proxy, not from our radio. */
  fromMqttProxy?: boolean;
}

/**
 * True when the packet was transmitted at zero hops by a node other than its
 * `from`, i.e. a reply another node sent in the sender's name.
 */
export function isSpoofedZeroHopPacket(packet: ChannelEvidencePacket): boolean {
  if (packet.viaMqtt) return false;
  const hopStart = packet.hopStart;
  const hopLimit = packet.hopLimit;
  const relayNode = packet.relayNode;
  if (hopStart == null || hopLimit == null || relayNode == null) return false;
  // hop_start 0 with hop_limit > 0 is legacy (pre-hop_start) firmware.
  if (Number(hopStart) !== 0 || Number(hopLimit) !== 0) return false;
  const relayByte = Number(relayNode) & 0xff;
  // relay_node 0 = not set by the transmitter (older firmware).
  if (relayByte === 0) return false;
  const fromNum = Number(packet.from);
  if (!Number.isFinite(fromNum) || fromNum <= 0) return false;
  return relayByte !== (fromNum & 0xff);
}

/**
 * Channel index the packet proves its sender is on, or `undefined` when the
 * packet is no evidence of channel membership. See the file header.
 */
export function channelIndexFromPacket(
  packet: ChannelEvidencePacket,
  ctx: ChannelEvidenceContext,
): number | undefined {
  if (ctx.decryptedBy !== 'node') return undefined;
  if (ctx.fromMqttProxy) return undefined;

  const channel = packet.channel;
  if (channel === undefined || channel === null) return undefined;
  const index = Number(channel);
  if (!Number.isInteger(index) || index < 0 || index > MAX_CHANNEL_INDEX) return undefined;

  if (packet.pkiEncrypted || packet.pki_encrypted) return undefined;

  const fromNum = packet.from != null ? Number(packet.from) : null;
  const rxTimeSec = packet.rxTime != null ? Number(packet.rxTime) : null;
  if (isFirmwareReplayPacket(fromNum, packet.id ?? null, rxTimeSec)) return undefined;

  if (isSpoofedZeroHopPacket(packet)) return undefined;

  return index;
}
