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

/**
 * Minimal shape of the in-memory MeshCore message the content filter inspects.
 * A subset of `MeshCoreMessage` (see `src/components/MeshCore/hooks/useMeshCore.ts`)
 * so this helper stays pure and decoupled from the React hook types.
 */
export interface MeshCoreContentMessage {
  fromPublicKey: string;
  toPublicKey?: string;
  text?: string;
  /** 'text' (DMs / channel) or 'room_post' (room server posts). */
  messageType?: string;
}

/**
 * Build the set of MeshCore contact public keys whose direct-message history
 * contains a given search term in the message body.
 *
 * Issue #3922 (MeshCore extension): mirrors {@link getMessageContentMatchNodeIds}
 * for the MeshCore Direct Messages view, whose conversation-list filter
 * historically matched only on the contact's name / public key. This lets the
 * same filter also surface conversations by *what was said*.
 *
 * The DM predicate mirrors `dmPeers`/`filtered` in `MeshCoreDirectMessagesView`:
 * room posts (`messageType === 'room_post'`) and channel pseudo-keys are
 * excluded, and only messages with a `toPublicKey` are considered. Both parties'
 * keys are added (canonicalized when a `canonicalize` fn is supplied), because
 * the conversation partner may be either the sender or the recipient.
 *
 * The search is a case-insensitive substring match over the in-memory `messages`
 * array only (no network round-trip); the global Ctrl+K search modal covers
 * exhaustive server-side search across all MeshCore sources.
 *
 * @param messages   In-memory MeshCore message list held by the DM view.
 * @param filter     The raw filter text entered by the user.
 * @param options    Optional hooks:
 *   - `canonicalize`: maps a raw (possibly prefix) key to its full contact key
 *     so match keys line up with the canonicalized peer keys in the DM list.
 *   - `isChannelKey`: predicate identifying synthetic `channel-*` pseudo-keys to
 *     exclude (mirrors `isChannelPseudoKey`).
 *   - `minLength`: minimum trimmed term length before content matching kicks in
 *     (defaults to 2), to avoid matching nearly every conversation on a single
 *     character.
 * @returns A set of contact public keys with at least one matching DM.
 */
export function getMeshCoreMessageContentMatchKeys(
  messages: MeshCoreContentMessage[],
  filter: string,
  options: {
    canonicalize?: (key: string) => string;
    isChannelKey?: (key: string) => boolean;
    minLength?: number;
  } = {},
): Set<string> {
  const { canonicalize = (k) => k, isChannelKey = () => false, minLength = 2 } = options;
  const matchKeys = new Set<string>();
  const term = filter.trim().toLowerCase();
  if (term.length < minLength) return matchKeys;

  for (const msg of messages) {
    // Direct text messages only — mirror the DM predicate in the DM view.
    if (msg.messageType === 'room_post') continue;
    if (!msg.toPublicKey) continue;
    if (isChannelKey(msg.toPublicKey) || isChannelKey(msg.fromPublicKey)) continue;
    if (!msg.text) continue;
    if (!msg.text.toLowerCase().includes(term)) continue;

    if (msg.fromPublicKey) matchKeys.add(canonicalize(msg.fromPublicKey));
    if (msg.toPublicKey) matchKeys.add(canonicalize(msg.toPublicKey));
  }

  return matchKeys;
}
