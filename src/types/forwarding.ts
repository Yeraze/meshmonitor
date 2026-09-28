/**
 * Message Forwarding rules (#5446) — shared by the server engine, the
 * `/api/sources/:id/forwarding` route and the Forwarding UI section.
 *
 * A rule copies a matching incoming text message to one destination on the
 * SAME source: a channel, or a DM to one node. Rules are stored per source as
 * a JSON array under the `forwardingRules` setting key, for Meshtastic and
 * MeshCore alike.
 *
 * This file must stay free of Node-native imports (it is bundled into the
 * frontend). Regex compilation lives server-side in
 * `src/server/utils/forwardingEngine.ts`.
 */

/** Per-source setting key holding the JSON array of rules. */
export const FORWARDING_SETTING_KEY = 'forwardingRules';

/**
 * Every forwarded message starts with this marker. The engine never forwards
 * a message that starts with it, which breaks A→B→A loops between two
 * MeshMonitor instances (or two rules) even when the other safeguards miss.
 */
export const FORWARDED_MARKER = '[fwd] ';

/** Hard caps — deliberately not configurable (maintainer decision on #5446). */
export const FORWARDING_MAX_PER_WINDOW = 5;
export const FORWARDING_WINDOW_MS = 60_000;
export const FORWARDING_MAX_TEXT_CHARS = 200;
export const FORWARDING_MAX_RULES = 20;
export const FORWARDING_MAX_PREFIX_CHARS = 40;
export const FORWARDING_MAX_NAME_CHARS = 60;
export const FORWARDING_MAX_REGEX_CHARS = 100;

export interface ForwardingMatch {
  /** Match channel messages on this channel index. Exclusive with `isDM`. */
  channel?: number | null;
  /** Match direct messages to our node. Exclusive with `channel`. */
  isDM?: boolean | null;
  /**
   * Only messages from this node. Meshtastic: `!abcd1234`. MeshCore: the
   * contact's public key (hex). Empty/absent = any sender.
   */
  fromNodeId?: string;
  /** Case-insensitive regex the text must match. Empty/absent = any text. */
  textRegex?: string;
}

export interface ForwardingTarget {
  /** Broadcast to this channel index. Exclusive with `destinationNodeId`. */
  channel?: number | null;
  /** DM this node (same id format as `ForwardingMatch.fromNodeId`). */
  destinationNodeId?: string;
}

export interface ForwardingRule {
  id: string;
  name: string;
  enabled: boolean;
  match: ForwardingMatch;
  forwardTo: ForwardingTarget;
  /**
   * Text placed after the `[fwd] ` marker and before the message. Supports
   * `{from}` (sender name or id) and `{channel}` (channel name, or `DM`).
   */
  prefix?: string;
}

export type ForwardingValidation =
  | { ok: true; rules: ForwardingRule[] }
  | { ok: false; error: string };

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

/** Normalise a node id for comparison: trim, lowercase, drop a leading `!`. */
export function normalizeForwardingNodeId(id: string | null | undefined): string {
  return (id ?? '').trim().toLowerCase().replace(/^!/, '');
}

/**
 * Structural validation shared by the route (store time) and the UI (before
 * save). Regex safety is checked separately on the server, where RE2 lives.
 * Returns cleaned copies of the rules — unknown fields are dropped.
 */
export function validateForwardingRules(input: unknown): ForwardingValidation {
  if (!Array.isArray(input)) return { ok: false, error: 'rules must be an array' };
  if (input.length > FORWARDING_MAX_RULES) {
    return { ok: false, error: `at most ${FORWARDING_MAX_RULES} forwarding rules per source` };
  }
  const seen = new Set<string>();
  const rules: ForwardingRule[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') return { ok: false, error: 'each rule must be an object' };
    const r = raw as Record<string, unknown>;
    const id = typeof r.id === 'string' ? r.id.trim() : '';
    if (!id || id.length > 64) return { ok: false, error: 'each rule needs an id' };
    if (seen.has(id)) return { ok: false, error: `duplicate rule id ${id}` };
    seen.add(id);
    const label = typeof r.name === 'string' && r.name.trim() ? r.name.trim() : id;
    const name = typeof r.name === 'string' ? r.name.trim() : '';
    if (!name) return { ok: false, error: `rule ${id}: name is required` };
    if (name.length > FORWARDING_MAX_NAME_CHARS) {
      return { ok: false, error: `rule "${label}": name is too long (max ${FORWARDING_MAX_NAME_CHARS})` };
    }

    const m = (r.match && typeof r.match === 'object' ? r.match : {}) as Record<string, unknown>;
    const matchChannel = isInt(m.channel) ? m.channel : null;
    const matchDM = m.isDM === true;
    if (m.channel != null && matchChannel === null) {
      return { ok: false, error: `rule "${label}": match channel must be a whole number` };
    }
    if (matchChannel !== null && (matchChannel < 0 || matchChannel > 255)) {
      return { ok: false, error: `rule "${label}": match channel is out of range` };
    }
    if (matchDM === (matchChannel !== null)) {
      return { ok: false, error: `rule "${label}": match either direct messages or one channel` };
    }
    const fromNodeId = typeof m.fromNodeId === 'string' ? m.fromNodeId.trim() : '';
    if (fromNodeId.length > 80) return { ok: false, error: `rule "${label}": sender id is too long` };
    const textRegex = typeof m.textRegex === 'string' ? m.textRegex.trim() : '';
    if (textRegex.length > FORWARDING_MAX_REGEX_CHARS) {
      return { ok: false, error: `rule "${label}": text pattern is too long (max ${FORWARDING_MAX_REGEX_CHARS})` };
    }

    const f = (r.forwardTo && typeof r.forwardTo === 'object' ? r.forwardTo : {}) as Record<string, unknown>;
    const toChannel = isInt(f.channel) ? f.channel : null;
    const toNode = typeof f.destinationNodeId === 'string' ? f.destinationNodeId.trim() : '';
    if (f.channel != null && toChannel === null) {
      return { ok: false, error: `rule "${label}": target channel must be a whole number` };
    }
    if (toChannel !== null && (toChannel < 0 || toChannel > 255)) {
      return { ok: false, error: `rule "${label}": target channel is out of range` };
    }
    if ((toChannel !== null) === (toNode !== '')) {
      return { ok: false, error: `rule "${label}": forward to either one channel or one node` };
    }
    if (toNode.length > 80) return { ok: false, error: `rule "${label}": target node id is too long` };

    // Loop shapes that could only ever bounce a message back where it came from.
    if (matchChannel !== null && toChannel !== null && matchChannel === toChannel) {
      return { ok: false, error: `rule "${label}": cannot forward a channel to itself` };
    }
    if (toNode && fromNodeId && normalizeForwardingNodeId(toNode) === normalizeForwardingNodeId(fromNodeId)) {
      return { ok: false, error: `rule "${label}": cannot forward a node's messages back to the same node` };
    }

    const prefix = typeof r.prefix === 'string' ? r.prefix : '';
    if (prefix.length > FORWARDING_MAX_PREFIX_CHARS) {
      return { ok: false, error: `rule "${label}": prefix is too long (max ${FORWARDING_MAX_PREFIX_CHARS})` };
    }

    const match: ForwardingMatch = matchDM ? { isDM: true } : { channel: matchChannel };
    if (fromNodeId) match.fromNodeId = fromNodeId;
    if (textRegex) match.textRegex = textRegex;
    const forwardTo: ForwardingTarget = toNode ? { destinationNodeId: toNode } : { channel: toChannel };

    rules.push({ id, name, enabled: r.enabled === true, match, forwardTo, prefix });
  }
  return { ok: true, rules };
}
