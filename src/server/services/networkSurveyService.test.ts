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
const getContacts = vi.fn();
const getHopCounts = vi.fn();
const getSetting = vi.fn();

vi.mock('../../services/database.js', () => ({
  default: {
    get nodes() { return { getAllNodes }; },
    get directRfContacts() { return { getContacts }; },
    get analysis() { return { getHopCounts }; },
    get settings() {
      return { getSetting, getLocalNodeNumForSource: (id: string) => getSetting(`localNodeNum_${id}`) };
    },
  },
}));

import { buildNetworkSurvey, bucketHops, clampWindowHours } from './networkSurveyService.js';

/** A Direct RF Contacts summary row (#6210) as the repository returns it. */
function contact(nodeNum: number | null, avgRssi: number | null, receptionCount: number, lastHeardAt: number, extra: Record<string, unknown> = {}) {
  return {
    nodeKey: nodeNum == null ? 'ab'.repeat(32) : `!${nodeNum.toString(16).padStart(8, '0')}`,
    nodeNum,
    protocol: nodeNum == null ? 'meshcore' : 'meshtastic',
    firstHeardAt: lastHeardAt - 1000,
    lastHeardAt,
    receptionCount,
    bestSnr: null,
    bestRssi: null,
    avgSnr: null,
    avgRssi,
    daysHeard: 1,
    ...extra,
  };
}

const SRC = 'src-a';

beforeEach(() => {
  getAllNodes.mockReset().mockResolvedValue([]);
  getContacts.mockReset().mockResolvedValue([]);
  getHopCounts.mockReset().mockResolvedValue({ entries: [] });
  getSetting.mockReset().mockImplementation(async (key: string) => (key === `localNodeNum_${SRC}` ? '1' : null));
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
      { hops: 0, nodeCount: 1, byTransport: { rf: 1, udp: 0, mqtt: 0 } },
      { hops: 1, nodeCount: 1, byTransport: { rf: 1, udp: 0, mqtt: 0 } },
      { hops: 2, nodeCount: 2, byTransport: { rf: 2, udp: 0, mqtt: 0 } },
    ]);
  });

  it('keeps hop 0 — direct contacts are a real bucket, not "no data"', () => {
    expect(bucketHops([{ hops: 0 }])).toEqual([
      { hops: 0, nodeCount: 1, byTransport: { rf: 1, udp: 0, mqtt: 0 } },
    ]);
  });

  it('drops nonsense hop values instead of charting them', () => {
    expect(bucketHops([{ hops: -1 }, { hops: NaN }, { hops: 3 }])).toEqual([
      { hops: 3, nodeCount: 1, byTransport: { rf: 1, udp: 0, mqtt: 0 } },
    ]);
  });

  it('splits a bucket by transport class', () => {
    expect(bucketHops([
      { hops: 2, transport: 'rf' },
      { hops: 2, transport: 'udp' },
      { hops: 2, transport: 'mqtt' },
      { hops: 2, transport: 'mqtt' },
    ])).toEqual([
      { hops: 2, nodeCount: 4, byTransport: { rf: 1, udp: 1, mqtt: 2 } },
    ]);
  });

  it('treats a missing transport as rf — the same fallback as the record class', () => {
    expect(bucketHops([{ hops: 1 }, { hops: 1, transport: 'mqtt' }])).toEqual([
      { hops: 1, nodeCount: 2, byTransport: { rf: 1, udp: 0, mqtt: 1 } },
    ]);
  });

  it('every bucket satisfies nodeCount === rf + udp + mqtt', () => {
    const buckets = bucketHops([
      { hops: 0, transport: 'rf' },
      { hops: 0, transport: 'udp' },
      { hops: 1, transport: 'mqtt' },
      { hops: 1 },
    ]);
    for (const b of buckets) {
      expect(b.nodeCount).toBe(b.byTransport.rf + b.byTransport.udp + b.byTransport.mqtt);
    }
  });
});

describe('buildNetworkSurvey', () => {
  it('scopes the direct-neighbour query to the source and the window', async () => {
    // Without the source scope the survey reports packets heard by OTHER
    // radios as this radio's neighbours.
    const before = Date.now();
    await buildNetworkSurvey(SRC, 12);
    const arg = getContacts.mock.calls[0][0];
    expect(arg.sourceId).toBe(SRC);
    expect(arg.toMs - arg.fromMs).toBe(12 * 3_600_000);
    expect(arg.toMs).toBeGreaterThanOrEqual(before);
    expect(getHopCounts).toHaveBeenCalledWith({
      sourceIds: [SRC],
      localNodeNums: new Map([[SRC, 1]]),
      includeTransport: true,
    });
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

  it('does not count Null Island or out-of-range coordinates as positioned', async () => {
    // Review catch on #4737. A stored coordinate is not a usable one: firmware
    // position-precision re-centres an obscured (0,0), and junk gets stored
    // too. Counting the column would overstate how locatable the mesh is.
    getAllNodes.mockResolvedValue([
      { nodeNum: 1, latitude: 30, longitude: -95 },   // real
      { nodeNum: 2, latitude: 0, longitude: 0 },      // Null Island
      { nodeNum: 3, latitude: 91, longitude: 0 },     // out of WGS-84 range
    ]);
    expect((await buildNetworkSurvey(SRC)).nodes.withPosition).toBe(1);
  });

  it('falls back to shortName when a node has no longName', async () => {
    // Review catch on #4737: the longName -> shortName -> null chain had only
    // its first and last links exercised.
    getAllNodes.mockResolvedValue([{ nodeNum: 5, shortName: 'HLTP' }]);
    getContacts.mockResolvedValue([contact(5, -80, 1, 1000)]);
    expect((await buildNetworkSurvey(SRC)).directNeighbours[0].name).toBe('HLTP');
  });

  it('derives maxHops independently of bucket ordering', async () => {
    // Reading the last bucket is correct only while bucketHops sorts ascending;
    // that coupling is invisible and would break with no type error.
    getHopCounts.mockResolvedValue({ entries: [{ hops: 7 }, { hops: 1 }, { hops: 3 }] });
    expect((await buildNetworkSurvey(SRC)).maxHops).toBe(7);
  });

  it('orders direct neighbours strongest-first and resolves names', async () => {
    getAllNodes.mockResolvedValue([{ nodeNum: 7, longName: 'Hilltop' }]);
    getContacts.mockResolvedValue([contact(7, -120.44, 3, 1000), contact(8, -70.16, 9, 2000)]);

    const { directNeighbours } = await buildNetworkSurvey(SRC);
    expect(directNeighbours.map((n) => n.nodeNum)).toEqual([8, 7]);
    expect(directNeighbours[1]).toMatchObject({ name: 'Hilltop', avgRssi: -120.4 });
    // No name on record — null rather than a fabricated placeholder.
    expect(directNeighbours[0].name).toBeNull();
  });

  it('sorts a null-RSSI neighbour last rather than to the top', async () => {
    // `(a.avgRssi ?? 0)` would rank an unknown signal above every real one,
    // since real RSSI is negative.
    getContacts.mockResolvedValue([contact(1, null, 1, 1000), contact(2, -95, 1, 1000)]);
    const { directNeighbours } = await buildNetworkSurvey(SRC);
    expect(directNeighbours.map((n) => n.nodeNum)).toEqual([2, 1]);
  });

  it('carries first/last heard and the reception count from the rollup (#6210)', async () => {
    getContacts.mockResolvedValue([contact(9, -88, 42, 5000, { firstHeardAt: 1234 })]);
    const [n] = (await buildNetworkSurvey(SRC)).directNeighbours;
    expect(n).toMatchObject({ nodeNum: 9, packetCount: 42, firstHeard: 1234, lastHeard: 5000, avgRssi: -88 });
  });

  it('leaves MeshCore rows (no nodeNum) out of this Meshtastic survey', async () => {
    getContacts.mockResolvedValue([contact(null, -70, 3, 1000), contact(4, -90, 1, 1000)]);
    expect((await buildNetworkSurvey(SRC)).directNeighbours.map((n) => n.nodeNum)).toEqual([4]);
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
    getContacts.mockRejectedValue(new Error('y'));
    getHopCounts.mockRejectedValue(new Error('z'));

    const survey = await buildNetworkSurvey(SRC);
    expect(survey.sourceId).toBe(SRC);
    expect(survey.nodes).toEqual({ total: 0, activeInWindow: 0, withPosition: 0 });
    expect(survey.directNeighbours).toEqual([]);
  });
});
