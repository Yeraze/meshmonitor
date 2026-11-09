import { describe, it, expect } from 'vitest';
import {
  aggregateLinks,
  buildRuns,
  DEFAULT_FILTERS,
  filterRuns,
  groupByPair,
  pathVariants,
  snrBand,
  nodeLabel,
  runToKeySegments,
  summarize,
  type ExplorerNodeWire,
  type ExplorerRunWire,
} from './explorerModel';

const A = 0xa1, B = 0xb2, R1 = 0x11, R2 = 0x22, R3 = 0x33;
const k = (n: number) => `mt:${n}`;

let nextId = 1;
function wire(o: Partial<ExplorerRunWire> = {}): ExplorerRunWire {
  const id = nextId++;
  return {
    id,
    sourceId: 'src-a',
    timestamp: 1_000_000 + id,
    fromNodeNum: A,
    toNodeNum: B,
    route: JSON.stringify([R1, R2]),
    routeBack: JSON.stringify([R2, R1]),
    // raw dB×4, one per hop incl. the destination
    snrTowards: JSON.stringify([24, -12, -40]),
    snrBack: JSON.stringify([8, 4, 0]),
    channel: 0,
    packetId: id,
    transportMechanism: 1,
    ...o,
  };
}

describe('buildRuns', () => {
  it('parses forward/return sequences with per-link SNR in dB', () => {
    const [run] = buildRuns([wire()]);
    expect(run.answered).toBe(true);
    expect(run.forward).toEqual([k(A), k(R1), k(R2), k(B)]);
    expect(run.forwardSnr).toEqual([6, -3, -10]);
    expect(run.back).toEqual([k(B), k(R2), k(R1), k(A)]);
    expect(run.hops).toBe(2);
    expect(run.asymmetric).toBe(false);
    expect(run.transport).toBe('rf');
  });

  it('treats a run with no route as unanswered', () => {
    const [run] = buildRuns([wire({ route: null, routeBack: null, snrTowards: null, snrBack: null })]);
    expect(run).toMatchObject({ answered: false, forward: null, back: null, hops: null });
  });

  it('treats an empty route as a direct, answered run', () => {
    const [run] = buildRuns([wire({ route: '[]', routeBack: '[]', snrTowards: '[20]', snrBack: '[12]' })]);
    expect(run).toMatchObject({ answered: true, forward: [k(A), k(B)], hops: 0 });
    expect(run.forwardSnr).toEqual([5]);
  });

  it('flags an asymmetric return path', () => {
    const [run] = buildRuns([wire({ routeBack: JSON.stringify([R3]), snrBack: '[4,4]' })]);
    expect(run.asymmetric).toBe(true);
  });

  it('flags a route change against the pair’s previous answered run only', () => {
    const runs = buildRuns([
      wire({ timestamp: 1 }),
      wire({ timestamp: 2, route: null, routeBack: null }),
      wire({ timestamp: 3 }),
      wire({ timestamp: 4, route: JSON.stringify([R3]), snrTowards: '[4,4]' }),
    ]);
    expect(runs.map(r => r.timestamp)).toEqual([4, 3, 2, 1]);
    expect(runs.map(r => r.routeChanged)).toEqual([true, false, false, false]);
  });

  it('merges one packet stored by two sources, keeping the answered copy', () => {
    const runs = buildRuns([
      wire({ sourceId: 'src-a', packetId: 77, route: null, routeBack: null }),
      wire({ sourceId: 'src-b', packetId: 77 }),
    ]);
    expect(runs).toHaveLength(1);
    expect(runs[0].answered).toBe(true);
    expect(runs[0].sourceIds).toEqual(['src-a', 'src-b']);
  });

  it('merges two unanswered copies of one packet into one unanswered run', () => {
    const runs = buildRuns([
      wire({ sourceId: 'src-a', packetId: 88, route: null, routeBack: null }),
      wire({ sourceId: 'src-b', packetId: 88, route: null, routeBack: null }),
    ]);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ answered: false, sourceIds: ['src-a', 'src-b'] });
  });

  it('classifies MQTT and UDP transport', () => {
    expect(buildRuns([wire({ transportMechanism: 5 })])[0].transport).toBe('mqtt');
    expect(buildRuns([wire({ transportMechanism: 6 })])[0].transport).toBe('udp');
    expect(buildRuns([wire({ transportMechanism: null })])[0].transport).toBe('rf');
  });
});

describe('filterRuns', () => {
  const nodes = new Map<string, ExplorerNodeWire>([
    [k(R3), { nodeNum: R3, nodeId: '!00000033', shortName: 'PEAK', longName: 'Bald Peak', role: null, hwModel: null, latitude: null, longitude: null }],
  ]);
  const runs = buildRuns([
    wire({ timestamp: 1 }),
    wire({ timestamp: 2, route: JSON.stringify([R3]), routeBack: null, snrTowards: '[4,4]', snrBack: null, transportMechanism: 5 }),
    wire({ timestamp: 3, route: null, routeBack: null }),
  ]);
  const ts = (f: Partial<typeof DEFAULT_FILTERS>) =>
    filterRuns(runs, { ...DEFAULT_FILTERS, ...f }, nodes).map(r => r.timestamp);

  it('filters by result', () => {
    expect(ts({ result: 'answered' })).toEqual([2, 1]);
    expect(ts({ result: 'failed' })).toEqual([3]);
  });
  it('filters by transport', () => {
    expect(ts({ transports: ['mqtt'] })).toEqual([2]);
  });
  it('filters by relay node and by name search', () => {
    expect(ts({ nodeKey: k(R1) })).toEqual([1]);
    expect(ts({ search: 'peak' })).toEqual([2]);
    expect(ts({ search: '!00000011' })).toEqual([1]);
  });
  it('caps hops but keeps unanswered runs', () => {
    expect(ts({ maxHops: 1 })).toEqual([3, 2]);
  });
});

describe('aggregates', () => {
  const runs = buildRuns([
    wire({ timestamp: 1 }),
    wire({ timestamp: 2 }),
    wire({ timestamp: 3, route: JSON.stringify([R3]), routeBack: null, snrTowards: '[4,4]', snrBack: null }),
    wire({ timestamp: 4, fromNodeNum: R1, toNodeNum: R2, route: null, routeBack: null }),
  ]);

  it('summarizes counts, answer rate, hops and route changes', () => {
    expect(summarize(runs)).toEqual({ total: 4, pairs: 2, answeredPct: 75, medianHops: 2, routeChanges: 1 });
  });

  it('groups by pair, newest pair first', () => {
    const pairs = groupByPair(runs);
    expect(pairs.map(p => p.key)).toEqual([`${k(R1)}>${k(R2)}`, `${k(A)}>${k(B)}`]);
    expect(pairs[1]).toMatchObject({ answeredCount: 3, distinctPaths: 2, medianHops: 2 });
    expect(pairs[1].latestAnswered?.timestamp).toBe(3);
    expect(pairs[0]).toMatchObject({ answeredCount: 0, latestAnswered: null, medianHops: null });
  });

  it('lists path variants by frequency', () => {
    const v = pathVariants(groupByPair(runs)[1].runs);
    expect(v.map(x => [x.path, x.count])).toEqual([
      [[k(A), k(R1), k(R2), k(B)], 2],
      [[k(A), k(R3), k(B)], 1],
    ]);
  });

  it('aggregates undirected link usage across both legs', () => {
    const links = aggregateLinks(runs);
    const ar1 = links.find(l => l.a === k(A) && l.b === k(R1));
    // 2 runs × (forward A→R1 + return R1→A)
    expect(ar1).toMatchObject({ count: 4 });
    expect(links.find(l => [l.a, l.b].sort().join() === [k(A), k(R3)].sort().join())?.count).toBe(1);
  });

  it('bands SNR', () => {
    expect([snrBand(3), snrBand(0), snrBand(-5), snrBand(-8), snrBand(null)]).toEqual(['good', 'good', 'fair', 'poor', 'unknown']);
  });
});

describe('MeshCore runs (#6276)', () => {
  const L = 'aa'.repeat(32), R = '11'.repeat(32), T = '77'.repeat(32), COMP = 'cc'.repeat(32);
  const mc = (o: Partial<ExplorerRunWire> = {}): ExplorerRunWire => {
    const id = nextId++;
    return {
      protocol: 'meshcore', id, sourceId: 'mc-src', timestamp: 2_000_000 + id,
      // synthetic numbers deliberately collide with the Meshtastic node A
      fromNodeNum: A, toNodeNum: B, route: '[]', routeBack: '[]', snrTowards: '[20]', snrBack: '[-4]',
      channel: null, packetId: null, transportMechanism: null,
      fromKey: `mc:${L}`, toKey: `mc:${T}`, routeKeys: [`mc:${L}`, `mc:${T}`], routeBackKeys: [`mc:${T}`, `mc:${L}`],
      turnaroundKey: `mc:${T}`, reachedTarget: true, traceTag: id, ...o,
    };
  };

  it('keeps a MeshCore node and a Meshtastic node with the same synthetic number distinct', () => {
    const runs = buildRuns([wire({ timestamp: 5 }), mc({ timestamp: 6 })]);
    const [m, t] = runs;
    expect(m.protocol).toBe('meshcore');
    expect(t.protocol).toBe('meshtastic');
    expect(m.fromNodeNum).toBe(t.fromNodeNum);
    expect(m.fromKey).not.toBe(t.fromKey);
    expect(m.pairKey).not.toBe(t.pairKey);
    expect(m.transport).toBe('rf');
  });

  it('builds legs from the key arrays; SNR is dB*4 and a -128 is unknown', () => {
    const [run] = buildRuns([mc({
      routeKeys: [`mc:${L}`, `mc:${R}`, `mc:${T}`], routeBackKeys: [`mc:${T}`, `mc:${R}`, `mc:${L}`],
      route: JSON.stringify([1]), snrTowards: '[20,-128]', snrBack: '[8,-4]',
    })]);
    expect(run).toMatchObject({ answered: true, hops: 1, reachedTarget: true });
    expect(run.forwardSnr).toEqual([5, null]);
    expect(run.backSnr).toEqual([2, -1]);
  });

  it('a turnaround before a companion target aligns SNR to the legs and keeps the target as toKey', () => {
    const [run] = buildRuns([mc({
      toKey: `mc:${COMP}`, reachedTarget: false, turnaroundKey: `mc:${R}`,
      routeKeys: [`mc:${L}`, `mc:${R}`], routeBackKeys: [`mc:${R}`, `mc:${L}`],
      snrTowards: '[20,-128]', snrBack: '[-128,-4]',
    })]);
    expect(run.toKey).toBe(`mc:${COMP}`);
    expect(run.forward).toEqual([`mc:${L}`, `mc:${R}`]);
    expect(run.forwardSnr).toEqual([5]);
    expect(run.backSnr).toEqual([-1]);
    expect(run.reachedTarget).toBe(false);
  });

  it('a timeout or failed run is unanswered but keeps its endpoints', () => {
    const [run] = buildRuns([mc({ status: 'timeout', routeKeys: null, routeBackKeys: null, route: null, routeBack: null, snrTowards: null, snrBack: null })]);
    expect(run).toMatchObject({ answered: false, forward: null, fromKey: `mc:${L}`, toKey: `mc:${T}` });
  });

  it('never merges MeshCore runs, even with equal tags on different sources', () => {
    const a = mc({ id: 900, traceTag: 5 }), b = mc({ id: 901, traceTag: 5, sourceId: 'mc-2' });
    expect(buildRuns([a, b])).toHaveLength(2);
  });

  it('aggregateLinks skips mch: ends', () => {
    const [run] = buildRuns([mc({
      routeKeys: [`mc:${L}`, 'mch:a3', `mc:${T}`], routeBackKeys: [`mc:${T}`, 'mch:a3', `mc:${L}`],
      route: JSON.stringify([4294967295]), snrTowards: '[20,12]', snrBack: '[8,-4]',
    })]);
    expect(aggregateLinks([run])).toEqual([]);
  });

  it('searches by public-key prefix and by hash; filters by protocol', () => {
    const runs = buildRuns([wire({ timestamp: 1 }), mc({ timestamp: 2, routeKeys: [`mc:${L}`, 'mch:a3', `mc:${T}`], routeBackKeys: null })]);
    const none = new Map<string, ExplorerNodeWire>();
    const f = (o: Partial<typeof DEFAULT_FILTERS>) => filterRuns(runs, { ...DEFAULT_FILTERS, ...o }, none).map(r => r.timestamp);
    expect(f({ search: '7777' })).toEqual([2]);
    expect(f({ search: 'a3' })).toEqual([2]);
    expect(f({ protocol: 'meshtastic' })).toEqual([1]);
    expect(f({ protocol: 'meshcore' })).toEqual([2]);
    expect(f({ nodeKey: `mc:${R}` })).toEqual([]);
    expect(f({ nodeKey: 'mch:a3' })).toEqual([2]);
  });

  it('labels: name, then 8 hex; unresolved hash as ?hash', () => {
    const nodes = new Map<string, ExplorerNodeWire>([
      [`mc:${L}`, { nodeNum: 1, nodeKey: `mc:${L}`, protocol: 'meshcore', nodeId: `mc:${L}`, shortName: null, longName: 'Hilltop', role: null, hwModel: null, latitude: null, longitude: null }],
    ]);
    expect(nodeLabel(nodes, `mc:${L}`)).toBe('Hilltop');
    expect(nodeLabel(nodes, `mc:${T}`)).toBe('77777777');
    expect(nodeLabel(nodes, 'mch:a3')).toBe('?a3');
    expect(nodeLabel(nodes, 'mt:161')).toBe('!00a1');
  });

  it('runToKeySegments: one segment per positioned pair, mch: and unpositioned ends skipped', () => {
    const [run] = buildRuns([mc({
      routeKeys: [`mc:${L}`, `mc:${R}`, 'mch:a3', `mc:${T}`], routeBackKeys: null,
      route: JSON.stringify([1, 4294967295]), snrTowards: '[20,12,8]', snrBack: null,
    })]);
    const p: Record<string, [number, number]> = { [`mc:${L}`]: [1, 1], [`mc:${R}`]: [2, 2], [`mc:${T}`]: [3, 3] };
    const segs = runToKeySegments(run, key => p[key] ?? null);
    expect(segs).toHaveLength(1);
    expect(segs[0]).toMatchObject({ fromKey: `mc:${L}`, toKey: `mc:${R}`, leg: 'forward', avgSnr: 5 });
  });
});
