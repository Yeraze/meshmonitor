/**
 * Network survey synthesis (#4726).
 *
 * The survey is read-only and passive, so the risks are not "does it break the
 * radio" but "does it quietly report the wrong thing": a unit mix-up that
 * marks every node inactive, another source's packets counted as this one's,
 * or one empty table blanking the whole view.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const getAllNodes = vi.fn();
const getDirectNeighborRssiAsync = vi.fn();
const getHopCounts = vi.fn();

vi.mock('../../services/database.js', () => ({
  default: {
    get nodes() { return { getAllNodes }; },
    get neighbors() { return { getDirectNeighborRssiAsync }; },
    get analysis() { return { getHopCounts }; },
  },
}));

import { buildNetworkSurvey, bucketHops, clampWindowHours } from './networkSurveyService.js';

const SRC = 'src-a';

beforeEach(() => {
  getAllNodes.mockReset().mockResolvedValue([]);
  getDirectNeighborRssiAsync.mockReset().mockResolvedValue(new Map());
  getHopCounts.mockReset().mockResolvedValue({ entries: [] });
});

describe('clampWindowHours', () => {
  it('defaults a non-numeric window rather than scanning everything', () => {
    expect(clampWindowHours(undefined)).toBe(24);
    expect(clampWindowHours('nonsense')).toBe(24);
  });

  it('clamps instead of rejecting', () => {
    expect(clampWindowHours(0)).toBe(1);
    expect(clampWindowHours(-5)).toBe(1);
    expect(clampWindowHours(99999)).toBe(24 * 30);
    expect(clampWindowHours('6')).toBe(6);
  });
});

describe('bucketHops', () => {
  it('counts nodes per hop distance, ascending', () => {
    expect(bucketHops([{ hops: 2 }, { hops: 0 }, { hops: 2 }, { hops: 1 }])).toEqual([
      { hops: 0, nodeCount: 1 },
      { hops: 1, nodeCount: 1 },
      { hops: 2, nodeCount: 2 },
    ]);
  });

  it('keeps hop 0 — direct contacts are a real bucket, not "no data"', () => {
    expect(bucketHops([{ hops: 0 }])).toEqual([{ hops: 0, nodeCount: 1 }]);
  });

  it('drops nonsense hop values instead of charting them', () => {
    expect(bucketHops([{ hops: -1 }, { hops: NaN }, { hops: 3 }])).toEqual([{ hops: 3, nodeCount: 1 }]);
  });
});

describe('buildNetworkSurvey', () => {
  it('scopes the direct-neighbour query to the source', async () => {
    // The whole point of the repository change: without this the survey
    // reports packets heard by OTHER radios as this radio's neighbours.
    await buildNetworkSurvey(SRC, 12);
    expect(getDirectNeighborRssiAsync).toHaveBeenCalledWith(12, SRC);
    expect(getHopCounts).toHaveBeenCalledWith({ sourceIds: [SRC] });
    expect(getAllNodes).toHaveBeenCalledWith(SRC);
  });

  it('treats node lastHeard as SECONDS against a millisecond window', async () => {
    // lastHeard is unix seconds; the cutoff is ms. Comparing them raw marks
    // every node inactive, which looks like a dead mesh rather than a bug.
    const nowSec = Math.floor(Date.now() / 1000);
    getAllNodes.mockResolvedValue([
      { nodeNum: 1, lastHeard: nowSec - 60 },        // a minute ago — active
      { nodeNum: 2, lastHeard: nowSec - 60 * 60 * 5 }, // 5h ago — outside a 1h window
      { nodeNum: 3, lastHeard: null },                 // never heard
    ]);

    const survey = await buildNetworkSurvey(SRC, 1);
    expect(survey.nodes.total).toBe(3);
    expect(survey.nodes.activeInWindow).toBe(1);
  });

  it('counts only nodes with both coordinates as positioned', async () => {
    getAllNodes.mockResolvedValue([
      { nodeNum: 1, latitude: 30, longitude: -95 },
      { nodeNum: 2, latitude: 30, longitude: null },
      { nodeNum: 3 },
    ]);
    expect((await buildNetworkSurvey(SRC)).nodes.withPosition).toBe(1);
  });

  it('orders direct neighbours strongest-first and resolves names', async () => {
    getAllNodes.mockResolvedValue([{ nodeNum: 7, longName: 'Hilltop' }]);
    getDirectNeighborRssiAsync.mockResolvedValue(new Map([
      [7, { nodeNum: 7, avgRssi: -120.44, packetCount: 3, lastHeard: 1 }],
      [8, { nodeNum: 8, avgRssi: -70.16, packetCount: 9, lastHeard: 2 }],
    ]));

    const { directNeighbours } = await buildNetworkSurvey(SRC);
    expect(directNeighbours.map((n) => n.nodeNum)).toEqual([8, 7]);
    expect(directNeighbours[1]).toMatchObject({ name: 'Hilltop', avgRssi: -120.4 });
    // No name on record — null rather than a fabricated placeholder.
    expect(directNeighbours[0].name).toBeNull();
  });

  it('sorts a null-RSSI neighbour last rather than to the top', async () => {
    // `(a.avgRssi ?? 0)` would rank an unknown signal above every real one,
    // since real RSSI is negative.
    getDirectNeighborRssiAsync.mockResolvedValue(new Map([
      [1, { nodeNum: 1, avgRssi: NaN, packetCount: 1, lastHeard: 1 }],
      [2, { nodeNum: 2, avgRssi: -95, packetCount: 1, lastHeard: 1 }],
    ]));
    const { directNeighbours } = await buildNetworkSurvey(SRC);
    expect(directNeighbours.map((n) => n.nodeNum)).toEqual([2, 1]);
  });

  it('reports maxHops from the distribution, null when nothing is answered', async () => {
    getHopCounts.mockResolvedValue({ entries: [{ hops: 1 }, { hops: 4 }, { hops: 2 }] });
    expect((await buildNetworkSurvey(SRC)).maxHops).toBe(4);

    getHopCounts.mockResolvedValue({ entries: [] });
    expect((await buildNetworkSurvey(SRC)).maxHops).toBeNull();
  });

  it('still returns a survey when one contributing query fails', async () => {
    // A young install with no traceroutes should not get a broken view.
    getAllNodes.mockResolvedValue([{ nodeNum: 1, lastHeard: Math.floor(Date.now() / 1000) }]);
    getHopCounts.mockRejectedValue(new Error('traceroute table exploded'));

    const survey = await buildNetworkSurvey(SRC);
    expect(survey.nodes.total).toBe(1);
    expect(survey.hopDistribution).toEqual([]);
    expect(survey.maxHops).toBeNull();
  });

  it('survives every query failing', async () => {
    getAllNodes.mockRejectedValue(new Error('x'));
    getDirectNeighborRssiAsync.mockRejectedValue(new Error('y'));
    getHopCounts.mockRejectedValue(new Error('z'));

    const survey = await buildNetworkSurvey(SRC);
    expect(survey.sourceId).toBe(SRC);
    expect(survey.nodes).toEqual({ total: 0, activeInWindow: 0, withPosition: 0 });
    expect(survey.directNeighbours).toEqual([]);
  });
});
