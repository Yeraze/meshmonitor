import { useState, useMemo, useCallback } from 'react';
import { getTelemetryLabel } from '../../TelemetryChart';
import { logger } from '../../../utils/logger';
import { type SortOption, type FavoriteChart, type NodeInfo } from '../types';
import { type DashboardDataSource, meshtasticDashboardSource } from '../dataSources';

interface UseDashboardFiltersOptions {
  favorites: FavoriteChart[];
  nodes: Map<string, NodeInfo>;
  customOrder: string[];
  favoriteTelemetryStorageDays: number;
  defaultSortOption?: SortOption;
  /**
   * Source adapter — provides display-name and role-label resolution so
   * the filter/sort logic works equally for Meshtastic and MeshCore nodes.
   * Defaults to the Meshtastic adapter so any legacy caller keeps prior
   * behaviour.
   */
  dataSource?: DashboardDataSource;
}

interface UseDashboardFiltersResult {
  // Filter state
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  selectedNode: string;
  setSelectedNode: (nodeId: string) => void;
  selectedType: string;
  setSelectedType: (type: string) => void;
  selectedRoles: Set<string>;
  sortOption: SortOption;
  setSortOption: (option: SortOption) => void;
  daysToView: number;
  setDaysToView: (days: number) => void;

  // Role dropdown
  roleDropdownOpen: boolean;
  handleToggleRoleDropdown: () => void;
  handleClearRoleFilter: () => void;
  handleToggleRole: (role: string, checked: boolean) => void;

  // Computed values
  filteredAndSortedFavorites: FavoriteChart[];
  uniqueNodes: Array<[string, string]>;
  uniqueTelemetryTypes: string[];
  uniqueDeviceRoles: string[];
}

/**
 * Hook for managing dashboard filter and sort state
 */
export function useDashboardFilters({
  favorites,
  nodes,
  customOrder,
  favoriteTelemetryStorageDays,
  defaultSortOption = 'custom',
  dataSource = meshtasticDashboardSource,
}: UseDashboardFiltersOptions): UseDashboardFiltersResult {
  // Days to view control
  const [daysToView, setDaysToViewState] = useState<number>(() => {
    try {
      const savedDaysToView = localStorage.getItem('telemetryDaysToView');
      if (savedDaysToView) {
        const parsed = parseInt(savedDaysToView);
        return Math.min(favoriteTelemetryStorageDays, Math.max(1, parsed));
      }
    } catch (error) {
      logger.error('Error loading days to view from Local Storage:', error);
    }
    return favoriteTelemetryStorageDays;
  });

  // Filter and sort state
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [selectedNode, setSelectedNode] = useState<string>('all');
  const [selectedType, setSelectedType] = useState<string>('all');
  const [selectedRoles, setSelectedRoles] = useState<Set<string>>(new Set());
  const [roleDropdownOpen, setRoleDropdownOpen] = useState<boolean>(false);
  const [sortOption, setSortOption] = useState<SortOption>(defaultSortOption);

  // Persist daysToView to localStorage
  const setDaysToView = useCallback((days: number) => {
    const clampedDays = Math.min(favoriteTelemetryStorageDays, Math.max(1, days));
    setDaysToViewState(clampedDays);
    try {
      localStorage.setItem('telemetryDaysToView', clampedDays.toString());
    } catch (error) {
      logger.error('Error saving days to view to Local Storage:', error);
    }
  }, [favoriteTelemetryStorageDays]);

  // Role dropdown handlers
  const handleToggleRoleDropdown = useCallback(() => {
    setRoleDropdownOpen(prev => !prev);
  }, []);

  const handleClearRoleFilter = useCallback(() => {
    setSelectedRoles(new Set());
  }, []);

  const handleToggleRole = useCallback((role: string, checked: boolean) => {
    setSelectedRoles(prev => {
      const newRoles = new Set(prev);
      if (checked) {
        newRoles.add(role);
      } else {
        newRoles.delete(role);
      }
      return newRoles;
    });
  }, []);

  // Get unique nodes for filter dropdown
  const uniqueNodes = useMemo(() => {
    const nodesMap = new Map<string, string>();
    favorites.forEach(fav => {
      const node = nodes.get(fav.nodeId);
      nodesMap.set(fav.nodeId, dataSource.getDisplayName(node, fav.nodeId));
    });
    return Array.from(nodesMap.entries()).sort((a, b) => a[1].localeCompare(b[1]));
  }, [favorites, nodes, dataSource]);

  // Get unique telemetry types for filter dropdown
  const uniqueTelemetryTypes = useMemo(() => {
    const types = new Set<string>();
    favorites.forEach(fav => types.add(fav.telemetryType));
    return Array.from(types).sort();
  }, [favorites]);

  // Get unique device roles for filter dropdown
  const uniqueDeviceRoles = useMemo(() => {
    const roles = new Map<string, string>();
    favorites.forEach(fav => {
      const node = nodes.get(fav.nodeId);
      const roleName = dataSource.getRoleName(node);
      if (roleName) {
        roles.set(roleName, roleName);
      }
    });
    return Array.from(roles.values()).sort();
  }, [favorites, nodes, dataSource]);

  // Filter and sort favorites
  const filteredAndSortedFavorites = useMemo(() => {
    let result = [...favorites];

    // Apply filters
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      result = result.filter(fav => {
        const node = nodes.get(fav.nodeId);
        const nodeName = dataSource.getDisplayName(node, fav.nodeId).toLowerCase();
        const typeName = getTelemetryLabel(fav.telemetryType).toLowerCase();
        return nodeName.includes(query) || typeName.includes(query);
      });
    }

    if (selectedNode !== 'all') {
      result = result.filter(fav => fav.nodeId === selectedNode);
    }

    if (selectedType !== 'all') {
      result = result.filter(fav => fav.telemetryType === selectedType);
    }

    if (selectedRoles.size > 0) {
      result = result.filter(fav => {
        const node = nodes.get(fav.nodeId);
        const roleName = dataSource.getRoleName(node);
        if (!roleName) return false;
        return selectedRoles.has(roleName);
      });
    }

    // Apply sorting
    if (sortOption === 'custom' && customOrder.length > 0) {
      result.sort((a, b) => {
        const keyA = `${a.nodeId}-${a.telemetryType}`;
        const keyB = `${b.nodeId}-${b.telemetryType}`;
        const indexA = customOrder.indexOf(keyA);
        const indexB = customOrder.indexOf(keyB);
        if (indexA === -1 && indexB === -1) return 0;
        if (indexA === -1) return 1;
        if (indexB === -1) return -1;
        return indexA - indexB;
      });
    } else if (sortOption === 'node-asc') {
      result.sort((a, b) => {
        const nameA = dataSource.getDisplayName(nodes.get(a.nodeId), a.nodeId).toLowerCase();
        const nameB = dataSource.getDisplayName(nodes.get(b.nodeId), b.nodeId).toLowerCase();
        return nameA.localeCompare(nameB);
      });
    } else if (sortOption === 'node-desc') {
      result.sort((a, b) => {
        const nameA = dataSource.getDisplayName(nodes.get(a.nodeId), a.nodeId).toLowerCase();
        const nameB = dataSource.getDisplayName(nodes.get(b.nodeId), b.nodeId).toLowerCase();
        return nameB.localeCompare(nameA);
      });
    } else if (sortOption === 'type-asc') {
      result.sort((a, b) => getTelemetryLabel(a.telemetryType).localeCompare(getTelemetryLabel(b.telemetryType)));
    } else if (sortOption === 'type-desc') {
      result.sort((a, b) => getTelemetryLabel(b.telemetryType).localeCompare(getTelemetryLabel(a.telemetryType)));
    }

    return result;
  }, [favorites, nodes, searchQuery, selectedNode, selectedType, selectedRoles, sortOption, customOrder, dataSource]);

  return {
    searchQuery,
    setSearchQuery,
    selectedNode,
    setSelectedNode,
    selectedType,
    setSelectedType,
    selectedRoles,
    sortOption,
    setSortOption,
    daysToView,
    setDaysToView,
    roleDropdownOpen,
    handleToggleRoleDropdown,
    handleClearRoleFilter,
    handleToggleRole,
    filteredAndSortedFavorites,
    uniqueNodes,
    uniqueTelemetryTypes,
    uniqueDeviceRoles,
  };
}
