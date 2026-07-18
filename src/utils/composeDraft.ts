/**
 * Compose-draft scoping helpers (#4183).
 *
 * The message compose box is a single shared React state (`newMessage` in
 * `MessagingContext`) used by both the DM view (`MessagesTab`) and the channel
 * view (`ChannelsTab`). Historically the conversation-switch handlers reset
 * `replyingTo` but never the draft, so a draft typed in one conversation would
 * remain in the box after switching to another — and sending it then delivered
 * it to the WRONG conversation (a private DM draft could be sent to a public
 * channel).
 *
 * These pure helpers encode the single decision "did the active compose target
 * change, and should the draft therefore be cleared?" so it can be unit-tested
 * in isolation and driven from one central effect rather than scattered across
 * every selection-change site (the four UI handlers plus several programmatic
 * `setSelectedDMNode` / `setSelectedChannel` call sites).
 */

/**
 * Identify the conversation the compose box currently targets, as a stable
 * string key, or `null` when no compose box is visible (the active tab is
 * neither the DM view nor the channel view).
 *
 * The active tab is part of the identity because the DM and channel compose
 * boxes share the same underlying draft state: switching from a DM to the
 * Channels tab (or vice-versa) changes the send target even when neither
 * `selectedDMNode` nor `selectedChannel` changes.
 */
export function getComposeConversationKey(
  activeTab: string,
  selectedDMNode: string,
  selectedChannel: number
): string | null {
  if (activeTab === 'messages') return `dm:${selectedDMNode}`;
  if (activeTab === 'channels') return `ch:${selectedChannel}`;
  return null;
}

export interface ComposeDraftTransition {
  /** The key to remember for the next transition. */
  key: string | null;
  /** Whether the compose draft should be cleared as a result of this change. */
  clear: boolean;
}

/**
 * Decide the next tracked conversation key and whether the draft must be
 * cleared, given the previously tracked key and the newly computed key.
 *
 * Rules:
 * - A `null` next key (no compose box visible, e.g. the Nodes/Settings tab)
 *   never clears and never overwrites the remembered target. This lets a user
 *   tab away from a conversation and return to the SAME conversation without
 *   losing an in-progress draft.
 * - Moving from "no remembered target" (`null`) to a concrete target never
 *   clears — this is initial mount, where the draft is empty anyway.
 * - Moving between two DIFFERENT concrete targets clears the draft.
 * - Re-observing the same concrete target is a no-op (e.g. an unrelated
 *   re-render that recomputes the same key).
 *
 * Note this is intentionally NOT keyed on send: sending a message does not
 * change the active conversation, so `clear` stays false and the existing
 * optimistic post-send clear in `App.tsx` remains the single source of truth
 * for that path.
 */
export function nextComposeDraftState(
  prevKey: string | null,
  nextKey: string | null
): ComposeDraftTransition {
  if (nextKey === null) {
    return { key: prevKey, clear: false };
  }
  if (prevKey === null) {
    return { key: nextKey, clear: false };
  }
  return { key: nextKey, clear: prevKey !== nextKey };
}
