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
  securityFilter: 'all' | 'flaggedOnly' | 'hideFlagged';
  setSecurityFilter: React.Dispatch<React.SetStateAction<'all' | 'flaggedOnly' | 'hideFlagged'>>;
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
  autoAckMessage: string;
  setAutoAckMessage: React.Dispatch<React.SetStateAction<string>>;
  autoAckChannels: number[];
  setAutoAckChannels: React.Dispatch<React.SetStateAction<number[]>>;
  autoAckDirectMessages: boolean;
  setAutoAckDirectMessages: React.Dispatch<React.SetStateAction<boolean>>;
  autoAckUseDM: boolean;
  setAutoAckUseDM: React.Dispatch<React.SetStateAction<boolean>>;
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
  autoAnnounceUseSchedule: boolean;
  setAutoAnnounceUseSchedule: React.Dispatch<React.SetStateAction<boolean>>;
  autoAnnounceSchedule: string;
  setAutoAnnounceSchedule: React.Dispatch<React.SetStateAction<string>>;
  autoWelcomeEnabled: boolean;
  setAutoWelcomeEnabled: React.Dispatch<React.SetStateAction<boolean>>;
  autoWelcomeMessage: string;
  setAutoWelcomeMessage: React.Dispatch<React.SetStateAction<string>>;
  autoWelcomeTarget: string;
  setAutoWelcomeTarget: React.Dispatch<React.SetStateAction<string>>;
  autoWelcomeWaitForName: boolean;
  setAutoWelcomeWaitForName: React.Dispatch<React.SetStateAction<boolean>>;
  showNodeFilterPopup: boolean;
  setShowNodeFilterPopup: React.Dispatch<React.SetStateAction<boolean>>;
  isNodeListCollapsed: boolean;
  setIsNodeListCollapsed: React.Dispatch<React.SetStateAction<boolean>>;
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
  const [securityFilter, setSecurityFilter] = useState<'all' | 'flaggedOnly' | 'hideFlagged'>('all');
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
  // Automation settings - loaded from backend API, not localStorage
  const [autoAckEnabled, setAutoAckEnabled] = useState<boolean>(false);
  const [autoAckRegex, setAutoAckRegex] = useState<string>('^(test|ping)');
  const [autoAckMessage, setAutoAckMessage] = useState<string>('🤖 Copy, {NUMBER_HOPS} hops at {TIME}');
  const [autoAckChannels, setAutoAckChannels] = useState<number[]>([]);
  const [autoAckDirectMessages, setAutoAckDirectMessages] = useState<boolean>(false);
  const [autoAckUseDM, setAutoAckUseDM] = useState<boolean>(false);
  const [autoAnnounceEnabled, setAutoAnnounceEnabled] = useState<boolean>(false);
  const [autoAnnounceIntervalHours, setAutoAnnounceIntervalHours] = useState<number>(6);
  const [autoAnnounceMessage, setAutoAnnounceMessage] = useState<string>('MeshMonitor {VERSION} online for {DURATION} {FEATURES}');
  const [autoAnnounceChannelIndex, setAutoAnnounceChannelIndex] = useState<number>(0);
  const [autoAnnounceOnStart, setAutoAnnounceOnStart] = useState<boolean>(false);
  const [autoAnnounceUseSchedule, setAutoAnnounceUseSchedule] = useState<boolean>(false);
  const [autoAnnounceSchedule, setAutoAnnounceSchedule] = useState<string>('0 */6 * * *');
  const [autoWelcomeEnabled, setAutoWelcomeEnabled] = useState<boolean>(false);
  const [autoWelcomeMessage, setAutoWelcomeMessage] = useState<string>('Welcome {LONG_NAME} ({SHORT_NAME}) to the mesh!');
  const [autoWelcomeTarget, setAutoWelcomeTarget] = useState<string>('0');
  const [autoWelcomeWaitForName, setAutoWelcomeWaitForName] = useState<boolean>(true);
  const [showNodeFilterPopup, setShowNodeFilterPopup] = useState<boolean>(false);
  // Start with node list collapsed on mobile devices (screens <= 768px)
  const [isNodeListCollapsed, setIsNodeListCollapsed] = useState<boolean>(() => {
    return window.innerWidth <= 768;
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
        securityFilter,
        setSecurityFilter,
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
        autoAckMessage,
        setAutoAckMessage,
        autoAckChannels,
        setAutoAckChannels,
        autoAckDirectMessages,
        setAutoAckDirectMessages,
        autoAckUseDM,
        setAutoAckUseDM,
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
        autoAnnounceUseSchedule,
        setAutoAnnounceUseSchedule,
        autoAnnounceSchedule,
        setAutoAnnounceSchedule,
        autoWelcomeEnabled,
        setAutoWelcomeEnabled,
        autoWelcomeMessage,
        setAutoWelcomeMessage,
        autoWelcomeTarget,
        setAutoWelcomeTarget,
        autoWelcomeWaitForName,
        setAutoWelcomeWaitForName,
        showNodeFilterPopup,
        setShowNodeFilterPopup,
        isNodeListCollapsed,
        setIsNodeListCollapsed,
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
