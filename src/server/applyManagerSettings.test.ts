/**
 * Regression test for the per-source scheduler bootstrap gap (see PR-follow-up
 * to #2708-era auto-traceroute bug):
 *
 * On multi-source installs, only the singleton manager had per-source scheduler
 * settings applied at startup. Additional `new MeshtasticManager(sourceId, ...)`
 * instances kept class-field defaults, so auto-traceroute / LocalStats /
 * key-repair silently never fired for any source after the first one.
 *
 * Pin the contract: applyManagerSettings() must call setTracerouteInterval,
 * setLocalStatsInterval, and setKeyRepairSettings with values resolved via
 * getSettingForSource (per-source → global fallback).
 */
import { describe, it, expect, vi } from 'vitest';
import { applyManagerSettings } from './applyManagerSettings.js';

type Settings = Record<string, string | null>;

function makeDbStub(settings: Settings) {
  return {
    settings: {
      async getSetting(key: string) {
        return settings[key] ?? null;
      },
      async getSettingForSource(sourceId: string | null | undefined, key: string) {
        if (sourceId) {
          const scoped = settings[`source:${sourceId}:${key}`];
          if (scoped !== undefined && scoped !== null) return scoped;
        }
        return settings[key] ?? null;
      },
    },
  } as any;
}

function makeManagerStub() {
  return {
    setTracerouteInterval: vi.fn(),
    setLocalStatsInterval: vi.fn(),
    setKeyRepairSettings: vi.fn(),
  } as any;
}

describe('applyManagerSettings — per-source scheduler bootstrap', () => {
  it('applies per-source tracerouteIntervalMinutes when present', async () => {
    const db = makeDbStub({
      'source:SRC-A:tracerouteIntervalMinutes': '15',
      tracerouteIntervalMinutes: '0',
    });
    const mgr = makeManagerStub();

    await applyManagerSettings(mgr, 'SRC-A', db);

    expect(mgr.setTracerouteInterval).toHaveBeenCalledWith(15);
  });

  it('falls back to global tracerouteIntervalMinutes when no per-source override', async () => {
    const db = makeDbStub({ tracerouteIntervalMinutes: '10' });
    const mgr = makeManagerStub();

    await applyManagerSettings(mgr, 'SRC-B', db);

    expect(mgr.setTracerouteInterval).toHaveBeenCalledWith(10);
  });

  it('applies per-source localStatsIntervalMinutes', async () => {
    const db = makeDbStub({ 'source:SRC-A:localStatsIntervalMinutes': '7' });
    const mgr = makeManagerStub();

    await applyManagerSettings(mgr, 'SRC-A', db);

    expect(mgr.setLocalStatsInterval).toHaveBeenCalledWith(7);
  });

  it('applies key repair settings with correct coercions', async () => {
    const db = makeDbStub({
      autoKeyManagementEnabled: 'true',
      autoKeyManagementIntervalMinutes: '8',
      autoKeyManagementMaxExchanges: '4',
      autoKeyManagementAutoPurge: 'true',
      autoKeyManagementImmediatePurge: 'false',
    });
    const mgr = makeManagerStub();

    await applyManagerSettings(mgr, 'SRC-A', db);

    expect(mgr.setKeyRepairSettings).toHaveBeenCalledWith({
      enabled: true,
      intervalMinutes: 8,
      maxExchanges: 4,
      autoPurge: true,
      immediatePurge: false,
    });
  });

  it('uses key repair defaults when settings are missing', async () => {
    const db = makeDbStub({});
    const mgr = makeManagerStub();

    await applyManagerSettings(mgr, 'SRC-A', db);

    expect(mgr.setKeyRepairSettings).toHaveBeenCalledWith({
      enabled: false,
      intervalMinutes: 5,
      maxExchanges: 3,
      autoPurge: false,
      immediatePurge: false,
    });
  });

  it('skips setTracerouteInterval when value out of range', async () => {
    const db = makeDbStub({ 'source:SRC-A:tracerouteIntervalMinutes': '999' });
    const mgr = makeManagerStub();

    await applyManagerSettings(mgr, 'SRC-A', db);

    expect(mgr.setTracerouteInterval).not.toHaveBeenCalled();
  });

  it('skips setTracerouteInterval when value is not a number', async () => {
    const db = makeDbStub({ 'source:SRC-A:tracerouteIntervalMinutes': 'abc' });
    const mgr = makeManagerStub();

    await applyManagerSettings(mgr, 'SRC-A', db);

    expect(mgr.setTracerouteInterval).not.toHaveBeenCalled();
  });

  it('allows 0 (disabled) for traceroute interval', async () => {
    const db = makeDbStub({ 'source:SRC-A:tracerouteIntervalMinutes': '0' });
    const mgr = makeManagerStub();

    await applyManagerSettings(mgr, 'SRC-A', db);

    expect(mgr.setTracerouteInterval).toHaveBeenCalledWith(0);
  });

  it('per-source value wins over global for both interval settings', async () => {
    const db = makeDbStub({
      tracerouteIntervalMinutes: '0',
      localStatsIntervalMinutes: '60',
      'source:SRC-A:tracerouteIntervalMinutes': '15',
      'source:SRC-A:localStatsIntervalMinutes': '5',
    });
    const mgr = makeManagerStub();

    await applyManagerSettings(mgr, 'SRC-A', db);

    expect(mgr.setTracerouteInterval).toHaveBeenCalledWith(15);
    expect(mgr.setLocalStatsInterval).toHaveBeenCalledWith(5);
  });
});
