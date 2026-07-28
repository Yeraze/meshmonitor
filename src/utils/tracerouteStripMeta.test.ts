/**
 * `buildStripNodeMeta` (issue #4381 WP4) — the `DeviceInfo[] -> Map` adapter
 * feeding `TracerouteStrip`. Runs in the default node environment; no React,
 * no DOM.
 */
import { describe, it, expect } from 'vitest';
import { buildStripNodeMeta } from './tracerouteStripMeta';
import type { TracerouteStripGraph, StripNode } from './tracerouteStrip';
import type { DeviceInfo } from '../types/device';

function makeStripNode(nodeNum: number, overrides: Partial<StripNode> = {}): StripNode {
  return {
    id: `0-0-${nodeNum}`,
    nodeNum,
    row: 0,
    col: 0,
    legs: ['forward'],
    shared: false,
    isUnknown: false,
    ...overrides,
  };
}

function makeGraph(nodes: StripNode[]): TracerouteStripGraph {
  return {
    nodes,
    edges: [],
    columns: nodes.length,
    hasForward: true,
    hasReturn: false,
    isEmpty: false,
  };
}

function makeDevice(overrides: Partial<DeviceInfo> = {}): DeviceInfo {
  return {
    nodeNum: 100,
    ...overrides,
  } as DeviceInfo;
}

describe('buildStripNodeMeta', () => {
  it('resolves shortName/longName/roleLabel/nodeId/category/hops/unmessagable from a known node', () => {
    const node = makeDevice({
      nodeNum: 100,
      user: { id: '!00000064', longName: 'Alice Router', shortName: 'ALCE', role: '2' },
      isUnmessagable: false,
    });
    const graph = makeGraph([makeStripNode(100)]);

    const meta = buildStripNodeMeta(graph, [node], {
      hopsCalculation: 'nodeinfo',
      traceroutes: [],
      currentNodeNum: null,
    });

    const m = meta.get(100);
    expect(m).toBeDefined();
    expect(m!.shortName).toBe('ALCE');
    expect(m!.longName).toBe('Alice Router');
    expect(m!.nodeId).toBe('!00000064');
    expect(m!.category).toBe('mtRouter');
    expect(m!.unmessagable).toBe(false);
  });

  it('falls back shortName to the last 4 hex digits of nodeNum when absent', () => {
    const node = makeDevice({ nodeNum: 100, user: { id: '!00000064' } });
    const graph = makeGraph([makeStripNode(100)]);

    const meta = buildStripNodeMeta(graph, [node], {
      hopsCalculation: 'nodeinfo',
      traceroutes: [],
      currentNodeNum: null,
    });

    expect(meta.get(100)!.shortName).toBe('0064');
  });

  it('falls back shortName to the last 4 hex digits when shortName is whitespace-only', () => {
    const node = makeDevice({ nodeNum: 100, user: { id: '!00000064', shortName: '   ' } });
    const graph = makeGraph([makeStripNode(100)]);

    const meta = buildStripNodeMeta(graph, [node], {
      hopsCalculation: 'nodeinfo',
      traceroutes: [],
      currentNodeNum: null,
    });

    expect(meta.get(100)!.shortName).toBe('0064');
  });

  it('falls back nodeId to padded hex when node.user.id is absent', () => {
    const node = makeDevice({ nodeNum: 100, user: { id: '' } });
    const graph = makeGraph([makeStripNode(100)]);

    const meta = buildStripNodeMeta(graph, [node], {
      hopsCalculation: 'nodeinfo',
      traceroutes: [],
      currentNodeNum: null,
    });

    expect(meta.get(100)!.nodeId).toBe('!00000064');
  });

  it('longName is null (not empty string) when absent', () => {
    const node = makeDevice({ nodeNum: 100, user: { id: '!00000064' } });
    const graph = makeGraph([makeStripNode(100)]);

    const meta = buildStripNodeMeta(graph, [node], {
      hopsCalculation: 'nodeinfo',
      traceroutes: [],
      currentNodeNum: null,
    });

    expect(meta.get(100)!.longName).toBeNull();
  });

  it('roleLabel is null when the role is unknown', () => {
    const node = makeDevice({ nodeNum: 100, user: { id: '!00000064' } });
    const graph = makeGraph([makeStripNode(100)]);

    const meta = buildStripNodeMeta(graph, [node], {
      hopsCalculation: 'nodeinfo',
      traceroutes: [],
      currentNodeNum: null,
    });

    expect(meta.get(100)!.roleLabel).toBeNull();
  });

  it('passes hopsCalculation/traceroutes/currentNodeNum through to getEffectiveHops (nodeinfo mode)', () => {
    const node = makeDevice({ nodeNum: 100, user: { id: '!00000064' }, hopsAway: 3 });
    const graph = makeGraph([makeStripNode(100)]);

    const meta = buildStripNodeMeta(graph, [node], {
      hopsCalculation: 'nodeinfo',
      traceroutes: [],
      currentNodeNum: null,
    });

    expect(meta.get(100)!.hops).toBe(3);
  });

  it('unknown node (hopsAway absent) reports 999 hops', () => {
    const node = makeDevice({ nodeNum: 100, user: { id: '!00000064' } });
    const graph = makeGraph([makeStripNode(100)]);

    const meta = buildStripNodeMeta(graph, [node], {
      hopsCalculation: 'nodeinfo',
      traceroutes: [],
      currentNodeNum: null,
    });

    expect(meta.get(100)!.hops).toBe(999);
  });

  it('passes traceroute-calculation mode through to getEffectiveHops', () => {
    const node = makeDevice({ nodeNum: 200, user: { id: '!000000c8' } });
    const graph = makeGraph([makeStripNode(200)]);

    const meta = buildStripNodeMeta(graph, [node], {
      hopsCalculation: 'traceroute',
      traceroutes: [{ fromNodeNum: 1, toNodeNum: 200, route: '[50]', routeBack: null }],
      currentNodeNum: 1,
    });

    // route [50] between currentNodeNum and the target => route.length hops.
    expect(meta.get(200)!.hops).toBe(1);
  });

  it('unmessagable flag reflects node.isUnmessagable', () => {
    const node = makeDevice({ nodeNum: 100, user: { id: '!00000064' }, isUnmessagable: true });
    const graph = makeGraph([makeStripNode(100)]);

    const meta = buildStripNodeMeta(graph, [node], {
      hopsCalculation: 'nodeinfo',
      traceroutes: [],
      currentNodeNum: null,
    });

    expect(meta.get(100)!.unmessagable).toBe(true);
  });

  it('a node number absent from `nodes` produces no map entry', () => {
    const graph = makeGraph([makeStripNode(999)]);

    const meta = buildStripNodeMeta(graph, [], {
      hopsCalculation: 'nodeinfo',
      traceroutes: [],
      currentNodeNum: null,
    });

    expect(meta.has(999)).toBe(false);
    expect(meta.size).toBe(0);
  });

  it('a graph node whose isUnknown is true but IS present in `nodes` still gets no special-cased handling here', () => {
    // The BROADCAST_ADDR placeholder nodeNum is never a real DeviceInfo, but
    // this function has no isUnknown-awareness of its own — that branch lives
    // in the component. Confirms this adapter doesn't need to know about it.
    const node = makeDevice({ nodeNum: 4294967295, user: { id: '!ffffffff' } });
    const graph = makeGraph([makeStripNode(4294967295, { isUnknown: true })]);

    const meta = buildStripNodeMeta(graph, [node], {
      hopsCalculation: 'nodeinfo',
      traceroutes: [],
      currentNodeNum: null,
    });

    expect(meta.has(4294967295)).toBe(true);
  });

  it('dedups a node number that appears on both row 0 and row 1 (single lookup, single map entry)', () => {
    const node = makeDevice({ nodeNum: 100, user: { id: '!00000064' } });
    const graph = makeGraph([
      makeStripNode(100, { row: 0, col: 0 }),
      makeStripNode(100, { row: 1, col: 1, id: '1-1-100' }),
    ]);

    const meta = buildStripNodeMeta(graph, [node], {
      hopsCalculation: 'nodeinfo',
      traceroutes: [],
      currentNodeNum: null,
    });

    expect(meta.size).toBe(1);
  });

  it('does not perform an O(n²) find over the nodes array (perf smoke guard)', () => {
    // 1,000 nodes, only 3 of which appear in the graph. A naive
    // `nodes.find(n => n.nodeNum === hop.nodeNum)` per hop is O(n*m) and
    // would still pass functionally, but this guards the shape called out in
    // spec §5.1: index once, then look up only the graph's node numbers.
    const nodes: DeviceInfo[] = Array.from({ length: 1000 }, (_, i) =>
      makeDevice({ nodeNum: i + 1, user: { id: `!${(i + 1).toString(16).padStart(8, '0')}` } }),
    );
    const graph = makeGraph([makeStripNode(1), makeStripNode(500), makeStripNode(1000)]);

    let findCalls = 0;
    const spiedNodes = new Proxy(nodes, {
      get(target, prop, receiver) {
        if (prop === 'find') {
          findCalls++;
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    const meta = buildStripNodeMeta(graph, spiedNodes, {
      hopsCalculation: 'nodeinfo',
      traceroutes: [],
      currentNodeNum: null,
    });

    expect(findCalls).toBe(0);
    expect(meta.size).toBe(3);
  });
});
