/**
 * Auto-Acknowledge 2×2 matrix model.
 *
 * The matrix is {message type: Channel | Direct} × {hop distance: ZeroHop | MultiHop}.
 * Each of the four cells has three independent toggles:
 *  - reply   — send the message-template reply
 *  - tapback — send the hop-count emoji reaction
 *  - replyDm — route the reply as a DM to the sender (applies to the Reply only)
 *
 * Backend persistence uses 12 per-source settings keys named
 * `autoAck{Cell}{Action}Enabled` where Cell ∈
 * {ChannelZeroHop, ChannelMultiHop, DirectZeroHop, DirectMultiHop} and
 * Action ∈ {Reply, Tapback, ReplyDm}. Each value is the string 'true' or 'false';
 * an unset key reads as OFF.
 */

export type AutoAckCellId = 'channelZeroHop' | 'channelMultiHop' | 'directZeroHop' | 'directMultiHop';

export interface AutoAckCellConfig {
  reply: boolean;
  tapback: boolean;
  replyDm: boolean;
}

export type AutoAckMatrix = Record<AutoAckCellId, AutoAckCellConfig>;

export interface AutoAckCellMeta {
  id: AutoAckCellId;
  type: 'channel' | 'direct';
  hop: 'zeroHop' | 'multiHop';
  label: string;
}

export const AUTOACK_CELLS: AutoAckCellMeta[] = [
  { id: 'channelZeroHop', type: 'channel', hop: 'zeroHop', label: 'Channel · Direct (0 hops)' },
  { id: 'channelMultiHop', type: 'channel', hop: 'multiHop', label: 'Channel · Multi-hop' },
  { id: 'directZeroHop', type: 'direct', hop: 'zeroHop', label: 'Direct Message · 0 hops' },
  { id: 'directMultiHop', type: 'direct', hop: 'multiHop', label: 'Direct Message · Multi-hop' },
];

export const DEFAULT_AUTOACK_MATRIX: AutoAckMatrix = {
  channelZeroHop: { reply: false, tapback: false, replyDm: false },
  channelMultiHop: { reply: false, tapback: false, replyDm: false },
  directZeroHop: { reply: false, tapback: false, replyDm: false },
  directMultiHop: { reply: false, tapback: false, replyDm: false },
};

/**
 * Server key prefix for a cell. e.g. 'channelZeroHop' → 'autoAckChannelZeroHop'.
 */
export function cellServerKeyPrefix(id: AutoAckCellId): string {
  const capitalized = id.charAt(0).toUpperCase() + id.slice(1);
  return `autoAck${capitalized}`;
}

/**
 * Serialize a matrix into the 12 settings keys with 'true'/'false' string values.
 */
export function matrixToSettings(m: AutoAckMatrix): Record<string, string> {
  const out: Record<string, string> = {};
  for (const cell of AUTOACK_CELLS) {
    const prefix = cellServerKeyPrefix(cell.id);
    const config = m[cell.id];
    out[`${prefix}ReplyEnabled`] = String(config.reply);
    out[`${prefix}TapbackEnabled`] = String(config.tapback);
    out[`${prefix}ReplyDmEnabled`] = String(config.replyDm);
  }
  return out;
}

/**
 * Parse the 12 settings keys out of a raw settings object into a matrix.
 * A value is true only when it === 'true' or === true; missing → false.
 */
export function settingsToMatrix(s: Record<string, unknown>): AutoAckMatrix {
  const isTrue = (v: unknown): boolean => v === 'true' || v === true;
  const matrix: AutoAckMatrix = {
    channelZeroHop: { ...DEFAULT_AUTOACK_MATRIX.channelZeroHop },
    channelMultiHop: { ...DEFAULT_AUTOACK_MATRIX.channelMultiHop },
    directZeroHop: { ...DEFAULT_AUTOACK_MATRIX.directZeroHop },
    directMultiHop: { ...DEFAULT_AUTOACK_MATRIX.directMultiHop },
  };
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
