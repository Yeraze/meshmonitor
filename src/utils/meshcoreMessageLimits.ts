/**
 * MeshCore text byte caps (UTF-8 bytes, not chars). Shared by the server and
 * the client so the send route, the composers and the automated senders all
 * agree (#6303, #6304).
 *
 * Firmware facts (meshcore-dev/MeshCore):
 * - `MAX_TEXT_LEN = 160` (`BaseChatMesh.h`).
 * - A channel send writes `"<node_name>: "` into the same buffer as the text
 *   and silently cuts the text when the two together pass 160 bytes
 *   (`BaseChatMesh::sendGroupMessage`). So the text budget on a channel is
 *   `160 - (utf8 bytes of the node name + 2)`.
 * - `node_name` is `char[32]`, so at most 31 bytes.
 * - Scope (transport codes) sits in the packet header, outside the text, so a
 *   scoped send has the same cap as an unscoped one.
 * - A DM carries no name prefix: the cap is the full 160. A DM retry past
 *   attempt 3 costs 2 bytes (158), but MeshMonitor DM retries never exceed
 *   attempt 3, so 160 holds.
 */
export const MESHCORE_MAX_TEXT_BYTES = 160;
export const MESHCORE_MAX_MESSAGE_BYTES_DM = MESHCORE_MAX_TEXT_BYTES;
/** Longest node name the firmware stores (`char[32]`). */
export const MESHCORE_MAX_NODE_NAME_BYTES = 31;
/** Bytes the firmware adds after the name: ": ". */
const CHANNEL_PREFIX_SUFFIX_BYTES = 2;

/** Channel cap when the node name is unknown: assumes the longest name (127). */
export const MESHCORE_MAX_MESSAGE_BYTES_CHANNEL_WORST_CASE =
  MESHCORE_MAX_TEXT_BYTES - (MESHCORE_MAX_NODE_NAME_BYTES + CHANNEL_PREFIX_SUFFIX_BYTES);

const encoder = new TextEncoder();

/**
 * Text budget for one channel message from a node with this name.
 * A missing or blank name gives the worst case (31-byte name), which is safe.
 */
export function meshcoreChannelMaxBytes(nodeName?: string | null): number {
  if (!nodeName || nodeName.length === 0) return MESHCORE_MAX_MESSAGE_BYTES_CHANNEL_WORST_CASE;
  const nameBytes = Math.min(encoder.encode(nodeName).length, MESHCORE_MAX_NODE_NAME_BYTES);
  return MESHCORE_MAX_TEXT_BYTES - (nameBytes + CHANNEL_PREFIX_SUFFIX_BYTES);
}

/** Byte cap for one MeshCore text send. `nodeName` only matters on a channel. */
export function meshcoreMessageByteCap(dest: { isDm: boolean; nodeName?: string | null }): number {
  return dest.isDm ? MESHCORE_MAX_MESSAGE_BYTES_DM : meshcoreChannelMaxBytes(dest.nodeName);
}

/**
 * Split-long-message limits for automated MeshCore senders (#6316). Meshtastic
 * uses the same values (#6330), so they live in the protocol-neutral
 * `messageSplitLimits` module; these names stay for existing callers.
 */
export {
  SPLIT_MAX_PARTS as MESHCORE_SPLIT_MAX_PARTS,
  SPLIT_PART_GAP_MS as MESHCORE_SPLIT_PART_GAP_MS,
  SPLIT_TIMER_MIN_INTERVAL_MINUTES as MESHCORE_SPLIT_TIMER_MIN_INTERVAL_MINUTES,
} from './messageSplitLimits.js';
