import { useState, useEffect, useCallback, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import api from '../../../services/api';
import { logger } from '../../../utils/logger';
import { type FavoriteChart, type NodeInfo, type CustomWidget } from '../types';

interface UseDashboardDataOptions {
  /** Polling interval in milliseconds (default: 30000) */
  refetchInterval?: number;
  /** Whether queries are enabled (default: true) */
  enabled?: boolean;
}

interface SettingsResponse {
  telemetryFavorites?: string;
  telemetryCustomOrder?: string;
  dashboardWidgets?: string;
  dashboardSolarVisibility?: string;
}

interface UseDashboardDataResult {
  favorites: FavoriteChart[];
  setFavorites: React.Dispatch<React.SetStateAction<FavoriteChart[]>>;
  customOrder: string[];
  setCustomOrder: React.Dispatch<React.SetStateAction<string[]>>;
  nodes: Map<string, NodeInfo>;
  customWidgets: CustomWidget[];
  setCustomWidgets: React.Dispatch<React.SetStateAction<CustomWidget[]>>;
  solarVisibility: Record<string, boolean>;
  setSolarVisibility: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

// Query keys for cache management
export const dashboardQueryKeys = {
  settings: ['dashboard', 'settings'] as const,
  nodes: ['dashboard', 'nodes'] as const,
};

/**
 * Hook for fetching and managing dashboard data (favorites, nodes, widgets)
 * Uses TanStack Query for caching, automatic refetching, and background updates
 */
export function useDashboardData(options?: UseDashboardDataOptions): UseDashboardDataResult {
  const { refetchInterval = 30000, enabled = true } = options ?? {};
  const queryClient = useQueryClient();

  // Local state for user modifications (before saving to server)
  const [localFavorites, setLocalFavorites] = useState<FavoriteChart[] | null>(null);
  const [localCustomOrder, setLocalCustomOrder] = useState<string[] | null>(null);
  const [localCustomWidgets, setLocalCustomWidgets] = useState<CustomWidget[] | null>(null);
  const [localSolarVisibility, setLocalSolarVisibility] = useState<Record<string, boolean> | null>(null);

  // Fetch settings (favorites, custom order, widgets, solar visibility)
  const settingsQuery = useQuery({
    queryKey: dashboardQueryKeys.settings,
    queryFn: async (): Promise<{
      favorites: FavoriteChart[];
      customOrder: string[];
      widgets: CustomWidget[];
      solarVisibility: Record<string, boolean>;
    }> => {
      const settings = await api.get<SettingsResponse>('/api/settings');

      const favoritesArray: FavoriteChart[] = settings.telemetryFavorites
        ? JSON.parse(settings.telemetryFavorites)
        : [];

      const serverCustomOrder: string[] = settings.telemetryCustomOrder
        ? JSON.parse(settings.telemetryCustomOrder)
        : [];

      const widgetsArray: CustomWidget[] = settings.dashboardWidgets
        ? JSON.parse(settings.dashboardWidgets)
        : [];

      const solarVisibilityObj: Record<string, boolean> = settings.dashboardSolarVisibility
        ? JSON.parse(settings.dashboardSolarVisibility)
        : {};

      return {
        favorites: favoritesArray,
        customOrder: serverCustomOrder,
        widgets: widgetsArray,
        solarVisibility: solarVisibilityObj,
      };
    },
    enabled,
    staleTime: 10 * 1000, // 10 seconds
    gcTime: 5 * 60 * 1000, // 5 minutes
    refetchInterval, // Poll every 30 seconds by default
    refetchIntervalInBackground: false, // Don't poll when tab is not visible
  });

  // Fetch nodes
  const nodesQuery = useQuery({
    queryKey: dashboardQueryKeys.nodes,
    queryFn: async (): Promise<Map<string, NodeInfo>> => {
      const nodesData = await api.get<NodeInfo[]>('/api/nodes');
      const nodesMap = new Map<string, NodeInfo>();
      nodesData.forEach((node: NodeInfo) => {
        if (node.user?.id) {
          nodesMap.set(node.user.id, node);
        }
      });
      return nodesMap;
    },
    enabled,
    staleTime: 10 * 1000, // 10 seconds
    gcTime: 5 * 60 * 1000, // 5 minutes
    refetchInterval, // Poll every 30 seconds by default
    refetchIntervalInBackground: false,
  });

  // Initialize custom order from localStorage on first successful fetch
  useEffect(() => {
    if (settingsQuery.data && localCustomOrder === null) {
      let finalCustomOrder: string[] = [];
      try {
        const localStorageOrder = localStorage.getItem('telemetryCustomOrder');
        if (localStorageOrder) {
          const localOrder = JSON.parse(localStorageOrder);
          finalCustomOrder = localOrder.length > 0 ? localOrder : settingsQuery.data.customOrder;
        } else {
          finalCustomOrder = settingsQuery.data.customOrder;
        }
      } catch (err) {
        logger.error('Error loading custom order from Local Storage:', err);
        finalCustomOrder = settingsQuery.data.customOrder;
      }

      setLocalCustomOrder(finalCustomOrder);

      // Save to localStorage
      try {
        localStorage.setItem('telemetryCustomOrder', JSON.stringify(finalCustomOrder));
      } catch (err) {
        logger.error('Error saving custom order to Local Storage:', err);
      }
    }
  }, [settingsQuery.data, localCustomOrder]);

  // Computed values - use local state if available, otherwise server data
  const favorites = useMemo(() => {
    return localFavorites ?? settingsQuery.data?.favorites ?? [];
  }, [localFavorites, settingsQuery.data?.favorites]);

  const customOrder = useMemo(() => {
    return localCustomOrder ?? settingsQuery.data?.customOrder ?? [];
  }, [localCustomOrder, settingsQuery.data?.customOrder]);

  const customWidgets = useMemo(() => {
    return localCustomWidgets ?? settingsQuery.data?.widgets ?? [];
  }, [localCustomWidgets, settingsQuery.data?.widgets]);

  const solarVisibility = useMemo(() => {
    return localSolarVisibility ?? settingsQuery.data?.solarVisibility ?? {};
  }, [localSolarVisibility, settingsQuery.data?.solarVisibility]);

  const nodes = useMemo(() => {
    return nodesQuery.data ?? new Map<string, NodeInfo>();
  }, [nodesQuery.data]);

  // Setters that update local state
  const setFavorites = useCallback((value: React.SetStateAction<FavoriteChart[]>) => {
    setLocalFavorites(prev => {
      const currentValue = prev ?? settingsQuery.data?.favorites ?? [];
      return typeof value === 'function' ? value(currentValue) : value;
    });
  }, [settingsQuery.data?.favorites]);

  const setCustomOrder = useCallback((value: React.SetStateAction<string[]>) => {
    setLocalCustomOrder(prev => {
      const currentValue = prev ?? settingsQuery.data?.customOrder ?? [];
      const newValue = typeof value === 'function' ? value(currentValue) : value;
      // Sync to localStorage
      try {
        localStorage.setItem('telemetryCustomOrder', JSON.stringify(newValue));
      } catch (err) {
        logger.error('Error saving custom order to Local Storage:', err);
      }
      return newValue;
    });
  }, [settingsQuery.data?.customOrder]);

  const setCustomWidgets = useCallback((value: React.SetStateAction<CustomWidget[]>) => {
    setLocalCustomWidgets(prev => {
      const currentValue = prev ?? settingsQuery.data?.widgets ?? [];
      return typeof value === 'function' ? value(currentValue) : value;
    });
  }, [settingsQuery.data?.widgets]);

  const setSolarVisibility = useCallback((value: React.SetStateAction<Record<string, boolean>>) => {
    setLocalSolarVisibility(prev => {
      const currentValue = prev ?? settingsQuery.data?.solarVisibility ?? {};
      return typeof value === 'function' ? value(currentValue) : value;
    });
  }, [settingsQuery.data?.solarVisibility]);

  // Combined loading state - only true on initial load
  const loading = (settingsQuery.isLoading || nodesQuery.isLoading) && !settingsQuery.data;

  // Combined error state
  const error = useMemo(() => {
    if (settingsQuery.error) {
      return settingsQuery.error instanceof Error 
        ? settingsQuery.error.message 
        : 'Failed to load settings';
    }
    if (nodesQuery.error) {
      return nodesQuery.error instanceof Error 
        ? nodesQuery.error.message 
        : 'Failed to load nodes';
    }
    return null;
  }, [settingsQuery.error, nodesQuery.error]);

  // Manual refresh function
  const refresh = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.settings }),
      queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.nodes }),
    ]);
  }, [queryClient]);

  return {
    favorites,
    setFavorites,
    customOrder,
    setCustomOrder,
    nodes,
    customWidgets,
    setCustomWidgets,
    solarVisibility,
    setSolarVisibility,
    loading,
    error,
    refresh,
  };
}
