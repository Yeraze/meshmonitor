/**
 * Message Forwarding engine (#5446) — protocol-neutral core shared by the
 * Meshtastic and MeshCore managers.
 *
 * Each manager turns an incoming text message into a {@link ForwardingMessage}
 * and supplies a `send` callback; this module decides which rules fire and
 * builds the forwarded text. Every mesh-safety rule lives here so both
 * protocols get the same limits:
 *
 *  - no send at all when the source cannot transmit (receive-only / TX off);
 *  - never forward our own sends (self-origin guard, mirrors #3914);
 *  - never forward a message that is itself a forward (the `[fwd] ` marker);
 *  - never forward a message that came from the rule's own destination
 *    (breaks A→B→A bounces between a channel/node pair);
 *  - at most {@link FORWARDING_MAX_PER_WINDOW} forwards per rule per rolling
 *    {@link FORWARDING_WINDOW_MS}; over the cap we drop and log once per window;
 *  - forwarded text capped at {@link FORWARDING_MAX_TEXT_CHARS} characters.
 *
 * Server-only: depends on RE2 through `compileAutoAckRegex`.
 */
import { logger } from '../../utils/logger.js';
import { compileAutoAckRegex } from './autoAckRegex.js';
import {
  FORWARDED_MARKER,
  FORWARDING_MAX_PER_WINDOW,
  FORWARDING_MAX_TEXT_CHARS,
  FORWARDING_WINDOW_MS,
  normalizeForwardingNodeId,
  validateForwardingRules,
  type ForwardingRule,
} from '../../types/forwarding.js';

export interface ForwardingMessage {
  text: string;
  isDM: boolean;
  /** Channel index for channel messages; ignored for DMs. */
  channel?: number | null;
  /** Sender id — Meshtastic `!abcd1234`, MeshCore public key (or prefix). */
  fromNodeId: string;
  /** True when the sender is one of MeshMonitor's own nodes. */
  isSelf: boolean;
  /** Display name for the `{from}` token; falls back to `fromNodeId`. */
  fromName?: string;
  /** Display name for the `{channel}` token; falls back to the index. */
  channelName?: string;
}

export type ForwardingTargetResolved =
  | { kind: 'dm'; nodeId: string }
  | { kind: 'channel'; channel: number };

export interface ForwardAction {
  ruleId: string;
  ruleName: string;
  target: ForwardingTargetResolved;
  text: string;
}

export type ForwardSkipReason =
  | 'tx_disabled'
  | 'self_origin'
  | 'already_forwarded'
  | 'empty_text'
  | 'disabled'
  | 'no_match'
  | 'from_destination'
  | 'invalid_regex'
  | 'rate_limited';

// ---------------------------------------------------------------------------
// Rate limiter
// ---------------------------------------------------------------------------

/**
 * Rolling-window limiter keyed by `sourceId:ruleId`. Held at module scope (see
 * {@link forwardingRateLimiter}) so it outlives a manager restart and is never
 * touched by a settings save — saving rules cannot re-open a spent window.
 */
export class ForwardingRateLimiter {
  private readonly sends = new Map<string, number[]>();
  /** Window start of the last "rate limited" log line per key. */
  private readonly loggedAt = new Map<string, number>();

  constructor(
    private readonly maxPerWindow: number = FORWARDING_MAX_PER_WINDOW,
    private readonly windowMs: number = FORWARDING_WINDOW_MS,
  ) {}

  /**
   * Record a send for `key` if under the cap. Returns false (and records
   * nothing) when the rolling window is already full.
   */
  tryConsume(key: string, now: number): boolean {
    const cutoff = now - this.windowMs;
    const recent = (this.sends.get(key) ?? []).filter((t) => t > cutoff);
    if (recent.length >= this.maxPerWindow) {
      this.sends.set(key, recent);
      return false;
    }
    recent.push(now);
    this.sends.set(key, recent);
    return true;
  }

  /**
   * True the first time a key is limited within a window, false afterwards —
   * so a flood logs one line per minute instead of one per dropped message.
   */
  shouldLogDrop(key: string, now: number): boolean {
    const last = this.loggedAt.get(key);
    if (last !== undefined && now - last < this.windowMs) return false;
    this.loggedAt.set(key, now);
    return true;
  }

  /** Test helper. */
  clear(): void {
    this.sends.clear();
    this.loggedAt.clear();
  }
}

/** Process-wide limiter shared by every source's manager. */
export const forwardingRateLimiter = new ForwardingRateLimiter();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** True when the text already carries our forwarding marker. */
export function isForwardedText(text: string): boolean {
  return text.trimStart().toLowerCase().startsWith(FORWARDED_MARKER.trim().toLowerCase());
}

/**
 * Two node ids refer to the same node. MeshCore can only name an unknown
 * sender by a public-key prefix, so a prefix of 12+ hex chars also counts.
 */
export function forwardingNodeIdsMatch(a: string, b: string): boolean {
  const x = normalizeForwardingNodeId(a);
  const y = normalizeForwardingNodeId(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= 12 && long.startsWith(short);
}

/**
 * Build the forwarded text: marker + rendered prefix + message, capped at
 * {@link FORWARDING_MAX_TEXT_CHARS} characters (code points, so an emoji is
 * never split). The message body is what gets trimmed, never the marker.
 */
export function buildForwardText(rule: ForwardingRule, message: ForwardingMessage): string {
  const from = (message.fromName || message.fromNodeId || '?').trim();
  const channel = message.isDM
    ? 'DM'
    : (message.channelName || (message.channel != null ? String(message.channel) : '?')).trim();
  const prefix = (rule.prefix ?? '').replace(/\{from\}/gi, from).replace(/\{channel\}/gi, channel);
  const head = Array.from(FORWARDED_MARKER + prefix).slice(0, FORWARDING_MAX_TEXT_CHARS - 20).join('');
  const body = Array.from(message.text.trim());
  const room = FORWARDING_MAX_TEXT_CHARS - Array.from(head).length;
  if (body.length <= room) return head + body.join('');
  return head + body.slice(0, room - 3).join('') + '...';
}

const regexCache = new Map<string, RegExp | null>();
function compileRuleRegex(pattern: string): RegExp | null {
  if (!regexCache.has(pattern)) {
    if (regexCache.size > 500) regexCache.clear();
    regexCache.set(pattern, compileAutoAckRegex(pattern).regex);
  }
  return regexCache.get(pattern) ?? null;
}

/** Parse the stored setting. Invalid JSON or rules yield an empty list. */
export function parseStoredForwardingRules(raw: string | null | undefined): ForwardingRule[] {
  if (!raw) return [];
  try {
    const v = validateForwardingRules(JSON.parse(raw));
    return v.ok ? v.rules : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

export interface ForwardingPlan {
  actions: ForwardAction[];
  /** Why each rule (or the whole message, keyed `*`) did not fire. */
  skipped: Array<{ ruleId: string; reason: ForwardSkipReason }>;
}

export interface PlanForwardsOptions {
  sourceId: string;
  rules: ForwardingRule[];
  message: ForwardingMessage;
  canTransmit: boolean;
  now?: number;
  limiter?: ForwardingRateLimiter;
}

/**
 * Decide which rules fire for one incoming message. Pure apart from the rate
 * limiter, which records every approved action.
 */
export function planForwards(opts: PlanForwardsOptions): ForwardingPlan {
  const { sourceId, rules, message } = opts;
  const now = opts.now ?? Date.now();
  const limiter = opts.limiter ?? forwardingRateLimiter;
  const plan: ForwardingPlan = { actions: [], skipped: [] };
  const skipAll = (reason: ForwardSkipReason): ForwardingPlan => {
    plan.skipped.push({ ruleId: '*', reason });
    return plan;
  };

  if (!rules.some((r) => r.enabled)) return skipAll('disabled');
  if (!opts.canTransmit) return skipAll('tx_disabled');
  if (message.isSelf) return skipAll('self_origin');
  const text = message.text ?? '';
  if (!text.trim()) return skipAll('empty_text');
  if (isForwardedText(text)) return skipAll('already_forwarded');

  for (const rule of rules) {
    const skip = (reason: ForwardSkipReason) => plan.skipped.push({ ruleId: rule.id, reason });
    if (!rule.enabled) { skip('disabled'); continue; }

    const m = rule.match;
    if (m.isDM === true) {
      if (!message.isDM) { skip('no_match'); continue; }
    } else {
      if (message.isDM || message.channel == null || m.channel !== message.channel) { skip('no_match'); continue; }
    }
    if (m.fromNodeId && !forwardingNodeIdsMatch(m.fromNodeId, message.fromNodeId)) { skip('no_match'); continue; }
    if (m.textRegex) {
      const re = compileRuleRegex(m.textRegex);
      if (!re) { skip('invalid_regex'); continue; }
      re.lastIndex = 0;
      if (!re.test(text)) { skip('no_match'); continue; }
    }

    // Loop break: never send a message back toward where it came from.
    const f = rule.forwardTo;
    let target: ForwardingTargetResolved;
    if (f.destinationNodeId) {
      if (forwardingNodeIdsMatch(f.destinationNodeId, message.fromNodeId)) { skip('from_destination'); continue; }
      target = { kind: 'dm', nodeId: f.destinationNodeId };
    } else if (typeof f.channel === 'number') {
      if (!message.isDM && message.channel === f.channel) { skip('from_destination'); continue; }
      target = { kind: 'channel', channel: f.channel };
    } else {
      skip('no_match');
      continue;
    }

    const key = `${sourceId}:${rule.id}`;
    if (!limiter.tryConsume(key, now)) {
      if (limiter.shouldLogDrop(key, now)) {
        logger.info(
          `[Forwarding:${sourceId}] Rule "${rule.name}" hit its limit of ${FORWARDING_MAX_PER_WINDOW} forwards per ` +
          `${FORWARDING_WINDOW_MS / 1000}s; dropping further matches until the window clears`,
        );
      }
      skip('rate_limited');
      continue;
    }

    plan.actions.push({ ruleId: rule.id, ruleName: rule.name, target, text: buildForwardText(rule, message) });
  }
  return plan;
}

/**
 * Plan and dispatch. `send` errors are logged, never thrown, so a bad rule
 * cannot break the caller's message loop. Sends run one after another.
 */
export async function runForwarding(
  opts: PlanForwardsOptions & { send: (action: ForwardAction) => Promise<boolean> | boolean },
): Promise<ForwardingPlan> {
  const plan = planForwards(opts);
  for (const action of plan.actions) {
    try {
      const ok = await opts.send(action);
      if (ok === false) {
        logger.warn(`[Forwarding:${opts.sourceId}] Rule "${action.ruleName}" send was not accepted`);
      } else {
        logger.debug(`[Forwarding:${opts.sourceId}] Rule "${action.ruleName}" forwarded to ${action.target.kind === 'dm' ? action.target.nodeId : `channel ${action.target.channel}`}`);
      }
    } catch (err) {
      logger.warn(`[Forwarding:${opts.sourceId}] Rule "${action.ruleName}" send failed: ${(err as Error).message}`);
    }
  }
  return plan;
}
