import { describe, it, expect } from 'vitest';
import {
  resolveNeighborEndpoints,
  resolveSegmentEndpoints,
  type EndpointNodeRecord,
} from './neighborLinkEndpoints';
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
  describe('resolveSegmentEndpoints', () => {
    const nodes: EndpointNodeRecord[] = [
      { nodeNum: 1, sourceId: 'src-a', latitude: 10, longitude: 20, altitude: 35, shortName: 'A1', sources: [{ sourceId: 'src-a' }] },
      { nodeNum: 2, sourceId: 'src-b', latitude: 11, longitude: 21, position: { altitude: 12 }, shortName: 'B1', sources: [{ sourceId: 'src-b' }] },
      { nodeNum: 3, sourceId: 'src-a', shortName: 'NOPOS', sources: [{ sourceId: 'src-a' }] },
    ];

    it('resolves both endpoints by nodeNum for a positioned segment', () => {
      const result = resolveSegmentEndpoints(
        { type: 'segment', fromNodeNum: 1, toNodeNum: 2 },
        nodes,
      );
      expect(result).not.toBeNull();
      expect(result?.a).toMatchObject({ nodeNum: 1, isMeshCore: false, isNode: true });
      expect(result?.b).toMatchObject({ nodeNum: 2, isMeshCore: false, isNode: true });
      expect(result?.a.id).toBe('mt:1');
      expect(result?.b.id).toBe('mt:2');
      // altitudeM carried from flat + nested shapes to seed the AGL inputs
      expect(result?.a.altitudeM).toBe(35);
      expect(result?.b.altitudeM).toBe(12);
    });

    it('returns null when an endpoint is unpositioned', () => {
      const result = resolveSegmentEndpoints(
        { type: 'segment', fromNodeNum: 1, toNodeNum: 3 },
        nodes,
      );
      expect(result).toBeNull();
    });

    it('returns null when nodeNums are missing', () => {
      expect(resolveSegmentEndpoints({ type: 'segment' }, nodes)).toBeNull();
    });

    it('returns null for a non-segment selection', () => {
      expect(
        resolveSegmentEndpoints({ type: 'node', nodeNum: 1, sourceId: 'a' }, nodes),
      ).toBeNull();
    });
  });
});

