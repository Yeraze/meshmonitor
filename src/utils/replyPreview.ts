/**
 * Reply-preview resolution for message feeds (#4245).
 *
 * Lives outside the page component so it can be exported and unit-tested
 * without tripping `react-refresh/only-export-components` — a module whose
 * default export is a component must not also export non-components, or Fast
 * Refresh breaks.
 *
 * Generic over the message type so it carries no coupling to any particular
 * page's `UnifiedMessage` shape.
 */

export type ReplyPreviewState<TMessage> =
  | { kind: 'none' }
  | { kind: 'unknown' }
  | { kind: 'resolved'; parent: TMessage };

/**
 * Classify a message's reply state.
 *
 * `unknown` is the case the original code silently collapsed into `none`: the
 * message IS a reply, but the parent packet was never received by any source
 * (or has since been purged), so there is nothing to quote. It still has to
 * render a reply box — otherwise the message is indistinguishable from one
 * that was never a reply at all, and a non-null `replyId` is dropped on the
 * floor.
 *
 * `replyId` is checked with `!= null`, not truthiness: packet id 0 is falsy but
 * is still a valid reply target.
 */
export function resolveReplyPreview<TMessage>(
  replyId: number | null | undefined,
  byPacketId: { get(key: number): TMessage | undefined },
): ReplyPreviewState<TMessage> {
  if (replyId == null) return { kind: 'none' };
  const parent = byPacketId.get(replyId);
  return parent ? { kind: 'resolved', parent } : { kind: 'unknown' };
}
