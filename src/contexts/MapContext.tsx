import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { DbTraceroute, DbNeighborInfo } from '../services/database';

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
  animatedNodes: Set<string>;
  triggerNodeAnimation: (nodeId: string) => void;
  mapCenterTarget: [number, number] | null;
  setMapCenterTarget: (target: [number, number] | null) => void;
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
}

const MapContext = createContext<MapContextType | undefined>(undefined);

interface MapProviderProps {
  children: ReactNode;
}

export const MapProvider: React.FC<MapProviderProps> = ({ children }) => {
  const [showPaths, setShowPaths] = useState<boolean>(false);
  const [showNeighborInfo, setShowNeighborInfo] = useState<boolean>(false);
  const [showRoute, setShowRoute] = useState<boolean>(true);
  const [showMotion, setShowMotion] = useState<boolean>(true);
  const [showMqttNodes, setShowMqttNodes] = useState<boolean>(true);
  const [showAnimations, setShowAnimations] = useState<boolean>(() => {
    const saved = localStorage.getItem('showAnimations');
    return saved === 'true';
  });
  const [animatedNodes, setAnimatedNodes] = useState<Set<string>>(new Set());
  const [mapCenterTarget, setMapCenterTarget] = useState<[number, number] | null>(null);
  const [mapZoom, setMapZoom] = useState<number>(10);
  const [traceroutes, setTraceroutes] = useState<DbTraceroute[]>([]);
  const [neighborInfo, setNeighborInfo] = useState<EnrichedNeighborInfo[]>([]);
  const [positionHistory, setPositionHistory] = useState<PositionHistoryItem[]>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  // Persist showAnimations to localStorage
  useEffect(() => {
    localStorage.setItem('showAnimations', showAnimations.toString());
  }, [showAnimations]);

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
        animatedNodes,
        triggerNodeAnimation,
        mapCenterTarget,
        setMapCenterTarget,
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
