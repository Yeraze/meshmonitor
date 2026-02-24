import { describe, it, expect } from 'vitest';
import type { DbTraceroute } from '../services/database';
import type { EnrichedNeighborInfo, PositionHistoryItem } from './MapContext';

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
    expect(mockTraceroute.fromNodeId).toBe('node1');
    expect(mockTraceroute.toNodeId).toBe('node2');
    expect(mockTraceroute.route).toBe('123,456');
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
    expect(mockNeighborInfo.nodeLatitude).toBe(40.7128);
    expect(mockNeighborInfo.neighborLongitude).toBe(-73.9851);
  });

  it('should have correct PositionHistoryItem type structure', () => {
    const mockPosition: PositionHistoryItem = {
      latitude: 40.7128,
      longitude: -74.0060,
      timestamp: Date.now()
    };

    expect(mockPosition).toBeDefined();
    expect(mockPosition.latitude).toBe(40.7128);
    expect(mockPosition.longitude).toBe(-74.0060);
    expect(mockPosition.timestamp).toBeGreaterThan(0);
  });

  it('should allow EnrichedNeighborInfo to extend DbNeighborInfo with optional fields', () => {
    // Test that we can create an EnrichedNeighborInfo with just required DbNeighborInfo fields
    const minimal: EnrichedNeighborInfo = {
      id: 1,
      nodeNum: 123,
      neighborNodeNum: 456,
      snr: 10,
      lastRxTime: Date.now(),
      timestamp: Date.now(),
      createdAt: Date.now()
    };

    expect(minimal).toBeDefined();
    expect(minimal.nodeName).toBeUndefined();
    expect(minimal.neighborName).toBeUndefined();
  });

  it('should support map center target tuple type', () => {
    const target: [number, number] = [40.7128, -74.0060];
    const nullTarget: [number, number] | null = null;

    expect(target).toHaveLength(2);
    expect(target[0]).toBe(40.7128);
    expect(target[1]).toBe(-74.0060);
    expect(nullTarget).toBeNull();
  });

  it('should support traceroutes array type', () => {
    const traceroutes: DbTraceroute[] = [
      {
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
      },
      {
        id: 2,
        fromNodeNum: 789,
        toNodeNum: 101,
        fromNodeId: 'node3',
        toNodeId: 'node4',
        route: '789,101',
        routeBack: '101,789',
        snrTowards: '15',
        snrBack: '14',
        timestamp: Date.now(),
        createdAt: Date.now()
      }
    ];

    expect(traceroutes).toHaveLength(2);
    expect(traceroutes[0].fromNodeNum).toBe(123);
    expect(traceroutes[1].toNodeNum).toBe(101);
  });

  it('should support neighborInfo array type with enriched fields', () => {
    const neighborInfo: EnrichedNeighborInfo[] = [
      {
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
      }
    ];

    expect(neighborInfo).toHaveLength(1);
    expect(neighborInfo[0].nodeName).toBe('Node1');
    expect(neighborInfo[0].neighborName).toBe('Node2');
    expect(neighborInfo[0].nodeLatitude).toBe(40.7128);
  });

  it('should support positionHistory array type', () => {
    const history: PositionHistoryItem[] = [
      {
        latitude: 40.7128,
        longitude: -74.0060,
        timestamp: Date.now()
      },
      {
        latitude: 40.7589,
        longitude: -73.9851,
        timestamp: Date.now() + 1000
      }
    ];

    expect(history).toHaveLength(2);
    expect(history[0].latitude).toBe(40.7128);
    expect(history[1].longitude).toBe(-73.9851);
  });

  it('should support showMqttNodes boolean state', () => {
    // Test that showMqttNodes can be set to true (default)
    const showMqttTrue = true;
    expect(showMqttTrue).toBe(true);

    // Test that showMqttNodes can be set to false
    const showMqttFalse = false;
    expect(showMqttFalse).toBe(false);
  });

  it('should support map control states for all visibility toggles', () => {
    const mapControls = {
      showPaths: false,
      showNeighborInfo: false,
      showRoute: true,
      showMotion: true,
      showMqttNodes: true
    };

    expect(mapControls.showPaths).toBe(false);
    expect(mapControls.showNeighborInfo).toBe(false);
    expect(mapControls.showRoute).toBe(true);
    expect(mapControls.showMotion).toBe(true);
    expect(mapControls.showMqttNodes).toBe(true);
  });
});
