import React, { createContext, useContext, useState, useMemo, useCallback, ReactNode } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { TabType, SortField, SortDirection, VALID_TABS } from '../types/ui';

interface UIContextType {
  activeTab: TabType;
  setActiveTab: (tab: TabType) => void;
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

export const UIProvider: React.FC<UIProviderProps> = ({ children }) => {
  // activeTab<->route adapter (#3962 5.4 PR1). `activeTab` used to be its own
  // piece of state synced to `window.location.hash`; it is now *derived* from
  // the router location (last path segment), and `setActiveTab` navigates
  // instead of setting state directly. This keeps every un-migrated
  // `activeTab === 'x'` render block and `Sidebar`'s `setActiveTab(id)` calls
  // working unchanged while tabs move to routes one PR at a time (see
  // task54_spec.md §2.3).
  //
  // PR8 (final PR of the stack) re-checked whether this can go: it can't.
  // Real consumers remain — useMessagingView.ts's 8 activeTab-gated scroll/
  // pagination/read-marking effects (the messages/channels tabs it owns),
  // useSourceView.ts's processedNodes filter (only applies nodesNodeFilter
  // when the nodes tab is active), MessagingContext.tsx's compose-conversation
  // key, and App.tsx/NodesTab.tsx's own DM/channel navigation
  // (setActiveTab('messages') on DM click, etc.). Converting all of those to
  // useLocation() directly is a real refactor with render-loop risk, not a
  // mechanical deletion — deliberately left in place rather than rushed.
  // Re-evaluate if/when those consumers are touched for other reasons.
  const location = useLocation();
  const navigate = useNavigate();
  const { sourceId } = useParams<{ sourceId: string }>();

  const activeTab = useMemo<TabType>(() => {
    const segments = location.pathname.split('/').filter(Boolean);
    const last = segments[segments.length - 1];
    return VALID_TABS.includes(last as TabType) ? (last as TabType) : 'nodes';
  }, [location.pathname]);

  const setActiveTab = useCallback((tab: TabType) => {
    if (!sourceId || tab === activeTab) return;
    void navigate(`/source/${sourceId}/${tab}`);
  }, [navigate, sourceId, activeTab]);

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

  const value = useMemo<UIContextType>(() => ({
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
  }), [
    activeTab, setActiveTab,
    showMqttMessagesState, setShowMqttMessages,
    error, setError,
    tracerouteLoading, setTracerouteLoading,
    nodeFilter, setNodeFilter,
    nodesNodeFilter, setNodesNodeFilter,
    messagesNodeFilter, setMessagesNodeFilter,
    securityFilter, setSecurityFilter,
    channelFilter, setChannelFilter,
    showIncompleteNodes, setShowIncompleteNodes,
    dmFilter, setDmFilter,
    sortField, setSortField,
    sortDirection, setSortDirection,
    showStatusModal, setShowStatusModal,
    systemStatus, setSystemStatus,
    nodePopup, setNodePopup,
    showNodeFilterPopup, setShowNodeFilterPopup,
    isNodeListCollapsed, setIsNodeListCollapsed,
    showIgnoredNodes, setShowIgnoredNodes,
    filterRemoteAdminOnly, setFilterRemoteAdminOnly,
  ]);

  return (
    <UIContext.Provider value={value}>
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
