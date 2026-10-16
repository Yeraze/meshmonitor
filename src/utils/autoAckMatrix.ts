/**
 * Auto-Acknowledge matrix model.
 *
 * The matrix is {message type: Channel | Direct} × {path: ZeroHop | MultiHop | Ip}.
 * `Ip` (#5796) holds messages that reached the node over MQTT or multicast UDP;
 * it is checked first, so an IP message never lands in ZeroHop or MultiHop.
 * Each of the six cells has three independent toggles:
 *  - reply   — send the message-template reply
 *  - tapback — send the hop-count emoji reaction
 *  - replyDm — route the reply as a DM to the sender (applies to the Reply only)
 *
 * Backend persistence uses 18 per-source settings keys named
 * `autoAck{Cell}{Action}Enabled` where Cell ∈
 * {ChannelZeroHop, ChannelMultiHop, ChannelIp, DirectZeroHop, DirectMultiHop, DirectIp}
 * and Action ∈ {Reply, Tapback, ReplyDm}. Each value is the string 'true' or
 * 'false'; an unset key reads as OFF (so the Ip cells start off on every install).
 */

export type AutoAckCellId =
  | 'channelZeroHop'
  | 'channelMultiHop'
  | 'channelIp'
  | 'directZeroHop'
  | 'directMultiHop'
  | 'directIp';

export interface AutoAckCellConfig {
  reply: boolean;
  tapback: boolean;
  replyDm: boolean;
}

export type AutoAckMatrix = Record<AutoAckCellId, AutoAckCellConfig>;

export interface AutoAckCellMeta {
  id: AutoAckCellId;
  type: 'channel' | 'direct';
  hop: 'zeroHop' | 'multiHop' | 'ip';
  label: string;
}

export const AUTOACK_CELLS: AutoAckCellMeta[] = [
  { id: 'channelZeroHop', type: 'channel', hop: 'zeroHop', label: 'Channel · Direct (0 hops)' },
  { id: 'channelMultiHop', type: 'channel', hop: 'multiHop', label: 'Channel · Multi-hop' },
  { id: 'channelIp', type: 'channel', hop: 'ip', label: 'Channel · IP (MQTT / UDP)' },
  { id: 'directZeroHop', type: 'direct', hop: 'zeroHop', label: 'Direct Message · 0 hops' },
  { id: 'directMultiHop', type: 'direct', hop: 'multiHop', label: 'Direct Message · Multi-hop' },
  { id: 'directIp', type: 'direct', hop: 'ip', label: 'Direct Message · IP (MQTT / UDP)' },
];

export const DEFAULT_AUTOACK_MATRIX: AutoAckMatrix = {
  channelZeroHop: { reply: false, tapback: false, replyDm: false },
  channelMultiHop: { reply: false, tapback: false, replyDm: false },
  channelIp: { reply: false, tapback: false, replyDm: false },
  directZeroHop: { reply: false, tapback: false, replyDm: false },
  directMultiHop: { reply: false, tapback: false, replyDm: false },
  directIp: { reply: false, tapback: false, replyDm: false },
};

/**
 * Server key prefix for a cell. e.g. 'channelZeroHop' → 'autoAckChannelZeroHop'.
 */
export function cellServerKeyPrefix(id: AutoAckCellId): string {
  const capitalized = id.charAt(0).toUpperCase() + id.slice(1);
  return `autoAck${capitalized}`;
}

/**
 * Serialize a matrix into the 18 settings keys with 'true'/'false' string values.
 */
export function matrixToSettings(m: AutoAckMatrix): Record<string, string> {
  const out: Record<string, string> = {};
  for (const cell of AUTOACK_CELLS) {
    const prefix = cellServerKeyPrefix(cell.id);
    // A matrix built before the IP row existed (#5796) has no Ip cells; they
    // serialize as off rather than throwing.
    const config = m[cell.id] ?? DEFAULT_AUTOACK_MATRIX[cell.id];
    out[`${prefix}ReplyEnabled`] = String(config.reply);
    out[`${prefix}TapbackEnabled`] = String(config.tapback);
    out[`${prefix}ReplyDmEnabled`] = String(config.replyDm);
  }
  return out;
}

/**
 * Parse the 18 settings keys out of a raw settings object into a matrix.
 * A value is true only when it === 'true' or === true; missing → false.
 */
export function settingsToMatrix(s: Record<string, unknown>): AutoAckMatrix {
  const isTrue = (v: unknown): boolean => v === 'true' || v === true;
  const matrix = {} as AutoAckMatrix;
  for (const cell of AUTOACK_CELLS) {
    const prefix = cellServerKeyPrefix(cell.id);
    matrix[cell.id] = {
      reply: isTrue(s[`${prefix}ReplyEnabled`]),
      tapback: isTrue(s[`${prefix}TapbackEnabled`]),
      replyDm: isTrue(s[`${prefix}ReplyDmEnabled`]),
    };
  }
  return matrix;
}
