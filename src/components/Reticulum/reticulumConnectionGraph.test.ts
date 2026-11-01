/**
 * reticulumConnectionGraph (#6119) — the pure path-table → node-graph builder
 * behind the position-free Connections view. Proves the topology shape: direct
 * vs relay edges, de-duplication, and (the issue's key case) that a `viaHash`
 * which resolves to NO known destination still becomes a relay node labelled
 * by its truncated hash.
 */
import { describe, it, expect } from 'vitest';
import {
  buildReticulumConnectionGraph,
  shortHash,
  LOCAL_NODE_ID,
} from './reticulumConnectionGraph';
import type { ReticulumDestinationRow, ReticulumPathRow } from '../../types/reticulum';

function dest(overrides: Partial<ReticulumDestinationRow> = {}): ReticulumDestinationRow {
  return {
    sourceId: 'src-rns', destinationHash: 'deadbeefcafef00d', identityHash: null,
    appName: 'sideband', aspects: null, displayName: 'Alice', appDataB64: null,
    hops: 2, nextHopInterface: null, rssi: -80, snr: 5, quality: null,
    announceCount: 1, firstSeen: 0, lastSeen: 0, lastAnnounceAt: null,
    isFavorite: false, createdAt: 0, updatedAt: 0,
    latitude: null, longitude: null, altitude: null, speed: null,
    bearing: null, accuracy: null, positionUpdatedAt: null,
    ...overrides,
  };
}

function path(overrides: Partial<ReticulumPathRow> = {}): ReticulumPathRow {
  return {
    sourceId: 'src-rns', destinationHash: 'deadbeefcafef00d', viaHash: null,
    hops: 1, interfaceName: null, expiresAt: null, updatedAt: 0,
    ...overrides,
  };
}

const LOCAL = { localLabel: 'This instance' };

describe('buildReticulumConnectionGraph', () => {
  it('returns an empty graph (not even a local node) when there are no paths', () => {
    expect(buildReticulumConnectionGraph([], [dest()], LOCAL)).toEqual({ nodes: [], edges: [] });
  });

  it('places the local instance at the centre when any path exists', () => {
    const { nodes } = buildReticulumConnectionGraph(
      [path({ destinationHash: 'aaaa', viaHash: null })], [], LOCAL,
    );
    expect(nodes[0]).toMatchObject({ id: LOCAL_NODE_ID, kind: 'local', hash: null, label: 'This instance' });
  });

  it('draws a direct edge for a destination with a null viaHash', () => {
    const graph = buildReticulumConnectionGraph(
      [path({ destinationHash: 'aaaa', viaHash: null })],
      [dest({ destinationHash: 'aaaa', displayName: 'Alice' })],
      LOCAL,
    );
    const destNode = graph.nodes.find(n => n.hash === 'aaaa');
    expect(destNode).toMatchObject({ kind: 'destination', label: 'Alice' });
    expect(graph.edges).toEqual([
      { id: `${LOCAL_NODE_ID}->dest:aaaa`, from: LOCAL_NODE_ID, to: 'dest:aaaa', kind: 'direct' },
    ]);
  });

  it('treats an empty-string viaHash as a direct edge', () => {
    const graph = buildReticulumConnectionGraph(
      [path({ destinationHash: 'aaaa', viaHash: '' })], [], LOCAL,
    );
    expect(graph.edges).toEqual([
      { id: `${LOCAL_NODE_ID}->dest:aaaa`, from: LOCAL_NODE_ID, to: 'dest:aaaa', kind: 'direct' },
    ]);
    expect(graph.nodes.some(n => n.kind === 'relay')).toBe(false);
  });

  it('draws a relay node and two relay legs for a destination reached via a hop', () => {
    const graph = buildReticulumConnectionGraph(
      [path({ destinationHash: 'aaaa', viaHash: 'bbbb' })],
      [
        dest({ destinationHash: 'aaaa', displayName: 'Alice' }),
        dest({ destinationHash: 'bbbb', displayName: 'RelayBob' }),
      ],
      LOCAL,
    );
    const relay = graph.nodes.find(n => n.id === 'relay:bbbb');
    expect(relay).toMatchObject({ kind: 'relay', hash: 'bbbb', label: 'RelayBob' });
    // Relay that resolves to a known destination keeps the row as a click target.
    expect(relay?.destination?.destinationHash).toBe('bbbb');
    expect(graph.edges).toEqual([
      { id: `${LOCAL_NODE_ID}->relay:bbbb`, from: LOCAL_NODE_ID, to: 'relay:bbbb', kind: 'relay' },
      { id: 'relay:bbbb->dest:aaaa', from: 'relay:bbbb', to: 'dest:aaaa', kind: 'relay' },
    ]);
  });

  it('creates a relay node labelled by truncated hash when viaHash resolves to no known destination', () => {
    const viaHash = 'feedfacecafebabe0123456789abcdef';
    const graph = buildReticulumConnectionGraph(
      [path({ destinationHash: 'aaaa', viaHash })],
      [dest({ destinationHash: 'aaaa', displayName: 'Alice' })], // bbbb/via NOT in destinations
      LOCAL,
    );
    const relay = graph.nodes.find(n => n.id === `relay:${viaHash}`);
    expect(relay).toBeDefined();
    expect(relay?.kind).toBe('relay');
    expect(relay?.destination).toBeNull(); // unresolved — no click-through details
    expect(relay?.label).toBe(shortHash(viaHash));
    expect(relay?.label).not.toContain(viaHash.slice(9, 20)); // genuinely truncated
  });

  it('falls back to a truncated hash for a destination with no name', () => {
    const graph = buildReticulumConnectionGraph(
      [path({ destinationHash: '0123456789abcdef0123', viaHash: null })],
      [], // destination not announced by name
      LOCAL,
    );
    const node = graph.nodes.find(n => n.hash === '0123456789abcdef0123');
    expect(node?.destination).toBeNull();
    expect(node?.label).toBe(shortHash('0123456789abcdef0123'));
  });

  it('shares one relay node across destinations that use the same via hop', () => {
    const graph = buildReticulumConnectionGraph(
      [
        path({ destinationHash: 'aaaa', viaHash: 'relay1' }),
        path({ destinationHash: 'cccc', viaHash: 'relay1' }),
      ],
      [],
      LOCAL,
    );
    const relays = graph.nodes.filter(n => n.kind === 'relay');
    expect(relays).toHaveLength(1);
    expect(relays[0].id).toBe('relay:relay1');
    // local->relay once (deduped), plus one relay->dest per destination.
    expect(graph.edges.filter(e => e.id === `${LOCAL_NODE_ID}->relay:relay1`)).toHaveLength(1);
    expect(graph.edges.filter(e => e.to === 'dest:aaaa')).toHaveLength(1);
    expect(graph.edges.filter(e => e.to === 'dest:cccc')).toHaveLength(1);
  });

  it('de-duplicates repeated identical path rows', () => {
    const graph = buildReticulumConnectionGraph(
      [
        path({ destinationHash: 'aaaa', viaHash: null }),
        path({ destinationHash: 'aaaa', viaHash: null }),
      ],
      [],
      LOCAL,
    );
    expect(graph.nodes.filter(n => n.hash === 'aaaa')).toHaveLength(1);
    expect(graph.edges).toHaveLength(1);
  });

  it('emits nodes local-first in deterministic first-seen order', () => {
    const graph = buildReticulumConnectionGraph(
      [
        path({ destinationHash: 'aaaa', viaHash: null }),
        path({ destinationHash: 'bbbb', viaHash: 'relayX' }),
      ],
      [],
      LOCAL,
    );
    expect(graph.nodes.map(n => n.id)).toEqual([
      LOCAL_NODE_ID, 'dest:aaaa', 'dest:bbbb', 'relay:relayX',
    ]);
  });
});
