import { describe, it, expect } from 'vitest';
import type { DeviceInfo } from '../types/device';
import type { NodeFilters } from '../types/ui';
import {
  DEFAULT_NODE_FILTERS,
  normalizeNodeFilters,
  passesNodeFilters,
  toMeshtasticFilterSubject,
  type NodeFilterSubject,
} from './nodeAdvancedFilter';

const subj = (o: Partial<NodeFilterSubject> = {}): NodeFilterSubject => ({
  hasPosition: false, isUnknown: false, isIgnored: false, isFavorite: false, role: 0, channel: 0, ...o,
});
const filt = (o: Partial<NodeFilters> = {}): NodeFilters => ({ ...DEFAULT_NODE_FILTERS, ...o });

describe('passesNodeFilters', () => {
  const cases: Array<[string, Partial<NodeFilters>, Partial<NodeFilterSubject>]> = [
    ['mqtt', { showMqtt: true }, { viaMqtt: true }],
    ['telemetry', { showTelemetry: true }, { hasTelemetry: true }],
    ['environment', { showEnvironment: true }, { hasEnvironment: true }],
    ['position', { showPosition: true }, { hasPosition: true }],
    ['pki', { showPKI: true }, { hasPKI: true }],
    ['remoteAdmin', { showRemoteAdmin: true }, { hasRemoteAdmin: true }],
    ['unknown', { showUnknown: true }, { isUnknown: true }],
    ['favorites', { showFavorites: true }, { isFavorite: true }],
    ['favoriteLocked', { showFavoriteLocked: true }, { favoriteLocked: true }],
    ['hiddenFromMap', { showHiddenFromMap: true }, { hiddenFromMap: true }],
    ['roles', { deviceRoles: [2] }, { role: 2 }],
    ['channels', { channels: [3] }, { channel: 3 }],
  ];
  for (const [name, f, match] of cases) {
    it(`${name}: show keeps matches, hide drops them`, () => {
      expect(passesNodeFilters(subj(match), filt({ ...f, filterMode: 'show' }))).toBe(true);
      expect(passesNodeFilters(subj(), filt({ ...f, filterMode: 'show' }))).toBe(false);
      expect(passesNodeFilters(subj(match), filt({ ...f, filterMode: 'hide' }))).toBe(false);
      expect(passesNodeFilters(subj(), filt({ ...f, filterMode: 'hide' }))).toBe(true);
    });
  }

  it('hops: null and undefined pass; range applies in both modes', () => {
    const f = filt({ minHops: 1, maxHops: 3 });
    expect(passesNodeFilters(subj({ hops: null }), f)).toBe(true);
    expect(passesNodeFilters(subj(), f)).toBe(true);
    expect(passesNodeFilters(subj({ hops: 0 }), f)).toBe(false);
    expect(passesNodeFilters(subj({ hops: 4 }), f)).toBe(false);
    expect(passesNodeFilters(subj({ hops: 2 }), filt({ ...f, filterMode: 'hide' }))).toBe(true);
  });

  it('power source skips when battery is undefined', () => {
    expect(passesNodeFilters(subj(), filt({ powerSource: 'powered' }))).toBe(true);
    expect(passesNodeFilters(subj({ batteryLevel: 80 }), filt({ powerSource: 'powered' }))).toBe(false);
    expect(passesNodeFilters(subj({ batteryLevel: 101 }), filt({ powerSource: 'battery' }))).toBe(false);
    expect(passesNodeFilters(subj({ batteryLevel: 101 }), filt({ powerSource: 'powered' }))).toBe(true);
  });

  it('ignored nodes hide unless showIgnored; allowAgedOut lets aged-out aircraft through', () => {
    expect(passesNodeFilters(subj({ isIgnored: true }), filt())).toBe(false);
    expect(passesNodeFilters(subj({ isIgnored: true }), filt({ showIgnored: true }))).toBe(true);
    const aged = subj({ isIgnored: true, isAgedOutAircraft: true });
    expect(passesNodeFilters(aged, filt())).toBe(false);
    expect(passesNodeFilters(aged, filt(), { allowAgedOut: true })).toBe(true);
    expect(passesNodeFilters(subj({ isIgnored: true }), filt(), { allowAgedOut: true })).toBe(false);
  });
});

describe('normalizeNodeFilters', () => {
  it('fills legacy objects', () => {
    const n = normalizeNodeFilters({ showMqtt: true, minHops: 2 });
    expect(n.showMqtt).toBe(true);
    expect(n.minHops).toBe(2);
    expect(n.showFavorites).toBe(false);
    expect(n.deviceRoles).toEqual([]);
  });
  it('survives garbage', () => {
    expect(normalizeNodeFilters(null)).toEqual(DEFAULT_NODE_FILTERS);
    expect(normalizeNodeFilters('x')).toEqual(DEFAULT_NODE_FILTERS);
    expect(normalizeNodeFilters([1])).toEqual(DEFAULT_NODE_FILTERS);
  });
  it('repairs filterMode and arrays', () => {
    const n = normalizeNodeFilters({ filterMode: '', deviceRoles: 5, channels: null });
    expect(n.filterMode).toBe('show');
    expect(n.deviceRoles).toEqual([]);
    expect(n.channels).toEqual([]);
  });
});

// Reference: the pre-extraction useSourceView predicate (without favourites).
function legacy(node: DeviceInfo, f: NodeFilters, sets: { t: Set<string>; w: Set<string>; p: Set<string> }): boolean {
  const nodeId = node.user?.id;
  const show = f.filterMode === 'show';
  const chk = (m: unknown) => (show ? !!m : !m);
  if (f.showMqtt && !chk(node.viaMqtt)) return false;
  if (f.showTelemetry && !chk(nodeId && sets.t.has(nodeId))) return false;
  if (f.showEnvironment && !chk(nodeId && sets.w.has(nodeId))) return false;
  const b = node.deviceMetrics?.batteryLevel;
  if (f.powerSource !== 'both' && b !== undefined) {
    const pw = b === 101;
    if (f.powerSource === 'powered' && !pw) return false;
    if (f.powerSource === 'battery' && pw) return false;
  }
  if (f.showPosition && !chk(node.position && node.position.latitude != null && node.position.longitude != null)) return false;
  if (node.hopsAway != null && (node.hopsAway < f.minHops || node.hopsAway > f.maxHops)) return false;
  if (f.showPKI && !chk(nodeId && sets.p.has(nodeId))) return false;
  if (f.showRemoteAdmin && !chk(!!node.hasRemoteAdmin)) return false;
  if (f.showUnknown) {
    const l = node.user?.longName && node.user.longName.trim() !== '';
    const s = node.user?.shortName && node.user.shortName.trim() !== '';
    if (!chk(!l && !s)) return false;
  }
  if (!f.showIgnored && node.isIgnored) return false;
  if (f.showFavoriteLocked && !chk(!!node.favoriteLocked)) return false;
  if (f.showHiddenFromMap && !chk(!!node.hideFromMap)) return false;
  if (f.deviceRoles.length > 0) {
    const r = typeof node.user?.role === 'number' ? node.user.role : parseInt(node.user?.role || '0');
    if (!chk(f.deviceRoles.includes(r))) return false;
  }
  if (f.channels.length > 0 && !chk(f.channels.includes(node.channel ?? -1))) return false;
  return true;
}

describe('toMeshtasticFilterSubject parity with the legacy predicate', () => {
  const sets = { t: new Set(['!a']), w: new Set(['!b']), p: new Set(['!a', '!c']) };
  const mk = (o: Partial<DeviceInfo>): DeviceInfo => ({ nodeNum: 1, ...o } as DeviceInfo);
  const nodes: DeviceInfo[] = [
    mk({ user: { id: '!a', longName: 'A', shortName: 'a', role: 2 } as any, viaMqtt: true, hopsAway: 1, channel: 0, position: { latitude: 1, longitude: 2 } as any, deviceMetrics: { batteryLevel: 101 } as any }),
    mk({ user: { id: '!b', longName: ' ', shortName: '', role: '5' } as any, hopsAway: 4, channel: 2, hasRemoteAdmin: true, favoriteLocked: true, isIgnored: true }),
    mk({ user: { id: '!c', longName: '', shortName: 'c' } as any, hideFromMap: true, deviceMetrics: { batteryLevel: 50 } as any, position: { latitude: 1 } as any }),
    mk({}),
    mk({ user: { id: '!d', longName: 'D', shortName: 'd', role: 0 } as any, hopsAway: 0, channel: undefined }),
  ];
  const filters: Array<Partial<NodeFilters>> = [
    {}, { showMqtt: true }, { showTelemetry: true }, { showEnvironment: true }, { powerSource: 'powered' },
    { powerSource: 'battery' }, { showPosition: true }, { minHops: 1, maxHops: 2 }, { showPKI: true },
    { showRemoteAdmin: true }, { showUnknown: true }, { showIgnored: true }, { showFavoriteLocked: true },
    { showHiddenFromMap: true }, { deviceRoles: [0, 2] }, { channels: [-1, 2] },
    { showMqtt: true, showPKI: true, showUnknown: true, showIgnored: true },
  ];
  for (const mode of ['show', 'hide'] as const) {
    it(`matches in ${mode} mode`, () => {
      for (const o of filters) {
        const f = filt({ ...o, filterMode: mode });
        for (const n of nodes) {
          const got = passesNodeFilters(toMeshtasticFilterSubject(n, { nodesWithTelemetry: sets.t, nodesWithWeather: sets.w, nodesWithPKC: sets.p }), f);
          expect(got, JSON.stringify([o, n.user?.id])).toBe(legacy(n, f, sets));
        }
      }
    });
  }
});
