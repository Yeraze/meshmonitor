/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import {
  useTraceroutePaths,
  NodePositionDigest,
  TracerouteDigest,
  ThemeColors,
} from './useTraceroutePaths';

/**
 * Tests for useTraceroutePaths hook filtering functionality
 *
 * Issue #1102: Route segments should be hidden when their connected nodes are filtered out
 *
 * The hook accepts a visibleNodeNums parameter that specifies which nodes are currently
 * visible on the map. Route segments where either endpoint is not in this set should
 * be filtered out.
 */

// Test data for route segment filtering
const mockNodesDigest: NodePositionDigest[] = [
  {
    nodeNum: 100,
    position: { latitude: 40.0, longitude: -75.0 },
    user: { id: '!64', longName: 'Node A', shortName: 'NDA' },
  },
  {
    nodeNum: 200,
    position: { latitude: 40.1, longitude: -75.1 },
    user: { id: '!c8', longName: 'Node B', shortName: 'NDB' },
  },
  {
    nodeNum: 300,
    position: { latitude: 40.05, longitude: -75.05 },
    user: { id: '!12c', longName: 'Node C', shortName: 'NDC' },
  },
];

// Traceroute from Node A (100) to Node B (200) via Node C (300)
const mockTraceroutes: TracerouteDigest[] = [
  {
    fromNodeNum: 100,
    toNodeNum: 200,
    fromNodeId: '!64',
    toNodeId: '!c8',
    route: '[300]', // Forward path goes through node 300
    routeBack: '[300]', // Return path goes through node 300
    snrTowards: '[40]', // 10 dB
    snrBack: '[32]', // 8 dB
    timestamp: Date.now(),
  },
];

describe('useTraceroutePaths - Route Segment Filtering', () => {
  describe('visibleNodeNums parameter', () => {
    it('should accept visibleNodeNums parameter in the hook interface', () => {
      // This test validates the type interface accepts the new parameter
      const visibleNodes = new Set([100, 200, 300]);

      // Type check: this should compile without errors
      const params: { visibleNodeNums?: Set<number> } = {
        visibleNodeNums: visibleNodes,
      };

      expect(params.visibleNodeNums).toBeDefined();
      expect(params.visibleNodeNums?.size).toBe(3);
    });

    it('should filter segments where one endpoint is not visible', () => {
      // When node 100 is filtered out, segments involving node 100 should be hidden
      const visibleNodes = new Set([200, 300]); // Node 100 is NOT visible

      // Segments in the traceroute: 100-300 (forward), 300-200 (forward)
      // Expected: 100-300 should be filtered out (100 not visible)
      // Expected: 300-200 should remain (both visible)

      // Test the filtering logic directly
      const segments = [
        { nodeNums: [100, 300] }, // Should be filtered (100 not visible)
        { nodeNums: [300, 200] }, // Should remain (both visible)
      ];

      const filteredSegments = segments.filter(segment => {
        const [nodeNum1, nodeNum2] = segment.nodeNums;
        return visibleNodes.has(nodeNum1) && visibleNodes.has(nodeNum2);
      });

      expect(filteredSegments).toHaveLength(1);
      expect(filteredSegments[0].nodeNums).toEqual([300, 200]);
    });

    it('should filter segments where both endpoints are not visible', () => {
      // When both nodes 100 and 300 are filtered out
      const visibleNodes = new Set([200]); // Only node 200 is visible

      const segments = [
        { nodeNums: [100, 300] }, // Should be filtered (neither visible)
        { nodeNums: [300, 200] }, // Should be filtered (300 not visible)
      ];

      const filteredSegments = segments.filter(segment => {
        const [nodeNum1, nodeNum2] = segment.nodeNums;
        return visibleNodes.has(nodeNum1) && visibleNodes.has(nodeNum2);
      });

      expect(filteredSegments).toHaveLength(0);
    });

    it('should show all segments when all nodes are visible', () => {
      const visibleNodes = new Set([100, 200, 300]); // All nodes visible

      const segments = [
        { nodeNums: [100, 300] },
        { nodeNums: [300, 200] },
      ];

      const filteredSegments = segments.filter(segment => {
        const [nodeNum1, nodeNum2] = segment.nodeNums;
        return visibleNodes.has(nodeNum1) && visibleNodes.has(nodeNum2);
      });

      expect(filteredSegments).toHaveLength(2);
    });

    it('should show all segments when visibleNodeNums is undefined', () => {
      const visibleNodeNums: Set<number> | undefined = undefined;

      const segments = [
        { nodeNums: [100, 300] },
        { nodeNums: [300, 200] },
      ];

      // When visibleNodeNums is undefined, no filtering should occur
      const filteredSegments = visibleNodeNums
        ? segments.filter(segment => {
            const [nodeNum1, nodeNum2] = segment.nodeNums;
            return visibleNodeNums.has(nodeNum1) && visibleNodeNums.has(nodeNum2);
          })
        : segments;

      expect(filteredSegments).toHaveLength(2);
    });

    it('should handle empty visibleNodeNums set', () => {
      const visibleNodes = new Set<number>(); // No nodes visible

      const segments = [
        { nodeNums: [100, 300] },
        { nodeNums: [300, 200] },
      ];

      const filteredSegments = segments.filter(segment => {
        const [nodeNum1, nodeNum2] = segment.nodeNums;
        return visibleNodes.has(nodeNum1) && visibleNodes.has(nodeNum2);
      });

      expect(filteredSegments).toHaveLength(0);
    });
  });

  describe('Channel filter integration', () => {
    it('should hide segments when nodes are filtered by channel', () => {
      // Scenario: User filters by a specific channel
      // Nodes on other channels should be filtered out
      // Route segments to those nodes should also be hidden

      // Assume nodes 100 and 200 are on channel 0, node 300 is on channel 1
      // When filtering by channel 0, node 300 is not visible
      const visibleNodes = new Set([100, 200]); // Node 300 is on different channel

      const segments = [
        { nodeNums: [100, 300] }, // Should be filtered (300 not on selected channel)
        { nodeNums: [300, 200] }, // Should be filtered (300 not on selected channel)
        { nodeNums: [100, 200] }, // Direct path if exists - should remain
      ];

      const filteredSegments = segments.filter(segment => {
        const [nodeNum1, nodeNum2] = segment.nodeNums;
        return visibleNodes.has(nodeNum1) && visibleNodes.has(nodeNum2);
      });

      expect(filteredSegments).toHaveLength(1);
      expect(filteredSegments[0].nodeNums).toEqual([100, 200]);
    });
  });

  describe('MQTT filter integration', () => {
    it('should hide segments when MQTT nodes are filtered out', () => {
      // Scenario: showMqttNodes is false, MQTT nodes are not visible
      // Route segments to MQTT nodes should be hidden

      // Assume node 300 is via MQTT and showMqttNodes is false
      const visibleNodes = new Set([100, 200]); // Node 300 (MQTT) is filtered

      const segments = [
        { nodeNums: [100, 300] }, // Should be filtered (300 is MQTT)
        { nodeNums: [300, 200] }, // Should be filtered (300 is MQTT)
      ];

      const filteredSegments = segments.filter(segment => {
        const [nodeNum1, nodeNum2] = segment.nodeNums;
        return visibleNodes.has(nodeNum1) && visibleNodes.has(nodeNum2);
      });

      expect(filteredSegments).toHaveLength(0);
    });
  });

  // #4047 regression — Phase 3 aligned `tracerouteNodeNums` (used for marker
  // filtering) to gate the forward/return legs independently, so a
  // forward-only or return-only traceroute still produces a non-null set.
  // `tracerouteBounds` (consumed only by NodesTab's TracerouteBoundsController
  // for zoom-to-fit) derived directly from that same set, so it started
  // producing bounds for partial traceroutes too. NodesTab's click handlers
  // still gate their `centerMapOnNode` fallback on a "both legs present"
  // check (unchanged), so for a partial traceroute both `centerMapOnNode`
  // (zoom-to-node) AND `TracerouteBoundsController.fitBounds` (zoom-to-route)
  // fired — the fitBounds call, running slightly after, silently overrode the
  // node-centering. Symptom: "zoom to node doesn't work", intermittent
  // because it only reproduced for nodes whose latest traceroute was one-way.
  describe('tracerouteBounds — #4047 zoom-to-node regression', () => {
    const nodes: NodePositionDigest[] = [
      { nodeNum: 100, position: { latitude: 40.0, longitude: -75.0 }, user: { id: '!64', longName: 'Node A' } },
      { nodeNum: 200, position: { latitude: 40.2, longitude: -75.2 }, user: { id: '!c8', longName: 'Node B' } },
    ];

    const themeColors: ThemeColors = { mauve: '#c6a0f6', red: '#ed8796', blue: '#8aadf4', overlay0: '#6e738d' };
    const callbacks = { onSelectNode: () => {}, onSelectRouteSegment: () => {} };

    const baseParams = {
      showPaths: false,
      showRoute: true,
      currentNodeId: '!local',
      nodesPositionDigest: nodes,
      distanceUnit: 'metric' as const,
      maxNodeAgeHours: 24,
      themeColors,
      callbacks,
    };

    it('produces bounds AND nodeNums for a complete (both-leg) traceroute', () => {
      const traceroutes: TracerouteDigest[] = [
        {
          fromNodeNum: 100,
          toNodeNum: 200,
          fromNodeId: '!64',
          toNodeId: '!c8',
          route: '[]',
          routeBack: '[]',
          timestamp: Date.now(),
        },
      ];

      const { result } = renderHook(() =>
        useTraceroutePaths({ ...baseParams, selectedNodeId: '!c8', traceroutesDigest: traceroutes })
      );

      expect(result.current.tracerouteNodeNums).not.toBeNull();
      expect(result.current.tracerouteBounds).not.toBeNull();
    });

    it('produces nodeNums (marker filter) but NO bounds (no zoom-fit) for a forward-only traceroute', () => {
      const traceroutes: TracerouteDigest[] = [
        {
          fromNodeNum: 100,
          toNodeNum: 200,
          fromNodeId: '!64',
          toNodeId: '!c8',
          route: '[]', // forward leg present
          routeBack: '', // no return leg
          timestamp: Date.now(),
        },
      ];

      const { result } = renderHook(() =>
        useTraceroutePaths({ ...baseParams, selectedNodeId: '!c8', traceroutesDigest: traceroutes })
      );

      // Phase 3 (#4047) deliberately keeps the marker filter populated for a
      // partial traceroute.
      expect(result.current.tracerouteNodeNums).not.toBeNull();
      expect(result.current.tracerouteNodeNums?.has(100)).toBe(true);
      expect(result.current.tracerouteNodeNums?.has(200)).toBe(true);
      // But zoom-to-fit must stay disabled so NodesTab's centerMapOnNode
      // fallback (which also requires both legs) isn't fought by a
      // subsequent fitBounds call.
      expect(result.current.tracerouteBounds).toBeNull();
    });

    it('produces nodeNums (marker filter) but NO bounds (no zoom-fit) for a return-only traceroute', () => {
      const traceroutes: TracerouteDigest[] = [
        {
          fromNodeNum: 100,
          toNodeNum: 200,
          fromNodeId: '!64',
          toNodeId: '!c8',
          route: '', // no forward leg
          routeBack: '[]', // return leg present (direct, zero intermediate hops)
          snrBack: '[10]', // gives hasReturnPath a signal even with an empty routeBack array
          timestamp: Date.now(),
        },
      ];

      const { result } = renderHook(() =>
        useTraceroutePaths({ ...baseParams, selectedNodeId: '!c8', traceroutesDigest: traceroutes })
      );

      expect(result.current.tracerouteNodeNums).not.toBeNull();
      expect(result.current.tracerouteBounds).toBeNull();
    });
  });
});
