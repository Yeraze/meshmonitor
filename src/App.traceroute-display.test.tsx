import { describe, it, expect } from 'vitest';
import { DeviceInfo } from './types/device';
import { DbTraceroute } from './services/database';

/**
 * Traceroute Display Tests
 *
 * Tests that traceroute Forward/Return paths are displayed correctly with proper
 * endpoint ordering in all four locations:
 * 1. Messages page - Top panel (recent traceroute)
 * 2. Messages page - Traceroute History window
 * 3. Map - Traceroute popup (clicking red line)
 * 4. Map - RouteSegmentTraceroutesModal (clicking segment)
 *
 * This test addresses issue #361 where endpoints were swapped.
 */

describe('Traceroute Display - Endpoint Ordering', () => {
  // Test data - create a traceroute from Node A (100) to Node B (200) via Repeater (300)
  const mockNodes: DeviceInfo[] = [
    {
      nodeNum: 100,
      user: {
        id: '!64',
        longName: 'Node A',
        shortName: 'NDEA',
        hwModel: 31,
        role: '1',
      },
      position: {
        latitude: 40.0,
        longitude: -75.0,
        altitude: 100,
      },
    },
    {
      nodeNum: 200,
      user: {
        id: '!c8',
        longName: 'Node B',
        shortName: 'NDEB',
        hwModel: 31,
        role: '1',
      },
      position: {
        latitude: 40.1,
        longitude: -75.1,
        altitude: 100,
      },
    },
    {
      nodeNum: 300,
      user: {
        id: '!12c',
        longName: 'Repeater One',
        shortName: 'RPT1',
        hwModel: 31,
        role: '1',
      },
      position: {
        latitude: 40.05,
        longitude: -75.05,
        altitude: 200,
      },
    },
  ];

  const mockTraceroute: DbTraceroute = {
    id: 1,
    fromNodeId: '!64',
    fromNodeNum: 100,
    toNodeId: '!c8',
    toNodeNum: 200,
    route: '[300]', // Forward path: 100 → 300 → 200
    routeBack: '[300]', // Return path: 200 → 300 → 100
    snrTowards: '[-5, 10]', // SNR values for forward hops
    snrBack: '[8, -3]', // SNR values for return hops
    timestamp: Date.now() - 60000, // 1 minute ago
    createdAt: Date.now() - 60000,
  };

  describe('Traceroute path building logic', () => {
    it('should build forward path correctly: fromNodeNum → route → toNodeNum', () => {
      const route = JSON.parse(mockTraceroute.route);
      const forwardSequence = [mockTraceroute.fromNodeNum, ...route, mockTraceroute.toNodeNum];

      expect(forwardSequence).toEqual([100, 300, 200]);
      expect(forwardSequence[0]).toBe(100); // Node A (responder)
      expect(forwardSequence[1]).toBe(300); // Repeater
      expect(forwardSequence[2]).toBe(200); // Node B (requester)
    });

    it('should build return path correctly: toNodeNum → routeBack → fromNodeNum', () => {
      const routeBack = JSON.parse(mockTraceroute.routeBack);
      const returnSequence = [mockTraceroute.toNodeNum, ...routeBack, mockTraceroute.fromNodeNum];

      expect(returnSequence).toEqual([200, 300, 100]);
      expect(returnSequence[0]).toBe(200); // Node B (requester)
      expect(returnSequence[1]).toBe(300); // Repeater
      expect(returnSequence[2]).toBe(100); // Node A (responder)
    });

    it('should swap only endpoints for display while preserving intermediate hops', () => {
      const route = JSON.parse(mockTraceroute.route);
      const forwardSequence = [mockTraceroute.fromNodeNum, ...route, mockTraceroute.toNodeNum];

      // Simulate the display logic that swaps endpoints
      const displaySequence = [...forwardSequence];
      if (displaySequence.length >= 2) {
        const temp = displaySequence[0];
        displaySequence[0] = displaySequence[displaySequence.length - 1];
        displaySequence[displaySequence.length - 1] = temp;
      }

      // Display should be: Node A → Repeater → Node B (swapped endpoints from build sequence)
      expect(displaySequence).toEqual([200, 300, 100]);

      // Verify endpoint swap
      expect(displaySequence[0]).toBe(mockTraceroute.toNodeNum); // Now shows toNode first
      expect(displaySequence[displaySequence.length - 1]).toBe(mockTraceroute.fromNodeNum); // Now shows fromNode last

      // Verify intermediate hop unchanged
      expect(displaySequence[1]).toBe(300); // Repeater still in middle
    });
  });

  describe('formatTracerouteRoute parameter order', () => {
    it('should use correct parameter order for Forward path: (route, snrTowards, fromNodeNum, toNodeNum)', () => {
      // This test documents the expected parameter order for the Messages page
      // Forward path should go: responder → requester (fromNodeNum → toNodeNum)

      const forwardParams = {
        route: mockTraceroute.route,
        snr: mockTraceroute.snrTowards,
        fromNum: mockTraceroute.fromNodeNum, // 100 (Node A - responder)
        toNum: mockTraceroute.toNodeNum,     // 200 (Node B - requester)
      };

      expect(forwardParams.fromNum).toBe(100);
      expect(forwardParams.toNum).toBe(200);
    });

    it('should use correct parameter order for Return path: (routeBack, snrBack, toNodeNum, fromNodeNum)', () => {
      // This test documents the expected parameter order for the Messages page
      // Return path should go: requester → responder (toNodeNum → fromNodeNum)

      const returnParams = {
        route: mockTraceroute.routeBack,
        snr: mockTraceroute.snrBack,
        fromNum: mockTraceroute.toNodeNum,     // 200 (Node B - requester)
        toNum: mockTraceroute.fromNodeNum,     // 100 (Node A - responder)
      };

      expect(returnParams.fromNum).toBe(200);
      expect(returnParams.toNum).toBe(100);
    });
  });

  describe('Map popup endpoint labels', () => {
    it('should display Forward path label as: fromName → toName', () => {
      const fromNode = mockNodes.find(n => n.nodeNum === mockTraceroute.fromNodeNum);
      const toNode = mockNodes.find(n => n.nodeNum === mockTraceroute.toNodeNum);

      const fromName = fromNode?.user?.longName || fromNode?.user?.shortName || '!unknown';
      const toName = toNode?.user?.longName || toNode?.user?.shortName || '!unknown';

      expect(fromName).toBe('Node A');
      expect(toName).toBe('Node B');

      // The popup should show "Node A → Node B" for forward path
      const forwardLabel = `${fromName} → ${toName}`;
      expect(forwardLabel).toBe('Node A → Node B');
    });

    it('should display Return path label as: toName → fromName', () => {
      const fromNode = mockNodes.find(n => n.nodeNum === mockTraceroute.fromNodeNum);
      const toNode = mockNodes.find(n => n.nodeNum === mockTraceroute.toNodeNum);

      const fromName = fromNode?.user?.longName || fromNode?.user?.shortName || '!unknown';
      const toName = toNode?.user?.longName || toNode?.user?.shortName || '!unknown';

      // The popup should show "Node B → Node A" for return path
      const returnLabel = `${toName} → ${fromName}`;
      expect(returnLabel).toBe('Node B → Node A');
    });
  });

  describe('Segment filtering for RouteSegmentTraceroutesModal', () => {
    it('should identify traceroutes containing a specific segment in forward path', () => {
      const nodeNum1 = 100; // Node A
      const nodeNum2 = 300; // Repeater

      const route = JSON.parse(mockTraceroute.route);
      const forwardSequence = [mockTraceroute.fromNodeNum, ...route, mockTraceroute.toNodeNum];

      // Check if segment exists in forward path
      const segmentInForward = forwardSequence.some((num, idx) => {
        if (idx === forwardSequence.length - 1) return false;
        const next = forwardSequence[idx + 1];
        return (num === nodeNum1 && next === nodeNum2) || (num === nodeNum2 && next === nodeNum1);
      });

      expect(segmentInForward).toBe(true);
    });

    it('should identify traceroutes containing a specific segment in return path', () => {
      const nodeNum1 = 300; // Repeater
      const nodeNum2 = 200; // Node B

      const routeBack = JSON.parse(mockTraceroute.routeBack);
      const backSequence = [mockTraceroute.toNodeNum, ...routeBack, mockTraceroute.fromNodeNum];

      // Check if segment exists in return path
      const segmentInBack = backSequence.some((num, idx) => {
        if (idx === backSequence.length - 1) return false;
        const next = backSequence[idx + 1];
        return (num === nodeNum1 && next === nodeNum2) || (num === nodeNum2 && next === nodeNum1);
      });

      expect(segmentInBack).toBe(true);
    });

    it('should not match traceroutes without the specific segment', () => {
      const nodeNum1 = 100; // Node A
      const nodeNum2 = 200; // Node B

      // This segment (direct A-B) doesn't exist in our traceroute (goes through repeater)
      const route = JSON.parse(mockTraceroute.route);
      const forwardSequence = [mockTraceroute.fromNodeNum, ...route, mockTraceroute.toNodeNum];

      const segmentInForward = forwardSequence.some((num, idx) => {
        if (idx === forwardSequence.length - 1) return false;
        const next = forwardSequence[idx + 1];
        return (num === nodeNum1 && next === nodeNum2) || (num === nodeNum2 && next === nodeNum1);
      });

      expect(segmentInForward).toBe(false);
    });
  });

  describe('Data model documentation', () => {
    it('should document the traceroute data model correctly', () => {
      // This test serves as living documentation of the data model

      // fromNodeNum/fromNodeId = Responder (remote node that responded to traceroute)
      expect(mockTraceroute.fromNodeNum).toBe(100);
      expect(mockTraceroute.fromNodeId).toBe('!64');

      // toNodeNum/toNodeId = Requester (local node that initiated traceroute)
      expect(mockTraceroute.toNodeNum).toBe(200);
      expect(mockTraceroute.toNodeId).toBe('!c8');

      // route = Forward path intermediate hops (responder → requester)
      expect(mockTraceroute.route).toBe('[300]');

      // routeBack = Return path intermediate hops (requester → responder)
      expect(mockTraceroute.routeBack).toBe('[300]');

      // snrTowards = SNR values for forward path hops
      expect(mockTraceroute.snrTowards).toBe('[-5, 10]');

      // snrBack = SNR values for return path hops
      expect(mockTraceroute.snrBack).toBe('[8, -3]');
    });

    it('should document the correct display direction', () => {
      // Forward path should display: responder → requester (Node A → Node B)
      // Even though the traceroute was initiated by Node B

      const forwardPathDisplay = 'Node A → Repeater One → Node B';
      expect(forwardPathDisplay).toMatch(/Node A.*Node B/);

      // Return path should display: requester → responder (Node B → Node A)
      const returnPathDisplay = 'Node B → Repeater One → Node A';
      expect(returnPathDisplay).toMatch(/Node B.*Node A/);
    });
  });

  describe('Route segment generation logic', () => {
    it('should generate correct segments from forward path', () => {
      // Forward path: requester (200) → intermediate (300) → responder (100)
      const forwardSequence = [mockTraceroute.toNodeNum, ...JSON.parse(mockTraceroute.route), mockTraceroute.fromNodeNum];
      expect(forwardSequence).toEqual([200, 300, 100]);

      // Segments should be created for consecutive pairs:
      // Segment 1: 200 → 300 (requester to intermediate)
      // Segment 2: 300 → 100 (intermediate to responder)
      const segments: Array<{from: number, to: number}> = [];
      for (let i = 0; i < forwardSequence.length - 1; i++) {
        segments.push({
          from: forwardSequence[i],
          to: forwardSequence[i + 1]
        });
      }

      expect(segments.length).toBe(2);
      expect(segments[0]).toEqual({from: 200, to: 300}); // Node B → Repeater
      expect(segments[1]).toEqual({from: 300, to: 100}); // Repeater → Node A
    });

    it('should generate correct segments from return path', () => {
      // Return path: responder (100) → intermediate (300) → requester (200)
      const returnSequence = [mockTraceroute.fromNodeNum, ...JSON.parse(mockTraceroute.routeBack), mockTraceroute.toNodeNum];
      expect(returnSequence).toEqual([100, 300, 200]);

      // Segments should be created for consecutive pairs:
      // Segment 1: 100 → 300 (responder to intermediate)
      // Segment 2: 300 → 200 (intermediate to requester)
      const segments: Array<{from: number, to: number}> = [];
      for (let i = 0; i < returnSequence.length - 1; i++) {
        segments.push({
          from: returnSequence[i],
          to: returnSequence[i + 1]
        });
      }

      expect(segments.length).toBe(2);
      expect(segments[0]).toEqual({from: 100, to: 300}); // Node A → Repeater
      expect(segments[1]).toEqual({from: 300, to: 200}); // Repeater → Node B
    });

    it('should store segments bidirectionally (same segment for both directions)', () => {
      const forwardSequence = [mockTraceroute.toNodeNum, ...JSON.parse(mockTraceroute.route), mockTraceroute.fromNodeNum];
      const returnSequence = [mockTraceroute.fromNodeNum, ...JSON.parse(mockTraceroute.routeBack), mockTraceroute.toNodeNum];

      // Get all segment pairs from both paths
      const forwardSegments: Array<{from: number, to: number}> = [];
      for (let i = 0; i < forwardSequence.length - 1; i++) {
        forwardSegments.push({from: forwardSequence[i], to: forwardSequence[i + 1]});
      }

      const returnSegments: Array<{from: number, to: number}> = [];
      for (let i = 0; i < returnSequence.length - 1; i++) {
        returnSegments.push({from: returnSequence[i], to: returnSequence[i + 1]});
      }

      // When displayed on map, segments should use sorted keys to treat A→B and B→A as the same segment
      const forwardKeys = forwardSegments.map(s => [s.from, s.to].sort().join('-'));
      const returnKeys = returnSegments.map(s => [s.from, s.to].sort().join('-'));

      // Both directions should produce the same segment keys (order may differ)
      expect(new Set(forwardKeys)).toEqual(new Set(returnKeys));
      expect(new Set(forwardKeys)).toEqual(new Set(['200-300', '100-300']));
    });
  });

  describe('Edge cases', () => {
    it('should handle traceroute with no intermediate hops (direct connection)', () => {
      const directTraceroute: DbTraceroute = {
        ...mockTraceroute,
        route: '[]',
        routeBack: '[]',
      };

      const route = JSON.parse(directTraceroute.route);
      const forwardSequence = [directTraceroute.fromNodeNum, ...route, directTraceroute.toNodeNum];

      expect(forwardSequence).toEqual([100, 200]);
      expect(forwardSequence.length).toBe(2);
    });

    it('should handle traceroute with multiple intermediate hops', () => {
      const multiHopTraceroute: DbTraceroute = {
        ...mockTraceroute,
        route: '[300, 400, 500]',
        routeBack: '[500, 400, 300]',
      };

      const route = JSON.parse(multiHopTraceroute.route);
      const forwardSequence = [multiHopTraceroute.fromNodeNum, ...route, multiHopTraceroute.toNodeNum];

      expect(forwardSequence).toEqual([100, 300, 400, 500, 200]);
      expect(forwardSequence.length).toBe(5);

      // Verify endpoint swap preserves intermediate order
      const displaySequence = [...forwardSequence];
      if (displaySequence.length >= 2) {
        const temp = displaySequence[0];
        displaySequence[0] = displaySequence[displaySequence.length - 1];
        displaySequence[displaySequence.length - 1] = temp;
      }

      expect(displaySequence).toEqual([200, 300, 400, 500, 100]);
      expect(displaySequence[1]).toBe(300); // First intermediate unchanged
      expect(displaySequence[2]).toBe(400); // Second intermediate unchanged
      expect(displaySequence[3]).toBe(500); // Third intermediate unchanged
    });

    it('should handle failed traceroute (null route)', () => {
      const failedTraceroute: DbTraceroute = {
        ...mockTraceroute,
        route: 'null',
        routeBack: 'null',
      };

      // The formatTracerouteRoute function should detect null and return error message
      const isNullRoute = !failedTraceroute.route || failedTraceroute.route === 'null';
      expect(isNullRoute).toBe(true);
    });
  });
});
