/**
 * Hop-limit policy for MQTT packets MeshMonitor hands to a radio
 * (issues #5188 and #5190).
 *
 * Two independent operator knobs, evaluated in a fixed order:
 *
 * 1. **Raise** (#5188) — `hop_limit = max(arrived, target)`. A deliberate
 *    bypass of the source radio's own hop scaling, for managed-infrastructure
 *    backhaul. Off by default, capped at {@link MAX_RAISE_TARGET}, and
 *    restricted to the four portnums firmware hop scaling operates on.
 * 2. **Clamp** (#5190) — `hop_limit = min(raised, max)`. Airtime protection
 *    against unrestrained upstream nodes. Off by default, applies to every
 *    portnum unless the operator exempts one.
 *
 * Effective result: `min(max(arrived, raise.target), clamp.max)`. The clamp
 * runs last so it is always the final airtime authority — a raise target
 * above the clamp maximum is suppressed, not honored.
 *
 * `hop_start` is never rewritten. Consumers derive hops-taken from
 * `hop_start - hop_limit`, and rewriting it would change that arithmetic for
 * every config already relying on #4081's behavior. A raised `hop_limit` can
 * therefore exceed `hop_start`; firmware guards that comparison rather than
 * computing a negative, so it degrades to "hops-away not updated", not
 * corrupt data. (#5188 asks for `hop_start` to track the raise target; we
 * deliberately keep #4081's shipped behavior instead.)
 */

import { MAX_HOP_LIMIT, PortNum } from './constants/meshtastic.js';

/**
 * Upper bound on a raise target (#5188). Backhaul is local injection into the
 * receiving cluster, not a wide-area flood, so this stays well below
 * {@link MAX_HOP_LIMIT}.
 */
export const MAX_RAISE_TARGET = 3;

/**
 * The portnums firmware hop scaling (`HAS_VARIABLE_HOPS`) clamps on the
 * originating radio, and therefore the only ones a raise may target. Text,
 * traceroutes and DMs are routing-layer concerns and stay out of scope.
 */
export const RAISEABLE_PORTNUMS: readonly number[] = [
  PortNum.POSITION_APP,
  PortNum.TELEMETRY_APP,
  PortNum.NODEINFO_APP,
  PortNum.NEIGHBORINFO_APP,
];

/**
 * Portnum selector. An explicit list matches only those portnums; `'all'`
 * matches everything including packets whose portnum we cannot read (an
 * encrypted payload we hold no key for). Only the legacy-config synthesis in
 * {@link resolveHopLimitPolicy} produces `'all'` for a raise — operator-authored
 * raises must name their portnums.
 */
export type PortnumSelector = readonly number[] | 'all';

export interface HopLimitRaiseConfig {
  enabled: boolean;
  /** 1–{@link MAX_RAISE_TARGET} for operator-authored config. */
  target: number;
  portnums: PortnumSelector;
}

export interface HopLimitClampConfig {
  enabled: boolean;
  /** 0–{@link MAX_HOP_LIMIT}. */
  max: number;
  /** Portnums the clamp skips. Never honored for unreadable portnums. */
  exemptPortnums?: readonly number[];
}

export interface HopLimitPolicy {
  raise?: HopLimitRaiseConfig;
  clamp?: HopLimitClampConfig;
}

/**
 * Stored shape on a source config. Both halves are optional and off by
 * default — a source with no `hopLimitPolicy` forwards `hop_limit` unchanged.
 */
export interface StoredHopLimitPolicy {
  raise?: { enabled?: boolean; target?: number; portnums?: number[] };
  clamp?: { enabled?: boolean; max?: number; exemptPortnums?: number[] };
}

/** Config fields this module reads. Both source managers satisfy it. */
export interface HopLimitPolicyCarrier {
  hopLimitPolicy?: StoredHopLimitPolicy;
  /** Legacy #4081 numeric override. */
  downlinkHopLimitOverride?: number;
  /** Legacy #3084 boolean, equivalent to `downlinkHopLimitOverride: 0`. */
  zeroHopInjection?: boolean;
}

function isValidHop(n: unknown, min: number, max: number): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= min && n <= max;
}

/**
 * Map a legacy #4081 "set hop_limit to N" override onto the raise/clamp pair
 * that reproduces it exactly: `min(max(arrived, N), N) === N`.
 *
 * The legacy knob applied to every portnum and was not capped at
 * {@link MAX_RAISE_TARGET}, so its synthesized raise uses the `'all'` selector
 * and whatever target was stored. This keeps pre-4.17 configs byte-identical
 * on the wire without a data migration — a source rewrites itself into the new
 * shape the next time it is saved from the UI, exactly as #4081 did for
 * `zeroHopInjection`.
 */
function synthesizeLegacyPolicy(config: HopLimitPolicyCarrier): HopLimitPolicy | null {
  const override = config.downlinkHopLimitOverride;
  const target = isValidHop(override, 0, MAX_HOP_LIMIT)
    ? override
    : config.zeroHopInjection
      ? 0
      : null;
  if (target === null) return null;
  return {
    // A target of 0 can only ever lower, so there is nothing to raise.
    raise: target > 0 ? { enabled: true, target, portnums: 'all' } : undefined,
    clamp: { enabled: true, max: target },
  };
}

/**
 * Resolve the effective policy for a source config, or null for "forward
 * `hop_limit` unchanged". The new `hopLimitPolicy` wins whenever it is
 * present and enables at least one half; otherwise the legacy #4081/#3084
 * fields are mapped onto their raise/clamp equivalent.
 *
 * Out-of-range or non-integer values are dropped rather than clamped — the
 * route layer rejects them on save, so this only guards hand-edited configs.
 */
export function resolveHopLimitPolicy(config: HopLimitPolicyCarrier | undefined | null): HopLimitPolicy | null {
  if (!config) return null;
  const stored = config.hopLimitPolicy;
  if (stored) {
    const policy: HopLimitPolicy = {};
    const r = stored.raise;
    if (r?.enabled && isValidHop(r.target, 1, MAX_RAISE_TARGET)) {
      const portnums = (r.portnums ?? []).filter((p) => RAISEABLE_PORTNUMS.includes(p));
      if (portnums.length > 0) {
        policy.raise = { enabled: true, target: r.target, portnums };
      }
    }
    const c = stored.clamp;
    if (c?.enabled && isValidHop(c.max, 0, MAX_HOP_LIMIT)) {
      policy.clamp = {
        enabled: true,
        max: c.max,
        exemptPortnums: Array.isArray(c.exemptPortnums) ? c.exemptPortnums : undefined,
      };
    }
    if (policy.raise || policy.clamp) return policy;
    // A `hopLimitPolicy` that is present but enables nothing is an explicit
    // "off", not a fall-through to the legacy fields the UI just dropped.
    return null;
  }
  return synthesizeLegacyPolicy(config);
}

function selectorMatches(selector: PortnumSelector, portnum: number | null): boolean {
  if (selector === 'all') return true;
  return portnum !== null && selector.includes(portnum);
}

/**
 * Apply a resolved policy to one packet.
 *
 * @param portnum - the packet's portnum, or null when it cannot be read
 *   (encrypted payload). A null portnum never matches a raise — raises are
 *   opt-in per portnum — but is still clamped, because the clamp is a
 *   whole-airtime ceiling and an exemption list cannot be evaluated against a
 *   portnum we do not know.
 * @param arrived - the `hop_limit` the packet arrived with. proto3 omits zero
 *   on the wire, so callers must pass 0 for an absent field, not undefined.
 * @returns the hop limit to forward with.
 */
export function applyHopLimitPolicy(
  policy: HopLimitPolicy,
  portnum: number | null,
  arrived: number,
): number {
  let hop = arrived;
  const raise = policy.raise;
  if (raise?.enabled && selectorMatches(raise.portnums, portnum)) {
    hop = Math.max(hop, raise.target);
  }
  const clamp = policy.clamp;
  if (clamp?.enabled) {
    const exempt = portnum !== null && (clamp.exemptPortnums?.includes(portnum) ?? false);
    if (!exempt) hop = Math.min(hop, clamp.max);
  }
  return Math.max(0, Math.min(hop, MAX_HOP_LIMIT));
}

/**
 * True when `raise.target > clamp.max`, i.e. the clamp silently suppresses the
 * raise. Surfaced as a config-time warning rather than a save error — the
 * combination is coherent, just almost certainly not what the operator meant.
 */
export function raiseIsSuppressedByClamp(policy: HopLimitPolicy | null): boolean {
  if (!policy?.raise?.enabled || !policy.clamp?.enabled) return false;
  return policy.raise.target > policy.clamp.max;
}
