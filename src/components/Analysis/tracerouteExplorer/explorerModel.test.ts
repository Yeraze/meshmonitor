import { describe, it, expect } from 'vitest';
import {
  aggregateLinks,
  buildRuns,
  DEFAULT_FILTERS,
  filterRuns,
  groupByPair,
  pathVariants,
  snrBand,
  summarize,
  type ExplorerNodeWire,
  type ExplorerRunWire,
} from './explorerModel';

const A = 0xa1, B = 0xb2, R1 = 0x11, R2 = 0x22, R3 = 0x33;

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
    expect(run.forward).toEqual([A, R1, R2, B]);
    expect(run.forwardSnr).toEqual([6, -3, -10]);
    expect(run.back).toEqual([B, R2, R1, A]);
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
    expect(run).toMatchObject({ answered: true, forward: [A, B], hops: 0 });
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
  const nodes = new Map<number, ExplorerNodeWire>([
    [R3, { nodeNum: R3, nodeId: '!00000033', shortName: 'PEAK', longName: 'Bald Peak', role: null, hwModel: null, latitude: null, longitude: null }],
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
    expect(ts({ nodeNum: R1 })).toEqual([1]);
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
    expect(pairs.map(p => p.key)).toEqual([`${R1}>${R2}`, `${A}>${B}`]);
    expect(pairs[1]).toMatchObject({ answeredCount: 3, distinctPaths: 2, medianHops: 2 });
    expect(pairs[1].latestAnswered?.timestamp).toBe(3);
    expect(pairs[0]).toMatchObject({ answeredCount: 0, latestAnswered: null, medianHops: null });
  });

  it('lists path variants by frequency', () => {
    const v = pathVariants(groupByPair(runs)[1].runs);
    expect(v.map(x => [x.path, x.count])).toEqual([
      [[A, R1, R2, B], 2],
      [[A, R3, B], 1],
    ]);
  });

  it('aggregates undirected link usage across both legs', () => {
    const links = aggregateLinks(runs);
    const ar1 = links.find(l => l.a === R1 && l.b === A);
    // 2 runs × (forward A→R1 + return R1→A)
    expect(ar1).toMatchObject({ count: 4 });
    expect(links.find(l => (l.a === A && l.b === R3) || (l.a === R3 && l.b === A))?.count).toBe(1);
  });

  it('bands SNR', () => {
    expect([snrBand(3), snrBand(0), snrBand(-5), snrBand(-8), snrBand(null)]).toEqual(['good', 'good', 'fair', 'poor', 'unknown']);
  });
});
