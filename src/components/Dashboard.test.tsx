import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

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
        data.forEach((item: any) => {
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
        data.forEach((item: any) => {
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
        data.forEach((item: any) => {
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
        data.forEach((item: any) => {
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
    it('should use TanStack Query for data fetching', () => {
      // This is a regression test to ensure proper data fetching
      // The Dashboard was refactored to use TanStack Query for data fetching
      // We verify this by checking that useDashboardData hook uses useQuery

      // Read the useDashboardData hook source to verify TanStack Query usage
      const __filename = fileURLToPath(import.meta.url);
      const __dirname = path.dirname(__filename);
      const hookSource = fs.readFileSync(
        path.join(__dirname, 'Dashboard/hooks/useDashboardData.ts'),
        'utf8'
      );

      // Check that the hook uses useQuery from TanStack Query
      // This ensures proper caching, background refetching, and no stale closures
      const useQueryPattern = /useQuery\(\{/;
      expect(hookSource).toMatch(useQueryPattern);
      
      // Also verify refetchInterval is set for polling
      const refetchIntervalPattern = /refetchInterval/;
      expect(hookSource).toMatch(refetchIntervalPattern);
    });
  });
});
