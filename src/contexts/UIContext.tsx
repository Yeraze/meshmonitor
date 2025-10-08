import React, { createContext, useContext, useState, ReactNode } from 'react';
import { TabType, SortField, SortDirection } from '../types/ui';

interface UIContextType {
  activeTab: TabType;
  setActiveTab: React.Dispatch<React.SetStateAction<TabType>>;
  showMqttMessages: boolean;
  setShowMqttMessages: React.Dispatch<React.SetStateAction<boolean>>;
  error: string | null;
  setError: React.Dispatch<React.SetStateAction<string | null>>;
  tracerouteLoading: string | null;
  setTracerouteLoading: React.Dispatch<React.SetStateAction<string | null>>;
  nodeFilter: string;
  setNodeFilter: React.Dispatch<React.SetStateAction<string>>;
  sortField: SortField;
  setSortField: React.Dispatch<React.SetStateAction<SortField>>;
  sortDirection: SortDirection;
  setSortDirection: React.Dispatch<React.SetStateAction<SortDirection>>;
  showStatusModal: boolean;
  setShowStatusModal: React.Dispatch<React.SetStateAction<boolean>>;
  systemStatus: any;
  setSystemStatus: React.Dispatch<React.SetStateAction<any>>;
  nodePopup: {nodeId: string, position: {x: number, y: number}} | null;
  setNodePopup: React.Dispatch<React.SetStateAction<{nodeId: string, position: {x: number, y: number}} | null>>;
  autoAckEnabled: boolean;
  setAutoAckEnabled: React.Dispatch<React.SetStateAction<boolean>>;
  autoAckRegex: string;
  setAutoAckRegex: React.Dispatch<React.SetStateAction<string>>;
  autoAnnounceEnabled: boolean;
  setAutoAnnounceEnabled: React.Dispatch<React.SetStateAction<boolean>>;
  autoAnnounceIntervalHours: number;
  setAutoAnnounceIntervalHours: React.Dispatch<React.SetStateAction<number>>;
  autoAnnounceMessage: string;
  setAutoAnnounceMessage: React.Dispatch<React.SetStateAction<string>>;
  autoAnnounceChannelIndex: number;
  setAutoAnnounceChannelIndex: React.Dispatch<React.SetStateAction<number>>;
  autoAnnounceOnStart: boolean;
  setAutoAnnounceOnStart: React.Dispatch<React.SetStateAction<boolean>>;
}

const UIContext = createContext<UIContextType | undefined>(undefined);

interface UIProviderProps {
  children: ReactNode;
}

export const UIProvider: React.FC<UIProviderProps> = ({ children }) => {
  const [activeTab, setActiveTab] = useState<TabType>('nodes');
  const [showMqttMessages, setShowMqttMessages] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [tracerouteLoading, setTracerouteLoading] = useState<string | null>(null);
  const [nodeFilter, setNodeFilter] = useState<string>('');
  const [sortField, setSortField] = useState<SortField>(() => {
    const saved = localStorage.getItem('preferredSortField');
    return (saved as SortField) || 'longName';
  });
  const [sortDirection, setSortDirection] = useState<SortDirection>(() => {
    const saved = localStorage.getItem('preferredSortDirection');
    return (saved === 'desc' ? 'desc' : 'asc') as SortDirection;
  });
  const [showStatusModal, setShowStatusModal] = useState<boolean>(false);
  const [systemStatus, setSystemStatus] = useState<any>(null);
  const [nodePopup, setNodePopup] = useState<{nodeId: string, position: {x: number, y: number}} | null>(null);
  const [autoAckEnabled, setAutoAckEnabled] = useState<boolean>(() => {
    const saved = localStorage.getItem('autoAckEnabled');
    return saved === 'true';
  });
  const [autoAckRegex, setAutoAckRegex] = useState<string>(() => {
    const saved = localStorage.getItem('autoAckRegex');
    // Migrate old patterns to new format
    if (saved === '(?i)test' || saved === 'test') {
      localStorage.setItem('autoAckRegex', '^(test|ping)');
      return '^(test|ping)';
    }
    return saved || '^(test|ping)';
  });
  const [autoAnnounceEnabled, setAutoAnnounceEnabled] = useState<boolean>(() => {
    const saved = localStorage.getItem('autoAnnounceEnabled');
    return saved === 'true';
  });
  const [autoAnnounceIntervalHours, setAutoAnnounceIntervalHours] = useState<number>(() => {
    const saved = localStorage.getItem('autoAnnounceIntervalHours');
    return saved ? parseInt(saved) : 6;
  });
  const [autoAnnounceMessage, setAutoAnnounceMessage] = useState<string>(() => {
    const saved = localStorage.getItem('autoAnnounceMessage');
    return saved || 'MeshMonitor {VERSION} online for {DURATION} {FEATURES}';
  });
  const [autoAnnounceChannelIndex, setAutoAnnounceChannelIndex] = useState<number>(() => {
    const saved = localStorage.getItem('autoAnnounceChannelIndex');
    return saved ? parseInt(saved) : 0;
  });
  const [autoAnnounceOnStart, setAutoAnnounceOnStart] = useState<boolean>(() => {
    const saved = localStorage.getItem('autoAnnounceOnStart');
    return saved === 'true';
  });

  return (
    <UIContext.Provider
      value={{
        activeTab,
        setActiveTab,
        showMqttMessages,
        setShowMqttMessages,
        error,
        setError,
        tracerouteLoading,
        setTracerouteLoading,
        nodeFilter,
        setNodeFilter,
        sortField,
        setSortField,
        sortDirection,
        setSortDirection,
        showStatusModal,
        setShowStatusModal,
        systemStatus,
        setSystemStatus,
        nodePopup,
        setNodePopup,
        autoAckEnabled,
        setAutoAckEnabled,
        autoAckRegex,
        setAutoAckRegex,
        autoAnnounceEnabled,
        setAutoAnnounceEnabled,
        autoAnnounceIntervalHours,
        setAutoAnnounceIntervalHours,
        autoAnnounceMessage,
        setAutoAnnounceMessage,
        autoAnnounceChannelIndex,
        setAutoAnnounceChannelIndex,
        autoAnnounceOnStart,
        setAutoAnnounceOnStart,
      }}
    >
      {children}
    </UIContext.Provider>
  );
};

export const useUI = () => {
  const context = useContext(UIContext);
  if (context === undefined) {
    throw new Error('useUI must be used within a UIProvider');
  }
  return context;
};
