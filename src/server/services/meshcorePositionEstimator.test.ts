import { describe, it, expect } from 'vitest';
import { estimateFromEdges } from './meshcorePositionEstimator.js';

const NOW = 1_800_000_000_000;
const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);
const T = 'd'.repeat(64);

const pos = (publicKey: string, latitude: number, longitude: number, extra = {}) => ({ publicKey, latitude, longitude, ...extra });
const bare = (publicKey: string, extra = {}) => ({ publicKey, latitude: null, longitude: null, ...extra });
const edge = (a: string, b: string, kind: 'neighbor' | 'trace' = 'neighbor', snrDb = 5) => ({ a, b, snrDb, timestamp: NOW - 1000, kind });
const all = () => true;

describe('estimateFromEdges (MeshCore estimated positions)', () => {
  it('solves from neighbour and trace edges, in both directions', () => {
    const nodes = [pos(A, 10, 20), pos(B, 10.02, 20.02), bare(T)];
    // T heard A (neighbour, T reports A); B heard T (trace, T is the sender).
    const out = estimateFromEdges(nodes, [edge(T, A, 'neighbor'), edge(T, B, 'trace')], all, 0, NOW);
    expect(out).toHaveLength(1);
    expect(out[0].publicKey).toBe(T);
    expect(out[0].uniqueAnchors).toBe(2);
    expect(out[0].latitude).toBeGreaterThan(10);
    expect(out[0].latitude).toBeLessThan(10.02);
  });

  it('skips targets that already have a position or an override', () => {
    const nodes = [
      pos(A, 10, 20),
      pos(B, 11, 21),
      bare(C, { positionOverrideEnabled: true, latitudeOverride: 5, longitudeOverride: 5 }),
    ];
    const out = estimateFromEdges(nodes, [edge(A, B), edge(C, A)], all, 0, NOW);
    expect(out).toEqual([]);
  });

  it('never anchors on a node the viewer cannot see', () => {
    const nodes = [pos(A, 10, 20), pos(B, 10.5, 20.5, { positionOverrideEnabled: true, latitudeOverride: 1, longitudeOverride: 1 }), bare(T)];
    const out = estimateFromEdges(nodes, [edge(T, A), edge(T, B)], (k) => k !== A, 0, NOW);
    // A is hidden; only the overridden B anchors, at its override position.
    expect(out).toHaveLength(1);
    expect(out[0].latitude).toBeCloseTo(1, 5);
    expect(out[0].uniqueAnchors).toBe(1);
    // With both hidden there is nothing to solve from.
    expect(estimateFromEdges(nodes, [edge(T, A), edge(T, B)], (k) => k === T, 0, NOW)).toEqual([]);
  });

  it('does not estimate a target the viewer cannot see', () => {
    const out = estimateFromEdges([pos(A, 10, 20), bare(T)], [edge(T, A)], (k) => k !== T, 0, NOW);
    expect(out).toEqual([]);
  });

  it('drops estimates above the max uncertainty, keeps all at 0', () => {
    const nodes = [pos(A, 10, 20), bare(T)];
    // One anchor -> single_anchor radius (5 km).
    expect(estimateFromEdges(nodes, [edge(T, A)], all, 2, NOW)).toEqual([]);
    const kept = estimateFromEdges(nodes, [edge(T, A)], all, 0, NOW);
    expect(kept).toHaveLength(1);
    expect(kept[0].radiusMethod).toBe('single_anchor');
    expect(kept[0].uncertaintyKm).toBe(5);
  });

  it('ignores bogus anchors and self links', () => {
    const nodes = [pos(A, 0, 0), bare(T)];
    expect(estimateFromEdges(nodes, [edge(T, A), edge(T, T)], all, 0, NOW)).toEqual([]);
  });

  it('matches public keys case-insensitively', () => {
    const out = estimateFromEdges([pos(A.toUpperCase(), 10, 20), bare(T)], [edge(T.toUpperCase(), A)], all, 0, NOW);
    expect(out).toHaveLength(1);
  });
});
