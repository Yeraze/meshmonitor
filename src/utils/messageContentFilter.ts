import type { MeshMessage } from '../types/message';

/**
 * Build the set of node IDs whose direct-message history contains a given
 * search term in the message body.
 *
 * Issue #3922: the Messages conversation-list filter historically matched only
 * on the conversation partner's node name / short name / node ID. This helper
 * lets the same filter also surface conversations by *what was said*, so a user
 * can find "that one message about X" without knowing who sent it.
 *
 * The match mirrors the DM predicate used by `getDMMessages` in MessagesTab:
 * only text direct messages (`channel === -1`, `portnum === 1`) that are not
 * broadcasts are considered. Both the `from` and `to` node IDs of a matching
 * message are added, because the conversation partner may be either party
 * depending on whether the message was inbound or outbound.
 *
 * The search is a case-insensitive substring match, matching the existing
 * node-name filter behaviour and the "simple LIKE/ILIKE" approach requested in
 * the issue. It operates over the in-memory `messages` array only (no network
 * round-trip); the global Ctrl+K search modal covers exhaustive server-side
 * full-text search.
 *
 * @param messages   In-memory message list held by the Messages view.
 * @param filter     The raw filter text entered by the user.
 * @param minLength  Minimum trimmed term length before content matching kicks
 *                   in, to avoid matching nearly every conversation on a single
 *                   character. Defaults to 2.
 * @returns A set of node IDs (e.g. `!abcd1234`) with at least one matching DM.
 */
export function getMessageContentMatchNodeIds(
  messages: MeshMessage[],
  filter: string,
  minLength = 2,
): Set<string> {
  const matchIds = new Set<string>();
  const term = filter.trim().toLowerCase();
  if (term.length < minLength) return matchIds;

  for (const msg of messages) {
    // Direct text messages only — mirror getDMMessages()'s predicate.
    if (msg.channel !== -1 || msg.portnum !== 1) continue;
    if (msg.to === '!ffffffff') continue;
    if (!msg.text) continue;
    if (!msg.text.toLowerCase().includes(term)) continue;

    if (msg.from) matchIds.add(msg.from);
    if (msg.to) matchIds.add(msg.to);
  }

  return matchIds;
}
