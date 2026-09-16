/**
 * Hop-limit policy form serialization (#5188, #5190).
 *
 * The load direction carries the interesting rule: a source still storing the
 * pre-4.17 "set hop_limit to N" override must load as a clamp with the raise
 * left OFF. Loading it as an enabled raise would switch on a bypass of
 * firmware hop scaling for an operator who never asked for one.
 */
import { describe, it, expect } from 'vitest';
import {
  EMPTY_HOP_LIMIT_POLICY_FORM,
  PORTNUM_NODEINFO,
  PORTNUM_POSITION,
  PORTNUM_TEXT_MESSAGE,
  formFromHopLimitConfig,
  hopLimitConfigFromForm,
  legacyHopOverrideNotice,
  legacyHopOverrideValue,
  raiseSuppressedByClamp,
} from './hopLimitPolicyForm';

describe('formFromHopLimitConfig', () => {
  it('returns the off-by-default form for a config with no hop settings', () => {
    const form = formFromHopLimitConfig({});
    expect(form.clampEnabled).toBe(false);
    expect(form.raiseEnabled).toBe(false);
  });

  it('loads a stored clamp', () => {
    const form = formFromHopLimitConfig({
      hopLimitPolicy: { clamp: { enabled: true, max: 2, exemptPortnums: [PORTNUM_TEXT_MESSAGE] } },
    });
    expect(form.clampEnabled).toBe(true);
    expect(form.clampMax).toBe(2);
    expect(form.clampExempt).toEqual([PORTNUM_TEXT_MESSAGE]);
  });

  it('loads a stored raise', () => {
    const form = formFromHopLimitConfig({
      hopLimitPolicy: { raise: { enabled: true, target: 3, portnums: [PORTNUM_POSITION] } },
    });
    expect(form.raiseEnabled).toBe(true);
    expect(form.raiseTarget).toBe(3);
    expect(form.raisePortnums).toEqual([PORTNUM_POSITION]);
  });

  it('drops raise portnums outside the hop-scaled set', () => {
    const form = formFromHopLimitConfig({
      hopLimitPolicy: { raise: { enabled: true, target: 2, portnums: [PORTNUM_TEXT_MESSAGE] } },
    });
    expect(form.raiseEnabled).toBe(false);
  });

  it('loads a legacy override as a clamp with the raise left off', () => {
    const form = formFromHopLimitConfig({ downlinkHopLimitOverride: 3 });
    expect(form.clampEnabled).toBe(true);
    expect(form.clampMax).toBe(3);
    expect(form.raiseEnabled).toBe(false);
  });

  it('loads the legacy zeroHopInjection boolean as a clamp at 0', () => {
    const form = formFromHopLimitConfig({ zeroHopInjection: true });
    expect(form.clampEnabled).toBe(true);
    expect(form.clampMax).toBe(0);
  });

  it('ignores the legacy fields once a policy is stored', () => {
    const form = formFromHopLimitConfig({
      downlinkHopLimitOverride: 7,
      hopLimitPolicy: { clamp: { enabled: true, max: 1 } },
    });
    expect(form.clampMax).toBe(1);
  });

  it('does not mutate the shared empty-form constant', () => {
    const form = formFromHopLimitConfig({});
    form.raisePortnums.push(PORTNUM_POSITION);
    expect(EMPTY_HOP_LIMIT_POLICY_FORM.raisePortnums).toEqual([PORTNUM_NODEINFO]);
  });
});

describe('legacyHopOverrideValue / legacyHopOverrideNotice', () => {
  it('reports the stored legacy value', () => {
    expect(legacyHopOverrideValue({ downlinkHopLimitOverride: 5 })).toBe(5);
    expect(legacyHopOverrideValue({ zeroHopInjection: true })).toBe(0);
    expect(legacyHopOverrideValue({})).toBeNull();
  });

  it('reports no legacy value once a policy is stored', () => {
    expect(
      legacyHopOverrideValue({ downlinkHopLimitOverride: 5, hopLimitPolicy: { clamp: { enabled: true, max: 1 } } }),
    ).toBeNull();
  });

  it('says a legacy 0 converts with no behavior change', () => {
    expect(legacyHopOverrideNotice({ downlinkHopLimitOverride: 0 })).toMatch(/identically/);
  });

  it('warns that a nonzero legacy override loses its raise on save', () => {
    const notice = legacyHopOverrideNotice({ downlinkHopLimitOverride: 4 })!;
    expect(notice).toMatch(/no longer be raised/);
    expect(notice).toMatch(/4/);
  });

  it('has nothing to say about a source with no legacy override', () => {
    expect(legacyHopOverrideNotice({})).toBeNull();
  });
});

describe('hopLimitConfigFromForm', () => {
  it('stores nothing when both halves are off', () => {
    expect(hopLimitConfigFromForm(EMPTY_HOP_LIMIT_POLICY_FORM)).toEqual({});
  });

  it('serializes a clamp, omitting an empty exemption list', () => {
    expect(
      hopLimitConfigFromForm({ ...EMPTY_HOP_LIMIT_POLICY_FORM, clampEnabled: true, clampMax: 2 }),
    ).toEqual({ hopLimitPolicy: { clamp: { enabled: true, max: 2 } } });
  });

  it('serializes clamp exemptions in a stable order', () => {
    const cfg = hopLimitConfigFromForm({
      ...EMPTY_HOP_LIMIT_POLICY_FORM,
      clampEnabled: true,
      clampMax: 3,
      clampExempt: [70, 1],
    }) as { hopLimitPolicy: { clamp: { exemptPortnums: number[] } } };
    expect(cfg.hopLimitPolicy.clamp.exemptPortnums).toEqual([1, 70]);
  });

  it('serializes a raise', () => {
    expect(
      hopLimitConfigFromForm({
        ...EMPTY_HOP_LIMIT_POLICY_FORM,
        raiseEnabled: true,
        raiseTarget: 2,
        raisePortnums: [PORTNUM_POSITION, PORTNUM_NODEINFO],
      }),
    ).toEqual({
      hopLimitPolicy: {
        raise: { enabled: true, target: 2, portnums: [PORTNUM_NODEINFO, PORTNUM_POSITION].sort((a, b) => a - b) },
      },
    });
  });

  it('drops a raise with no portnums selected rather than storing an unusable one', () => {
    expect(
      hopLimitConfigFromForm({
        ...EMPTY_HOP_LIMIT_POLICY_FORM,
        raiseEnabled: true,
        raisePortnums: [],
      }),
    ).toEqual({});
  });

  it('round-trips through the load direction', () => {
    const form = {
      ...EMPTY_HOP_LIMIT_POLICY_FORM,
      clampEnabled: true,
      clampMax: 3,
      clampExempt: [PORTNUM_TEXT_MESSAGE],
      raiseEnabled: true,
      raiseTarget: 2,
      raisePortnums: [PORTNUM_NODEINFO],
    };
    const cfg = hopLimitConfigFromForm(form);
    expect(formFromHopLimitConfig(cfg)).toEqual(form);
  });
});

describe('raiseSuppressedByClamp', () => {
  it('flags a raise target above the clamp maximum', () => {
    expect(
      raiseSuppressedByClamp({
        ...EMPTY_HOP_LIMIT_POLICY_FORM,
        raiseEnabled: true,
        raiseTarget: 3,
        clampEnabled: true,
        clampMax: 2,
      }),
    ).toBe(true);
  });

  it('stays quiet for a coherent pair or a single enabled half', () => {
    expect(
      raiseSuppressedByClamp({
        ...EMPTY_HOP_LIMIT_POLICY_FORM,
        raiseEnabled: true,
        raiseTarget: 2,
        clampEnabled: true,
        clampMax: 3,
      }),
    ).toBe(false);
    expect(
      raiseSuppressedByClamp({ ...EMPTY_HOP_LIMIT_POLICY_FORM, raiseEnabled: true, raiseTarget: 3 }),
    ).toBe(false);
  });
});
