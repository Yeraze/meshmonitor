import React, { createContext, useContext, useState, useMemo, ReactNode } from 'react';
import { DeviceInfo, Channel } from '../types/device';
import { MeshMessage } from '../types/message';
import { ConnectionStatus } from '../types/ui';

interface DataContextType {
  nodes: DeviceInfo[];
  setNodes: React.Dispatch<React.SetStateAction<DeviceInfo[]>>;
  channels: Channel[];
  setChannels: React.Dispatch<React.SetStateAction<Channel[]>>;
  connectionStatus: ConnectionStatus;
  setConnectionStatus: React.Dispatch<React.SetStateAction<ConnectionStatus>>;
  messages: MeshMessage[];
  setMessages: React.Dispatch<React.SetStateAction<MeshMessage[]>>;
  channelMessages: {[key: number]: MeshMessage[]};
  setChannelMessages: React.Dispatch<React.SetStateAction<{[key: number]: MeshMessage[]}>>;
  deviceInfo: any;
  setDeviceInfo: React.Dispatch<React.SetStateAction<any>>;
  deviceConfig: any;
  setDeviceConfig: React.Dispatch<React.SetStateAction<any>>;
  currentNodeId: string;
  setCurrentNodeId: React.Dispatch<React.SetStateAction<string>>;
  nodeAddress: string;
  setNodeAddress: React.Dispatch<React.SetStateAction<string>>;
  // Pagination state for infinite scroll
  channelHasMore: {[key: number]: boolean};
  setChannelHasMore: React.Dispatch<React.SetStateAction<{[key: number]: boolean}>>;
  channelLoadingMore: {[key: number]: boolean};
  setChannelLoadingMore: React.Dispatch<React.SetStateAction<{[key: number]: boolean}>>;
  dmHasMore: {[key: string]: boolean};
  setDmHasMore: React.Dispatch<React.SetStateAction<{[key: string]: boolean}>>;
  dmLoadingMore: {[key: string]: boolean};
  setDmLoadingMore: React.Dispatch<React.SetStateAction<{[key: string]: boolean}>>;
}

const DataContext = createContext<DataContextType | undefined>(undefined);

interface DataProviderProps {
  children: ReactNode;
}

export const DataProvider: React.FC<DataProviderProps> = ({ children }) => {
  const [nodes, setNodes] = useState<DeviceInfo[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('disconnected');
  const [messages, setMessages] = useState<MeshMessage[]>([]);
  const [channelMessages, setChannelMessages] = useState<{[key: number]: MeshMessage[]}>({});
  const [deviceInfo, setDeviceInfo] = useState<any>(null);
  const [deviceConfig, setDeviceConfig] = useState<any>(null);
  const [currentNodeId, setCurrentNodeId] = useState<string>('');
  // Starts empty (not a 'Loading...' placeholder): the connection-status string
  // interpolates nodeAddress, and the literal 'Loading...' must never leak into
  // "Connecting to …" before the real per-source address is resolved (#3611).
  const [nodeAddress, setNodeAddress] = useState<string>('');
  // Pagination state for infinite scroll
  const [channelHasMore, setChannelHasMore] = useState<{[key: number]: boolean}>({});
  const [channelLoadingMore, setChannelLoadingMore] = useState<{[key: number]: boolean}>({});
  const [dmHasMore, setDmHasMore] = useState<{[key: string]: boolean}>({});
  const [dmLoadingMore, setDmLoadingMore] = useState<{[key: string]: boolean}>({});

  const value = useMemo<DataContextType>(() => ({
    nodes,
    setNodes,
    channels,
    setChannels,
    connectionStatus,
    setConnectionStatus,
    messages,
    setMessages,
    channelMessages,
    setChannelMessages,
    deviceInfo,
    setDeviceInfo,
    deviceConfig,
    setDeviceConfig,
    currentNodeId,
    setCurrentNodeId,
    nodeAddress,
    setNodeAddress,
    channelHasMore,
    setChannelHasMore,
    channelLoadingMore,
    setChannelLoadingMore,
    dmHasMore,
    setDmHasMore,
    dmLoadingMore,
    setDmLoadingMore,
  }), [
    nodes, setNodes,
    channels, setChannels,
    connectionStatus, setConnectionStatus,
    messages, setMessages,
    channelMessages, setChannelMessages,
    deviceInfo, setDeviceInfo,
    deviceConfig, setDeviceConfig,
    currentNodeId, setCurrentNodeId,
    nodeAddress, setNodeAddress,
    channelHasMore, setChannelHasMore,
    channelLoadingMore, setChannelLoadingMore,
    dmHasMore, setDmHasMore,
    dmLoadingMore, setDmLoadingMore,
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
