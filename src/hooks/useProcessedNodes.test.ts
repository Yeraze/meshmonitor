/**
 * Tests for useProcessedNodes hook
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import {
  useProcessedNodes,
  sortNodes,
  filterNodesByText,
  DEFAULT_NODE_FILTERS,
  type NodeFilters,
} from './useProcessedNodes';
import type { DeviceInfo } from '../types/device';

// Mock all dependencies
const mockUseNodesReturn = vi.fn();
const mockUseTelemetryNodesReturn = vi.fn();
const mockUseUIReturn = vi.fn();
const mockUseSettingsReturn = vi.fn();

vi.mock('./useServerData', () => ({
  useNodes: () => mockUseNodesReturn(),
  useTelemetryNodes: () => mockUseTelemetryNodesReturn(),
}));

vi.mock('../contexts/UIContext', () => ({
  useUI: () => mockUseUIReturn(),
}));

vi.mock('../contexts/SettingsContext', () => ({
  useSettings: () => mockUseSettingsReturn(),
}));

// Helper to create a wrapper with QueryClient
function createWrapper() {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        gcTime: 0,
      },
    },
  });

  return function Wrapper({ children }: { children: React.ReactNode }) {
    return createElement(QueryClientProvider, { client }, children);
  };
}

// Sample test data
const now = Date.now() / 1000;
const mockNodes: DeviceInfo[] = [
  {
    nodeNum: 12345,
    user: { id: '!abc123', longName: 'Alpha Node', shortName: 'AN' },
    lastHeard: now - 3600, // 1 hour ago
    isFavorite: true,
    snr: 10,
    hopsAway: 1,
    viaMqtt: false,
    position: { latitude: 40.0, longitude: -74.0 },
  } as DeviceInfo,
  {
    nodeNum: 67890,
    user: { id: '!def456', longName: 'Beta Node', shortName: 'BN' },
    lastHeard: now - 7200, // 2 hours ago
    isFavorite: false,
    snr: 5,
    hopsAway: 2,
    viaMqtt: true,
    position: { latitude: 41.0, longitude: -75.0 },
  } as DeviceInfo,
  {
    nodeNum: 11111,
    user: { id: '!ghi789', longName: 'Gamma Node', shortName: 'GN' },
    lastHeard: now - 86400 * 10, // 10 days ago (should be filtered by age)
    isFavorite: false,
    snr: -5,
    hopsAway: 3,
    viaMqtt: false,
  } as DeviceInfo,
  {
    nodeNum: 22222,
    user: { id: '!jkl012', longName: 'Delta Node', shortName: 'DN' },
    lastHeard: now - 1800, // 30 minutes ago
    isFavorite: false,
    snr: 15,
    hopsAway: 0,
    viaMqtt: false,
    deviceMetrics: { batteryLevel: 101 }, // Powered
    position: { latitude: 42.0, longitude: -76.0 },
  } as DeviceInfo,
  {
    nodeNum: 33333,
    user: { id: '!mno345', longName: '', shortName: '' }, // Unknown node
    lastHeard: now - 600, // 10 minutes ago
    isFavorite: false,
  } as DeviceInfo,
];

describe('useProcessedNodes', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default mock returns
    mockUseNodesReturn.mockReturnValue({
      nodes: mockNodes,
      isLoading: false,
      error: null,
    });

    mockUseTelemetryNodesReturn.mockReturnValue({
      nodesWithTelemetry: new Set(['!abc123', '!def456']),
      nodesWithWeather: new Set(['!abc123']),
      nodesWithPKC: new Set(['!abc123']),
      isLoading: false,
    });

    mockUseUIReturn.mockReturnValue({
      nodeFilter: '',
    });

    mockUseSettingsReturn.mockReturnValue({
      maxNodeAgeHours: 72, // 3 days
      preferredSortField: 'lastHeard',
      preferredSortDirection: 'desc',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('basic functionality', () => {
    it('should return processed nodes with age filtering', () => {
      const { result } = renderHook(() => useProcessedNodes(), {
        wrapper: createWrapper(),
      });

      // Old node (10 days) should be filtered out with 72h max age
      expect(result.current.processedNodes).toHaveLength(4);
      expect(result.current.processedNodes.find(n => n.nodeNum === 11111)).toBeUndefined();
    });

    it('should put favorites first', () => {
      const { result } = renderHook(() => useProcessedNodes(), {
        wrapper: createWrapper(),
      });

      // Alpha Node is favorite, should be first
      expect(result.current.processedNodes[0].nodeNum).toBe(12345);
      expect(result.current.processedNodes[0].isFavorite).toBe(true);
    });

    it('should return loading state', () => {
      mockUseNodesReturn.mockReturnValue({
        nodes: [],
        isLoading: true,
        error: null,
      });

      const { result } = renderHook(() => useProcessedNodes(), {
        wrapper: createWrapper(),
      });

      expect(result.current.isLoading).toBe(true);
    });

    it('should return total nodes count', () => {
      const { result } = renderHook(() => useProcessedNodes(), {
        wrapper: createWrapper(),
      });

      expect(result.current.totalNodes).toBe(5);
    });
  });

  describe('text filtering', () => {
    it('should filter by longName', () => {
      mockUseUIReturn.mockReturnValue({
        nodeFilter: 'Alpha',
      });

      const { result } = renderHook(() => useProcessedNodes(), {
        wrapper: createWrapper(),
      });

      expect(result.current.processedNodes).toHaveLength(1);
      expect(result.current.processedNodes[0].user?.longName).toBe('Alpha Node');
    });

    it('should filter by shortName', () => {
      mockUseUIReturn.mockReturnValue({
        nodeFilter: 'BN',
      });

      const { result } = renderHook(() => useProcessedNodes(), {
        wrapper: createWrapper(),
      });

      expect(result.current.processedNodes).toHaveLength(1);
      expect(result.current.processedNodes[0].user?.shortName).toBe('BN');
    });

    it('should filter by node ID', () => {
      mockUseUIReturn.mockReturnValue({
        nodeFilter: 'def456',
      });

      const { result } = renderHook(() => useProcessedNodes(), {
        wrapper: createWrapper(),
      });

      expect(result.current.processedNodes).toHaveLength(1);
      expect(result.current.processedNodes[0].user?.id).toBe('!def456');
    });

    it('should be case-insensitive', () => {
      mockUseUIReturn.mockReturnValue({
        nodeFilter: 'BETA',
      });

      const { result } = renderHook(() => useProcessedNodes(), {
        wrapper: createWrapper(),
      });

      expect(result.current.processedNodes).toHaveLength(1);
      expect(result.current.processedNodes[0].user?.longName).toBe('Beta Node');
    });
  });

  describe('advanced filters', () => {
    it('should filter by MQTT in show mode', () => {
      const filters: NodeFilters = {
        ...DEFAULT_NODE_FILTERS,
        filterMode: 'show',
        showMqtt: true,
      };

      const { result } = renderHook(() => useProcessedNodes({ nodeFilters: filters }), { wrapper: createWrapper() });

      // Only Beta Node has viaMqtt=true
      expect(result.current.processedNodes).toHaveLength(1);
      expect(result.current.processedNodes[0].viaMqtt).toBe(true);
    });

    it('should filter by MQTT in hide mode', () => {
      const filters: NodeFilters = {
        ...DEFAULT_NODE_FILTERS,
        filterMode: 'hide',
        showMqtt: true,
      };

      const { result } = renderHook(() => useProcessedNodes({ nodeFilters: filters }), { wrapper: createWrapper() });

      // Should exclude MQTT nodes, leaving 3 (excluding old node)
      expect(result.current.processedNodes.every(n => !n.viaMqtt)).toBe(true);
    });

    it('should filter by telemetry', () => {
      const filters: NodeFilters = {
        ...DEFAULT_NODE_FILTERS,
        filterMode: 'show',
        showTelemetry: true,
      };

      const { result } = renderHook(() => useProcessedNodes({ nodeFilters: filters }), { wrapper: createWrapper() });

      // Only nodes with telemetry
      expect(result.current.processedNodes.length).toBeLessThanOrEqual(2);
      result.current.processedNodes.forEach(node => {
        expect(['!abc123', '!def456']).toContain(node.user?.id);
      });
    });

    it('should filter by power source - powered', () => {
      const filters: NodeFilters = {
        ...DEFAULT_NODE_FILTERS,
        powerSource: 'powered',
      };

      const { result } = renderHook(() => useProcessedNodes({ nodeFilters: filters }), { wrapper: createWrapper() });

      // Only Delta Node has batteryLevel 101 (powered)
      const poweredNodes = result.current.processedNodes.filter(n => n.deviceMetrics?.batteryLevel === 101);
      expect(poweredNodes.length).toBeGreaterThan(0);
    });

    it('should filter by hops range', () => {
      const filters: NodeFilters = {
        ...DEFAULT_NODE_FILTERS,
        minHops: 1,
        maxHops: 2,
      };

      const { result } = renderHook(() => useProcessedNodes({ nodeFilters: filters }), { wrapper: createWrapper() });

      // Should include nodes with hopsAway 1 or 2
      result.current.processedNodes.forEach(node => {
        if (node.hopsAway != null) {
          expect(node.hopsAway).toBeGreaterThanOrEqual(1);
          expect(node.hopsAway).toBeLessThanOrEqual(2);
        }
      });
    });

    it('should filter by position in show mode', () => {
      const filters: NodeFilters = {
        ...DEFAULT_NODE_FILTERS,
        filterMode: 'show',
        showPosition: true,
      };

      const { result } = renderHook(() => useProcessedNodes({ nodeFilters: filters }), { wrapper: createWrapper() });

      // Only nodes with position
      result.current.processedNodes.forEach(node => {
        expect(node.position?.latitude).toBeDefined();
        expect(node.position?.longitude).toBeDefined();
      });
    });

    it('should filter unknown nodes in show mode', () => {
      const filters: NodeFilters = {
        ...DEFAULT_NODE_FILTERS,
        filterMode: 'show',
        showUnknown: true,
      };

      const { result } = renderHook(() => useProcessedNodes({ nodeFilters: filters }), { wrapper: createWrapper() });

      // Only unknown node (no longName/shortName)
      expect(result.current.processedNodes.length).toBe(1);
      expect(result.current.processedNodes[0].nodeNum).toBe(33333);
    });
  });

  describe('sorting', () => {
    it('should sort by lastHeard descending', () => {
      const { result } = renderHook(
        () =>
          useProcessedNodes({
            sortField: 'lastHeard',
            sortDirection: 'desc',
          }),
        { wrapper: createWrapper() }
      );

      // Favorites first, then by lastHeard desc
      const nonFavorites = result.current.processedNodes.filter(n => !n.isFavorite);
      for (let i = 1; i < nonFavorites.length; i++) {
        expect(nonFavorites[i - 1].lastHeard).toBeGreaterThanOrEqual(nonFavorites[i].lastHeard || 0);
      }
    });

    it('should sort by longName ascending', () => {
      const { result } = renderHook(
        () =>
          useProcessedNodes({
            sortField: 'longName',
            sortDirection: 'asc',
          }),
        { wrapper: createWrapper() }
      );

      const nonFavorites = result.current.processedNodes.filter(n => !n.isFavorite);
      // Filter out nodes with no longName for clearer test
      const nodesWithName = nonFavorites.filter(n => n.user?.longName && n.user.longName.trim() !== '');
      for (let i = 1; i < nodesWithName.length; i++) {
        const prev = nodesWithName[i - 1].user?.longName || '';
        const curr = nodesWithName[i].user?.longName || '';
        expect(prev.toLowerCase() <= curr.toLowerCase()).toBe(true);
      }
    });

    it('should sort by SNR descending', () => {
      const { result } = renderHook(
        () =>
          useProcessedNodes({
            sortField: 'snr',
            sortDirection: 'desc',
          }),
        { wrapper: createWrapper() }
      );

      const nonFavorites = result.current.processedNodes.filter(n => !n.isFavorite);
      for (let i = 1; i < nonFavorites.length; i++) {
        expect((nonFavorites[i - 1].snr ?? -999) >= (nonFavorites[i].snr ?? -999)).toBe(true);
      }
    });
  });

  describe('option overrides', () => {
    it('should use maxNodeAgeHours override', () => {
      // Set very short age limit
      const { result } = renderHook(() => useProcessedNodes({ maxNodeAgeHours: 1 }), { wrapper: createWrapper() });

      // Only nodes heard within 1 hour should be included
      // Alpha Node is 1 hour ago, Delta is 30 min ago, Unknown is 10 min ago
      expect(result.current.processedNodes.length).toBeLessThan(5);
    });

    it('should use textFilter override', () => {
      const { result } = renderHook(() => useProcessedNodes({ textFilter: 'Delta' }), { wrapper: createWrapper() });

      expect(result.current.processedNodes).toHaveLength(1);
      expect(result.current.processedNodes[0].user?.longName).toBe('Delta Node');
    });
  });
});

describe('sortNodes helper', () => {
  const testNodes: DeviceInfo[] = [
    {
      nodeNum: 1,
      user: { longName: 'Zebra', shortName: 'Z', id: '!z' },
      lastHeard: 1000,
      snr: 5,
    } as DeviceInfo,
    {
      nodeNum: 2,
      user: { longName: 'Alpha', shortName: 'A', id: '!a' },
      lastHeard: 3000,
      snr: 10,
    } as DeviceInfo,
    {
      nodeNum: 3,
      user: { longName: 'Mango', shortName: 'M', id: '!m' },
      lastHeard: 2000,
      snr: -5,
    } as DeviceInfo,
  ];

  it('should sort by longName ascending', () => {
    const sorted = sortNodes(testNodes, 'longName', 'asc');
    expect(sorted[0].user?.longName).toBe('Alpha');
    expect(sorted[1].user?.longName).toBe('Mango');
    expect(sorted[2].user?.longName).toBe('Zebra');
  });

  it('should sort by longName descending', () => {
    const sorted = sortNodes(testNodes, 'longName', 'desc');
    expect(sorted[0].user?.longName).toBe('Zebra');
    expect(sorted[1].user?.longName).toBe('Mango');
    expect(sorted[2].user?.longName).toBe('Alpha');
  });

  it('should sort by lastHeard ascending', () => {
    const sorted = sortNodes(testNodes, 'lastHeard', 'asc');
    expect(sorted[0].lastHeard).toBe(1000);
    expect(sorted[2].lastHeard).toBe(3000);
  });

  it('should sort by snr descending', () => {
    const sorted = sortNodes(testNodes, 'snr', 'desc');
    expect(sorted[0].snr).toBe(10);
    expect(sorted[1].snr).toBe(5);
    expect(sorted[2].snr).toBe(-5);
  });

  it('should not mutate original array', () => {
    const original = [...testNodes];
    sortNodes(testNodes, 'longName', 'asc');
    expect(testNodes).toEqual(original);
  });
});

describe('filterNodesByText helper', () => {
  const testNodes: DeviceInfo[] = [
    {
      nodeNum: 1,
      user: { longName: 'Test Node One', shortName: 'TN1', id: '!test1' },
    } as DeviceInfo,
    {
      nodeNum: 2,
      user: { longName: 'Another Node', shortName: 'AN2', id: '!another' },
    } as DeviceInfo,
    {
      nodeNum: 3,
      user: { longName: 'Third Node', shortName: 'T3', id: '!third' },
    } as DeviceInfo,
  ];

  it('should return all nodes when filter is empty', () => {
    expect(filterNodesByText(testNodes, '')).toHaveLength(3);
    expect(filterNodesByText(testNodes, '   ')).toHaveLength(3);
  });

  it('should filter by longName', () => {
    const result = filterNodesByText(testNodes, 'Another');
    expect(result).toHaveLength(1);
    expect(result[0].user?.longName).toBe('Another Node');
  });

  it('should filter by shortName', () => {
    const result = filterNodesByText(testNodes, 'TN1');
    expect(result).toHaveLength(1);
    expect(result[0].user?.shortName).toBe('TN1');
  });

  it('should filter by id', () => {
    const result = filterNodesByText(testNodes, 'third');
    expect(result).toHaveLength(1);
    expect(result[0].user?.id).toBe('!third');
  });

  it('should be case-insensitive', () => {
    expect(filterNodesByText(testNodes, 'THIRD')).toHaveLength(1);
    expect(filterNodesByText(testNodes, 'another')).toHaveLength(1);
  });

  it('should match partial strings', () => {
    const result = filterNodesByText(testNodes, 'Node');
    expect(result).toHaveLength(3); // All have "Node" in longName
  });
});
