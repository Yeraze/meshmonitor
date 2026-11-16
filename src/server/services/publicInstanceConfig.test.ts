import { describe, it, expect, beforeEach, vi } from 'vitest';

const { getSyncMock, getAsyncMock } = vi.hoisted(() => ({
  getSyncMock: vi.fn(),
  getAsyncMock: vi.fn(),
}));

vi.mock('../../services/database.js', () => ({
  default: { getSetting: getSyncMock, settings: { getSetting: getAsyncMock } },
}));

import {
  getPublicInstanceConfig,
  reloadPublicInstanceConfig,
  __setPublicInstanceConfigForTest,
  __resetPublicInstanceConfigForTest,
} from './publicInstanceConfig.js';

function store(values: Record<string, string>) {
  getSyncMock.mockImplementation((k: string) => values[k] ?? null);
  getAsyncMock.mockImplementation(async (k: string) => values[k] ?? null);
}

describe('publicInstanceConfig', () => {
  beforeEach(() => {
    __resetPublicInstanceConfigForTest();
    getSyncMock.mockReset();
    getAsyncMock.mockReset();
  });

  it('defaults: master off, toggles on', () => {
    store({});
    expect(getPublicInstanceConfig()).toEqual({
      enabled: false,
      hideLongNames: true,
      hidePublicKeys: true,
      roundTimestamps: true,
      hideMessageText: true,
    });
  });

  it('returns a frozen object', () => {
    store({});
    expect(Object.isFrozen(getPublicInstanceConfig())).toBe(true);
  });

  it('master parse truth table', () => {
    for (const [raw, want] of [['1', true], ['true', true], ['0', false], ['false', false], ['yes', false], ['', false]] as const) {
      __resetPublicInstanceConfigForTest();
      store({ publicInstanceModeEnabled: raw });
      expect(getPublicInstanceConfig().enabled, raw).toBe(want);
    }
  });

  it('sub-toggle parse truth table', () => {
    for (const [raw, want] of [['0', false], ['false', false], ['1', true], ['true', true], ['x', true], ['', true]] as const) {
      __resetPublicInstanceConfigForTest();
      store({ publicInstanceHideLongNames: raw });
      expect(getPublicInstanceConfig().hideLongNames, raw).toBe(want);
    }
  });

  it('reload picks up changed settings', async () => {
    store({});
    expect(getPublicInstanceConfig().enabled).toBe(false);
    store({ publicInstanceModeEnabled: '1', publicInstanceHideMessageText: '0' });
    await reloadPublicInstanceConfig();
    const cfg = getPublicInstanceConfig();
    expect(cfg.enabled).toBe(true);
    expect(cfg.hideMessageText).toBe(false);
  });

  it('test hook installs a config', () => {
    __setPublicInstanceConfigForTest({ enabled: true, hidePublicKeys: false });
    expect(getPublicInstanceConfig()).toMatchObject({ enabled: true, hidePublicKeys: false, hideLongNames: true });
  });
});
