/**
 * Tests for `filterPathfindingContacts` — MeshCore Auto-Pathfinding target
 * filtering (#4024). Pure-function tests only: no manager construction, no
 * device IO. See docs/internal/dev-notes/PATHFINDING_FILTER_SPEC.md §3.1/§7.1.
 *
 * Unit note: `lastSeen` on `MeshCoreContact` is epoch **milliseconds**
 * (verified against meshcoreManager.ts write sites — every assignment uses
 * `Date.now()` or an advert-derived `advertMs`). `lastAdvert` is epoch
 * **seconds** (raw firmware `last_advert`). Fixtures below use the correct
 * unit for each field; the last-heard filter normalizes both to milliseconds
 * before comparing against the cutoff.
 */
import { describe, it, expect } from 'vitest';
import {
  filterPathfindingContacts,
  MC_PF_RSSI_FLOOR,
  MC_PF_SNR_FLOOR,
  MeshCoreDeviceType,
  type MeshCoreContact,
} from './meshcoreManager.js';
import type { MeshcorePathfindingFilterSettings } from '../services/database.js';

const NOW_MS = 1_700_000_000_000; // fixed reference instant

function baseCfg(overrides: Partial<MeshcorePathfindingFilterSettings> = {}): MeshcorePathfindingFilterSettings {
  return {
    enabled: true,
    targetKeys: [],
    contactsEnabled: false,
    regexEnabled: false,
    nameRegex: '.*',
    lastHeardEnabled: false,
    lastHeardHours: 168,
    hopsEnabled: false,
    hopsMin: 0,
    hopsMax: 10,
    signalEnabled: false,
    rssiMin: MC_PF_RSSI_FLOOR,
    snrMin: MC_PF_SNR_FLOOR,
    ...overrides,
  };
}

function contact(overrides: Partial<MeshCoreContact> & { publicKey: string }): MeshCoreContact {
  return {
    advName: undefined,
    name: undefined,
    advType: MeshCoreDeviceType.COMPANION,
    ...overrides,
  };
}

describe('filterPathfindingContacts (#4024)', () => {
  it('master off ⇒ returns input unchanged (identity)', () => {
    const contacts = [contact({ publicKey: 'k1' }), contact({ publicKey: 'k2' })];
    const cfg = baseCfg({ enabled: false, contactsEnabled: true, targetKeys: ['k1'] });
    expect(filterPathfindingContacts(contacts, cfg, NOW_MS)).toBe(contacts);
  });

  it('master on, no OR configured, no AND configured ⇒ all pass', () => {
    const contacts = [contact({ publicKey: 'k1' }), contact({ publicKey: 'k2' })];
    const cfg = baseCfg();
    const result = filterPathfindingContacts(contacts, cfg, NOW_MS);
    expect(result).toEqual(contacts);
  });

  it('allowlist only ⇒ only the listed contact passes', () => {
    const contacts = [contact({ publicKey: 'k1' }), contact({ publicKey: 'k2' })];
    const cfg = baseCfg({ contactsEnabled: true, targetKeys: ['k1'] });
    const result = filterPathfindingContacts(contacts, cfg, NOW_MS);
    expect(result.map(c => c.publicKey)).toEqual(['k1']);
  });

  it('selected contact no longer exists ⇒ empty result, no throw', () => {
    const contacts = [contact({ publicKey: 'k1' }), contact({ publicKey: 'k2' })];
    const cfg = baseCfg({ contactsEnabled: true, targetKeys: ['kGhost'] });
    expect(() => filterPathfindingContacts(contacts, cfg, NOW_MS)).not.toThrow();
    expect(filterPathfindingContacts(contacts, cfg, NOW_MS)).toEqual([]);
  });

  it('regex only ⇒ matches by advName/name', () => {
    const contacts = [
      contact({ publicKey: 'k1', advName: 'repeater-north' }),
      contact({ publicKey: 'k2', name: 'repeater-south' }),
      contact({ publicKey: 'k3', advName: 'companion-1' }),
    ];
    const cfg = baseCfg({ regexEnabled: true, nameRegex: '^repeater' });
    const result = filterPathfindingContacts(contacts, cfg, NOW_MS);
    expect(result.map(c => c.publicKey).sort()).toEqual(['k1', 'k2']);
  });

  it('regex "." wildcard default ⇒ all pass', () => {
    const contacts = [contact({ publicKey: 'k1' }), contact({ publicKey: 'k2' })];
    const cfg = baseCfg({ regexEnabled: true, nameRegex: '.*' });
    const result = filterPathfindingContacts(contacts, cfg, NOW_MS);
    expect(result).toEqual(contacts);
  });

  it('invalid regex, no other OR configured ⇒ hasAnyOr is false so every AND-survivor passes', () => {
    // RE2 rejects backreferences — an unsupported/malformed pattern compiles to
    // `regex = null`. With no allowlist active either, `hasAnyOr` evaluates
    // false (identical to "OR not configured"), so the AND-survivor pool
    // passes through untouched per the §3.1 algorithm.
    const contacts = [contact({ publicKey: 'k1', advName: 'alice' })];
    const cfg = baseCfg({ regexEnabled: true, nameRegex: '(a)\\1' });
    const result = filterPathfindingContacts(contacts, cfg, NOW_MS);
    expect(result).toEqual(contacts);
  });

  it('invalid regex falls through to a co-configured allowlist (OR union still applies)', () => {
    const contacts = [
      contact({ publicKey: 'k1', advName: 'alice' }), // in allowlist
      contact({ publicKey: 'k2', advName: 'bob' }), // not in allowlist, invalid regex can't rescue it
    ];
    const cfg = baseCfg({
      contactsEnabled: true,
      targetKeys: ['k1'],
      regexEnabled: true,
      nameRegex: '(a)\\1',
    });
    const result = filterPathfindingContacts(contacts, cfg, NOW_MS);
    expect(result.map(c => c.publicKey)).toEqual(['k1']);
  });

  it('OR union: allowlist ∪ regex, not intersection', () => {
    const contacts = [
      contact({ publicKey: 'k1', advName: 'zzz' }), // matches allowlist only
      contact({ publicKey: 'k2', advName: 'rep-1' }), // matches regex only
      contact({ publicKey: 'k3', advName: 'other' }), // matches neither
    ];
    const cfg = baseCfg({
      contactsEnabled: true,
      targetKeys: ['k1'],
      regexEnabled: true,
      nameRegex: '^rep',
    });
    const result = filterPathfindingContacts(contacts, cfg, NOW_MS);
    expect(result.map(c => c.publicKey).sort()).toEqual(['k1', 'k2']);
  });

  describe('last-heard AND filter', () => {
    it('excludes a contact whose lastSeen (ms) is older than the cutoff', () => {
      const hours = 24;
      const staleMs = NOW_MS - (hours + 1) * 3600 * 1000;
      const freshMs = NOW_MS - 1 * 3600 * 1000;
      const contacts = [
        contact({ publicKey: 'stale', lastSeen: staleMs }),
        contact({ publicKey: 'fresh', lastSeen: freshMs }),
      ];
      const cfg = baseCfg({ lastHeardEnabled: true, lastHeardHours: hours });
      const result = filterPathfindingContacts(contacts, cfg, NOW_MS);
      expect(result.map(c => c.publicKey)).toEqual(['fresh']);
    });

    it('honors lastAdvert (seconds) fallback when lastSeen is absent', () => {
      const hours = 24;
      const freshAdvertSecs = Math.floor((NOW_MS - 1 * 3600 * 1000) / 1000);
      const staleAdvertSecs = Math.floor((NOW_MS - (hours + 1) * 3600 * 1000) / 1000);
      const contacts = [
        contact({ publicKey: 'fresh', lastAdvert: freshAdvertSecs }),
        contact({ publicKey: 'stale', lastAdvert: staleAdvertSecs }),
      ];
      const cfg = baseCfg({ lastHeardEnabled: true, lastHeardHours: hours });
      const result = filterPathfindingContacts(contacts, cfg, NOW_MS);
      expect(result.map(c => c.publicKey)).toEqual(['fresh']);
    });

    it('excludes a contact with both lastSeen and lastAdvert null when enabled', () => {
      const contacts = [contact({ publicKey: 'k1' })];
      const cfg = baseCfg({ lastHeardEnabled: true, lastHeardHours: 24 });
      const result = filterPathfindingContacts(contacts, cfg, NOW_MS);
      expect(result).toEqual([]);
    });
  });

  describe('hop-range AND filter', () => {
    it('keeps pathLen within [min,max], excludes out-of-range', () => {
      const contacts = [
        contact({ publicKey: 'low', pathLen: 0 }),
        contact({ publicKey: 'mid', pathLen: 3 }),
        contact({ publicKey: 'high', pathLen: 9 }),
      ];
      const cfg = baseCfg({ hopsEnabled: true, hopsMin: 1, hopsMax: 5 });
      const result = filterPathfindingContacts(contacts, cfg, NOW_MS);
      expect(result.map(c => c.publicKey)).toEqual(['mid']);
    });

    it('excludes pathLen=null (unknown route) when hopsEnabled', () => {
      const contacts = [
        contact({ publicKey: 'unknown', pathLen: null }),
        contact({ publicKey: 'known', pathLen: 2 }),
      ];
      const cfg = baseCfg({ hopsEnabled: true, hopsMin: 0, hopsMax: 10 });
      const result = filterPathfindingContacts(contacts, cfg, NOW_MS);
      expect(result.map(c => c.publicKey)).toEqual(['known']);
    });
  });

  describe('signal AND filter', () => {
    it('applies rssiMin/snrMin thresholds; floor sentinel is a no-op', () => {
      const contacts = [
        contact({ publicKey: 'good', rssi: -50, snr: 5 }),
        contact({ publicKey: 'weakRssi', rssi: -90, snr: 5 }),
        contact({ publicKey: 'weakSnr', rssi: -50, snr: -20 }),
      ];
      const cfg = baseCfg({ signalEnabled: true, rssiMin: -70, snrMin: 0 });
      const result = filterPathfindingContacts(contacts, cfg, NOW_MS);
      expect(result.map(c => c.publicKey)).toEqual(['good']);
    });

    it('rssiMin at floor ⇒ rssi is not checked; only snr enforced', () => {
      const contacts = [
        contact({ publicKey: 'noRssi', rssi: undefined, snr: 5 }),
        contact({ publicKey: 'lowSnr', rssi: -50, snr: -50 }),
      ];
      const cfg = baseCfg({ signalEnabled: true, rssiMin: MC_PF_RSSI_FLOOR, snrMin: 0 });
      const result = filterPathfindingContacts(contacts, cfg, NOW_MS);
      expect(result.map(c => c.publicKey)).toEqual(['noRssi']);
    });

    it('excludes a contact missing the targeted metric when threshold is configured', () => {
      const contacts = [contact({ publicKey: 'k1', rssi: undefined, snr: 5 })];
      const cfg = baseCfg({ signalEnabled: true, rssiMin: -80, snrMin: MC_PF_SNR_FLOOR });
      const result = filterPathfindingContacts(contacts, cfg, NOW_MS);
      expect(result).toEqual([]);
    });

    it('requires both rssi and snr thresholds when both configured', () => {
      const contacts = [
        contact({ publicKey: 'bothPass', rssi: -50, snr: 5 }),
        contact({ publicKey: 'onlyRssiPass', rssi: -50, snr: -50 }),
        contact({ publicKey: 'onlySnrPass', rssi: -90, snr: 5 }),
      ];
      const cfg = baseCfg({ signalEnabled: true, rssiMin: -70, snrMin: 0 });
      const result = filterPathfindingContacts(contacts, cfg, NOW_MS);
      expect(result.map(c => c.publicKey)).toEqual(['bothPass']);
    });
  });

  it('AND narrows before OR: an allowlisted contact failing an AND pre-filter is excluded', () => {
    const contacts = [
      contact({ publicKey: 'k1', pathLen: 99 }), // allowlisted but out of hop range
    ];
    const cfg = baseCfg({
      contactsEnabled: true,
      targetKeys: ['k1'],
      hopsEnabled: true,
      hopsMin: 0,
      hopsMax: 5,
    });
    const result = filterPathfindingContacts(contacts, cfg, NOW_MS);
    expect(result).toEqual([]);
  });

  it('companions/repeaters share one filter: filtering the mixed set then splitting by advType', () => {
    const contacts = [
      contact({ publicKey: 'comp1', advType: MeshCoreDeviceType.COMPANION, advName: 'alice' }),
      contact({ publicKey: 'comp2', advType: MeshCoreDeviceType.COMPANION, advName: 'bob' }),
      contact({ publicKey: 'rep1', advType: MeshCoreDeviceType.REPEATER, advName: 'repeater-a' }),
      contact({ publicKey: 'rep2', advType: MeshCoreDeviceType.REPEATER, advName: 'repeater-b' }),
    ];
    const cfg = baseCfg({ regexEnabled: true, nameRegex: '^(alice|repeater-a)$' });
    const filtered = filterPathfindingContacts(contacts, cfg, NOW_MS);
    const companions = filtered.filter(c => c.advType === MeshCoreDeviceType.COMPANION);
    const repeaters = filtered.filter(c => c.advType === MeshCoreDeviceType.REPEATER);
    expect(companions.map(c => c.publicKey)).toEqual(['comp1']);
    expect(repeaters.map(c => c.publicKey)).toEqual(['rep1']);
  });
});
