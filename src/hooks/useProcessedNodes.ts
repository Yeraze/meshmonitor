/**
 * Hook for processing nodes with filtering and sorting
 *
 * This hook combines data from TanStack Query cache with UI filters
 * to produce a processed list of nodes ready for display.
 *
 * Migration Note: This hook replaces the processedNodes useMemo in App.tsx,
 * reading directly from the TanStack Query cache instead of DataContext.
 */

import { useMemo } from 'react';
import { useNodes, useTelemetryNodes } from './useServerData';
import { useUI } from '../contexts/UIContext';
import { useSettings } from '../contexts/SettingsContext';
import type { DeviceInfo } from '../types/device';
import type { SortField, SortDirection } from '../types/ui';

/**
 * Node filter configuration
 * Controls which nodes are displayed based on various criteria
 */
export interface NodeFilters {
  filterMode: 'show' | 'hide';
  showMqtt: boolean;
  showTelemetry: boolean;
  showEnvironment: boolean;
  powerSource: 'powered' | 'battery' | 'both';
  showPosition: boolean;
  minHops: number;
  maxHops: number;
  showPKI: boolean;
  showUnknown: boolean;
  showIgnored: boolean;
  deviceRoles: number[];
  channels: number[];
}

/**
 * Default filter values
 */
export const DEFAULT_NODE_FILTERS: NodeFilters = {
  filterMode: 'show',
  showMqtt: false,
  showTelemetry: false,
  showEnvironment: false,
  powerSource: 'both',
  showPosition: false,
  minHops: 0,
  maxHops: 10,
  showPKI: false,
  showUnknown: false,
  showIgnored: false,
  deviceRoles: [],
  channels: [],
};

/**
 * Helper function to sort nodes by a given field and direction
 */
export function sortNodes(nodes: DeviceInfo[], field: SortField, direction: SortDirection): DeviceInfo[] {
  return [...nodes].sort((a, b) => {
    let aVal: string | number, bVal: string | number;

    switch (field) {
      case 'longName':
        aVal = a.user?.longName || `Node ${a.nodeNum}`;
        bVal = b.user?.longName || `Node ${b.nodeNum}`;
        break;
      case 'shortName':
        aVal = a.user?.shortName || '';
        bVal = b.user?.shortName || '';
        break;
      case 'id':
        aVal = a.user?.id || String(a.nodeNum);
        bVal = b.user?.id || String(b.nodeNum);
        break;
      case 'lastHeard':
        aVal = a.lastHeard || 0;
        bVal = b.lastHeard || 0;
        break;
      case 'snr':
        aVal = a.snr || -999;
        bVal = b.snr || -999;
        break;
      case 'battery':
        aVal = a.deviceMetrics?.batteryLevel || -1;
        bVal = b.deviceMetrics?.batteryLevel || -1;
        break;
      case 'hwModel':
        aVal = a.user?.hwModel || 0;
        bVal = b.user?.hwModel || 0;
        break;
      case 'hops': {
        // For nodes without hop data, use fallback values that push them to bottom
        // Ascending: use 999 (high value = bottom), Descending: use -1 (low value = bottom)
        const noHopFallback = direction === 'asc' ? 999 : -1;
        aVal = a.hopsAway !== undefined && a.hopsAway !== null ? a.hopsAway : noHopFallback;
        bVal = b.hopsAway !== undefined && b.hopsAway !== null ? b.hopsAway : noHopFallback;
        break;
      }
      default:
        return 0;
    }

    if (typeof aVal === 'string' && typeof bVal === 'string') {
      const comparison = aVal.toLowerCase().localeCompare(bVal.toLowerCase());
      return direction === 'asc' ? comparison : -comparison;
    } else {
      const comparison = aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
      return direction === 'asc' ? comparison : -comparison;
    }
  });
}

/**
 * Helper function to filter nodes by text search
 */
export function filterNodesByText(nodes: DeviceInfo[], filter: string): DeviceInfo[] {
  if (!filter.trim()) return nodes;

  const lowerFilter = filter.toLowerCase();
  return nodes.filter(node => {
    const longName = (node.user?.longName || '').toLowerCase();
    const shortName = (node.user?.shortName || '').toLowerCase();
    const id = (node.user?.id || '').toLowerCase();

    return longName.includes(lowerFilter) || shortName.includes(lowerFilter) || id.includes(lowerFilter);
  });
}

/**
 * Options for useProcessedNodes hook
 */
interface UseProcessedNodesOptions {
  /** Advanced filter options */
  nodeFilters?: NodeFilters;
  /** Override text filter (uses UIContext by default) */
  textFilter?: string;
  /** Override max node age in hours (uses SettingsContext by default) */
  maxNodeAgeHours?: number;
  /** Override sort field (uses SettingsContext by default) */
  sortField?: SortField;
  /** Override sort direction (uses SettingsContext by default) */
  sortDirection?: SortDirection;
}

/**
 * Hook to get processed (filtered and sorted) nodes
 *
 * Reads nodes from TanStack Query cache and applies:
 * 1. Age filtering (maxNodeAgeHours)
 * 2. Text search filtering
 * 3. Advanced filters (MQTT, telemetry, position, etc.)
 * 4. Sorting (favorites first, then by selected field)
 *
 * @param options - Optional overrides for filter/sort settings
 * @returns Processed nodes array and loading state
 */
export function useProcessedNodes(options: UseProcessedNodesOptions = {}) {
  // Get nodes from TanStack Query cache
  const { nodes, isLoading } = useNodes();

  // Get telemetry availability
  const { nodesWithTelemetry, nodesWithWeather, nodesWithPKC } = useTelemetryNodes();

  // Get UI filters
  const { nodeFilter: uiNodeFilter } = useUI();

  // Get settings
  const { maxNodeAgeHours: settingsMaxAge, preferredSortField, preferredSortDirection } = useSettings();

  // Allow overrides from options
  const nodeFilters = options.nodeFilters ?? DEFAULT_NODE_FILTERS;
  const textFilter = options.textFilter ?? uiNodeFilter;
  const maxNodeAgeHours = options.maxNodeAgeHours ?? settingsMaxAge;
  const sortField = options.sortField ?? preferredSortField;
  const sortDirection = options.sortDirection ?? preferredSortDirection;

  // Process nodes with memoization
  const processedNodes = useMemo((): DeviceInfo[] => {
    const cutoffTime = Date.now() / 1000 - maxNodeAgeHours * 60 * 60;

    // Step 1: Age filter
    const ageFiltered = nodes.filter(node => {
      if (!node.lastHeard) return false;
      return node.lastHeard >= cutoffTime;
    });

    // Step 2: Text filter
    const textFiltered = filterNodesByText(ageFiltered, textFilter);

    // Step 3: Advanced filters
    const advancedFiltered = textFiltered.filter(node => {
      const nodeId = node.user?.id;
      const isShowMode = nodeFilters.filterMode === 'show';

      // MQTT filter
      if (nodeFilters.showMqtt) {
        const matches = node.viaMqtt;
        if (isShowMode && !matches) return false;
        if (!isShowMode && matches) return false;
      }

      // Telemetry filter
      if (nodeFilters.showTelemetry) {
        const matches = nodeId && nodesWithTelemetry.has(nodeId);
        if (isShowMode && !matches) return false;
        if (!isShowMode && matches) return false;
      }

      // Environment metrics filter
      if (nodeFilters.showEnvironment) {
        const matches = nodeId && nodesWithWeather.has(nodeId);
        if (isShowMode && !matches) return false;
        if (!isShowMode && matches) return false;
      }

      // Power source filter
      const batteryLevel = node.deviceMetrics?.batteryLevel;
      if (nodeFilters.powerSource !== 'both' && batteryLevel !== undefined) {
        const isPowered = batteryLevel === 101;
        if (nodeFilters.powerSource === 'powered' && !isPowered) {
          return false;
        }
        if (nodeFilters.powerSource === 'battery' && isPowered) {
          return false;
        }
      }

      // Position filter
      if (nodeFilters.showPosition) {
        const hasPosition = node.position && node.position.latitude != null && node.position.longitude != null;
        const matches = hasPosition;
        if (isShowMode && !matches) return false;
        if (!isShowMode && matches) return false;
      }

      // Hops filter (always applies regardless of mode)
      if (node.hopsAway != null) {
        if (node.hopsAway < nodeFilters.minHops || node.hopsAway > nodeFilters.maxHops) {
          return false;
        }
      }

      // PKI filter
      if (nodeFilters.showPKI) {
        const matches = nodeId && nodesWithPKC.has(nodeId);
        if (isShowMode && !matches) return false;
        if (!isShowMode && matches) return false;
      }

      // Unknown nodes filter
      if (nodeFilters.showUnknown) {
        const hasLongName = node.user?.longName && node.user.longName.trim() !== '';
        const hasShortName = node.user?.shortName && node.user.shortName.trim() !== '';
        const isUnknown = !hasLongName && !hasShortName;
        const matches = isUnknown;
        if (isShowMode && !matches) return false;
        if (!isShowMode && matches) return false;
      }

      // Device role filter
      if (nodeFilters.deviceRoles.length > 0) {
        const role = typeof node.user?.role === 'number' ? node.user.role : parseInt(node.user?.role || '0');
        const matches = nodeFilters.deviceRoles.includes(role);
        if (isShowMode && !matches) return false;
        if (!isShowMode && matches) return false;
      }

      // Channel filter
      if (nodeFilters.channels.length > 0) {
        const nodeChannel = node.channel ?? -1;
        const matches = nodeFilters.channels.includes(nodeChannel);
        if (isShowMode && !matches) return false;
        if (!isShowMode && matches) return false;
      }

      return true;
    });

    // Step 4: Sort with favorites first
    const favorites = advancedFiltered.filter(node => node.isFavorite);
    const nonFavorites = advancedFiltered.filter(node => !node.isFavorite);

    const sortedFavorites = sortNodes(favorites, sortField, sortDirection);
    const sortedNonFavorites = sortNodes(nonFavorites, sortField, sortDirection);

    return [...sortedFavorites, ...sortedNonFavorites];
  }, [
    nodes,
    maxNodeAgeHours,
    textFilter,
    sortField,
    sortDirection,
    nodeFilters,
    nodesWithTelemetry,
    nodesWithWeather,
    nodesWithPKC,
  ]);

  return {
    processedNodes,
    isLoading,
    /** Total unfiltered node count */
    totalNodes: nodes.length,
  };
}
