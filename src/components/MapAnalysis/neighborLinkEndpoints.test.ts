import { describe, it, expect } from 'vitest';
import { resolveNeighborEndpoints, type EndpointNodeRecord } from './neighborLinkEndpoints';
import type { SelectedTarget } from './MapAnalysisContext';

describe('resolveNeighborEndpoints (#3826 Phase 1 WP-1)', () => {
  it('Meshtastic, both positioned: returns endpoints with correct lat/lng/id/sourceId/nodeNum/isMeshCore, sourceIds from sources', () => {
    const selected: SelectedTarget = {
      type: 'neighbor',
      sourceId: 'src-a',
      nodeNum: 1,
      neighborNum: 2,
      snr: 5,
      timestamp: 1000,
    };
    const nodes: EndpointNodeRecord[] = [
      {
        nodeNum: 1,
        sourceId: 'src-a',
        latitude: 10,
        longitude: 20,
        shortName: 'A1',
        sources: [{ sourceId: 'src-a' }],
      },
      {
        nodeNum: 2,
        sourceId: 'src-a',
        latitude: 11,
        longitude: 21,
        shortName: 'B1',
        sources: [{ sourceId: 'src-a' }],
      },
    ];

    const result = resolveNeighborEndpoints(selected, nodes);

    expect(result).not.toBeNull();
    expect(result?.a).toEqual({
      id: 'mt:1',
      lat: 10,
      lng: 20,
      isNode: true,
      sourceId: 'src-a',
      sourceIds: ['src-a'],
      nodeNum: 1,
      isMeshCore: false,
      label: 'A1',
    });
    expect(result?.b).toEqual({
      id: 'mt:2',
      lat: 11,
      lng: 21,
      isNode: true,
      sourceId: 'src-a',
      sourceIds: ['src-a'],
      nodeNum: 2,
      isMeshCore: false,
      label: 'B1',
    });
  });

  it('Meshtastic, cross-source fallback (#3792): endpoint B positioned only under a different source than selected.sourceId still resolves', () => {
    const selected: SelectedTarget = {
      type: 'neighbor',
      sourceId: 'src-a',
      nodeNum: 1,
      neighborNum: 2,
    };
    const nodes: EndpointNodeRecord[] = [
      { nodeNum: 1, sourceId: 'src-a', latitude: 10, longitude: 20 },
      // Only reported (positioned) under src-b, not the edge's own src-a.
      { nodeNum: 2, sourceId: 'src-b', latitude: 11, longitude: 21 },
    ];

    const result = resolveNeighborEndpoints(selected, nodes);

    expect(result).not.toBeNull();
    expect(result?.b.sourceId).toBe('src-b');
    expect(result?.b.lat).toBe(11);
    expect(result?.b.lng).toBe(21);
  });

  it('Meshtastic, one endpoint unpositioned: returns null', () => {
    const selected: SelectedTarget = {
      type: 'neighbor',
      sourceId: 'src-a',
      nodeNum: 1,
      neighborNum: 2,
    };
    const nodes: EndpointNodeRecord[] = [
      { nodeNum: 1, sourceId: 'src-a', latitude: 10, longitude: 20 },
      // No latitude/longitude at all for node 2.
      { nodeNum: 2, sourceId: 'src-a' },
    ];

    expect(resolveNeighborEndpoints(selected, nodes)).toBeNull();
  });

  it('MeshCore, both positioned: matched by publicKey/neighborPublicKey, isMeshCore:true, nodeNum from record', () => {
    const selected: SelectedTarget = {
      type: 'neighbor',
      sourceId: 'mc-src',
      publicKey: 'pubA',
      neighborPublicKey: 'pubB',
      nodeName: 'Node A',
      neighborName: 'Node B',
      snr: 3,
      timestamp: 2000,
      nodeNum: 0,
      neighborNum: 0,
    };
    const nodes: EndpointNodeRecord[] = [
      {
        isMeshCore: true,
        publicKey: 'pubA',
        sourceId: 'mc-src',
        nodeNum: 100,
        latitude: 30,
        longitude: 40,
        shortName: 'MCA',
        sources: [{ sourceId: 'mc-src' }],
      },
      {
        isMeshCore: true,
        publicKey: 'pubB',
        sourceId: 'mc-src',
        nodeNum: 101,
        latitude: 31,
        longitude: 41,
        shortName: 'MCB',
        sources: [{ sourceId: 'mc-src' }],
      },
    ];

    const result = resolveNeighborEndpoints(selected, nodes);

    expect(result).not.toBeNull();
    expect(result?.a).toEqual({
      id: 'mc:pubA',
      lat: 30,
      lng: 40,
      isNode: true,
      sourceId: 'mc-src',
      sourceIds: ['mc-src'],
      nodeNum: 100,
      isMeshCore: true,
      label: 'MCA',
    });
    expect(result?.b).toEqual({
      id: 'mc:pubB',
      lat: 31,
      lng: 41,
      isNode: true,
      sourceId: 'mc-src',
      sourceIds: ['mc-src'],
      nodeNum: 101,
      isMeshCore: true,
      label: 'MCB',
    });
  });

  it('MeshCore, publicKey not found: returns null', () => {
    const selected: SelectedTarget = {
      type: 'neighbor',
      sourceId: 'mc-src',
      publicKey: 'pubA',
      neighborPublicKey: 'pub-missing',
      nodeNum: 0,
      neighborNum: 0,
    };
    const nodes: EndpointNodeRecord[] = [
      { isMeshCore: true, publicKey: 'pubA', sourceId: 'mc-src', nodeNum: 100, latitude: 30, longitude: 40 },
    ];

    expect(resolveNeighborEndpoints(selected, nodes)).toBeNull();
  });

  it('Null-Island endpoint (0,0) is discarded by resolveNodeLatLng, returns null', () => {
    const selected: SelectedTarget = {
      type: 'neighbor',
      sourceId: 'src-a',
      nodeNum: 1,
      neighborNum: 2,
    };
    const nodes: EndpointNodeRecord[] = [
      { nodeNum: 1, sourceId: 'src-a', latitude: 10, longitude: 20 },
      { nodeNum: 2, sourceId: 'src-a', latitude: 0, longitude: 0 },
    ];

    expect(resolveNeighborEndpoints(selected, nodes)).toBeNull();
  });

  it('Non-neighbor selection: returns null', () => {
    const selected: SelectedTarget = {
      type: 'node',
      nodeNum: 1,
      sourceId: 'src-a',
    };
    const nodes: EndpointNodeRecord[] = [
      { nodeNum: 1, sourceId: 'src-a', latitude: 10, longitude: 20 },
    ];

    expect(resolveNeighborEndpoints(selected, nodes)).toBeNull();
  });
});
