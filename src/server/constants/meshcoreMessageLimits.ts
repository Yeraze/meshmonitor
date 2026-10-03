/**
 * MeshCore text byte caps, by destination and scope (UTF-8 bytes, not chars).
 *
 * The firmware limit is `MAX_TEXT_LEN = 160` (BaseChatMesh.h). These caps sit
 * below it to leave room for what the firmware adds: a channel message carries
 * the sender's name inline, and a scoped flood carries transport codes.
 *
 * One source of truth for the HTTP send route (`VALIDATION` in
 * `routes/meshcoreRouteShared.ts`), which rejects an over-long message, and
 * for automated senders such as Auto-Acknowledge (#5564), which truncate or
 * split instead.
 */
export const MESHCORE_MAX_MESSAGE_BYTES_DM = 150;
export const MESHCORE_MAX_MESSAGE_BYTES_CHANNEL = 130;
export const MESHCORE_MAX_MESSAGE_BYTES_CHANNEL_SCOPED = 120;

/**
 * Byte cap for one MeshCore text send.
 *
 * `scoped` only matters for a channel send: true when the send carries a
 * named region. This mirrors the HTTP send route, which applies the scoped
 * cap only when a region name is present.
 */
export function meshcoreMessageByteCap(dest: { isDm: boolean; scoped: boolean }): number {
  if (dest.isDm) return MESHCORE_MAX_MESSAGE_BYTES_DM;
  return dest.scoped ? MESHCORE_MAX_MESSAGE_BYTES_CHANNEL_SCOPED : MESHCORE_MAX_MESSAGE_BYTES_CHANNEL;
}
