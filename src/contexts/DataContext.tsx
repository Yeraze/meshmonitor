import React, { createContext, useContext, useState, useMemo, ReactNode } from 'react';
import { DeviceInfo, Channel } from '../types/device';
import { ConnectionStatus } from '../types/ui';

// messages/channelMessages (+ their channelHasMore/channelLoadingMore/
// dmHasMore/dmLoadingMore pagination state) were removed (#3962 5.4 PR7).
// They were never pure poll-cache mirrors — the optimistic-send merge and
// infinite-scroll pagination logic they need moved to `useMessagingView`
// (src/hooks/useMessagingView.ts), which now owns this state itself instead
// of prop-drilling it through DataContext.
interface DataContextType {
  nodes: DeviceInfo[];
  setNodes: React.Dispatch<React.SetStateAction<DeviceInfo[]>>;
  channels: Channel[];
  setChannels: React.Dispatch<React.SetStateAction<Channel[]>>;
  connectionStatus: ConnectionStatus;
  setConnectionStatus: React.Dispatch<React.SetStateAction<ConnectionStatus>>;
  deviceInfo: any;
  setDeviceInfo: React.Dispatch<React.SetStateAction<any>>;
  deviceConfig: any;
  setDeviceConfig: React.Dispatch<React.SetStateAction<any>>;
  currentNodeId: string;
  setCurrentNodeId: React.Dispatch<React.SetStateAction<string>>;
  nodeAddress: string;
  setNodeAddress: React.Dispatch<React.SetStateAction<string>>;
}

const DataContext = createContext<DataContextType | undefined>(undefined);

interface DataProviderProps {
  children: ReactNode;
}

export const DataProvider: React.FC<DataProviderProps> = ({ children }) => {
  const [nodes, setNodes] = useState<DeviceInfo[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('disconnected');
  const [deviceInfo, setDeviceInfo] = useState<any>(null);
  const [deviceConfig, setDeviceConfig] = useState<any>(null);
  const [currentNodeId, setCurrentNodeId] = useState<string>('');
  // Starts empty (not a 'Loading...' placeholder): the connection-status string
  // interpolates nodeAddress, and the literal 'Loading...' must never leak into
  // "Connecting to …" before the real per-source address is resolved (#3611).
  const [nodeAddress, setNodeAddress] = useState<string>('');

  const value = useMemo<DataContextType>(() => ({
    nodes,
    setNodes,
    channels,
    setChannels,
    connectionStatus,
    setConnectionStatus,
    deviceInfo,
    setDeviceInfo,
    deviceConfig,
    setDeviceConfig,
    currentNodeId,
    setCurrentNodeId,
    nodeAddress,
    setNodeAddress,
  }), [
    nodes, setNodes,
    channels, setChannels,
    connectionStatus, setConnectionStatus,
    deviceInfo, setDeviceInfo,
    deviceConfig, setDeviceConfig,
    currentNodeId, setCurrentNodeId,
    nodeAddress, setNodeAddress,
  ]);

  return (
    <DataContext.Provider value={value}>
      {children}
    </DataContext.Provider>
  );
};

export const useData = () => {
  const context = useContext(DataContext);
  if (context === undefined) {
    throw new Error('useData must be used within a DataProvider');
  }
  return context;
};
