/**
 * Unread-anchor helpers (#4607).
 *
 * The divider and the jump-to-first-unread entry scroll both need one thing:
 * the id of the oldest message in the open conversation that the operator had
 * NOT seen at the moment they opened it.
 *
 * "At the moment they opened it" is the load-bearing part. Every conversation
 * view marks itself read on entry and again on every incoming message
 * (useMessagingView GATED EFFECTS #6/#7, MeshCoreChannelsView's mark-read
 * effect). A live "is this unread?" lookup therefore returns nothing a tick
 * after the view mounts, which is exactly when the divider would be drawn. So
 * the views PIN a watermark when the conversation key changes and resolve the
 * anchor against that frozen value for as long as they stay in the thread.
 *
 * Pure functions, no React — so the rule can be tested without mounting three
 * different conversation views.
 */

/** Minimal message shape the anchor resolution needs. */
export interface AnchorableMessage {
  id: string;
  /** Sort time in ms — whatever the view already orders the list by. */
  sortTime: number;
}

/**
 * Resolve the divider anchor from a pinned watermark.
 *
 * `watermarkMs` semantics differ slightly per protocol and both are supported
 * by the same rule:
 *  - MeshCore stores a LAST-READ timestamp, so the anchor is the first message
 *    STRICTLY newer than it. Pass `mode: 'lastRead'`.
 *  - Meshtastic derives the FIRST-UNREAD timestamp from `read_messages`, so
 *    the anchor is the first message at or after it. Pass `mode: 'firstUnread'`.
 *
 * Returns `null` when there is nothing unread, when the watermark is unknown,
 * or when the only unread messages are ones the operator sent themselves
 * (callers filter those out before calling — see `ownMessageIds`).
 */
export function resolveUnreadAnchorId(params: {
  messages: ReadonlyArray<AnchorableMessage>;
  watermarkMs: number | null | undefined;
  mode: 'lastRead' | 'firstUnread';
  /** Message ids that must never be the anchor (e.g. our own sent messages). */
  ownMessageIds?: ReadonlySet<string>;
}): string | null {
  const { messages, watermarkMs, mode, ownMessageIds } = params;
  if (watermarkMs == null || !Number.isFinite(watermarkMs)) return null;
  if (messages.length === 0) return null;

  for (const msg of messages) {
    const isUnread = mode === 'lastRead'
      ? msg.sortTime > watermarkMs
      : msg.sortTime >= watermarkMs;
    if (!isUnread) continue;
    if (ownMessageIds?.has(msg.id)) continue;
    return msg.id;
  }
  return null;
}

/**
 * Should the divider be suppressed entirely?
 *
 * Drawing a line above the very first message in a conversation is noise — it
 * says "everything below is new" in a thread the operator has never opened,
 * where that is trivially true. Suppress it when the anchor is the oldest
 * message currently loaded AND no older history exists to scroll back to.
 *
 * When older history DOES exist, keep the line: the operator genuinely has
 * read messages above, they just aren't loaded yet.
 */
export function shouldSuppressDivider(params: {
  anchorId: string | null;
  messages: ReadonlyArray<AnchorableMessage>;
  hasMoreOlder?: boolean;
}): boolean {
  const { anchorId, messages, hasMoreOlder } = params;
  if (!anchorId) return true;
  if (hasMoreOlder) return false;
  return messages.length > 0 && messages[0].id === anchorId;
}
