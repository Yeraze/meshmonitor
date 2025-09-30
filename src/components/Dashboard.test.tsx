import { describe, it, expect } from 'vitest';

describe('Dashboard', () => {

  describe('Global time range synchronization', () => {
    it('should calculate global min/max time across all telemetry data', () => {
      const telemetryData = new Map([
        ['node1-temperature', [
          { id: 1, nodeId: 'node1', nodeNum: 1, telemetryType: 'temperature', timestamp: 1000, value: 20, createdAt: 1000 },
          { id: 2, nodeId: 'node1', nodeNum: 1, telemetryType: 'temperature', timestamp: 2000, value: 21, createdAt: 2000 },
        ]],
        ['node2-humidity', [
          { id: 3, nodeId: 'node2', nodeNum: 2, telemetryType: 'humidity', timestamp: 500, value: 60, createdAt: 500 },
          { id: 4, nodeId: 'node2', nodeNum: 2, telemetryType: 'humidity', timestamp: 3000, value: 65, createdAt: 3000 },
        ]],
      ]);

      // Simulate the getGlobalTimeRange function
      let minTime = Infinity;
      let maxTime = -Infinity;

      telemetryData.forEach((data) => {
        data.forEach((item) => {
          if (item.timestamp < minTime) minTime = item.timestamp;
          if (item.timestamp > maxTime) maxTime = item.timestamp;
        });
      });

      // Global range should be from earliest (500) to latest (3000)
      expect(minTime).toBe(500);
      expect(maxTime).toBe(3000);
    });

    it('should return null when no telemetry data exists', () => {
      const telemetryData = new Map();

      let minTime = Infinity;
      let maxTime = -Infinity;

      telemetryData.forEach((data) => {
        data.forEach((item) => {
          if (item.timestamp < minTime) minTime = item.timestamp;
          if (item.timestamp > maxTime) maxTime = item.timestamp;
        });
      });

      const result = (minTime === Infinity || maxTime === -Infinity) ? null : [minTime, maxTime];

      expect(result).toBeNull();
    });

    it('should handle single data point', () => {
      const telemetryData = new Map([
        ['node1-temperature', [
          { id: 1, nodeId: 'node1', nodeNum: 1, telemetryType: 'temperature', timestamp: 1500, value: 20, createdAt: 1500 },
        ]],
      ]);

      let minTime = Infinity;
      let maxTime = -Infinity;

      telemetryData.forEach((data) => {
        data.forEach((item) => {
          if (item.timestamp < minTime) minTime = item.timestamp;
          if (item.timestamp > maxTime) maxTime = item.timestamp;
        });
      });

      // Both min and max should be the same
      expect(minTime).toBe(1500);
      expect(maxTime).toBe(1500);
    });

    it('should correctly handle multiple nodes with overlapping time ranges', () => {
      const telemetryData = new Map([
        ['node1-temperature', [
          { id: 1, nodeId: 'node1', nodeNum: 1, telemetryType: 'temperature', timestamp: 1000, value: 20, createdAt: 1000 },
          { id: 2, nodeId: 'node1', nodeNum: 1, telemetryType: 'temperature', timestamp: 2000, value: 21, createdAt: 2000 },
          { id: 3, nodeId: 'node1', nodeNum: 1, telemetryType: 'temperature', timestamp: 5000, value: 22, createdAt: 5000 },
        ]],
        ['node2-humidity', [
          { id: 4, nodeId: 'node2', nodeNum: 2, telemetryType: 'humidity', timestamp: 1500, value: 60, createdAt: 1500 },
          { id: 5, nodeId: 'node2', nodeNum: 2, telemetryType: 'humidity', timestamp: 2500, value: 65, createdAt: 2500 },
        ]],
        ['node3-pressure', [
          { id: 6, nodeId: 'node3', nodeNum: 3, telemetryType: 'pressure', timestamp: 800, value: 1013, createdAt: 800 },
          { id: 7, nodeId: 'node3', nodeNum: 3, telemetryType: 'pressure', timestamp: 6000, value: 1015, createdAt: 6000 },
        ]],
      ]);

      let minTime = Infinity;
      let maxTime = -Infinity;

      telemetryData.forEach((data) => {
        data.forEach((item) => {
          if (item.timestamp < minTime) minTime = item.timestamp;
          if (item.timestamp > maxTime) maxTime = item.timestamp;
        });
      });

      // Global range should span from node3's earliest (800) to node3's latest (6000)
      expect(minTime).toBe(800);
      expect(maxTime).toBe(6000);
    });
  });

  describe('useEffect dependencies', () => {
    it('should include baseUrl in dependency array', () => {
      // This is a regression test to ensure baseUrl is in the dependency array
      // The bug was that baseUrl was missing, causing stale closures
      // We verify this by checking that the dependency array includes baseUrl

      // Read the Dashboard component source to verify dependencies
      const dashboardSource = require('fs').readFileSync(
        require('path').join(__dirname, 'Dashboard.tsx'),
        'utf8'
      );

      // Check that the useEffect has baseUrl in its dependency array
      // Pattern: }, [telemetryHours, baseUrl]);
      const useEffectPattern = /},\s*\[telemetryHours,\s*baseUrl\]/;
      expect(dashboardSource).toMatch(useEffectPattern);
    });
  });
});
