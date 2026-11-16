import { describe, it, expect } from 'vitest';
import { parsePublicInstanceConfig, isPublicHiddenText, viewerPrecisionBits, PUBLIC_INSTANCE_HIDDEN_TEXT, PUBLIC_INSTANCE_SETTING_KEYS as K } from './publicInstanceMode.js';

describe('parsePublicInstanceConfig', () => {
  it('defaults: master off, toggles on', () => {
    expect(parsePublicInstanceConfig({})).toEqual({
      enabled: false, hideLongNames: true, hidePublicKeys: true, roundTimestamps: true, hideMessageText: true,
    });
    expect(parsePublicInstanceConfig(null).enabled).toBe(false);
  });
  it('master turns on only for 1/true', () => {
    for (const v of ['1', 'true']) expect(parsePublicInstanceConfig({ [K.enabled]: v }).enabled).toBe(true);
    for (const v of ['0', 'false', 'yes', '', null]) expect(parsePublicInstanceConfig({ [K.enabled]: v }).enabled).toBe(false);
  });
  it('toggles turn off only for 0/false', () => {
    for (const key of [K.hideLongNames, K.hidePublicKeys, K.roundTimestamps, K.hideMessageText]) {
      expect(parsePublicInstanceConfig({ [key]: '0' })).not.toEqual(parsePublicInstanceConfig({}));
      expect(parsePublicInstanceConfig({ [key]: 'false' })).not.toEqual(parsePublicInstanceConfig({}));
      expect(parsePublicInstanceConfig({ [key]: 'garbage' })).toEqual(parsePublicInstanceConfig({}));
    }
  });
});

describe('isPublicHiddenText', () => {
  it('matches only the exact placeholder', () => {
    expect(isPublicHiddenText(PUBLIC_INSTANCE_HIDDEN_TEXT)).toBe(true);
    expect(isPublicHiddenText(PUBLIC_INSTANCE_HIDDEN_TEXT + ' ')).toBe(false);
    expect(isPublicHiddenText('hello')).toBe(false);
    expect(isPublicHiddenText(null)).toBe(false);
    expect(isPublicHiddenText(undefined)).toBe(false);
  });
});

describe('viewerPrecisionBits', () => {
  it('passes bits through when not coarse', () => {
    expect(viewerPrecisionBits(32, false)).toBe(32);
    expect(viewerPrecisionBits(null, false)).toBeNull();
    expect(viewerPrecisionBits(undefined, false)).toBeUndefined();
  });
  it('keeps 1..13 and caps everything else to 14 when coarse', () => {
    expect(viewerPrecisionBits(1, true)).toBe(1);
    expect(viewerPrecisionBits(13, true)).toBe(13);
    for (const b of [0, 14, 16, 32, null, undefined, -1]) expect(viewerPrecisionBits(b, true)).toBe(14);
  });
});
