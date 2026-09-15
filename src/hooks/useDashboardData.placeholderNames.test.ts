/**
 * #5231 — the unified map rendered `e848` for a node five sources knew by name.
 *
 * MeshMonitor inserts a stub row named `Node !9e80e848` / `e848` the first time
 * a node turns up as a traceroute hop or a neighbour entry. Those are non-empty
 * strings, so the cross-source merge — which takes each field from the newest
 * record that has "a value" — let a busy MQTT source's stub eclipse the real
 * `SKYC` another source had learned.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../init', () => ({ appBasename: '/meshmonitor' }));
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ authStatus: { authenticated: true, user: { isAdmin: true } } }),
}));

import { mergeUnifiedSourceData } from './useDashboardData';

const NODE_NUM = 0x9e80e848;
const NODE_ID = '!9e80e848';

const bundle = (sourceId: string, node: Record<string, unknown>) => ({
  sourceId,
  sourceName: sourceId,
  protocol: 'Meshtastic' as const,
  nodes: [{ nodeNum: NODE_NUM, nodeId: NODE_ID, ...node }],
  traceroutes: [],
  neighborInfo: [],
  channels: [],
});

describe('mergeUnifiedSourceData — derived name placeholders (#5231)', () => {
  it('prefers a real name over a newer source\'s hex stub', () => {
    const { nodes } = mergeUnifiedSourceData([
      // Freshest, but it only ever saw this node as a traceroute hop.
      bundle('mqtt', { longName: `Node ${NODE_ID}`, shortName: 'e848', lastHeard: 2000 }),
      bundle('tcp', { longName: 'Seeed Solar Node', shortName: 'SKYC', lastHeard: 1000 }),
    ]);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({ longName: 'Seeed Solar Node', shortName: 'SKYC' });
  });

  it('keeps the stub when no source has anything better', () => {
    const { nodes } = mergeUnifiedSourceData([
      bundle('mqtt', { longName: `Node ${NODE_ID}`, shortName: 'e848', lastHeard: 2000 }),
      bundle('tcp', { longName: `Node ${NODE_ID}`, shortName: 'e848', lastHeard: 1000 }),
    ]);
    expect(nodes[0]).toMatchObject({ longName: `Node ${NODE_ID}`, shortName: 'e848' });
  });

  it('does not treat another node\'s hex as this node\'s placeholder', () => {
    // '3de0' is the stub for !433b3de0, not for !9e80e848 — it is a real name here.
    const { nodes } = mergeUnifiedSourceData([
      bundle('mqtt', { shortName: '3de0', lastHeard: 2000 }),
      bundle('tcp', { shortName: 'SKYC', lastHeard: 1000 }),
    ]);
    expect(nodes[0]).toMatchObject({ shortName: '3de0' });
  });

  it('prefers a real MAC over a newer source\'s all-zero one', () => {
    const { nodes } = mergeUnifiedSourceData([
      bundle('mqtt', { shortName: 'SKYC', macaddr: '000000000000', lastHeard: 2000 }),
      bundle('tcp', { shortName: 'SKYC', macaddr: 'c4d266f1c31d', lastHeard: 1000 }),
    ]);
    expect(nodes[0]).toMatchObject({ macaddr: 'c4d266f1c31d' });
  });

  it('still reports every source that heard the node', () => {
    const { nodes } = mergeUnifiedSourceData([
      bundle('mqtt', { longName: `Node ${NODE_ID}`, shortName: 'e848', lastHeard: 2000 }),
      bundle('tcp', { longName: 'Seeed Solar Node', shortName: 'SKYC', lastHeard: 1000 }),
    ]);
    expect((nodes[0] as any).sources).toHaveLength(2);
  });
});
