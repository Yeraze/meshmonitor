/**
 * Form model for an mqtt_broker source's hop-limit policy (#5188 raise,
 * #5190 clamp).
 *
 * Pure serialization helpers, kept out of DashboardPage.tsx so the page file
 * exports only components (react-refresh/only-export-components).
 *
 * The server-side evaluation lives in `src/server/mqttHopLimitPolicy.ts`;
 * these constants are duplicated rather than imported because pages and
 * components must not pull from `src/server`. They must stay in sync with
 * `MAX_RAISE_TARGET` / `RAISEABLE_PORTNUMS` there, which the source-save
 * endpoint validates against.
 */

/** Protocol max for `hop_limit` (3-bit field). Mirrors MAX_HOP_LIMIT. */
export const MAX_HOP_LIMIT = 7;

/** Mirrors MAX_RAISE_TARGET — backhaul is local injection, not a flood. */
export const MAX_RAISE_TARGET = 3;

export const PORTNUM_POSITION = 3;
export const PORTNUM_NODEINFO = 4;
export const PORTNUM_TEXT_MESSAGE = 1;
export const PORTNUM_TRACEROUTE = 70;
export const PORTNUM_TELEMETRY = 67;
export const PORTNUM_NEIGHBORINFO = 71;

/**
 * The portnums a raise may target — the ones firmware hop scaling
 * (`HAS_VARIABLE_HOPS`) clamps on the originating radio. Mirrors
 * RAISEABLE_PORTNUMS.
 */
export const RAISEABLE_PORTNUMS: ReadonlyArray<{ portnum: number; label: string }> = [
  { portnum: PORTNUM_POSITION, label: 'Position' },
  { portnum: PORTNUM_TELEMETRY, label: 'Telemetry' },
  { portnum: PORTNUM_NODEINFO, label: 'NodeInfo' },
  { portnum: PORTNUM_NEIGHBORINFO, label: 'NeighborInfo' },
];

/**
 * Portnums offered as clamp exemptions. The clamp covers everything by
 * default; these are the ones an operator plausibly wants to keep at full
 * arrived reach (cross-mesh chat, network diagnostics).
 *
 * An exemption can only be honored when the portnum is readable. Packets we
 * hold no decryption key for are clamped regardless — see the null-portnum
 * rule in `mqttHopLimitPolicy.ts`.
 */
export const CLAMP_EXEMPTABLE_PORTNUMS: ReadonlyArray<{ portnum: number; label: string }> = [
  { portnum: PORTNUM_TEXT_MESSAGE, label: 'Text messages' },
  { portnum: PORTNUM_TRACEROUTE, label: 'Traceroutes' },
  { portnum: PORTNUM_POSITION, label: 'Position' },
  { portnum: PORTNUM_TELEMETRY, label: 'Telemetry' },
  { portnum: PORTNUM_NODEINFO, label: 'NodeInfo' },
  { portnum: PORTNUM_NEIGHBORINFO, label: 'NeighborInfo' },
];

export interface HopLimitPolicyForm {
  clampEnabled: boolean;
  clampMax: number;
  clampExempt: number[];
  raiseEnabled: boolean;
  raiseTarget: number;
  raisePortnums: number[];
}

export const EMPTY_HOP_LIMIT_POLICY_FORM: HopLimitPolicyForm = {
  clampEnabled: false,
  clampMax: 3,
  clampExempt: [],
  raiseEnabled: false,
  raiseTarget: 2,
  raisePortnums: [PORTNUM_NODEINFO],
};

function isInt(n: unknown, min: number, max: number): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= min && n <= max;
}

/**
 * Read a stored broker config into form state.
 *
 * A source saved before 4.17 carries the legacy `downlinkHopLimitOverride`
 * (or `zeroHopInjection`) "set hop_limit to N" knob. That loads as a **clamp
 * at N with the raise left off**, never as an enabled raise: the raise is a
 * deliberate bypass of firmware hop scaling and must not be switched on for an
 * operator who never asked for it. The server keeps honoring the legacy field
 * verbatim until the source is saved, so nothing changes on the wire until the
 * operator confirms — {@link legacyHopOverrideNotice} supplies the copy that
 * tells them what saving will do.
 */
export function formFromHopLimitConfig(cfg: Record<string, unknown> | null | undefined): HopLimitPolicyForm {
  const form: HopLimitPolicyForm = { ...EMPTY_HOP_LIMIT_POLICY_FORM, clampExempt: [], raisePortnums: [...EMPTY_HOP_LIMIT_POLICY_FORM.raisePortnums] };
  const stored = cfg?.hopLimitPolicy as
    | { raise?: { enabled?: boolean; target?: number; portnums?: number[] }; clamp?: { enabled?: boolean; max?: number; exemptPortnums?: number[] } }
    | undefined;

  if (stored) {
    if (stored.clamp?.enabled && isInt(stored.clamp.max, 0, MAX_HOP_LIMIT)) {
      form.clampEnabled = true;
      form.clampMax = stored.clamp.max;
      form.clampExempt = Array.isArray(stored.clamp.exemptPortnums) ? [...stored.clamp.exemptPortnums] : [];
    }
    if (stored.raise?.enabled && isInt(stored.raise.target, 1, MAX_RAISE_TARGET)) {
      const portnums = (stored.raise.portnums ?? []).filter((p) =>
        RAISEABLE_PORTNUMS.some((r) => r.portnum === p),
      );
      if (portnums.length > 0) {
        form.raiseEnabled = true;
        form.raiseTarget = stored.raise.target;
        form.raisePortnums = portnums;
      }
    }
    return form;
  }

  const legacy = legacyHopOverrideValue(cfg);
  if (legacy !== null) {
    form.clampEnabled = true;
    form.clampMax = legacy;
  }
  return form;
}

/**
 * The legacy #4081 / #3084 "set hop_limit to N" value stored on a config, or
 * null when the source has no legacy override.
 */
export function legacyHopOverrideValue(cfg: Record<string, unknown> | null | undefined): number | null {
  if (!cfg) return null;
  if (cfg.hopLimitPolicy) return null;
  const override = cfg.downlinkHopLimitOverride;
  if (isInt(override, 0, MAX_HOP_LIMIT)) return override;
  return cfg.zeroHopInjection ? 0 : null;
}

/**
 * Copy for the banner shown when a source still carries a legacy override,
 * or null when it does not. Explains what saving converts it into.
 */
export function legacyHopOverrideNotice(cfg: Record<string, unknown> | null | undefined): string | null {
  const legacy = legacyHopOverrideValue(cfg);
  if (legacy === null) return null;
  if (legacy === 0) {
    return 'This source uses the older "set hop limit to 0" override. Saving converts it to a clamp at 0, which behaves identically.';
  }
  return `This source uses the older "set hop limit to ${legacy}" override, which both raised and lowered every packet to ${legacy}. Saving converts it to a clamp at ${legacy} — packets arriving below ${legacy} will no longer be raised. If you need the raise back, enable it explicitly below.`;
}

/**
 * Serialize form state into the `hopLimitPolicy` config fragment. Returns an
 * empty object when neither half is enabled, so a source that turns the
 * feature off stores nothing at all rather than a disabled husk.
 */
export function hopLimitConfigFromForm(form: HopLimitPolicyForm): Record<string, unknown> {
  const policy: Record<string, unknown> = {};
  if (form.clampEnabled) {
    policy.clamp = {
      enabled: true,
      max: form.clampMax,
      ...(form.clampExempt.length > 0 ? { exemptPortnums: [...form.clampExempt].sort((a, b) => a - b) } : {}),
    };
  }
  if (form.raiseEnabled && form.raisePortnums.length > 0) {
    policy.raise = {
      enabled: true,
      target: form.raiseTarget,
      portnums: [...form.raisePortnums].sort((a, b) => a - b),
    };
  }
  return Object.keys(policy).length > 0 ? { hopLimitPolicy: policy } : {};
}

/** True when the clamp would silently suppress the configured raise. */
export function raiseSuppressedByClamp(form: HopLimitPolicyForm): boolean {
  return form.raiseEnabled && form.clampEnabled && form.raiseTarget > form.clampMax;
}
