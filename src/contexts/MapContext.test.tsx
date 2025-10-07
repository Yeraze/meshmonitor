import { describe, it, expect } from 'vitest';
import type { DbTraceroute } from '../services/database';
import type { EnrichedNeighborInfo } from './MapContext';

describe('MapContext Types', () => {
  it('should have correct DbTraceroute type structure', () => {
    const mockTraceroute: DbTraceroute = {
      id: 1,
      fromNodeNum: 123,
      toNodeNum: 456,
      fromNodeId: 'node1',
      toNodeId: 'node2',
      route: '123,456',
      routeBack: '456,123',
      snrTowards: '10',
      snrBack: '12',
      timestamp: Date.now(),
      createdAt: Date.now()
    };

    expect(mockTraceroute).toBeDefined();
    expect(mockTraceroute.fromNodeNum).toBe(123);
    expect(mockTraceroute.toNodeNum).toBe(456);
  });

  it('should have correct EnrichedNeighborInfo type structure', () => {
    const mockNeighborInfo: EnrichedNeighborInfo = {
      id: 1,
      nodeNum: 123,
      neighborNodeNum: 456,
      snr: 10,
      lastRxTime: Date.now(),
      timestamp: Date.now(),
      createdAt: Date.now(),
      nodeName: 'Node1',
      neighborName: 'Node2',
      nodeLatitude: 40.7128,
      nodeLongitude: -74.0060,
      neighborLatitude: 40.7589,
      neighborLongitude: -73.9851
    };

    expect(mockNeighborInfo).toBeDefined();
    expect(mockNeighborInfo.nodeNum).toBe(123);
    expect(mockNeighborInfo.neighborNodeNum).toBe(456);
    expect(mockNeighborInfo.nodeName).toBe('Node1');
    expect(mockNeighborInfo.neighborName).toBe('Node2');
  });
});
