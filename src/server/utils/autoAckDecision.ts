/**
 * Pure decision helpers for the Auto-Acknowledge 2×2 matrix (discussion #3564).
 *
 * The matrix is {Channel,Direct} × {ZeroHop,MultiHop}. These helpers isolate the
 * two non-trivial decisions from `MeshtasticManager.checkAutoAcknowledge` so they
 * can be unit-tested without a full manager/messageQueue harness:
 *   1. which cell a packet falls into, and
 *   2. how a reply is routed (on-channel vs DM, and whether it can be threaded).
 */

/**
 * A packet is "zero hop" when it travelled 0 hops over RF. MQTT-relayed packets
 * are never zero-hop even at 0 hops — they traversed the internet, not a direct
 * RF link, so RF metrics (SNR/RSSI) and the 0-hop notion don't apply.
 */
export function autoAckIsZeroHop(hopsTraveled: number, viaMqtt: boolean | undefined | null): boolean {
  return hopsTraveled === 0 && viaMqtt !== true;
}

/**
 * Settings-key prefix for the matrix cell a packet falls into, e.g.
 * `autoAckChannelMultiHop`. Append `ReplyEnabled` / `TapbackEnabled` /
 * `ReplyDmEnabled` to read a specific toggle.
 */
export function autoAckCellKey(isDirectMessage: boolean, isZeroHop: boolean): string {
  return `autoAck${isDirectMessage ? 'Direct' : 'Channel'}${isZeroHop ? 'ZeroHop' : 'MultiHop'}`;
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
