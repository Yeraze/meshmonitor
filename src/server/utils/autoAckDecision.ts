/**
 * Pure decision helpers for the Auto-Acknowledge matrix (discussion #3564, #5796).
 *
 * The matrix is {Channel,Direct} × {ZeroHop,MultiHop,Ip}. These helpers isolate
 * the non-trivial decisions from `MeshtasticManager.checkAutoAcknowledge` so they
 * can be unit-tested without a full manager/messageQueue harness:
 *   1. which cell a packet falls into, and
 *   2. how a reply is routed (on-channel vs DM, and whether it can be threaded).
 *
 * The Automation Engine's derived `zeroHop` / `viaIp` trigger fields
 * (triggerContext.ts) call the same helpers, so the matrix and a converted
 * automation always agree on which row a packet belongs to.
 */
import { TransportMechanism } from '../constants/meshtastic.js';

/**
 * A packet is "IP" when it reached the node over an IP link rather than LoRa:
 * the legacy `viaMqtt` flag, or a transport mechanism of MQTT (5) or multicast
 * UDP (6). API (7) is a client on the node's own API link, not an IP hop
 * between nodes, so it is NOT IP.
 */
export function autoAckIsIp(
  viaMqtt: boolean | undefined | null,
  transportMechanism?: number | null,
): boolean {
  return (
    viaMqtt === true ||
    transportMechanism === TransportMechanism.MQTT ||
    transportMechanism === TransportMechanism.MULTICAST_UDP
  );
}

/**
 * A packet is "zero hop" when it travelled 0 hops over RF. IP packets (MQTT /
 * multicast UDP) are never zero-hop even at 0 hops — they crossed an IP link,
 * not a direct RF one, so RF metrics (SNR/RSSI) and the 0-hop notion don't apply.
 */
export function autoAckIsZeroHop(
  hopsTraveled: number,
  viaMqtt: boolean | undefined | null,
  transportMechanism?: number | null,
): boolean {
  return hopsTraveled === 0 && !autoAckIsIp(viaMqtt, transportMechanism);
}

/**
 * Settings-key prefix for the matrix cell a packet falls into, e.g.
 * `autoAckChannelMultiHop`. Append `ReplyEnabled` / `TapbackEnabled` /
 * `ReplyDmEnabled` to read a specific toggle.
 *
 * IP is checked first (#5796): an IP packet lands in the Ip row whatever its
 * hop count, never in ZeroHop or MultiHop.
 */
export function autoAckCellKey(isDirectMessage: boolean, isZeroHop: boolean, isIp = false): string {
  const hop = isIp ? 'Ip' : isZeroHop ? 'ZeroHop' : 'MultiHop';
  return `autoAck${isDirectMessage ? 'Direct' : 'Channel'}${hop}`;
}

export interface AutoAckReplyRouting {
  /** True when the reply is sent as a DM to the sender (vs on the channel). */
  replyViaDm: boolean;
  /** messageQueue destination: the sender's node number for a DM, 0 for a channel. */
  replyDest: number;
  /** messageQueue channel: the channel index for a channel reply, undefined for a DM. */
  replyChannel: number | undefined;
  /** Threaded-reply id, or undefined when we change destination (channel→DM) and can't thread. */
  replyId: number | undefined;
}

/**
 * Resolve how an auto-ack *message reply* is delivered.
 *
 * "Respond via DM" (`cellReplyDmEnabled`) applies to the reply only. A Direct
 * message is inherently a DM, so its reply always returns as a DM regardless of
 * the toggle. When replying via DM to a *channel* trigger we change destination
 * (channel → DM), so the reply can no longer be a threaded reply and `replyId`
 * is cleared.
 */
export function resolveAutoAckReplyRouting(opts: {
  isDirectMessage: boolean;
  cellReplyDmEnabled: boolean;
  channelIndex: number;
  fromNum: number;
  packetId?: number;
}): AutoAckReplyRouting {
  const { isDirectMessage, cellReplyDmEnabled, channelIndex, fromNum, packetId } = opts;
  const replyViaDm = isDirectMessage || cellReplyDmEnabled;
  return {
    replyViaDm,
    replyDest: replyViaDm ? fromNum : 0,
    replyChannel: replyViaDm ? undefined : channelIndex,
    replyId: cellReplyDmEnabled && !isDirectMessage ? undefined : packetId,
  };
}
