import React, { createContext, useContext, useState, useEffect, useMemo, ReactNode, useRef } from 'react';
import { DbTraceroute, DbNeighborInfo } from '../services/database';
import api from '../services/api';
import { useCsrf } from './CsrfContext';

export interface PositionHistoryItem {
  latitude: number;
  longitude: number;
  timestamp: number;
  altitude?: number;
  groundSpeed?: number;   // km/h (firmware emits ground_speed via TinyGPS++ .kmph(); see #3797)
  groundTrack?: number;   // degrees (0-360, 0=North)
  // Receive metadata of the packet this fix arrived in (#3492). Only present
  // for fixes received after migration 089. SNR is only meaningful when the
  // fix was heard directly (hopStart === hopLimit, i.e. 0 hops).
  snr?: number;
  hopStart?: number;
  hopLimit?: number;
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
  bidirectional?: boolean;
  transportClass?: 'rf' | 'udp' | 'mqtt';
}

// MeshCore node for map display
export interface MeshCoreMapNode {
  publicKey: string;
  name: string;
  latitude: number;
  longitude: number;
  rssi?: number;
  snr?: number;
  lastSeen?: number;
  advType?: number;
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
  showUdpNodes: boolean;
  setShowUdpNodes: (show: boolean) => void;
  showRfNodes: boolean;
  setShowRfNodes: (show: boolean) => void;
  showMeshCoreNodes: boolean;
  setShowMeshCoreNodes: (show: boolean) => void;
  showWaypoints: boolean;
  setShowWaypoints: (show: boolean) => void;
  // Position history: render points only (no connecting line) — issue #3492
  positionHistoryPointsOnly: boolean;
  setPositionHistoryPointsOnly: (value: boolean) => void;
  showAnimations: boolean;
  setShowAnimations: (show: boolean) => void;
  showEstimatedPositions: boolean;
  setShowEstimatedPositions: (show: boolean) => void;
  showAccuracyRegions: boolean;
  setShowAccuracyRegions: (show: boolean) => void;
  showPolarGrid: boolean;
  setShowPolarGrid: (show: boolean) => void;
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
  // Map Features "maximum age" slider (#3322). null = follow the global
  // maxNodeAgeHours setting (slider sits at max). A concrete value hides node
  // markers, traceroutes, and route segments older than this many hours.
  mapMaxAgeHours: number | null;
  setMapMaxAgeHours: (hours: number | null) => void;
  meshCoreNodes: MeshCoreMapNode[];
  setMeshCoreNodes: (nodes: MeshCoreMapNode[]) => void;
}

const MapContext = createContext<MapContextType | undefined>(undefined);

interface MapProviderProps {
  children: ReactNode;
}

export const MapProvider: React.FC<MapProviderProps> = ({ children }) => {
  const { getToken: getCsrfToken, refreshToken: refreshCsrfToken } = useCsrf();

  // Initialize with defaults (will be overridden by server preferences when loaded)
  const [showPaths, setShowPathsState] = useState<boolean>(false);
  const [showNeighborInfo, setShowNeighborInfoState] = useState<boolean>(false);
  const [showRoute, setShowRouteState] = useState<boolean>(true);
  const [showMotion, setShowMotionState] = useState<boolean>(true);
  const [showMqttNodes, setShowMqttNodesState] = useState<boolean>(false);
  // Show UDP / RF defaults per #3112: RF on, UDP off, MQTT off. RF is the
  // common case; UDP and MQTT are opt-in classes so users with a busy
  // MQTT bridge or UDP multicast feed don't get a saturated map by default.
  const [showUdpNodes, setShowUdpNodesState] = useState<boolean>(false);
  const [showRfNodes, setShowRfNodesState] = useState<boolean>(true);
  const [showMeshCoreNodes, setShowMeshCoreNodesState] = useState<boolean>(true);
  // Waypoint markers default on (#3253) — opt-out toggle in the Map Features panel.
  const [showWaypoints, setShowWaypointsState] = useState<boolean>(true);
  const [positionHistoryPointsOnly, setPositionHistoryPointsOnlyState] = useState<boolean>(false);
  const [showAnimations, setShowAnimationsState] = useState<boolean>(false);
  const [meshCoreNodes, setMeshCoreNodes] = useState<MeshCoreMapNode[]>([]);
  const [showEstimatedPositions, setShowEstimatedPositionsState] = useState<boolean>(() => {
    const saved = localStorage.getItem('showEstimatedPositions');
    return saved !== null ? saved === 'true' : true; // Default to true
  });
  const [showAccuracyRegions, setShowAccuracyRegionsState] = useState<boolean>(false);
  const [showPolarGrid, setShowPolarGridState] = useState<boolean>(false);
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
  const [mapMaxAgeHours, setMapMaxAgeHoursState] = useState<number | null>(null);
  // Create wrapper setters that persist to server (no localStorage)
  const setShowPaths = React.useCallback((value: boolean) => {
    setShowPathsState(value);
    // Save to server (fire and forget)
    void savePreferenceToServer({ showPaths: value });
  }, []);

  const setShowNeighborInfo = React.useCallback((value: boolean) => {
    setShowNeighborInfoState(value);
    void savePreferenceToServer({ showNeighborInfo: value });
  }, []);

  const setShowRoute = React.useCallback((value: boolean) => {
    setShowRouteState(value);
    void savePreferenceToServer({ showRoute: value });
  }, []);

  const setShowMotion = React.useCallback((value: boolean) => {
    setShowMotionState(value);
    void savePreferenceToServer({ showMotion: value });
  }, []);

  const setShowMqttNodes = React.useCallback((value: boolean) => {
    setShowMqttNodesState(value);
    void savePreferenceToServer({ showMqttNodes: value });
  }, []);

  const setShowUdpNodes = React.useCallback((value: boolean) => {
    setShowUdpNodesState(value);
    void savePreferenceToServer({ showUdpNodes: value });
  }, []);

  const setShowRfNodes = React.useCallback((value: boolean) => {
    setShowRfNodesState(value);
    void savePreferenceToServer({ showRfNodes: value });
  }, []);

  const setShowMeshCoreNodes = React.useCallback((value: boolean) => {
    setShowMeshCoreNodesState(value);
    void savePreferenceToServer({ showMeshCoreNodes: value });
  }, []);

  const setShowWaypoints = React.useCallback((value: boolean) => {
    setShowWaypointsState(value);
    void savePreferenceToServer({ showWaypoints: value });
  }, []);

  const setPositionHistoryPointsOnly = React.useCallback((value: boolean) => {
    setPositionHistoryPointsOnlyState(value);
    void savePreferenceToServer({ positionHistoryPointsOnly: value });
  }, []);

  const setShowAnimations = React.useCallback((value: boolean) => {
    setShowAnimationsState(value);
    void savePreferenceToServer({ showAnimations: value });
  }, []);

  const setShowEstimatedPositions = React.useCallback((value: boolean) => {
    setShowEstimatedPositionsState(value);
    localStorage.setItem('showEstimatedPositions', value.toString());
    void savePreferenceToServer({ showEstimatedPositions: value });
  }, []);

  const setShowAccuracyRegions = React.useCallback((value: boolean) => {
    setShowAccuracyRegionsState(value);
    void savePreferenceToServer({ showAccuracyRegions: value });
  }, []);

  const setShowPolarGrid = React.useCallback((value: boolean) => {
    setShowPolarGridState(value);
    void savePreferenceToServer({ showPolarGrid: value });
  }, []);

  // Helper function to save preference to server
  const savePreferenceToServer = React.useCallback(async (preference: Record<string, boolean | number | null>, isRetry = false) => {
    try {
      const baseUrl = await api.getBaseUrl();
      const csrfToken = getCsrfToken();

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

      if (!response.ok) {
        // On CSRF failure, refresh token and retry once
        if (response.status === 403 && !isRetry) {
          const error = await response.json().catch(() => ({ error: '' }));
          if (error.error && error.error.toLowerCase().includes('csrf')) {
            console.warn('[MapContext] CSRF error - refreshing token and retrying...');
            sessionStorage.removeItem('csrfToken');
            await refreshCsrfToken();
            return savePreferenceToServer(preference, true);
          }
        }
        const errorText = await response.text();
        console.error('[MapContext] Save failed:', errorText);
      }
    } catch (error) {
      console.error('[MapContext] Failed to save map preference to server:', error);
    }
  }, [getCsrfToken, refreshCsrfToken]);

  // Create wrapper setter for positionHistoryHours that persists to server with debouncing
  const positionHistoryDebounceRef = useRef<NodeJS.Timeout | null>(null);
  const setPositionHistoryHours = React.useCallback((value: number | null) => {
    setPositionHistoryHoursState(value);
    // Debounce server save to avoid excessive API calls during slider dragging
    if (positionHistoryDebounceRef.current) {
      clearTimeout(positionHistoryDebounceRef.current);
    }
    positionHistoryDebounceRef.current = setTimeout(() => {
      void savePreferenceToServer({ positionHistoryHours: value });
    }, 500);
  }, [savePreferenceToServer]);

  // Create wrapper setter for mapMaxAgeHours that persists to server with debouncing
  const mapMaxAgeDebounceRef = useRef<NodeJS.Timeout | null>(null);
  const setMapMaxAgeHours = React.useCallback((value: number | null) => {
    setMapMaxAgeHoursState(value);
    if (mapMaxAgeDebounceRef.current) {
      clearTimeout(mapMaxAgeDebounceRef.current);
    }
    mapMaxAgeDebounceRef.current = setTimeout(() => {
      void savePreferenceToServer({ mapMaxAgeHours: value });
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
            if (preferences.showUdpNodes !== undefined) {
              setShowUdpNodesState(preferences.showUdpNodes);
            }
            if (preferences.showRfNodes !== undefined) {
              setShowRfNodesState(preferences.showRfNodes);
            }
            if (preferences.showMeshCoreNodes !== undefined) {
              setShowMeshCoreNodesState(preferences.showMeshCoreNodes);
            }
            if (preferences.showWaypoints !== undefined) {
              setShowWaypointsState(preferences.showWaypoints);
            }
            if (preferences.positionHistoryPointsOnly !== undefined) {
              setPositionHistoryPointsOnlyState(preferences.positionHistoryPointsOnly);
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
            if (preferences.showPolarGrid !== undefined) {
              setShowPolarGridState(preferences.showPolarGrid);
            }
            if (preferences.positionHistoryHours !== undefined) {
              setPositionHistoryHoursState(preferences.positionHistoryHours);
            }
            if (preferences.mapMaxAgeHours !== undefined) {
              setMapMaxAgeHoursState(preferences.mapMaxAgeHours);
            }
          }
          // If preferences is null (anonymous user), initial defaults are already set
        }
      } catch (error) {
        console.debug('Failed to load map preferences from server:', error);
        // Fall back to localStorage values (already loaded in initial state)
      }
    };

    void loadServerPreferences();
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

  const value = useMemo<MapContextType>(() => ({
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
    showUdpNodes,
    setShowUdpNodes,
    showRfNodes,
    setShowRfNodes,
    showMeshCoreNodes,
    setShowMeshCoreNodes,
    showWaypoints,
    positionHistoryPointsOnly,
    setPositionHistoryPointsOnly,
    setShowWaypoints,
    meshCoreNodes,
    setMeshCoreNodes,
    showAnimations,
    setShowAnimations,
    showEstimatedPositions,
    setShowEstimatedPositions,
    showAccuracyRegions,
    setShowAccuracyRegions,
    showPolarGrid,
    setShowPolarGrid,
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
    mapMaxAgeHours,
    setMapMaxAgeHours,
  }), [
    showPaths, setShowPaths,
    showNeighborInfo, setShowNeighborInfo,
    showRoute, setShowRoute,
    showMotion, setShowMotion,
    showMqttNodes, setShowMqttNodes,
    showUdpNodes, setShowUdpNodes,
    showRfNodes, setShowRfNodes,
    showMeshCoreNodes, setShowMeshCoreNodes,
    showWaypoints, setShowWaypoints,
    positionHistoryPointsOnly, setPositionHistoryPointsOnly,
    meshCoreNodes, setMeshCoreNodes,
    showAnimations, setShowAnimations,
    showEstimatedPositions, setShowEstimatedPositions,
    showAccuracyRegions, setShowAccuracyRegions,
    showPolarGrid, setShowPolarGrid,
    animatedNodes, triggerNodeAnimation,
    mapCenterTarget, setMapCenterTarget,
    mapCenter, setMapCenter,
    mapZoom, setMapZoom,
    traceroutes, setTraceroutes,
    neighborInfo, setNeighborInfo,
    positionHistory, setPositionHistory,
    selectedNodeId, setSelectedNodeId,
    positionHistoryHours, setPositionHistoryHours,
    mapMaxAgeHours, setMapMaxAgeHours,
  ]);

  return (
    <MapContext.Provider value={value}>
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
