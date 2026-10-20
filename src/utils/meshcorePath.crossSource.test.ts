/**
 * #5909: own-contacts-first route resolution with a cross-source fallback.
 */
import { describe, it, expect } from 'vitest';
import { resolveRouteWithFallback, type CrossSourceHopPool, type CrossSourceHopCandidate } from './meshcorePath';
import type { MeshCoreContact } from './meshcoreHelpers';

const key = (prefix: string, fill = 'b') => prefix + fill.repeat(64 - prefix.length);

const own: MeshCoreContact[] = [
  { publicKey: key('a3'), advType: 2, advName: 'Own Hilltop', latitude: 52.0, longitude: 4.5 },
];

const cand = (prefix: string, name: string, over: Partial<CrossSourceHopCandidate> = {}): CrossSourceHopCandidate => ({
  name,
  publicKey: key(prefix, name.length % 2 ? 'c' : 'd'),
  sourceId: 'mqtt-1',
  sourceName: 'DutchMeshcore',
  ...over,
});

describe('resolveRouteWithFallback', () => {
  it('leaves own matches alone even when the pool has the same hash', () => {
    const pool: CrossSourceHopPool = { a3: [cand('a3', 'Other A3')] };
    const [r] = resolveRouteWithFallback(['a3'], own, pool);
    expect(r).toMatchObject({ origin: 'own', name: 'Own Hilltop', via: null, tentative: false, candidates: [] });
  });

  it('behaves like resolveRoute with no pool', () => {
    const rows = resolveRouteWithFallback(['a3', 'ff'], own, null);
    expect(rows.map((r) => [r.origin, r.name])).toEqual([['own', 'Own Hilltop'], ['none', null]]);
  });

  it('names an unknown hop from a single other-source match, labelled and not tentative', () => {
    const pool: CrossSourceHopPool = { '7f': [cand('7f', 'NL-RTM-RPT-01', { latitude: 51.9, longitude: 4.4 })] };
    const [, r] = resolveRouteWithFallback(['a3', '7f'], own, pool);
    expect(r).toMatchObject({
      origin: 'other',
      name: 'NL-RTM-RPT-01',
      via: { sourceId: 'mqtt-1', sourceName: 'DutchMeshcore' },
      tentative: false,
      matchCount: 1,
      position: { lat: 51.9, lon: 4.4 },
    });
  });

  it('ranks a collision by distance to neighbours and marks the guess tentative with no position', () => {
    const pool: CrossSourceHopPool = {
      '7f': [
        cand('7f', 'Far Away', { latitude: 40.0, longitude: -74.0 }),
        cand('7f', 'Close By', { latitude: 52.01, longitude: 4.51 }),
        cand('7f', 'No Fix'),
      ],
    };
    const [, r] = resolveRouteWithFallback(['a3', '7f'], own, pool);
    expect(r.origin).toBe('other');
    expect(r.tentative).toBe(true);
    expect(r.name).toBe('Close By');
    expect(r.matchCount).toBe(3);
    expect(r.position).toBeNull();
    expect(r.candidates.map((c) => c.name)).toEqual(['Close By', 'Far Away', 'No Fix']);
    expect(r.candidates[2].distanceKm).toBeUndefined();
  });

  it('uses the receiving radio as the anchor after the last hop', () => {
    const pool: CrossSourceHopPool = {
      '7f': [
        cand('7f', 'Near Receiver', { latitude: 10.0, longitude: 10.0 }),
        cand('7f', 'Near Nothing', { latitude: -30.0, longitude: 100.0 }),
      ],
    };
    const [r] = resolveRouteWithFallback(['7f'], [], pool, { lat: 10.01, lon: 10.01 });
    expect(r).toMatchObject({ tentative: true, name: 'Near Receiver', via: { sourceName: 'DutchMeshcore' } });
  });

  it('does not anchor on a previous hop that was itself a guess', () => {
    const pool: CrossSourceHopPool = {
      '11': [
        cand('11', 'G1', { latitude: 0.5, longitude: 0.5 }),
        cand('11', 'G2', { latitude: 60, longitude: 60 }),
      ],
      '22': [
        cand('22', 'H1', { latitude: 0.6, longitude: 0.6 }),
        cand('22', 'H2', { latitude: 20, longitude: 20 }),
      ],
    };
    // Receiver near H2: hop 2 must rank by the receiver, not by hop 1's guess G1.
    const rows = resolveRouteWithFallback(['11', '22'], [], pool, { lat: 20.01, lon: 20.01 });
    expect(rows[1].name).toBe('H2');
  });

  it('shows "N candidates" (no name) when nothing can be ranked', () => {
    const pool: CrossSourceHopPool = { '7f': [cand('7f', 'Bravo'), cand('7f', 'Alpha')] };
    const [r] = resolveRouteWithFallback(['7f'], [], pool, null);
    expect(r).toMatchObject({ origin: 'other', name: null, tentative: false, via: null, matchCount: 2 });
    expect(r.candidates.map((c) => c.name)).toEqual(['Alpha', 'Bravo']);
  });

  it.each([
    ['1-byte', 'a3', 'a3'],
    ['2-byte', 'a3f2', 'a3f2'],
    ['3-byte', 'a3f20b', 'a3f20b'],
  ])('matches %s hop hashes by key prefix', (_label, hop, prefix) => {
    const pool: CrossSourceHopPool = { [hop]: [cand(prefix, 'Wide'), { ...cand('ee', 'Wrong Prefix') }] };
    const [r] = resolveRouteWithFallback([hop], [], pool);
    // The mismatched-prefix entry is dropped, leaving one certain match.
    expect(r).toMatchObject({ origin: 'other', name: 'Wide', tentative: false, matchCount: 1 });
  });

  it('own 2-byte contacts still win over the pool', () => {
    const contacts: MeshCoreContact[] = [{ publicKey: key('a3f2'), advType: 3, advName: 'Own Room' }];
    const pool: CrossSourceHopPool = { a3f2: [cand('a3f2', 'Remote')] };
    const [r] = resolveRouteWithFallback(['a3f2'], contacts, pool);
    expect(r).toMatchObject({ origin: 'own', name: 'Own Room' });
  });
});
