import React, { createContext, useContext, useState, useEffect, ReactNode, useRef } from 'react';
import { DbTraceroute, DbNeighborInfo } from '../services/database';
import api from '../services/api';
import { useCsrf } from './CsrfContext';

export interface PositionHistoryItem {
  latitude: number;
  longitude: number;
  timestamp: number;
}

export interface EnrichedNeighborInfo extends DbNeighborInfo {
  nodeId?: string;
  nodeName?: string;
  neighborNodeId?: string;
  neighborName?: string;
  nodeLatitude?: number;
  nodeLongitude?: number;
  neighborLatitude?: number;
  neighborLongitude?: number;
}

interface MapContextType {
  showPaths: boolean;
  setShowPaths: (show: boolean) => void;
  showNeighborInfo: boolean;
  setShowNeighborInfo: (show: boolean) => void;
  showRoute: boolean;
  setShowRoute: (show: boolean) => void;
  showMotion: boolean;
  setShowMotion: (show: boolean) => void;
  showMqttNodes: boolean;
  setShowMqttNodes: (show: boolean) => void;
  showAnimations: boolean;
  setShowAnimations: (show: boolean) => void;
  showEstimatedPositions: boolean;
  setShowEstimatedPositions: (show: boolean) => void;
  showAccuracyRegions: boolean;
  setShowAccuracyRegions: (show: boolean) => void;
  animatedNodes: Set<string>;
  triggerNodeAnimation: (nodeId: string) => void;
  mapCenterTarget: [number, number] | null;
  setMapCenterTarget: (target: [number, number] | null) => void;
  mapCenter: [number, number] | null;
  setMapCenter: (center: [number, number] | null) => void;
  mapZoom: number;
  setMapZoom: (zoom: number) => void;
  traceroutes: DbTraceroute[];
  setTraceroutes: (traceroutes: DbTraceroute[]) => void;
  neighborInfo: EnrichedNeighborInfo[];
  setNeighborInfo: (info: EnrichedNeighborInfo[]) => void;
  positionHistory: PositionHistoryItem[];
  setPositionHistory: (history: PositionHistoryItem[]) => void;
  selectedNodeId: string | null;
  setSelectedNodeId: (id: string | null) => void;
  positionHistoryHours: number | null;
  setPositionHistoryHours: (hours: number | null) => void;
}

const MapContext = createContext<MapContextType | undefined>(undefined);

interface MapProviderProps {
  children: ReactNode;
}

export const MapProvider: React.FC<MapProviderProps> = ({ children }) => {
  const { getToken: getCsrfToken } = useCsrf();

  // Initialize with defaults (will be overridden by server preferences when loaded)
  const [showPaths, setShowPathsState] = useState<boolean>(false);
  const [showNeighborInfo, setShowNeighborInfoState] = useState<boolean>(false);
  const [showRoute, setShowRouteState] = useState<boolean>(true);
  const [showMotion, setShowMotionState] = useState<boolean>(true);
  const [showMqttNodes, setShowMqttNodesState] = useState<boolean>(true);
  const [showAnimations, setShowAnimationsState] = useState<boolean>(false);
  const [showEstimatedPositions, setShowEstimatedPositionsState] = useState<boolean>(() => {
    const saved = localStorage.getItem('showEstimatedPositions');
    return saved !== null ? saved === 'true' : true; // Default to true
  });
  const [showAccuracyRegions, setShowAccuracyRegionsState] = useState<boolean>(false);
  const [animatedNodes, setAnimatedNodes] = useState<Set<string>>(new Set());
  const [mapCenterTarget, setMapCenterTarget] = useState<[number, number] | null>(null);
  const [mapCenter, setMapCenter] = useState<[number, number] | null>(() => {
    const saved = localStorage.getItem('mapCenter');
    if (saved) {
      try {
        return JSON.parse(saved);
      } catch {
        return null;
      }
    }
    return null;
  });
  const [mapZoom, setMapZoom] = useState<number>(() => {
    const saved = localStorage.getItem('mapZoom');
    if (saved) {
      const zoom = parseFloat(saved);
      if (!isNaN(zoom)) {
        return zoom;
      }
    }
    return 13; // Default zoom level for initial view (city/neighborhood level)
  });
  const [traceroutes, setTraceroutes] = useState<DbTraceroute[]>([]);
  const [neighborInfo, setNeighborInfo] = useState<EnrichedNeighborInfo[]>([]);
  const [positionHistory, setPositionHistory] = useState<PositionHistoryItem[]>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [positionHistoryHours, setPositionHistoryHoursState] = useState<number | null>(null);

  // Create wrapper setters that persist to server (no localStorage)
  const setShowPaths = React.useCallback((value: boolean) => {
    setShowPathsState(value);
    // Save to server (fire and forget)
    savePreferenceToServer({ showPaths: value });
  }, []);

  const setShowNeighborInfo = React.useCallback((value: boolean) => {
    setShowNeighborInfoState(value);
    savePreferenceToServer({ showNeighborInfo: value });
  }, []);

  const setShowRoute = React.useCallback((value: boolean) => {
    setShowRouteState(value);
    savePreferenceToServer({ showRoute: value });
  }, []);

  const setShowMotion = React.useCallback((value: boolean) => {
    setShowMotionState(value);
    savePreferenceToServer({ showMotion: value });
  }, []);

  const setShowMqttNodes = React.useCallback((value: boolean) => {
    setShowMqttNodesState(value);
    savePreferenceToServer({ showMqttNodes: value });
  }, []);

  const setShowAnimations = React.useCallback((value: boolean) => {
    setShowAnimationsState(value);
    savePreferenceToServer({ showAnimations: value });
  }, []);

  const setShowEstimatedPositions = React.useCallback((value: boolean) => {
    setShowEstimatedPositionsState(value);
    localStorage.setItem('showEstimatedPositions', value.toString());
    savePreferenceToServer({ showEstimatedPositions: value });
  }, []);

  const setShowAccuracyRegions = React.useCallback((value: boolean) => {
    setShowAccuracyRegionsState(value);
    savePreferenceToServer({ showAccuracyRegions: value });
  }, []);

  // Helper function to save preference to server
  const savePreferenceToServer = React.useCallback(async (preference: Record<string, boolean | number | null>) => {
    try {
      const baseUrl = await api.getBaseUrl();
      const csrfToken = getCsrfToken();
      console.log('[MapContext] Saving preference to server:', preference);
      console.log('[MapContext] CSRF token:', csrfToken ? 'present' : 'MISSING');
      console.log('[MapContext] Base URL:', baseUrl);

      const headers: HeadersInit = { 'Content-Type': 'application/json' };

      if (csrfToken) {
        headers['X-CSRF-Token'] = csrfToken;
      }

      const response = await fetch(`${baseUrl}/api/user/map-preferences`, {
        method: 'POST',
        headers,
        credentials: 'include',
        body: JSON.stringify(preference)
      });

      console.log('[MapContext] Save response status:', response.status);
      if (!response.ok) {
        const errorText = await response.text();
        console.error('[MapContext] Save failed:', errorText);
      }
    } catch (error) {
      // Silently fail - localStorage will still work
      console.error('[MapContext] Failed to save map preference to server:', error);
    }
  }, [getCsrfToken]);

  // Create wrapper setter for positionHistoryHours that persists to server with debouncing
  const positionHistoryDebounceRef = useRef<NodeJS.Timeout | null>(null);
  const setPositionHistoryHours = React.useCallback((value: number | null) => {
    setPositionHistoryHoursState(value);
    // Debounce server save to avoid excessive API calls during slider dragging
    if (positionHistoryDebounceRef.current) {
      clearTimeout(positionHistoryDebounceRef.current);
    }
    positionHistoryDebounceRef.current = setTimeout(() => {
      savePreferenceToServer({ positionHistoryHours: value });
    }, 500);
  }, [savePreferenceToServer]);

  // Load preferences from server on mount
  useEffect(() => {
    const loadServerPreferences = async () => {
      try {
        const baseUrl = await api.getBaseUrl();
        const response = await fetch(`${baseUrl}/api/user/map-preferences`, {
          credentials: 'include'
        });

        if (response.ok) {
          const { preferences } = await response.json();

          // If user has saved preferences, use them; otherwise use defaults
          if (preferences) {
            if (preferences.showPaths !== undefined) {
              setShowPathsState(preferences.showPaths);
            }
            if (preferences.showNeighborInfo !== undefined) {
              setShowNeighborInfoState(preferences.showNeighborInfo);
            }
            if (preferences.showRoute !== undefined) {
              setShowRouteState(preferences.showRoute);
            }
            if (preferences.showMotion !== undefined) {
              setShowMotionState(preferences.showMotion);
            }
            if (preferences.showMqttNodes !== undefined) {
              setShowMqttNodesState(preferences.showMqttNodes);
            }
            if (preferences.showAnimations !== undefined) {
              setShowAnimationsState(preferences.showAnimations);
            }
            if (preferences.showEstimatedPositions !== undefined) {
              setShowEstimatedPositionsState(preferences.showEstimatedPositions);
            }
            // Support both old 'showAccuracyCircles' and new 'showAccuracyRegions' for backward compatibility
            if (preferences.showAccuracyRegions !== undefined) {
              setShowAccuracyRegionsState(preferences.showAccuracyRegions);
            } else if (preferences.showAccuracyCircles !== undefined) {
              setShowAccuracyRegionsState(preferences.showAccuracyCircles);
            }
            if (preferences.positionHistoryHours !== undefined) {
              setPositionHistoryHoursState(preferences.positionHistoryHours);
            }
          }
          // If preferences is null (anonymous user), initial defaults are already set
        }
      } catch (error) {
        console.debug('Failed to load map preferences from server:', error);
        // Fall back to localStorage values (already loaded in initial state)
      }
    };

    loadServerPreferences();
  }, []); // Run once on mount

  // Persist map center to localStorage
  useEffect(() => {
    if (mapCenter) {
      localStorage.setItem('mapCenter', JSON.stringify(mapCenter));
    }
  }, [mapCenter]);

  // Persist map zoom to localStorage
  useEffect(() => {
    localStorage.setItem('mapZoom', mapZoom.toString());
  }, [mapZoom]);

  // Trigger animation for a node (lasts 1 second)
  const triggerNodeAnimation = React.useCallback((nodeId: string) => {
    if (!showAnimations) return;

    setAnimatedNodes(prev => new Set([...prev, nodeId]));

    // Remove from animated nodes after 1 second
    setTimeout(() => {
      setAnimatedNodes(prev => {
        const next = new Set(prev);
        next.delete(nodeId);
        return next;
      });
    }, 1000);
  }, [showAnimations]);

  return (
    <MapContext.Provider
      value={{
        showPaths,
        setShowPaths,
        showNeighborInfo,
        setShowNeighborInfo,
        showRoute,
        setShowRoute,
        showMotion,
        setShowMotion,
        showMqttNodes,
        setShowMqttNodes,
        showAnimations,
        setShowAnimations,
        showEstimatedPositions,
        setShowEstimatedPositions,
        showAccuracyRegions,
        setShowAccuracyRegions,
        animatedNodes,
        triggerNodeAnimation,
        mapCenterTarget,
        setMapCenterTarget,
        mapCenter,
        setMapCenter,
        mapZoom,
        setMapZoom,
        traceroutes,
        setTraceroutes,
        neighborInfo,
        setNeighborInfo,
        positionHistory,
        setPositionHistory,
        selectedNodeId,
        setSelectedNodeId,
        positionHistoryHours,
        setPositionHistoryHours,
      }}
    >
      {children}
    </MapContext.Provider>
  );
};

export const useMapContext = () => {
  const context = useContext(MapContext);
  if (context === undefined) {
    throw new Error('useMapContext must be used within a MapProvider');
  }
  return context;
};
