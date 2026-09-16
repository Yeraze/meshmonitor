/**
 * Hop-limit raise/clamp policy (#5188, #5190).
 */
import { describe, it, expect } from 'vitest';
import {
  MAX_RAISE_TARGET,
  RAISEABLE_PORTNUMS,
  applyHopLimitPolicy,
  raiseIsSuppressedByClamp,
  resolveHopLimitPolicy,
  type HopLimitPolicy,
} from './mqttHopLimitPolicy.js';
import { PortNum } from './constants/meshtastic.js';

const POSITION = PortNum.POSITION_APP;
const TEXT = PortNum.TEXT_MESSAGE_APP;

describe('resolveHopLimitPolicy', () => {
  it('returns null for a config with no hop settings at all', () => {
    expect(resolveHopLimitPolicy({})).toBeNull();
    expect(resolveHopLimitPolicy(undefined)).toBeNull();
    expect(resolveHopLimitPolicy(null)).toBeNull();
  });

  it('maps the legacy zeroHopInjection boolean onto a clamp at 0', () => {
    const policy = resolveHopLimitPolicy({ zeroHopInjection: true });
    expect(policy).toEqual({ raise: undefined, clamp: { enabled: true, max: 0 } });
  });

  it('maps a legacy numeric override onto the raise+clamp pair that reproduces it', () => {
    const policy = resolveHopLimitPolicy({ downlinkHopLimitOverride: 5 })!;
    // min(max(arrived, 5), 5) === 5 for every arrival, which is exactly what
    // the old "set hop_limit to 5" did.
    for (const arrived of [0, 1, 5, 7]) {
      expect(applyHopLimitPolicy(policy, POSITION, arrived)).toBe(5);
      expect(applyHopLimitPolicy(policy, TEXT, arrived)).toBe(5);
      expect(applyHopLimitPolicy(policy, null, arrived)).toBe(5);
    }
  });

  it('honors a legacy override of 0 even though proto3 omits it', () => {
    const policy = resolveHopLimitPolicy({ downlinkHopLimitOverride: 0 })!;
    expect(applyHopLimitPolicy(policy, POSITION, 7)).toBe(0);
    expect(policy.raise).toBeUndefined();
  });

  it('ignores an out-of-range legacy override', () => {
    expect(resolveHopLimitPolicy({ downlinkHopLimitOverride: 9 })).toBeNull();
    expect(resolveHopLimitPolicy({ downlinkHopLimitOverride: 1.5 })).toBeNull();
  });

  it('prefers the new policy over the legacy fields when both are stored', () => {
    const policy = resolveHopLimitPolicy({
      downlinkHopLimitOverride: 7,
      hopLimitPolicy: { clamp: { enabled: true, max: 2 } },
    })!;
    expect(applyHopLimitPolicy(policy, POSITION, 7)).toBe(2);
    expect(policy.raise).toBeUndefined();
  });

  it('treats a present-but-empty policy as an explicit off, not a legacy fallthrough', () => {
    expect(
      resolveHopLimitPolicy({
        downlinkHopLimitOverride: 7,
        hopLimitPolicy: { clamp: { enabled: false, max: 2 } },
      }),
    ).toBeNull();
  });

  it('drops a raise whose target exceeds the cap', () => {
    const policy = resolveHopLimitPolicy({
      hopLimitPolicy: { raise: { enabled: true, target: MAX_RAISE_TARGET + 1, portnums: [POSITION] } },
    });
    expect(policy).toBeNull();
  });

  it('drops portnums a raise is not allowed to target', () => {
    const policy = resolveHopLimitPolicy({
      hopLimitPolicy: { raise: { enabled: true, target: 2, portnums: [TEXT] } },
    });
    expect(policy).toBeNull();
  });

  it('keeps only the allowed portnums from a mixed raise list', () => {
    const policy = resolveHopLimitPolicy({
      hopLimitPolicy: { raise: { enabled: true, target: 2, portnums: [TEXT, POSITION] } },
    })!;
    expect(policy.raise?.portnums).toEqual([POSITION]);
  });

  it('exposes every raiseable portnum from the firmware hop-scaling set', () => {
    expect([...RAISEABLE_PORTNUMS].sort((a, b) => a - b)).toEqual(
      [
        PortNum.POSITION_APP,
        PortNum.NODEINFO_APP,
        PortNum.TELEMETRY_APP,
        PortNum.NEIGHBORINFO_APP,
      ].sort((a, b) => a - b),
    );
  });
});

/**
 * The legacy "set hop_limit to N" scalar has no resolver of its own any more —
 * `resolveHopLimitPolicy` subsumes it. These cases came from the retired
 * `resolveDownlinkHopLimit` suite and pin the same boundaries end-to-end:
 * whatever the stored legacy config, the forwarded value must equal what the
 * old scalar produced, or pass through untouched.
 */
describe('legacy scalar equivalence', () => {
  /** Forwarded hop limit for a config, or null for "pass through unchanged". */
  function forwarded(config: Parameters<typeof resolveHopLimitPolicy>[0], arrived = 5): number | null {
    const policy = resolveHopLimitPolicy(config);
    return policy ? applyHopLimitPolicy(policy, POSITION, arrived) : null;
  }

  it('passes through when nothing is configured', () => {
    expect(forwarded({})).toBeNull();
    expect(forwarded({ zeroHopInjection: false })).toBeNull();
  });

  it('reproduces the scalar across the whole 0-7 range, from any arrival', () => {
    for (let n = 0; n <= 7; n++) {
      for (const arrived of [0, 1, 4, 7]) {
        expect(forwarded({ downlinkHopLimitOverride: n }, arrived)).toBe(n);
      }
    }
  });

  it('prefers the numeric override over the legacy boolean', () => {
    expect(forwarded({ zeroHopInjection: true, downlinkHopLimitOverride: 4 })).toBe(4);
  });

  it('falls back to the boolean when the numeric override is unusable', () => {
    for (const bad of [-1, 8, 3.5, NaN]) {
      expect(forwarded({ downlinkHopLimitOverride: bad })).toBeNull();
      expect(forwarded({ zeroHopInjection: true, downlinkHopLimitOverride: bad })).toBe(0);
    }
  });
});

describe('applyHopLimitPolicy', () => {
  const raisePolicy: HopLimitPolicy = {
    raise: { enabled: true, target: 3, portnums: [POSITION] },
  };
  const clampPolicy: HopLimitPolicy = { clamp: { enabled: true, max: 3 } };

  it('raises only upward, never downward', () => {
    expect(applyHopLimitPolicy(raisePolicy, POSITION, 0)).toBe(3);
    expect(applyHopLimitPolicy(raisePolicy, POSITION, 1)).toBe(3);
    expect(applyHopLimitPolicy(raisePolicy, POSITION, 5)).toBe(5);
  });

  it('leaves portnums outside the raise list alone', () => {
    expect(applyHopLimitPolicy(raisePolicy, TEXT, 1)).toBe(1);
  });

  it('never raises a packet whose portnum cannot be read', () => {
    // An encrypted payload: we cannot tell whether it is one of the four
    // hop-scaled types, so the bypass must not fire.
    expect(applyHopLimitPolicy(raisePolicy, null, 1)).toBe(1);
  });

  it('clamps only downward, never upward', () => {
    expect(applyHopLimitPolicy(clampPolicy, TEXT, 7)).toBe(3);
    expect(applyHopLimitPolicy(clampPolicy, TEXT, 2)).toBe(2);
  });

  it('clamps a packet whose portnum cannot be read', () => {
    expect(applyHopLimitPolicy(clampPolicy, null, 7)).toBe(3);
  });

  it('honors a clamp exemption for a readable portnum', () => {
    const policy: HopLimitPolicy = {
      clamp: { enabled: true, max: 3, exemptPortnums: [TEXT] },
    };
    expect(applyHopLimitPolicy(policy, TEXT, 7)).toBe(7);
    expect(applyHopLimitPolicy(policy, POSITION, 7)).toBe(3);
  });

  it('cannot honor an exemption for an unreadable portnum', () => {
    const policy: HopLimitPolicy = {
      clamp: { enabled: true, max: 3, exemptPortnums: [TEXT] },
    };
    expect(applyHopLimitPolicy(policy, null, 7)).toBe(3);
  });

  it('runs the raise first and the clamp second', () => {
    const policy: HopLimitPolicy = {
      raise: { enabled: true, target: 3, portnums: [POSITION] },
      clamp: { enabled: true, max: 2 },
    };
    // Raise would take 1 → 3, then the clamp takes it back to 2. The clamp is
    // the final airtime authority.
    expect(applyHopLimitPolicy(policy, POSITION, 1)).toBe(2);
  });

  it('lets a raise through when it sits under the clamp', () => {
    const policy: HopLimitPolicy = {
      raise: { enabled: true, target: 2, portnums: [POSITION] },
      clamp: { enabled: true, max: 5 },
    };
    expect(applyHopLimitPolicy(policy, POSITION, 1)).toBe(2);
    expect(applyHopLimitPolicy(policy, POSITION, 7)).toBe(5);
  });

  it('never returns a value outside the 3-bit protocol range', () => {
    const policy: HopLimitPolicy = { clamp: { enabled: true, max: 7 } };
    expect(applyHopLimitPolicy(policy, POSITION, 99)).toBe(7);
    expect(applyHopLimitPolicy({}, POSITION, 99)).toBe(7);
  });
});

describe('raiseIsSuppressedByClamp', () => {
  it('flags a raise target above the clamp maximum', () => {
    expect(
      raiseIsSuppressedByClamp({
        raise: { enabled: true, target: 3, portnums: [POSITION] },
        clamp: { enabled: true, max: 1 },
      }),
    ).toBe(true);
  });

  it('does not flag a coherent pair', () => {
    expect(
      raiseIsSuppressedByClamp({
        raise: { enabled: true, target: 2, portnums: [POSITION] },
        clamp: { enabled: true, max: 3 },
      }),
    ).toBe(false);
  });

  it('does not flag when only one half is enabled', () => {
    expect(raiseIsSuppressedByClamp({ clamp: { enabled: true, max: 1 } })).toBe(false);
    expect(raiseIsSuppressedByClamp(null)).toBe(false);
  });
});
