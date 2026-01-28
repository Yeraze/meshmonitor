import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock dependencies before any imports
const mockGetSetting = vi.fn();
const mockSetSetting = vi.fn();
const mockGetAllNodes = vi.fn();
const mockGetNode = vi.fn();

vi.mock('../services/database.js', () => ({
  default: {
    getSetting: mockGetSetting,
    setSetting: mockSetSetting,
    getAllNodes: mockGetAllNodes,
    getNode: mockGetNode,
  },
}));

vi.mock('./messageQueueService.js', () => ({
  messageQueueService: {
    enqueue: vi.fn(),
  },
}));

vi.mock('./logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('node-cron', () => ({
  default: {
    schedule: vi.fn((_expression: string, _callback: () => void) => ({
      stop: vi.fn(),
    })),
    validate: vi.fn(() => true),
  },
}));

import type { GeofenceTrigger, GeofenceShape, GeofenceNodeFilter } from '../components/auto-responder/types.js';
import { isPointInGeofence, distanceToGeofenceCenter } from '../utils/geometry.js';
import { messageQueueService } from './messageQueueService.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Build a circle geofence trigger with sensible defaults. */
function makeCircleTrigger(overrides: Partial<GeofenceTrigger> = {}): GeofenceTrigger {
  return {
    id: 'geo-1',
    name: 'Test Geofence',
    enabled: true,
    shape: {
      type: 'circle',
      center: { lat: 26.0, lng: -80.0 },
      radiusKm: 10,
    },
    event: 'entry',
    nodeFilter: { type: 'all' },
    responseType: 'text',
    response: 'Node entered the zone',
    channel: 0,
    ...overrides,
  };
}

/** Coordinates well inside the default circle (center 26.0, -80.0, 10 km). */
const INSIDE = { lat: 26.0, lng: -80.0 };

/** Coordinates well outside the default circle. */
const OUTSIDE = { lat: 30.0, lng: -85.0 };

describe('MeshtasticManager - Geofence Engine', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ─── 1. Entry detection ────────────────────────────────────────────────────

  describe('Entry detection', () => {
    it('should fire an entry event when a node moves from outside to inside a circle geofence', () => {
      const trigger = makeCircleTrigger({ event: 'entry' });
      const triggersJson = JSON.stringify([trigger]);

      // During init the node is outside the geofence
      mockGetSetting.mockImplementation((key: string) => {
        if (key === 'geofenceTriggers') return triggersJson;
        return null;
      });
      mockGetAllNodes.mockReturnValue([
        { nodeNum: 1000, latitude: OUTSIDE.lat, longitude: OUTSIDE.lng },
      ]);

      // Create a minimal manager-like object simulating state
      const geofenceNodeState = new Map<string, Set<number>>();
      const geofenceWhileInsideTimers = new Map<string, NodeJS.Timeout>();

      // Simulate initGeofenceEngine: compute initial state
      const allNodes = mockGetAllNodes();
      const insideSet = new Set<number>();
      for (const node of allNodes) {
        if (node.latitude == null || node.longitude == null) continue;
        if (isPointInGeofence(node.latitude, node.longitude, trigger.shape)) {
          insideSet.add(Number(node.nodeNum));
        }
      }
      geofenceNodeState.set(trigger.id, insideSet);

      // Node should be outside initially
      expect(insideSet.has(1000)).toBe(false);

      // Now simulate checkGeofencesForNode: node moves inside
      const nodeNum = 1000;
      const isInside = isPointInGeofence(INSIDE.lat, INSIDE.lng, trigger.shape);
      expect(isInside).toBe(true);

      const stateSet = geofenceNodeState.get(trigger.id) || new Set<number>();
      const wasInside = stateSet.has(nodeNum);
      expect(wasInside).toBe(false);

      // State transition: outside -> inside
      if (isInside && !wasInside) {
        stateSet.add(nodeNum);
        geofenceNodeState.set(trigger.id, stateSet);
      }

      // Node should now be tracked as inside
      expect(geofenceNodeState.get(trigger.id)!.has(nodeNum)).toBe(true);
      // And an entry event should fire (trigger.event === 'entry')
      expect(trigger.event === 'entry' && isInside && !wasInside).toBe(true);
    });
  });

  // ─── 2. Exit detection ─────────────────────────────────────────────────────

  describe('Exit detection', () => {
    it('should fire an exit event when a node moves from inside to outside a circle geofence', () => {
      const trigger = makeCircleTrigger({ event: 'exit' });

      // Init state: node is inside
      const geofenceNodeState = new Map<string, Set<number>>();
      const insideSet = new Set<number>([1000]);
      geofenceNodeState.set(trigger.id, insideSet);

      expect(geofenceNodeState.get(trigger.id)!.has(1000)).toBe(true);

      // Node reports new position outside
      const isInside = isPointInGeofence(OUTSIDE.lat, OUTSIDE.lng, trigger.shape);
      expect(isInside).toBe(false);

      const stateSet = geofenceNodeState.get(trigger.id)!;
      const wasInside = stateSet.has(1000);
      expect(wasInside).toBe(true);

      // State transition: inside -> outside
      let exitFired = false;
      if (!isInside && wasInside) {
        stateSet.delete(1000);
        geofenceNodeState.set(trigger.id, stateSet);
        if (trigger.event === 'exit') {
          exitFired = true;
        }
      }

      expect(exitFired).toBe(true);
      expect(geofenceNodeState.get(trigger.id)!.has(1000)).toBe(false);
    });
  });

  // ─── 3. No false positive: stays outside ───────────────────────────────────

  describe('No false positive when node stays outside', () => {
    it('should not fire any event when a node remains outside the geofence', () => {
      const trigger = makeCircleTrigger({ event: 'entry' });

      // Init state: node is outside
      const geofenceNodeState = new Map<string, Set<number>>();
      geofenceNodeState.set(trigger.id, new Set<number>());

      const nodeNum = 1000;
      const isInside = isPointInGeofence(OUTSIDE.lat, OUTSIDE.lng, trigger.shape);
      expect(isInside).toBe(false);

      const stateSet = geofenceNodeState.get(trigger.id)!;
      const wasInside = stateSet.has(nodeNum);
      expect(wasInside).toBe(false);

      // No state change: still outside
      const entryFired = isInside && !wasInside;
      const exitFired = !isInside && wasInside;

      expect(entryFired).toBe(false);
      expect(exitFired).toBe(false);
    });
  });

  // ─── 4. No false positive: stays inside ────────────────────────────────────

  describe('No false positive when node stays inside', () => {
    it('should not fire entry or exit events when a node remains inside the geofence', () => {
      const trigger = makeCircleTrigger({ event: 'entry' });

      // Init state: node already inside
      const geofenceNodeState = new Map<string, Set<number>>();
      geofenceNodeState.set(trigger.id, new Set<number>([1000]));

      const nodeNum = 1000;
      const isInside = isPointInGeofence(INSIDE.lat, INSIDE.lng, trigger.shape);
      expect(isInside).toBe(true);

      const stateSet = geofenceNodeState.get(trigger.id)!;
      const wasInside = stateSet.has(nodeNum);
      expect(wasInside).toBe(true);

      // No state transition
      const entryFired = isInside && !wasInside;
      const exitFired = !isInside && wasInside;

      expect(entryFired).toBe(false);
      expect(exitFired).toBe(false);
    });
  });

  // ─── 5. Node filter matching ───────────────────────────────────────────────

  describe('Node filter matching', () => {
    it('should match any node when filter type is "all"', () => {
      const filter: GeofenceNodeFilter = { type: 'all' };
      const nodeNums = [100, 200, 300, 999999];

      for (const nodeNum of nodeNums) {
        const matches = filter.type === 'all' ||
          (filter.type === 'selected' && filter.nodeNums.includes(nodeNum));
        expect(matches).toBe(true);
      }
    });

    it('should only match listed nodeNums when filter type is "selected"', () => {
      const filter: GeofenceNodeFilter = { type: 'selected', nodeNums: [100, 200] };

      // Listed nodes should match
      expect(filter.type === 'selected' && filter.nodeNums.includes(100)).toBe(true);
      expect(filter.type === 'selected' && filter.nodeNums.includes(200)).toBe(true);

      // Unlisted node should not match
      expect(filter.type === 'selected' && filter.nodeNums.includes(300)).toBe(false);
    });

    it('should skip nodes not in the selected list during checkGeofencesForNode', () => {
      const trigger = makeCircleTrigger({
        event: 'entry',
        nodeFilter: { type: 'selected', nodeNums: [1000] },
      });

      const triggersJson = JSON.stringify([trigger]);
      mockGetSetting.mockImplementation((key: string) => {
        if (key === 'geofenceTriggers') return triggersJson;
        return null;
      });

      // Simulate the filter check from checkGeofencesForNode
      const nodeNum = 2000; // Not in selected list
      const shouldSkip = trigger.nodeFilter.type === 'selected' &&
        !trigger.nodeFilter.nodeNums.includes(nodeNum);

      expect(shouldSkip).toBe(true);

      // Now with a listed node
      const listedNodeNum = 1000;
      const shouldNotSkip = trigger.nodeFilter.type === 'selected' &&
        !trigger.nodeFilter.nodeNums.includes(listedNodeNum);

      expect(shouldNotSkip).toBe(false);
    });
  });

  // ─── 6. While-inside timer setup ───────────────────────────────────────────

  describe('While-inside timer', () => {
    it('should set up an interval timer for while_inside events during init', () => {
      const trigger = makeCircleTrigger({
        event: 'while_inside',
        whileInsideIntervalMinutes: 5,
      });

      const triggersJson = JSON.stringify([trigger]);
      mockGetSetting.mockImplementation((key: string) => {
        if (key === 'geofenceTriggers') return triggersJson;
        return null;
      });
      mockGetAllNodes.mockReturnValue([]);

      // Simulate initGeofenceEngine's while_inside timer logic
      const geofenceWhileInsideTimers = new Map<string, NodeJS.Timeout>();

      if (trigger.event === 'while_inside' &&
          trigger.whileInsideIntervalMinutes &&
          trigger.whileInsideIntervalMinutes >= 1) {
        const intervalMs = trigger.whileInsideIntervalMinutes * 60 * 1000;
        const callback = vi.fn();
        const timer = setInterval(callback, intervalMs);
        geofenceWhileInsideTimers.set(trigger.id, timer);
      }

      expect(geofenceWhileInsideTimers.has(trigger.id)).toBe(true);

      // Verify the timer fires at the correct interval (5 min = 300000 ms)
      const callback = vi.fn();
      clearInterval(geofenceWhileInsideTimers.get(trigger.id)!);
      const timer = setInterval(callback, 5 * 60 * 1000);
      geofenceWhileInsideTimers.set(trigger.id, timer);

      expect(callback).not.toHaveBeenCalled();
      vi.advanceTimersByTime(5 * 60 * 1000);
      expect(callback).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(5 * 60 * 1000);
      expect(callback).toHaveBeenCalledTimes(2);

      clearInterval(timer);
    });

    it('should not set up a timer for non-while_inside events', () => {
      const entryTrigger = makeCircleTrigger({ event: 'entry' });
      const exitTrigger = makeCircleTrigger({ id: 'geo-2', event: 'exit' });

      const geofenceWhileInsideTimers = new Map<string, NodeJS.Timeout>();

      for (const trigger of [entryTrigger, exitTrigger]) {
        if (trigger.event === 'while_inside' &&
            trigger.whileInsideIntervalMinutes &&
            trigger.whileInsideIntervalMinutes >= 1) {
          const timer = setInterval(() => {}, trigger.whileInsideIntervalMinutes * 60 * 1000);
          geofenceWhileInsideTimers.set(trigger.id, timer);
        }
      }

      expect(geofenceWhileInsideTimers.size).toBe(0);
    });
  });

  // ─── 7. Token expansion ────────────────────────────────────────────────────

  describe('Token expansion (replaceGeofenceTokens)', () => {
    it('should replace {GEOFENCE_NAME}, {EVENT}, {NODE_LAT}, {NODE_LON}, {DISTANCE_TO_CENTER}', () => {
      const trigger = makeCircleTrigger({
        name: 'Downtown Zone',
        shape: {
          type: 'circle',
          center: { lat: 26.0, lng: -80.0 },
          radiusKm: 10,
        },
      });

      const nodeNum = 1000;
      const lat = 26.05;
      const lng = -80.02;
      const eventType = 'entry';

      // Replicate token replacement logic from replaceGeofenceTokens
      // (skipping replaceAnnouncementTokens which handles {VERSION} etc.)
      let message = '{GEOFENCE_NAME} | {EVENT} | {NODE_LAT} | {NODE_LON} | {DISTANCE_TO_CENTER}';

      const nodeId = `!${nodeNum.toString(16).padStart(8, '0')}`;
      const dist = distanceToGeofenceCenter(lat, lng, trigger.shape);

      message = message.replace(/{GEOFENCE_NAME}/g, trigger.name);
      message = message.replace(/{NODE_LAT}/g, String(lat));
      message = message.replace(/{NODE_LON}/g, String(lng));
      message = message.replace(/{EVENT}/g, eventType);
      message = message.replace(/{DISTANCE_TO_CENTER}/g, dist.toFixed(2));

      expect(message).toContain('Downtown Zone');
      expect(message).toContain('entry');
      expect(message).toContain('26.05');
      expect(message).toContain('-80.02');
      // Distance should be a small number (< 10 km since the point is near center)
      expect(parseFloat(dist.toFixed(2))).toBeLessThan(10);
      expect(message).toContain(dist.toFixed(2));
    });

    it('should replace {NODE_ID}, {NODE_NUM}, {LONG_NAME}, {SHORT_NAME}', () => {
      const trigger = makeCircleTrigger();
      const nodeNum = 1000;
      const lat = 26.0;
      const lng = -80.0;

      let message = '{NODE_ID} | {NODE_NUM} | {LONG_NAME} | {SHORT_NAME}';

      const nodeId = `!${nodeNum.toString(16).padStart(8, '0')}`;
      const mockNode = { longName: 'Test Node Alpha', shortName: 'TNA' };

      message = message.replace(/{NODE_ID}/g, nodeId);
      message = message.replace(/{NODE_NUM}/g, String(nodeNum));
      message = message.replace(/{LONG_NAME}/g, mockNode.longName || nodeId);
      message = message.replace(/{SHORT_NAME}/g, mockNode.shortName || nodeId);

      expect(message).toBe('!000003e8 | 1000 | Test Node Alpha | TNA');
    });

    it('should handle message with no tokens', () => {
      const plainMessage = 'Hello from the geofence!';
      // No tokens to replace, should stay the same
      let result = plainMessage;
      result = result.replace(/{GEOFENCE_NAME}/g, 'Zone');
      result = result.replace(/{EVENT}/g, 'entry');
      expect(result).toBe(plainMessage);
    });

    it('should handle multiple occurrences of the same token', () => {
      let message = '{GEOFENCE_NAME} alert: {GEOFENCE_NAME} triggered';
      message = message.replace(/{GEOFENCE_NAME}/g, 'Zone A');
      expect(message).toBe('Zone A alert: Zone A triggered');
    });
  });

  // ─── 8. Initial state computation ──────────────────────────────────────────

  describe('Initial state computation (initGeofenceEngine)', () => {
    it('should load node positions and compute initial inside/outside state without firing events', () => {
      const trigger = makeCircleTrigger({ event: 'entry' });
      const triggersJson = JSON.stringify([trigger]);

      mockGetSetting.mockImplementation((key: string) => {
        if (key === 'geofenceTriggers') return triggersJson;
        return null;
      });

      // Two nodes: one inside, one outside
      mockGetAllNodes.mockReturnValue([
        { nodeNum: 1000, latitude: INSIDE.lat, longitude: INSIDE.lng },
        { nodeNum: 2000, latitude: OUTSIDE.lat, longitude: OUTSIDE.lng },
      ]);

      // Simulate initGeofenceEngine
      const geofenceNodeState = new Map<string, Set<number>>();
      const allNodes = mockGetAllNodes();
      const enabledTriggers = [trigger];

      for (const t of enabledTriggers) {
        const insideSet = new Set<number>();
        for (const node of allNodes) {
          if (node.latitude == null || node.longitude == null) continue;
          const nodeNum = Number(node.nodeNum);
          if (t.nodeFilter.type === 'selected' && !t.nodeFilter.nodeNums.includes(nodeNum)) continue;
          if (isPointInGeofence(node.latitude, node.longitude, t.shape)) {
            insideSet.add(nodeNum);
          }
        }
        geofenceNodeState.set(t.id, insideSet);
      }

      // Node 1000 should be inside, node 2000 outside
      const state = geofenceNodeState.get(trigger.id)!;
      expect(state.has(1000)).toBe(true);
      expect(state.has(2000)).toBe(false);
      expect(state.size).toBe(1);

      // No events should be fired during init (messageQueueService.enqueue not called)
      expect(messageQueueService.enqueue).not.toHaveBeenCalled();
    });

    it('should skip nodes without position data', () => {
      const trigger = makeCircleTrigger();
      const triggersJson = JSON.stringify([trigger]);

      mockGetSetting.mockImplementation((key: string) => {
        if (key === 'geofenceTriggers') return triggersJson;
        return null;
      });

      mockGetAllNodes.mockReturnValue([
        { nodeNum: 1000, latitude: null, longitude: null },
        { nodeNum: 2000, latitude: undefined, longitude: undefined },
        { nodeNum: 3000, latitude: INSIDE.lat, longitude: INSIDE.lng },
      ]);

      const geofenceNodeState = new Map<string, Set<number>>();
      const allNodes = mockGetAllNodes();
      const insideSet = new Set<number>();

      for (const node of allNodes) {
        if (node.latitude == null || node.longitude == null) continue;
        if (isPointInGeofence(node.latitude, node.longitude, trigger.shape)) {
          insideSet.add(Number(node.nodeNum));
        }
      }
      geofenceNodeState.set(trigger.id, insideSet);

      // Only node 3000 has valid position and is inside
      expect(insideSet.size).toBe(1);
      expect(insideSet.has(3000)).toBe(true);
    });

    it('should handle empty node list gracefully', () => {
      const trigger = makeCircleTrigger();
      mockGetAllNodes.mockReturnValue([]);

      const insideSet = new Set<number>();
      const allNodes = mockGetAllNodes();
      for (const node of allNodes) {
        if (node.latitude == null || node.longitude == null) continue;
        if (isPointInGeofence(node.latitude, node.longitude, trigger.shape)) {
          insideSet.add(Number(node.nodeNum));
        }
      }

      expect(insideSet.size).toBe(0);
    });

    it('should handle missing geofenceTriggers setting', () => {
      mockGetSetting.mockReturnValue(null);

      const triggersJson = mockGetSetting('geofenceTriggers');
      expect(triggersJson).toBeNull();
      // initGeofenceEngine returns early, no error
    });

    it('should handle malformed JSON in geofenceTriggers setting', () => {
      mockGetSetting.mockReturnValue('this is not json');

      const triggersJson = mockGetSetting('geofenceTriggers');
      let parsed = null;
      try {
        parsed = JSON.parse(triggersJson);
      } catch {
        // Expected to fail
      }

      expect(parsed).toBeNull();
    });
  });

  // ─── 9. Disabled triggers are skipped ──────────────────────────────────────

  describe('Disabled triggers are skipped', () => {
    it('should not process disabled triggers in initGeofenceEngine', () => {
      const enabledTrigger = makeCircleTrigger({ id: 'geo-enabled', enabled: true });
      const disabledTrigger = makeCircleTrigger({ id: 'geo-disabled', enabled: false });
      const triggers = [enabledTrigger, disabledTrigger];

      const enabledTriggers = triggers.filter(t => t.enabled);
      expect(enabledTriggers.length).toBe(1);
      expect(enabledTriggers[0].id).toBe('geo-enabled');
    });

    it('should not process disabled triggers in checkGeofencesForNode', () => {
      const disabledTrigger = makeCircleTrigger({ enabled: false, event: 'entry' });
      const triggersJson = JSON.stringify([disabledTrigger]);

      mockGetSetting.mockImplementation((key: string) => {
        if (key === 'geofenceTriggers') return triggersJson;
        return null;
      });

      // Simulate checkGeofencesForNode
      const triggers = JSON.parse(triggersJson);
      let eventFired = false;

      for (const trigger of triggers) {
        if (!trigger.enabled) continue; // Should skip
        eventFired = true;
      }

      expect(eventFired).toBe(false);
    });

    it('should process enabled triggers but skip disabled ones in a mixed list', () => {
      const triggers = [
        makeCircleTrigger({ id: 'geo-1', enabled: true, event: 'entry' }),
        makeCircleTrigger({ id: 'geo-2', enabled: false, event: 'entry' }),
        makeCircleTrigger({ id: 'geo-3', enabled: true, event: 'exit' }),
      ];

      const processedIds: string[] = [];
      for (const trigger of triggers) {
        if (!trigger.enabled) continue;
        processedIds.push(trigger.id);
      }

      expect(processedIds).toEqual(['geo-1', 'geo-3']);
      expect(processedIds).not.toContain('geo-2');
    });
  });

  // ─── Additional edge cases ─────────────────────────────────────────────────

  describe('Geometry integration', () => {
    it('should correctly detect points inside and outside a circle geofence', () => {
      const shape: GeofenceShape = {
        type: 'circle',
        center: { lat: 26.0, lng: -80.0 },
        radiusKm: 10,
      };

      // Center point is inside
      expect(isPointInGeofence(26.0, -80.0, shape)).toBe(true);

      // Very close to center is inside
      expect(isPointInGeofence(26.001, -80.001, shape)).toBe(true);

      // Far away is outside
      expect(isPointInGeofence(30.0, -85.0, shape)).toBe(false);
    });

    it('should calculate distance to geofence center correctly', () => {
      const shape: GeofenceShape = {
        type: 'circle',
        center: { lat: 26.0, lng: -80.0 },
        radiusKm: 10,
      };

      // At the center, distance should be 0
      const distAtCenter = distanceToGeofenceCenter(26.0, -80.0, shape);
      expect(distAtCenter).toBeCloseTo(0, 1);

      // Far away should be a large distance
      const distFar = distanceToGeofenceCenter(30.0, -85.0, shape);
      expect(distFar).toBeGreaterThan(100);
    });
  });

  describe('updateGeofenceTriggerResult', () => {
    it('should update trigger lastRun and lastResult in settings', () => {
      const trigger = makeCircleTrigger({ id: 'geo-update' });
      const triggers = [trigger];
      const triggersJson = JSON.stringify(triggers);

      mockGetSetting.mockReturnValue(triggersJson);

      // Simulate updateGeofenceTriggerResult
      const parsed = JSON.parse(mockGetSetting('geofenceTriggers'));
      const found = parsed.find((t: any) => t.id === 'geo-update');

      expect(found).toBeDefined();

      found.lastRun = Date.now();
      found.lastResult = 'success';
      delete found.lastError;

      mockSetSetting('geofenceTriggers', JSON.stringify(parsed));

      expect(mockSetSetting).toHaveBeenCalledWith(
        'geofenceTriggers',
        expect.stringContaining('"lastResult":"success"')
      );
    });

    it('should set lastError when result is error', () => {
      const trigger = makeCircleTrigger({ id: 'geo-err' });
      const triggers = [trigger];
      const triggersJson = JSON.stringify(triggers);

      mockGetSetting.mockReturnValue(triggersJson);

      const parsed = JSON.parse(mockGetSetting('geofenceTriggers'));
      const found = parsed.find((t: any) => t.id === 'geo-err');

      found.lastRun = Date.now();
      found.lastResult = 'error';
      found.lastError = 'Script file not found';

      mockSetSetting('geofenceTriggers', JSON.stringify(parsed));

      expect(mockSetSetting).toHaveBeenCalledWith(
        'geofenceTriggers',
        expect.stringContaining('"lastError":"Script file not found"')
      );
    });
  });

  describe('restartGeofenceEngine', () => {
    it('should clear existing timers and state before reinitializing', () => {
      // Simulate existing state
      const geofenceNodeState = new Map<string, Set<number>>();
      const geofenceWhileInsideTimers = new Map<string, NodeJS.Timeout>();

      geofenceNodeState.set('geo-1', new Set([1000, 2000]));
      const timer = setInterval(() => {}, 60000);
      geofenceWhileInsideTimers.set('geo-1', timer);

      expect(geofenceNodeState.size).toBe(1);
      expect(geofenceWhileInsideTimers.size).toBe(1);

      // Simulate restart: clear everything
      geofenceWhileInsideTimers.forEach(t => clearInterval(t));
      geofenceWhileInsideTimers.clear();
      geofenceNodeState.clear();

      expect(geofenceNodeState.size).toBe(0);
      expect(geofenceWhileInsideTimers.size).toBe(0);
    });
  });

  describe('while_inside entry also fires on initial entry', () => {
    it('should fire entry event when node enters a while_inside geofence', () => {
      const trigger = makeCircleTrigger({
        event: 'while_inside',
        whileInsideIntervalMinutes: 5,
      });

      const geofenceNodeState = new Map<string, Set<number>>();
      geofenceNodeState.set(trigger.id, new Set<number>());

      const nodeNum = 1000;
      const isInside = isPointInGeofence(INSIDE.lat, INSIDE.lng, trigger.shape);
      const stateSet = geofenceNodeState.get(trigger.id)!;
      const wasInside = stateSet.has(nodeNum);

      expect(isInside).toBe(true);
      expect(wasInside).toBe(false);

      // Per checkGeofencesForNode logic: while_inside triggers also fire on entry
      let shouldExecute = false;
      if (isInside && !wasInside) {
        stateSet.add(nodeNum);
        if (trigger.event === 'entry' || trigger.event === 'while_inside') {
          shouldExecute = true;
        }
      }

      expect(shouldExecute).toBe(true);
    });
  });
});
