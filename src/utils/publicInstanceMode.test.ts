import { describe, it, expect } from 'vitest';
import { parsePublicInstanceConfig, PUBLIC_INSTANCE_SETTING_KEYS as K } from './publicInstanceMode.js';

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
