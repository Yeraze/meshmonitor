import React, { createContext, useContext, useState, ReactNode } from 'react';
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
  nodesWithTelemetry: Set<string>;
  setNodesWithTelemetry: React.Dispatch<React.SetStateAction<Set<string>>>;
  nodesWithWeatherTelemetry: Set<string>;
  setNodesWithWeatherTelemetry: React.Dispatch<React.SetStateAction<Set<string>>>;
  nodesWithEstimatedPosition: Set<string>;
  setNodesWithEstimatedPosition: React.Dispatch<React.SetStateAction<Set<string>>>;
  nodesWithPKC: Set<string>;
  setNodesWithPKC: React.Dispatch<React.SetStateAction<Set<string>>>;
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
  const [nodeAddress, setNodeAddress] = useState<string>('Loading...');
  const [nodesWithTelemetry, setNodesWithTelemetry] = useState<Set<string>>(new Set());
  const [nodesWithWeatherTelemetry, setNodesWithWeatherTelemetry] = useState<Set<string>>(new Set());
  const [nodesWithEstimatedPosition, setNodesWithEstimatedPosition] = useState<Set<string>>(new Set());
  const [nodesWithPKC, setNodesWithPKC] = useState<Set<string>>(new Set());

  return (
    <DataContext.Provider
      value={{
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
        nodesWithTelemetry,
        setNodesWithTelemetry,
        nodesWithWeatherTelemetry,
        setNodesWithWeatherTelemetry,
        nodesWithEstimatedPosition,
        setNodesWithEstimatedPosition,
        nodesWithPKC,
        setNodesWithPKC,
      }}
    >
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
