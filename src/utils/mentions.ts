/**
 * `@` mentions in conversations (#5276).
 *
 * Meshtastic has no protocol field for a mention: it is a plain-text convention
 * the clients agreed on (meshtastic/design#21), and iOS and Android already
 * ship it. The token on the wire is `@!` plus the node's 8 hex digits, e.g.
 * `@!ffccee11` — never a display name, so a rename does not break an old
 * message. MeshMonitor must emit exactly that, or its mentions will not
 * highlight in the official apps.
 *
 * Differences between the two apps, and what we do about them:
 * - iOS matches lowercase hex only; Android matches either case. We **emit**
 *   lowercase and **parse** case-insensitively, which both apps accept.
 * - Android appends a space after inserting, iOS does not. We append one: it is
 *   what a typist expects, and a trailing space never breaks either parser.
 *
 * MeshCore is deliberately NOT handled here. Its `@[Name]` form (#3851) is a
 * name-based convention borrowed from another client, with no id to anchor to,
 * and merging the two would produce a parser that is wrong for both.
 */

/**
 * A mention token: `@!` + exactly 8 hex digits, not followed by another hex
 * digit (so `@!deadbeef00` is not read as a mention of `@!deadbeef`).
 *
 * Returns a fresh regex each call. A shared `/g` regex carries `lastIndex`
 * between calls, so one caller forgetting to reset it silently skips matches
 * in the next.
 */
export const mentionTokenRegex = (): RegExp => /@(![0-9a-fA-F]{8})(?![0-9a-fA-F])/g;

/** Node id (`!ffccee11`) for a node number, in the form the token carries. */
export function nodeIdFromNum(nodeNum: number): string {
  return `!${(nodeNum >>> 0).toString(16).padStart(8, '0')}`;
}

/** The text inserted when a node is picked, including its trailing space. */
export function mentionToken(nodeId: string): string {
  return `@${nodeId.toLowerCase()} `;
}

/** Every node id mentioned in a message, lowercased, in order, without repeats. */
export function mentionedNodeIds(text: string | null | undefined): string[] {
  if (!text) return [];
  const ids: string[] = [];
  for (const match of text.matchAll(mentionTokenRegex())) {
    const id = match[1].toLowerCase();
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

/**
 * Whether a message mentions one node. Both apps compare the id alone and fold
 * case, so a node's names are never matched against message text — that keeps
 * "was I mentioned" exact instead of fuzzy.
 */
export function textMentionsNode(text: string | null | undefined, nodeId: string | null | undefined): boolean {
  if (!nodeId || nodeId.length <= 1) return false;
  return mentionedNodeIds(text).includes(nodeId.toLowerCase());
}

/** An in-progress `@…` the caret is sitting in. */
export interface MentionQuery {
  /** Text between the `@` and the caret, lowercased. Empty means a bare `@`. */
  query: string;
  /** Index of the `@`. */
  start: number;
  /** Caret position, i.e. the end of the text to replace. */
  end: number;
}

/**
 * Find the mention being typed to the left of the caret, matching the trigger
 * rules both official apps use:
 * - the `@` starts a word, so an email address never opens the list,
 * - whitespace inside the query ends it,
 * - a bare `@` offers everything,
 * - a token already resolved (`@!…`) does not re-trigger.
 */
export function findMentionQuery(text: string, caret: number): MentionQuery | null {
  if (caret < 0 || caret > text.length) return null;

  const at = text.lastIndexOf('@', caret - 1);
  if (at === -1) return null;

  const before = at > 0 ? text[at - 1] : '';
  if (before && !/\s/.test(before)) return null;

  const query = text.slice(at + 1, caret);
  if (/\s/.test(query)) return null;
  if (query.startsWith('!')) return null;

  return { query: query.toLowerCase(), start: at, end: caret };
}

/** One row in the autocomplete list. */
export interface MentionCandidate {
  /** Node id (`!ffccee11`), the value that goes on the wire. */
  id: string;
  longName: string;
  shortName: string;
}

/** Longest list we show; Android caps at 5 and a longer list buries the input. */
export const MENTION_SUGGESTION_LIMIT = 5;

/**
 * Candidates for a query, matched on long name, short name or id, the way both
 * apps filter. An empty query returns the first few candidates as given, so the
 * caller decides what "most likely" means (usually most recently heard).
 */
export function filterMentionCandidates<T extends MentionCandidate>(
  candidates: readonly T[],
  query: string,
  limit: number = MENTION_SUGGESTION_LIMIT,
): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return candidates.slice(0, limit);
  return candidates
    .filter(c =>
      c.longName.toLowerCase().includes(q) ||
      c.shortName.toLowerCase().includes(q) ||
      c.id.toLowerCase().includes(q)
    )
    .slice(0, limit);
}

/**
 * Replace the query with the node's token, and say where the caret lands.
 *
 * The token ends in a space, so a space already following the query is dropped
 * — otherwise mentioning someone mid-sentence would leave a double space in a
 * message every recipient sees. Android's own insertion does the same.
 */
export function applyMention(
  text: string,
  mention: MentionQuery,
  nodeId: string,
): { text: string; caret: number } {
  const token = mentionToken(nodeId);
  const tail = text.slice(mention.end);
  const next = text.slice(0, mention.start) + token + (tail.startsWith(' ') ? tail.slice(1) : tail);
  return { text: next, caret: mention.start + token.length };
}
