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
 * Largest `"<name>: <text>"` body (bytes) a raw `CMD_SEND_RAW_PACKET` frame can
 * carry. The radio frame limit is 176 bytes (`MAX_FRAME_SIZE`); the raw frame is
 * `cmd + priority + header + [4 transport codes] + path_len + 3 + 16*ceil((5+L)/16)`,
 * which gives L <= 155 both scoped and unscoped (#6282).
 */
export const MESHCORE_RAW_MAX_BODY_BYTES = 155;

/**
 * Text budget (bytes) for one channel message sent under `senderName`.
 * Normal path: the firmware cap, `160 - (name + 2)`. Raw path (a sender-name
 * override sent as a hand-built packet): `155 - (name + 2)`, 5 bytes lower.
 */
export function meshcoreChannelTextCap(senderName: string, opts: { raw: boolean }): number {
  const nameBytes = Math.min(encoder.encode(senderName).length, MESHCORE_MAX_NODE_NAME_BYTES);
  const total = opts.raw ? MESHCORE_RAW_MAX_BODY_BYTES : MESHCORE_MAX_TEXT_BYTES;
  return total - (nameBytes + CHANNEL_PREFIX_SUFFIX_BYTES);
}

/**
 * Split-long-message limits for automated MeshCore senders (#6316).
 * Fixed by the maintainer: at most 3 parts, 10 s apart. Shared with the UI so
 * the airtime warning text cannot drift from the real behaviour.
 */
export const MESHCORE_SPLIT_MAX_PARTS = 3;
export const MESHCORE_SPLIT_PART_GAP_MS = 10_000;
/** Shortest timer interval (minutes) allowed when a timer splits long messages. */
export const MESHCORE_SPLIT_TIMER_MIN_INTERVAL_MINUTES = 5;
