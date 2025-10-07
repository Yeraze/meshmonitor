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
  const [sortField, setSortField] = useState<SortField>('longName');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');
  const [showStatusModal, setShowStatusModal] = useState<boolean>(false);
  const [systemStatus, setSystemStatus] = useState<any>(null);
  const [nodePopup, setNodePopup] = useState<{nodeId: string, position: {x: number, y: number}} | null>(null);

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
