import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { TabType, SortField, SortDirection } from '../types/ui';
import { AutoResponderTrigger, TimerTrigger, GeofenceTrigger } from '../components/auto-responder/types';

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
  autoAckEnabled: boolean;
  setAutoAckEnabled: React.Dispatch<React.SetStateAction<boolean>>;
  autoAckRegex: string;
  setAutoAckRegex: React.Dispatch<React.SetStateAction<string>>;
  autoAckMessage: string;
  setAutoAckMessage: React.Dispatch<React.SetStateAction<string>>;
  autoAckMessageDirect: string;
  setAutoAckMessageDirect: React.Dispatch<React.SetStateAction<string>>;
  autoAckChannels: number[];
  setAutoAckChannels: React.Dispatch<React.SetStateAction<number[]>>;
  autoAckDirectMessages: boolean;
  setAutoAckDirectMessages: React.Dispatch<React.SetStateAction<boolean>>;
  autoAckUseDM: boolean;
  setAutoAckUseDM: React.Dispatch<React.SetStateAction<boolean>>;
  autoAckSkipIncompleteNodes: boolean;
  setAutoAckSkipIncompleteNodes: React.Dispatch<React.SetStateAction<boolean>>;
  autoAckTapbackEnabled: boolean;
  setAutoAckTapbackEnabled: React.Dispatch<React.SetStateAction<boolean>>;
  autoAckReplyEnabled: boolean;
  setAutoAckReplyEnabled: React.Dispatch<React.SetStateAction<boolean>>;
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
  autoAnnounceNodeInfoEnabled: boolean;
  setAutoAnnounceNodeInfoEnabled: React.Dispatch<React.SetStateAction<boolean>>;
  autoAnnounceNodeInfoChannels: number[];
  setAutoAnnounceNodeInfoChannels: React.Dispatch<React.SetStateAction<number[]>>;
  autoAnnounceNodeInfoDelaySeconds: number;
  setAutoAnnounceNodeInfoDelaySeconds: React.Dispatch<React.SetStateAction<number>>;
  autoWelcomeEnabled: boolean;
  setAutoWelcomeEnabled: React.Dispatch<React.SetStateAction<boolean>>;
  autoWelcomeMessage: string;
  setAutoWelcomeMessage: React.Dispatch<React.SetStateAction<string>>;
  autoWelcomeTarget: string;
  setAutoWelcomeTarget: React.Dispatch<React.SetStateAction<string>>;
  autoWelcomeWaitForName: boolean;
  setAutoWelcomeWaitForName: React.Dispatch<React.SetStateAction<boolean>>;
  autoWelcomeMaxHops: number;
  setAutoWelcomeMaxHops: React.Dispatch<React.SetStateAction<number>>;
  autoResponderEnabled: boolean;
  setAutoResponderEnabled: React.Dispatch<React.SetStateAction<boolean>>;
  autoResponderTriggers: AutoResponderTrigger[];
  setAutoResponderTriggers: React.Dispatch<React.SetStateAction<AutoResponderTrigger[]>>;
  autoResponderSkipIncompleteNodes: boolean;
  setAutoResponderSkipIncompleteNodes: React.Dispatch<React.SetStateAction<boolean>>;
  autoKeyManagementEnabled: boolean;
  setAutoKeyManagementEnabled: React.Dispatch<React.SetStateAction<boolean>>;
  autoKeyManagementIntervalMinutes: number;
  setAutoKeyManagementIntervalMinutes: React.Dispatch<React.SetStateAction<number>>;
  autoKeyManagementMaxExchanges: number;
  setAutoKeyManagementMaxExchanges: React.Dispatch<React.SetStateAction<number>>;
  autoKeyManagementAutoPurge: boolean;
  setAutoKeyManagementAutoPurge: React.Dispatch<React.SetStateAction<boolean>>;
  timerTriggers: TimerTrigger[];
  setTimerTriggers: React.Dispatch<React.SetStateAction<TimerTrigger[]>>;
  geofenceTriggers: GeofenceTrigger[];
  setGeofenceTriggers: React.Dispatch<React.SetStateAction<GeofenceTrigger[]>>;
  showNodeFilterPopup: boolean;
  setShowNodeFilterPopup: React.Dispatch<React.SetStateAction<boolean>>;
  isNodeListCollapsed: boolean;
  setIsNodeListCollapsed: React.Dispatch<React.SetStateAction<boolean>>;
  showIgnoredNodes: boolean;
  setShowIgnoredNodes: React.Dispatch<React.SetStateAction<boolean>>;
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
  // Automation settings - loaded from backend API, not localStorage
  const [autoAckEnabled, setAutoAckEnabled] = useState<boolean>(false);
  const [autoAckRegex, setAutoAckRegex] = useState<string>('^(test|ping)');
  const [autoAckMessage, setAutoAckMessage] = useState<string>('🤖 Copy, {NUMBER_HOPS} hops at {TIME}');
  const [autoAckMessageDirect, setAutoAckMessageDirect] = useState<string>('🤖 Copy, direct connection! SNR: {SNR}dB RSSI: {RSSI}dBm at {TIME}');
  const [autoAckChannels, setAutoAckChannels] = useState<number[]>([]);
  const [autoAckDirectMessages, setAutoAckDirectMessages] = useState<boolean>(false);
  const [autoAckUseDM, setAutoAckUseDM] = useState<boolean>(false);
  const [autoAckSkipIncompleteNodes, setAutoAckSkipIncompleteNodes] = useState<boolean>(false);
  const [autoAckTapbackEnabled, setAutoAckTapbackEnabled] = useState<boolean>(false);
  const [autoAckReplyEnabled, setAutoAckReplyEnabled] = useState<boolean>(true); // Default true for backward compatibility
  const [autoAnnounceEnabled, setAutoAnnounceEnabled] = useState<boolean>(false);
  const [autoAnnounceIntervalHours, setAutoAnnounceIntervalHours] = useState<number>(6);
  const [autoAnnounceMessage, setAutoAnnounceMessage] = useState<string>('MeshMonitor {VERSION} online for {DURATION} {FEATURES}');
  const [autoAnnounceChannelIndex, setAutoAnnounceChannelIndex] = useState<number>(0);
  const [autoAnnounceOnStart, setAutoAnnounceOnStart] = useState<boolean>(false);
  const [autoAnnounceUseSchedule, setAutoAnnounceUseSchedule] = useState<boolean>(false);
  const [autoAnnounceSchedule, setAutoAnnounceSchedule] = useState<string>('0 */6 * * *');
  const [autoAnnounceNodeInfoEnabled, setAutoAnnounceNodeInfoEnabled] = useState<boolean>(false);
  const [autoAnnounceNodeInfoChannels, setAutoAnnounceNodeInfoChannels] = useState<number[]>([]);
  const [autoAnnounceNodeInfoDelaySeconds, setAutoAnnounceNodeInfoDelaySeconds] = useState<number>(30);
  const [autoWelcomeEnabled, setAutoWelcomeEnabled] = useState<boolean>(false);
  const [autoWelcomeMessage, setAutoWelcomeMessage] = useState<string>('Welcome {LONG_NAME} ({SHORT_NAME}) to the mesh!');
  const [autoWelcomeTarget, setAutoWelcomeTarget] = useState<string>('0');
  const [autoWelcomeWaitForName, setAutoWelcomeWaitForName] = useState<boolean>(true);
  const [autoWelcomeMaxHops, setAutoWelcomeMaxHops] = useState<number>(5);
  const [autoResponderEnabled, setAutoResponderEnabled] = useState<boolean>(false);
  const [autoResponderTriggers, setAutoResponderTriggers] = useState<AutoResponderTrigger[]>([]);
  const [autoResponderSkipIncompleteNodes, setAutoResponderSkipIncompleteNodes] = useState<boolean>(false);
  const [autoKeyManagementEnabled, setAutoKeyManagementEnabled] = useState<boolean>(false);
  const [autoKeyManagementIntervalMinutes, setAutoKeyManagementIntervalMinutes] = useState<number>(5);
  const [autoKeyManagementMaxExchanges, setAutoKeyManagementMaxExchanges] = useState<number>(3);
  const [autoKeyManagementAutoPurge, setAutoKeyManagementAutoPurge] = useState<boolean>(false);
  const [timerTriggers, setTimerTriggers] = useState<TimerTrigger[]>([]);
  const [geofenceTriggers, setGeofenceTriggers] = useState<GeofenceTrigger[]>([]);
  const [showNodeFilterPopup, setShowNodeFilterPopup] = useState<boolean>(false);
  // Start with node list collapsed on mobile devices (screens <= 768px)
  const [isNodeListCollapsed, setIsNodeListCollapsed] = useState<boolean>(() => {
    return window.innerWidth <= 768;
  });
  // Default to hiding ignored nodes
  const [showIgnoredNodes, setShowIgnoredNodes] = useState<boolean>(false);

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
        autoAckEnabled,
        setAutoAckEnabled,
        autoAckRegex,
        setAutoAckRegex,
        autoAckMessage,
        setAutoAckMessage,
        autoAckMessageDirect,
        setAutoAckMessageDirect,
        autoAckChannels,
        setAutoAckChannels,
        autoAckDirectMessages,
        setAutoAckDirectMessages,
        autoAckUseDM,
        setAutoAckUseDM,
        autoAckSkipIncompleteNodes,
        setAutoAckSkipIncompleteNodes,
        autoAckTapbackEnabled,
        setAutoAckTapbackEnabled,
        autoAckReplyEnabled,
        setAutoAckReplyEnabled,
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
        autoAnnounceNodeInfoEnabled,
        setAutoAnnounceNodeInfoEnabled,
        autoAnnounceNodeInfoChannels,
        setAutoAnnounceNodeInfoChannels,
        autoAnnounceNodeInfoDelaySeconds,
        setAutoAnnounceNodeInfoDelaySeconds,
        autoWelcomeEnabled,
        setAutoWelcomeEnabled,
        autoWelcomeMessage,
        setAutoWelcomeMessage,
        autoWelcomeTarget,
        setAutoWelcomeTarget,
        autoWelcomeWaitForName,
        setAutoWelcomeWaitForName,
        autoWelcomeMaxHops,
        setAutoWelcomeMaxHops,
        autoResponderEnabled,
        setAutoResponderEnabled,
        autoResponderTriggers,
        setAutoResponderTriggers,
        autoResponderSkipIncompleteNodes,
        setAutoResponderSkipIncompleteNodes,
        autoKeyManagementEnabled,
        setAutoKeyManagementEnabled,
        autoKeyManagementIntervalMinutes,
        setAutoKeyManagementIntervalMinutes,
        autoKeyManagementMaxExchanges,
        setAutoKeyManagementMaxExchanges,
        autoKeyManagementAutoPurge,
        setAutoKeyManagementAutoPurge,
        timerTriggers,
        setTimerTriggers,
        geofenceTriggers,
        setGeofenceTriggers,
        showNodeFilterPopup,
        setShowNodeFilterPopup,
        isNodeListCollapsed,
        setIsNodeListCollapsed,
        showIgnoredNodes,
        setShowIgnoredNodes,
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
