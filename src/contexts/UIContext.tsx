import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
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
  nodeFilter: string; // Deprecated - kept for backward compatibility, use nodesNodeFilter or messagesNodeFilter instead
  setNodeFilter: React.Dispatch<React.SetStateAction<string>>;
  nodesNodeFilter: string;
  setNodesNodeFilter: React.Dispatch<React.SetStateAction<string>>;
  messagesNodeFilter: string;
  setMessagesNodeFilter: React.Dispatch<React.SetStateAction<string>>;
  securityFilter: 'all' | 'flaggedOnly' | 'hideFlagged';
  setSecurityFilter: React.Dispatch<React.SetStateAction<'all' | 'flaggedOnly' | 'hideFlagged'>>;
  channelFilter: number | 'all';
  setChannelFilter: React.Dispatch<React.SetStateAction<number | 'all'>>;
  showIncompleteNodes: boolean;
  setShowIncompleteNodes: React.Dispatch<React.SetStateAction<boolean>>;
  dmFilter: 'all' | 'unread' | 'recent' | 'hops' | 'favorites' | 'withPosition' | 'noInfra';
  setDmFilter: React.Dispatch<React.SetStateAction<'all' | 'unread' | 'recent' | 'hops' | 'favorites' | 'withPosition' | 'noInfra'>>;
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
  showNodeFilterPopup: boolean;
  setShowNodeFilterPopup: React.Dispatch<React.SetStateAction<boolean>>;
  isNodeListCollapsed: boolean;
  setIsNodeListCollapsed: React.Dispatch<React.SetStateAction<boolean>>;
  showIgnoredNodes: boolean;
  setShowIgnoredNodes: React.Dispatch<React.SetStateAction<boolean>>;
  filterRemoteAdminOnly: boolean;
  setFilterRemoteAdminOnly: React.Dispatch<React.SetStateAction<boolean>>;
}

const UIContext = createContext<UIContextType | undefined>(undefined);

interface UIProviderProps {
  children: ReactNode;
}

// Valid tab types for hash validation
const VALID_TABS: TabType[] = ['nodes', 'channels', 'messages', 'info', 'settings', 'automation', 'dashboard', 'configuration', 'notifications', 'users', 'audit', 'security', 'themes', 'admin', 'meshcore'];

// Helper to get tab from URL hash
const getTabFromHash = (): TabType => {
  const hash = window.location.hash.slice(1); // Remove the '#'
  return VALID_TABS.includes(hash as TabType) ? (hash as TabType) : 'nodes';
};

// Helper to update URL hash
const updateHash = (tab: TabType) => {
  if (window.location.hash.slice(1) !== tab) {
    window.location.hash = tab;
  }
};

export const UIProvider: React.FC<UIProviderProps> = ({ children }) => {
  // Initialize activeTab from URL hash, or default to 'nodes'
  const [activeTab, setActiveTab] = useState<TabType>(() => getTabFromHash());
  const [showMqttMessagesState, setShowMqttMessagesState] = useState<boolean>(() => {
    const saved = localStorage.getItem('showMqttMessages');
    return saved !== null ? saved === 'true' : false; // Default to false
  });
  const [error, setError] = useState<string | null>(null);
  const [tracerouteLoading, setTracerouteLoading] = useState<string | null>(null);
  const [nodeFilter, setNodeFilter] = useState<string>(''); // Deprecated - kept for backward compatibility
  const [nodesNodeFilter, setNodesNodeFilter] = useState<string>('');
  const [messagesNodeFilter, setMessagesNodeFilter] = useState<string>('');
  const [securityFilter, setSecurityFilter] = useState<'all' | 'flaggedOnly' | 'hideFlagged'>('all');
  const [channelFilter, setChannelFilter] = useState<number | 'all'>('all');
  // Default to showing incomplete nodes (true), but can be toggled to hide them
  // On secure channels (custom PSK), users may want to hide incomplete nodes
  const [showIncompleteNodes, setShowIncompleteNodes] = useState<boolean>(true);
  const [dmFilter, setDmFilter] = useState<'all' | 'unread' | 'recent' | 'hops' | 'favorites' | 'withPosition' | 'noInfra'>('all');
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
  const [showNodeFilterPopup, setShowNodeFilterPopup] = useState<boolean>(false);
  // Start with node list collapsed on mobile devices (screens <= 768px)
  const [isNodeListCollapsed, setIsNodeListCollapsed] = useState<boolean>(() => {
    return window.innerWidth <= 768;
  });
  // Default to hiding ignored nodes
  const [showIgnoredNodes, setShowIgnoredNodes] = useState<boolean>(false);
  const [filterRemoteAdminOnly, setFilterRemoteAdminOnly] = useState<boolean>(false);

  // Wrapper setter for showMqttMessages that persists to localStorage
  const setShowMqttMessages = React.useCallback((value: React.SetStateAction<boolean>) => {
    setShowMqttMessagesState(prevValue => {
      const newValue = typeof value === 'function' ? value(prevValue) : value;
      localStorage.setItem('showMqttMessages', newValue.toString());
      return newValue;
    });
  }, []);

  // Sync activeTab to URL hash when activeTab changes
  useEffect(() => {
    updateHash(activeTab);
  }, [activeTab]);

  // Listen for hash changes (back/forward button navigation)
  useEffect(() => {
    const handleHashChange = () => {
      const tabFromHash = getTabFromHash();
      setActiveTab(tabFromHash);
    };

    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, []);

  return (
    <UIContext.Provider
      value={{
        activeTab,
        setActiveTab,
        showMqttMessages: showMqttMessagesState,
        setShowMqttMessages,
        error,
        setError,
        tracerouteLoading,
        setTracerouteLoading,
        nodeFilter,
        setNodeFilter,
        nodesNodeFilter,
        setNodesNodeFilter,
        messagesNodeFilter,
        setMessagesNodeFilter,
        securityFilter,
        setSecurityFilter,
        channelFilter,
        setChannelFilter,
        showIncompleteNodes,
        setShowIncompleteNodes,
        dmFilter,
        setDmFilter,
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
        showNodeFilterPopup,
        setShowNodeFilterPopup,
        isNodeListCollapsed,
        setIsNodeListCollapsed,
        showIgnoredNodes,
        setShowIgnoredNodes,
        filterRemoteAdminOnly,
        setFilterRemoteAdminOnly,
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
