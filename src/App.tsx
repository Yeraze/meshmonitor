import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { flushSync } from 'react-dom';
import { useTranslation } from 'react-i18next';
// Popup and Polyline moved to useTraceroutePaths hook
// Recharts imports moved to useTraceroutePaths hook
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import './App.css';

import InfoTab from './components/InfoTab';
import SettingsTab from './components/SettingsTab';
import ConfigurationTab from './components/ConfigurationTab';
import NotificationsTab from './components/NotificationsTab';
import UsersTab from './components/UsersTab';
import AuditLogTab from './components/AuditLogTab';
import { SecurityTab } from './components/SecurityTab';
import AdminCommandsTab from './components/AdminCommandsTab';
import Dashboard from './components/Dashboard';
import NodesTab from './components/NodesTab';
import MessagesTab from './components/MessagesTab';
import ChannelsTab from './components/ChannelsTab';
import { MeshCoreTab } from './components/MeshCore';
import AutoAcknowledgeSection from './components/AutoAcknowledgeSection';
import AutoTracerouteSection from './components/AutoTracerouteSection';
import AutoAnnounceSection from './components/AutoAnnounceSection';
import AutoWelcomeSection from './components/AutoWelcomeSection';
import AutoResponderSection from './components/AutoResponderSection';
import AutoKeyManagementSection from './components/AutoKeyManagementSection';
import TimerTriggersSection from './components/TimerTriggersSection';
import GeofenceTriggersSection from './components/GeofenceTriggersSection';
import RemoteAdminScannerSection from './components/RemoteAdminScannerSection';
import AutoTimeSyncSection from './components/AutoTimeSyncSection';
import IgnoredNodesSection from './components/IgnoredNodesSection';
import SectionNav from './components/SectionNav';
import { ToastProvider, useToast } from './components/ToastContainer';
import { RebootModal } from './components/RebootModal';
import { AppBanners } from './components/AppBanners';
import { AppHeader } from './components/AppHeader';
import { PurgeDataModal } from './components/PurgeDataModal';
import { PositionOverrideModal } from './components/PositionOverrideModal';
import { NodeInfoModal } from './components/NodeInfoModal/NodeInfoModal';
import { SystemStatusModal } from './components/SystemStatusModal';
import { NodePopup } from './components/NodePopup';
import { EmojiPickerModal } from './components/EmojiPickerModal';
import { AdvancedNodeFilterPopup } from './components/AdvancedNodeFilterPopup';
import { NewsPopup } from './components/NewsPopup';
// import { version } from '../package.json' // Removed - footer no longer displayed
import { type TemperatureUnit } from './utils/temperature';
// calculateDistance and formatDistance moved to useTraceroutePaths hook
import { DeviceInfo, Channel } from './types/device';
import { MeshMessage } from './types/message';
import { SortField, SortDirection, NodeFilters } from './types/ui';
import { ResourceType } from './types/permission';
import api, { type ChannelDatabaseEntry } from './services/api';
import { logger } from './utils/logger';
// generateArrowMarkers moved to useTraceroutePaths hook
import { isNodeComplete, getEffectivePosition } from './utils/nodeHelpers';
import Sidebar from './components/Sidebar';
import { SettingsProvider, useSettings } from './contexts/SettingsContext';
import { MapProvider, useMapContext } from './contexts/MapContext';
import { DataProvider, useData } from './contexts/DataContext';
import { MessagingProvider, useMessaging } from './contexts/MessagingContext';
import { UIProvider, useUI } from './contexts/UIContext';
import { useAuth } from './contexts/AuthContext';
import { useCsrf } from './contexts/CsrfContext';
import { useWebSocketConnected } from './contexts/WebSocketContext';
import { useHealth } from './hooks/useHealth';
import { useTxStatus } from './hooks/useTxStatus';
import { usePoll, type PollData } from './hooks/usePoll';
import { useTraceroutePaths } from './hooks/useTraceroutePaths';
import { useNotificationNavigationHandler } from './hooks/useNotificationNavigationHandler';
import LoginModal from './components/LoginModal';
import LoginPage from './components/LoginPage';
import { SaveBarProvider } from './contexts/SaveBarContext';
import { SaveBar } from './components/SaveBar';

// Track pending favorite requests outside component to persist across remounts
// Maps nodeNum -> expected isFavorite state
const pendingFavoriteRequests = new Map<number, boolean>();
const pendingIgnoredRequests = new Map<number, boolean>();
import TracerouteHistoryModal from './components/TracerouteHistoryModal';
import RouteSegmentTraceroutesModal from './components/RouteSegmentTraceroutesModal';

// Fix for default markers in React-Leaflet
delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl:
    'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjQiIGhlaWdodD0iMjQiIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPHBhdGggZD0iTTEyIDJDOS4yNCAyIDcgNC4yNCA3IDdDNyAxMy40NyAxMiAyMiAxMiAyMkMxMiAyMiAxNyAxMy40NyAxNyA3QzE3IDQuMjQgMTQuNzYgMiAxMiAyWk0xMiA5LjVDMTAuNjIgOS41IDkuNSA4LjM4IDkuNSA3UzkuNTEgNC41IDExIDQuNVMxNS41IDUuNjIgMTUuNSA3UzE0LjM4IDkuNSAxMiA5LjVaIiBmaWxsPSIjZmY2NjY2Ii8+Cjwvc3ZnPg==',
  iconUrl:
    'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjQiIGhlaWdodD0iMjQiIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPHBhdGggZD0iTTEyIDJDOS4yNCAyIDcgNC4yNCA3IDdDNyAxMy40NyAxMiAyMiAxMiAyMkMxMiAyMiAxNyAxMy40NyAxNyA3QzE3IDQuMjQgMTQuNzYgMiAxMiAyWk0xMiA5LjVDMTAuNjIgOS41IDkuNSA4LjM4IDkuNSA3UzkuNTEgNC41IDExIDQuNVMxNS41IDUuNjIgMTUuNSA7UzE0LjM4IDkuNSAxMiA5LjVaIiBmaWxsPSIjNjY5OGY1Ii8+Cjwvc3ZnPg==',
  shadowUrl:
    'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjQiIGhlaWdodD0iMjQiIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPHBhdGggZD0iTTEyIDJDOS4yNCAyIDcgNC4yNCA3IDdDNyAxMy40NyAxMiAyMiAxMiAyMkMxMiAyMiAxNyAxMy40NyAxNyA3QzE3IDQuMjQgMTQuNzYgMiAxMiAyWk0xMiA5LjVDMTAuNjIgOS41IDkuNSA4LjM4IDkuNSA3UzkuNTEgNC41IDExIDQuNVMxNS41IDUuNjIgMTUuNSA3UzE0LjM4IDkuNSAxMiA5LjVaIiBmaWxsPSIjMDAwIiBmaWxsLW9wYWNpdHk9IjAuMyIvPgo8L3N2Zz4K',
  iconSize: [24, 24],
  iconAnchor: [12, 24],
  popupAnchor: [0, -24],
});

// Icons and helpers are now imported from utils/

function App() {
  const { t } = useTranslation();
  const { authStatus, hasPermission, loading: authLoading } = useAuth();
  const { getToken: getCsrfToken, refreshToken: refreshCsrfToken } = useCsrf();
  const webSocketConnected = useWebSocketConnected();
  const { showToast } = useToast();
  const [showLoginModal, setShowLoginModal] = useState(false);
  const [isDefaultPassword, setIsDefaultPassword] = useState(false);
  const [configIssues, setConfigIssues] = useState<
    Array<{
      type: 'cookie_secure' | 'allowed_origins';
      severity: 'error' | 'warning';
      message: string;
      docsUrl: string;
    }>
  >([]);
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [latestVersion, setLatestVersion] = useState('');
  const [releaseUrl, setReleaseUrl] = useState('');
  const [upgradeEnabled, setUpgradeEnabled] = useState(false);
  const [upgradeInProgress, setUpgradeInProgress] = useState(false);
  const [upgradeStatus, setUpgradeStatus] = useState('');
  const [upgradeProgress, setUpgradeProgress] = useState(0);
  const [_upgradeId, setUpgradeId] = useState<string | null>(null);
  const [channelInfoModal, setChannelInfoModal] = useState<number | null>(null);
  const [showPsk, setShowPsk] = useState(false);
  const [showRebootModal, setShowRebootModal] = useState(false);
  const [configRefreshTrigger, setConfigRefreshTrigger] = useState(0);
  const [showTracerouteHistoryModal, setShowTracerouteHistoryModal] = useState(false);
  const [showPurgeDataModal, setShowPurgeDataModal] = useState(false);
  const [showNewsPopup, setShowNewsPopup] = useState(false);
  const [forceShowAllNews, setForceShowAllNews] = useState(false);
  const [showPositionOverrideModal, setShowPositionOverrideModal] = useState(false);
  const [showNodeInfoModal, setShowNodeInfoModal] = useState(false);
  const [nodeConnectionInfo, setNodeConnectionInfo] = useState<{
    nodeIp: string;
    tcpPort: number;
    defaultIp: string;
    defaultPort: number;
    isOverridden: boolean;
  } | null>(null);
  const [selectedRouteSegment, setSelectedRouteSegment] = useState<{ nodeNum1: number; nodeNum2: number } | null>(null);
  const [emojiPickerMessage, setEmojiPickerMessage] = useState<MeshMessage | null>(null);

  // Check if mobile viewport and default to collapsed on mobile
  const isMobileViewport = () => window.innerWidth <= 768;
  const [isMessagesNodeListCollapsed, setIsMessagesNodeListCollapsed] = useState(isMobileViewport());

  // Node list filter options (shared between Map and Messages pages)
  // Load from localStorage on initial render
  const [nodeFilters, setNodeFilters] = useState<NodeFilters>(() => {
    const savedFilters = localStorage.getItem('nodeFilters');
    if (savedFilters) {
      try {
        const parsed = JSON.parse(savedFilters);
        // Add filterMode if it doesn't exist (backward compatibility)
        if (!parsed.filterMode) {
          parsed.filterMode = 'show';
        }
        // Add channels if it doesn't exist (backward compatibility)
        if (!parsed.channels) {
          parsed.channels = [];
        }
        // Add deviceRoles if it doesn't exist (backward compatibility)
        if (!parsed.deviceRoles) {
          parsed.deviceRoles = [];
        }
        // Add showIgnored if it doesn't exist (backward compatibility)
        if (parsed.showIgnored === undefined) {
          parsed.showIgnored = false;
        }
        return parsed;
      } catch (e) {
        logger.error('Failed to parse saved node filters:', e);
      }
    }
    return {
      filterMode: 'show' as 'show' | 'hide',
      showMqtt: false,
      showTelemetry: false,
      showEnvironment: false,
      powerSource: 'both' as 'powered' | 'battery' | 'both',
      showPosition: false,
      minHops: 0,
      maxHops: 10,
      showPKI: false,
      showRemoteAdmin: false,
      showUnknown: false,
      showIgnored: false,
      deviceRoles: [] as number[], // Empty array means show all roles
      channels: [] as number[],
    };
  });

  const hasSelectedInitialChannelRef = useRef<boolean>(false);
  const selectedChannelRef = useRef<number>(-1);
  const lastChannelSelectionRef = useRef<number>(-1); // Track last selected channel before switching to Messages tab
  const showRebootModalRef = useRef<boolean>(false); // Track reboot modal state for interval closure
  const connectionStatusRef = useRef<string>('disconnected'); // Track connection status for interval closure
  const localNodeIdRef = useRef<string>(''); // Track local node ID for immediate access (bypasses React state delay)
  const pendingMessagesRef = useRef<Map<string, MeshMessage>>(new Map()); // Track pending messages for interval access (bypasses closure stale state)
  const upgradePollingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null); // Track upgrade polling interval for cleanup

  // Constants for emoji tapbacks
  const EMOJI_FLAG = 1; // Protobuf flag indicating this is a tapback/reaction

  const channelMessagesContainerRef = useRef<HTMLDivElement>(null);
  const dmMessagesContainerRef = useRef<HTMLDivElement>(null);
  const lastScrollLoadTimeRef = useRef<number>(0); // Throttle scroll-triggered loads (200ms)

  // const lastNotificationTime = useRef<number>(0) // Disabled for now
  // Detect base URL from pathname
  const detectBaseUrl = () => {
    const pathname = window.location.pathname;
    const pathParts = pathname.split('/').filter(Boolean);

    if (pathParts.length > 0) {
      // Remove any trailing segments that look like app routes
      const appRoutes = ['nodes', 'channels', 'messages', 'settings', 'info', 'dashboard'];
      const baseSegments = [];

      for (const segment of pathParts) {
        if (appRoutes.includes(segment.toLowerCase())) {
          break;
        }
        baseSegments.push(segment);
      }

      if (baseSegments.length > 0) {
        return '/' + baseSegments.join('/');
      }
    }

    return '';
  };

  // Initialize baseUrl from pathname immediately to avoid 404s on initial render
  const initialBaseUrl = detectBaseUrl();
  const [baseUrl, setBaseUrl] = useState<string>(initialBaseUrl);

  // Also set the baseUrl in the api service to skip its auto-detection
  api.setBaseUrl(initialBaseUrl);

  // Monitor server health and auto-reload on version change (e.g., after auto-upgrade)
  useHealth({ baseUrl, reloadOnVersionChange: true });

  // Monitor device TX status to show warning banner when TX is disabled
  const { isTxDisabled } = useTxStatus({ baseUrl });

  // Settings from context
  const {
    maxNodeAgeHours,
    inactiveNodeThresholdHours,
    inactiveNodeCheckIntervalMinutes,
    inactiveNodeCooldownHours,
    tracerouteIntervalMinutes,
    temperatureUnit,
    distanceUnit,
    telemetryVisualizationHours,
    favoriteTelemetryStorageDays,
    preferredSortField,
    preferredSortDirection,
    timeFormat,
    dateFormat,
    mapTileset,
    mapPinStyle,
    theme,
    language,
    solarMonitoringEnabled,
    solarMonitoringLatitude,
    solarMonitoringLongitude,
    solarMonitoringAzimuth,
    solarMonitoringDeclination,
    enableAudioNotifications,
    tapbackEmojis,
    setMaxNodeAgeHours,
    setInactiveNodeThresholdHours,
    setInactiveNodeCheckIntervalMinutes,
    setInactiveNodeCooldownHours,
    setTracerouteIntervalMinutes,
    setTemperatureUnit,
    setDistanceUnit,
    positionHistoryLineStyle,
    setPositionHistoryLineStyle,
    setTelemetryVisualizationHours,
    setFavoriteTelemetryStorageDays,
    setPreferredSortField,
    setPreferredSortDirection,
    setTimeFormat,
    setDateFormat,
    setMapTileset,
    setMapPinStyle,
    setTheme,
    setLanguage,
    setSolarMonitoringEnabled,
    setSolarMonitoringLatitude,
    setSolarMonitoringLongitude,
    setSolarMonitoringAzimuth,
    setSolarMonitoringDeclination,
  } = useSettings();

  // Map context
  const {
    showPaths,
    showRoute,
    showMqttNodes,
    showEstimatedPositions,
    setMapCenterTarget,
    traceroutes,
    setTraceroutes,
    setNeighborInfo,
    setPositionHistory,
    selectedNodeId,
    setSelectedNodeId,
  } = useMapContext();

  // Data context
  const {
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
    channelHasMore,
    setChannelHasMore,
    channelLoadingMore,
    setChannelLoadingMore,
    dmHasMore,
    setDmHasMore,
    dmLoadingMore,
    setDmLoadingMore,
  } = useData();

  // Consolidated polling for nodes, messages, channels, config
  // Enabled only when connected and not in reboot/user-disconnected state
  // When WebSocket is connected, polling interval is reduced (30s backup) as real-time
  // updates come via WebSocket. When disconnected, polls every 5s for real-time updates.
  const shouldPoll = connectionStatus === 'connected' && !showRebootModal;
  const { data: pollData, refetch: refetchPoll } = usePoll({
    baseUrl,
    enabled: shouldPoll,
    webSocketConnected,
  });

  // Get computed CSS color values for Leaflet Polyline components (which don't support CSS variables)
  const [themeColors, setThemeColors] = useState({
    mauve: '#cba6f7', // Default to Mocha theme colors
    red: '#f38ba8',
    blue: '#89b4fa', // For forward traceroute path
    overlay0: '#6c7086', // For MQTT segments (muted gray)
  });

  // Update theme colors when theme changes
  useEffect(() => {
    const rootStyle = getComputedStyle(document.documentElement);
    const mauve = rootStyle.getPropertyValue('--ctp-mauve').trim();
    const red = rootStyle.getPropertyValue('--ctp-red').trim();
    const blue = rootStyle.getPropertyValue('--ctp-blue').trim();
    const overlay0 = rootStyle.getPropertyValue('--ctp-overlay0').trim();

    if (mauve && red && blue && overlay0) {
      setThemeColors({ mauve, red, blue, overlay0 });
    }
  }, [theme]);

  // Channel Database entries for displaying names of server-decrypted channels
  const [channelDatabaseEntries, setChannelDatabaseEntries] = useState<ChannelDatabaseEntry[]>([]);

  // Fetch Channel Database entries when authenticated
  useEffect(() => {
    const fetchChannelDatabaseEntries = async () => {
      if (!authStatus?.authenticated) return;
      try {
        const response = await api.getChannelDatabaseEntries();
        if (response.success && response.data) {
          setChannelDatabaseEntries(response.data);
        }
      } catch (err) {
        // Channel database might not be accessible to all users, fail silently
        logger.debug('Failed to fetch channel database entries:', err);
      }
    };
    fetchChannelDatabaseEntries();
  }, [authStatus?.authenticated]);

  // Show news popup when authenticated user has unread news
  useEffect(() => {
    const checkUnreadNews = async () => {
      if (!authStatus?.authenticated) return;
      try {
        const response = await api.getUnreadNews();
        if (response.items && response.items.length > 0) {
          setForceShowAllNews(false);
          setShowNewsPopup(true);
        }
      } catch (err) {
        // News might not be available, fail silently
        logger.debug('Failed to fetch unread news:', err);
      }
    };
    checkUnreadNews();
  }, [authStatus?.authenticated]);

  // Messaging context
  const {
    selectedDMNode,
    setSelectedDMNode,
    selectedChannel,
    setSelectedChannel,
    newMessage,
    setNewMessage,
    replyingTo,
    setReplyingTo,
    pendingMessages: _pendingMessages, // Not used directly - we use pendingMessagesRef for interval access
    setPendingMessages,
    unreadCounts,
    setUnreadCounts,
    isChannelScrolledToBottom: _isChannelScrolledToBottom,
    setIsChannelScrolledToBottom,
    isDMScrolledToBottom: _isDMScrolledToBottom,
    setIsDMScrolledToBottom,
    markMessagesAsRead,
    unreadCountsData,
  } = useMessaging();

  // UI context
  const {
    activeTab,
    setActiveTab,
    showMqttMessages,
    setShowMqttMessages,
    error,
    setError,
    tracerouteLoading,
    setTracerouteLoading,
    nodeFilter: _nodeFilter, // Deprecated - kept for backward compatibility
    setNodeFilter: _setNodeFilter, // Deprecated
    nodesNodeFilter,
    messagesNodeFilter,
    setMessagesNodeFilter,
    securityFilter,
    setSecurityFilter,
    channelFilter,
    dmFilter,
    setDmFilter,
    sortField,
    setSortField: _setSortField,
    sortDirection,
    setSortDirection: _setSortDirection,
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
    autoAckDirectEnabled,
    setAutoAckDirectEnabled,
    autoAckDirectTapbackEnabled,
    setAutoAckDirectTapbackEnabled,
    autoAckDirectReplyEnabled,
    setAutoAckDirectReplyEnabled,
    autoAckMultihopEnabled,
    setAutoAckMultihopEnabled,
    autoAckMultihopTapbackEnabled,
    setAutoAckMultihopTapbackEnabled,
    autoAckMultihopReplyEnabled,
    setAutoAckMultihopReplyEnabled,
    autoAckTestMessages,
    setAutoAckTestMessages,
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
    showIncompleteNodes,
    setShowIncompleteNodes,
  } = useUI();

  // Check tab permissions and redirect if unauthorized
  // This prevents users from accessing protected tabs via direct URL navigation
  useEffect(() => {
    // Wait for auth to finish loading before checking permissions
    // This prevents false redirects when navigating via URL hash
    if (authLoading) {
      return;
    }

    const isAdmin = authStatus?.user?.isAdmin || false;
    const isAuthenticated = authStatus?.authenticated || false;

    // Define permission requirements for each protected tab
    const tabPermissions: Record<string, () => boolean> = {
      settings: () => hasPermission('settings', 'read'),
      automation: () => hasPermission('automation', 'read'),
      configuration: () => hasPermission('configuration', 'read'),
      notifications: () => isAuthenticated,
      users: () => isAdmin,
      admin: () => isAdmin,
      audit: () => hasPermission('audit', 'read'),
      security: () => hasPermission('security', 'read'),
    };

    // Check if current tab requires permission
    const permissionCheck = tabPermissions[activeTab];
    if (permissionCheck && !permissionCheck()) {
      // User doesn't have permission - redirect to nodes tab
      logger.info(`[Auth] Redirecting from '${activeTab}' tab - insufficient permissions`);
      setActiveTab('nodes');
    }
  }, [activeTab, authStatus, authLoading, hasPermission, setActiveTab]);

  // Helper function to safely parse node IDs to node numbers
  const parseNodeId = useCallback((nodeId: string): number => {
    try {
      const nodeNumStr = nodeId.replace('!', '');
      const result = parseInt(nodeNumStr, 16);

      if (isNaN(result)) {
        logger.error(`Failed to parse node ID: ${nodeId}`);
        throw new Error(`Invalid node ID: ${nodeId}`);
      }

      return result;
    } catch (error) {
      logger.error(`Error parsing node ID ${nodeId}:`, error);
      throw error;
    }
  }, []);

  // Track previous total unread count to detect when new messages arrive
  const previousUnreadTotal = useRef<number>(0);

  // Track the newest message ID to detect NEW messages (count-based tracking fails at the 100 message limit)
  const newestMessageId = useRef<string>('');

  // Position exchange loading state (separate from traceroute loading)
  const [positionLoading, setPositionLoading] = useState<string | null>(null);

  // NodeInfo exchange loading state (for key exchange / user info request)
  const [nodeInfoLoading, setNodeInfoLoading] = useState<string | null>(null);

  // NeighborInfo request loading state
  const [neighborInfoLoading, setNeighborInfoLoading] = useState<string | null>(null);

  // Telemetry request loading state
  const [telemetryRequestLoading, setTelemetryRequestLoading] = useState<string | null>(null);

  // Play notification sound using Web Audio API
  const playNotificationSound = useCallback(() => {
    // Check if audio notifications are enabled
    if (!enableAudioNotifications) {
      logger.debug('🔇 Audio notifications disabled, skipping sound');
      return;
    }

    try {
      logger.debug('🔊 playNotificationSound called');

      const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
      logger.debug('🔊 AudioContext created, state:', audioContext.state);

      // Resume context if suspended (browser autoplay policy)
      if (audioContext.state === 'suspended') {
        audioContext.resume();
      }

      const oscillator = audioContext.createOscillator();
      const gainNode = audioContext.createGain();

      oscillator.connect(gainNode);
      gainNode.connect(audioContext.destination);

      // Create a pleasant "ding" sound at 800Hz
      oscillator.frequency.value = 800;
      oscillator.type = 'sine';

      // Envelope: quick attack, moderate decay
      gainNode.gain.setValueAtTime(0, audioContext.currentTime);
      gainNode.gain.linearRampToValueAtTime(0.3, audioContext.currentTime + 0.01);
      gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.3);

      oscillator.start(audioContext.currentTime);
      oscillator.stop(audioContext.currentTime + 0.3);

      // Close AudioContext after sound finishes to prevent resource leak
      oscillator.onended = () => {
        audioContext.close().catch(() => {
          // Ignore close errors
        });
      };

      logger.debug('🔊 Sound started successfully');
    } catch (error) {
      logger.error('❌ Failed to play notification sound:', error);
    }
  }, [enableAudioNotifications]);

  // Update favicon with red dot when there are unread messages
  const updateFavicon = useCallback(
    (hasUnread: boolean) => {
      const favicon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
      if (!favicon) return;

      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = 32;
        canvas.height = 32;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        // Draw the original favicon
        ctx.drawImage(img, 0, 0, 32, 32);

        // Draw red dot if there are unread messages
        if (hasUnread) {
          ctx.fillStyle = '#ff4444';
          ctx.beginPath();
          ctx.arc(24, 8, 6, 0, 2 * Math.PI);
          ctx.fill();
          // Add white border for visibility
          ctx.strokeStyle = 'white';
          ctx.lineWidth = 2;
          ctx.stroke();
        }

        // Update favicon
        favicon.href = canvas.toDataURL('image/png');
      };
      img.src = `${baseUrl}/favicon-32x32.png`;
    },
    [baseUrl]
  );

  // Compute connected node name for sidebar and page title
  const connectedNodeName = useMemo(() => {
    // Find the local node from the nodes array
    let localNode = currentNodeId ? nodes.find(n => n.user?.id === currentNodeId) : null;

    // If currentNodeId isn't available, use localNodeInfo from /api/config
    if (!localNode && deviceInfo?.localNodeInfo) {
      return deviceInfo.localNodeInfo.longName;
    }

    if (localNode && localNode.user) {
      return localNode.user.longName;
    }

    return undefined;
  }, [currentNodeId, nodes, deviceInfo]);

  // Update page title when connected node name changes
  useEffect(() => {
    if (connectedNodeName) {
      document.title = `MeshMonitor – ${connectedNodeName}`;
    } else {
      document.title = 'MeshMonitor - Meshtastic Node Monitoring';
    }
  }, [connectedNodeName]);

  // Helper to fetch with credentials and automatic CSRF token retry
  // Memoized to prevent unnecessary re-renders of components that depend on it
  const authFetch = useCallback(
    async (url: string, options?: RequestInit, retryCount = 0, timeoutMs = 10000): Promise<Response> => {
      const headers = new Headers(options?.headers);

      // Add CSRF token for mutation requests
      const method = options?.method?.toUpperCase() || 'GET';
      if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(method)) {
        const csrfToken = getCsrfToken();
        if (csrfToken) {
          headers.set('X-CSRF-Token', csrfToken);
          console.log('[App] ✓ CSRF token added to request');
        } else {
          console.error('[App] ✗ NO CSRF TOKEN - Request may fail!');
        }
      }

      // Create AbortController for timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await fetch(url, {
          ...options,
          headers,
          credentials: 'include',
          signal: controller.signal,
        });

        // Handle 403 CSRF errors with automatic token refresh and retry
        if (response.status === 403 && retryCount < 1) {
          if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(method)) {
            // Clone response to check if it's a CSRF error without consuming the body
            const clonedResponse = response.clone();
            const error = await clonedResponse.json().catch(() => ({ error: '' }));
            if (error.error && error.error.toLowerCase().includes('csrf')) {
              console.warn('[App] 403 CSRF error - Refreshing token and retrying...');
              sessionStorage.removeItem('csrfToken');
              await refreshCsrfToken();
              return authFetch(url, options, retryCount + 1, timeoutMs);
            }
          }
        }

        // Silently handle auth errors to prevent console spam
        if (response.status === 401 || response.status === 403) {
          return response;
        }

        return response;
      } catch (error) {
        // Check for AbortError from both Error and DOMException for browser compatibility
        if (
          (error instanceof DOMException && error.name === 'AbortError') ||
          (error instanceof Error && error.name === 'AbortError')
        ) {
          throw new Error(`Request timeout after ${timeoutMs}ms`);
        }
        throw error;
      } finally {
        // Always clear timeout to prevent memory leaks
        clearTimeout(timeoutId);
      }
    },
    [getCsrfToken, refreshCsrfToken]
  );

  // Function to detect MQTT/bridge messages that should be filtered
  const isMqttBridgeMessage = (msg: MeshMessage): boolean => {
    // Primary check: use the viaMqtt field from the packet if available
    if (msg.viaMqtt === true) {
      return true;
    }

    // Filter messages from unknown senders
    if (msg.from === 'unknown' || msg.fromNodeId === 'unknown') {
      return true;
    }

    // Filter MQTT-related text patterns (fallback for older messages without viaMqtt)
    const mqttPatterns = [
      'mqtt.',
      'areyoumeshingwith.us',
      /^\d+\.\d+\.\d+\.[a-f0-9]+$/, // Version patterns like "2.5.7.f77c87d"
      /^\/.*\.(js|css|proto|html)/, // File paths
      /^[A-Z]{2,3}[�\x00-\x1F\x7F-\xFF]+/, // Garbage data patterns
    ];

    return mqttPatterns.some(pattern => {
      if (typeof pattern === 'string') {
        return msg.text.includes(pattern);
      } else {
        return pattern.test(msg.text);
      }
    });
  };
  const markerRefs = useRef<Map<string, L.Marker>>(new Map());

  // Load configuration and check connection status on startup
  useEffect(() => {
    const initializeApp = async () => {
      try {
        // Load configuration from server
        let configBaseUrl = '';
        try {
          const config = await api.getConfig();
          setNodeAddress(config.meshtasticNodeIp);
          configBaseUrl = config.baseUrl || '';
          setBaseUrl(configBaseUrl);
        } catch (error) {
          logger.error('Failed to load config:', error);
          setNodeAddress('192.168.1.100');
          setBaseUrl('');
        }

        // Load settings from server
        const settingsResponse = await authFetch(`${baseUrl}/api/settings`);
        if (settingsResponse.ok) {
          const settings = await settingsResponse.json();

          // Apply server settings if they exist, otherwise use localStorage/defaults
          if (settings.maxNodeAgeHours) {
            const value = parseInt(settings.maxNodeAgeHours);
            setMaxNodeAgeHours(value);
            localStorage.setItem('maxNodeAgeHours', value.toString());
          }

          if (settings.inactiveNodeThresholdHours) {
            const value = parseInt(settings.inactiveNodeThresholdHours);
            if (!isNaN(value) && value > 0) {
              setInactiveNodeThresholdHours(value);
              localStorage.setItem('inactiveNodeThresholdHours', value.toString());
            }
          }

          if (settings.inactiveNodeCheckIntervalMinutes) {
            const value = parseInt(settings.inactiveNodeCheckIntervalMinutes);
            if (!isNaN(value) && value > 0) {
              setInactiveNodeCheckIntervalMinutes(value);
              localStorage.setItem('inactiveNodeCheckIntervalMinutes', value.toString());
            }
          }

          if (settings.inactiveNodeCooldownHours) {
            const value = parseInt(settings.inactiveNodeCooldownHours);
            if (!isNaN(value) && value > 0) {
              setInactiveNodeCooldownHours(value);
              localStorage.setItem('inactiveNodeCooldownHours', value.toString());
            }
          }

          if (settings.tracerouteIntervalMinutes) {
            const value = parseInt(settings.tracerouteIntervalMinutes);
            setTracerouteIntervalMinutes(value);
            localStorage.setItem('tracerouteIntervalMinutes', value.toString());
          }

          if (settings.temperatureUnit) {
            setTemperatureUnit(settings.temperatureUnit as TemperatureUnit);
            localStorage.setItem('temperatureUnit', settings.temperatureUnit);
          }

          if (settings.distanceUnit) {
            setDistanceUnit(settings.distanceUnit as 'km' | 'mi');
            localStorage.setItem('distanceUnit', settings.distanceUnit);
          }

          if (settings.telemetryVisualizationHours) {
            const value = parseInt(settings.telemetryVisualizationHours);
            setTelemetryVisualizationHours(value);
            localStorage.setItem('telemetryVisualizationHours', value.toString());
          }

          // Automation settings - loaded from database, not localStorage
          if (settings.autoAckEnabled !== undefined) {
            setAutoAckEnabled(settings.autoAckEnabled === 'true');
          }

          if (settings.autoAckRegex) {
            setAutoAckRegex(settings.autoAckRegex);
          }

          if (settings.autoAckMessage) {
            setAutoAckMessage(settings.autoAckMessage);
          }

          if (settings.autoAckMessageDirect) {
            setAutoAckMessageDirect(settings.autoAckMessageDirect);
          }

          if (settings.autoAckChannels) {
            const channels = settings.autoAckChannels
              .split(',')
              .map((c: string) => parseInt(c.trim()))
              .filter((n: number) => !isNaN(n));
            setAutoAckChannels(channels);
          }

          if (settings.autoAckDirectMessages !== undefined) {
            setAutoAckDirectMessages(settings.autoAckDirectMessages === 'true');
          }

          if (settings.autoAckUseDM !== undefined) {
            setAutoAckUseDM(settings.autoAckUseDM === 'true');
          }

          if (settings.autoAckSkipIncompleteNodes !== undefined) {
            setAutoAckSkipIncompleteNodes(settings.autoAckSkipIncompleteNodes === 'true');
          }

          if (settings.autoAckTapbackEnabled !== undefined) {
            setAutoAckTapbackEnabled(settings.autoAckTapbackEnabled === 'true');
          }

          if (settings.autoAckReplyEnabled !== undefined) {
            setAutoAckReplyEnabled(settings.autoAckReplyEnabled !== 'false'); // Default true for backward compatibility
          }

          // New direct/multihop settings
          if (settings.autoAckDirectEnabled !== undefined) {
            setAutoAckDirectEnabled(settings.autoAckDirectEnabled !== 'false');
          }
          if (settings.autoAckDirectTapbackEnabled !== undefined) {
            setAutoAckDirectTapbackEnabled(settings.autoAckDirectTapbackEnabled !== 'false');
          }
          if (settings.autoAckDirectReplyEnabled !== undefined) {
            setAutoAckDirectReplyEnabled(settings.autoAckDirectReplyEnabled !== 'false');
          }
          if (settings.autoAckMultihopEnabled !== undefined) {
            setAutoAckMultihopEnabled(settings.autoAckMultihopEnabled !== 'false');
          }
          if (settings.autoAckMultihopTapbackEnabled !== undefined) {
            setAutoAckMultihopTapbackEnabled(settings.autoAckMultihopTapbackEnabled !== 'false');
          }
          if (settings.autoAckMultihopReplyEnabled !== undefined) {
            setAutoAckMultihopReplyEnabled(settings.autoAckMultihopReplyEnabled !== 'false');
          }

          if (settings.autoAckTestMessages) {
            setAutoAckTestMessages(settings.autoAckTestMessages);
          }

          if (settings.autoAnnounceEnabled !== undefined) {
            setAutoAnnounceEnabled(settings.autoAnnounceEnabled === 'true');
          }

          if (settings.autoAnnounceIntervalHours) {
            const value = parseInt(settings.autoAnnounceIntervalHours);
            setAutoAnnounceIntervalHours(value);
          }

          if (settings.autoAnnounceMessage) {
            setAutoAnnounceMessage(settings.autoAnnounceMessage);
          }

          if (settings.autoAnnounceChannelIndex !== undefined) {
            const value = parseInt(settings.autoAnnounceChannelIndex);
            setAutoAnnounceChannelIndex(value);
          }

          if (settings.autoAnnounceOnStart !== undefined) {
            setAutoAnnounceOnStart(settings.autoAnnounceOnStart === 'true');
          }

          if (settings.autoAnnounceUseSchedule !== undefined) {
            setAutoAnnounceUseSchedule(settings.autoAnnounceUseSchedule === 'true');
          }

          if (settings.autoAnnounceSchedule) {
            setAutoAnnounceSchedule(settings.autoAnnounceSchedule);
          }

          if (settings.autoAnnounceNodeInfoEnabled !== undefined) {
            setAutoAnnounceNodeInfoEnabled(settings.autoAnnounceNodeInfoEnabled === 'true');
          }

          if (settings.autoAnnounceNodeInfoChannels) {
            try {
              const channels = JSON.parse(settings.autoAnnounceNodeInfoChannels);
              if (Array.isArray(channels)) {
                setAutoAnnounceNodeInfoChannels(channels);
              }
            } catch (e) {
              console.error('Failed to parse autoAnnounceNodeInfoChannels:', e);
            }
          }

          if (settings.autoAnnounceNodeInfoDelaySeconds !== undefined) {
            setAutoAnnounceNodeInfoDelaySeconds(parseInt(settings.autoAnnounceNodeInfoDelaySeconds) || 30);
          }

          if (settings.autoWelcomeEnabled !== undefined) {
            setAutoWelcomeEnabled(settings.autoWelcomeEnabled === 'true');
          }

          if (settings.autoWelcomeMessage) {
            setAutoWelcomeMessage(settings.autoWelcomeMessage);
          }

          if (settings.autoWelcomeTarget) {
            setAutoWelcomeTarget(settings.autoWelcomeTarget);
          }

          if (settings.autoWelcomeWaitForName !== undefined) {
            setAutoWelcomeWaitForName(settings.autoWelcomeWaitForName === 'true');
          }

          if (settings.autoWelcomeMaxHops) {
            setAutoWelcomeMaxHops(parseInt(settings.autoWelcomeMaxHops));
          }

          if (settings.autoResponderEnabled !== undefined) {
            setAutoResponderEnabled(settings.autoResponderEnabled === 'true');
          }

          if (settings.autoResponderTriggers) {
            try {
              const triggers = JSON.parse(settings.autoResponderTriggers);
              setAutoResponderTriggers(triggers);
            } catch (e) {
              console.error('Failed to parse autoResponderTriggers:', e);
            }
          }

          if (settings.autoResponderSkipIncompleteNodes !== undefined) {
            setAutoResponderSkipIncompleteNodes(settings.autoResponderSkipIncompleteNodes === 'true');
          }

          // Auto key management settings
          if (settings.autoKeyManagementEnabled !== undefined) {
            setAutoKeyManagementEnabled(settings.autoKeyManagementEnabled === 'true');
          }
          if (settings.autoKeyManagementIntervalMinutes !== undefined) {
            setAutoKeyManagementIntervalMinutes(parseInt(settings.autoKeyManagementIntervalMinutes) || 5);
          }
          if (settings.autoKeyManagementMaxExchanges !== undefined) {
            setAutoKeyManagementMaxExchanges(parseInt(settings.autoKeyManagementMaxExchanges) || 3);
          }
          if (settings.autoKeyManagementAutoPurge !== undefined) {
            setAutoKeyManagementAutoPurge(settings.autoKeyManagementAutoPurge === 'true');
          }

          if (settings.timerTriggers) {
            try {
              const triggers = JSON.parse(settings.timerTriggers);
              setTimerTriggers(triggers);
            } catch (e) {
              console.error('Failed to parse timerTriggers:', e);
            }
          }

          if (settings.geofenceTriggers) {
            try {
              const triggers = JSON.parse(settings.geofenceTriggers);
              setGeofenceTriggers(triggers);
            } catch (e) {
              console.error('Failed to parse geofenceTriggers:', e);
            }
          }

          // Hide incomplete nodes setting
          if (settings.hideIncompleteNodes !== undefined) {
            logger.debug(`📋 Loading hideIncompleteNodes setting: ${settings.hideIncompleteNodes}`);
            setShowIncompleteNodes(settings.hideIncompleteNodes !== '1');
          } else {
            logger.debug('📋 hideIncompleteNodes setting not found in database');
          }
        }

        // Check connection status with the loaded baseUrl
        await checkConnectionStatus(configBaseUrl);
      } catch (_error) {
        setNodeAddress('192.168.1.100');
        setError('Failed to load configuration');
      }
    };

    initializeApp();
  }, []);

  // Check for default admin password
  useEffect(() => {
    const checkDefaultPassword = async () => {
      try {
        const response = await authFetch(`${baseUrl}/api/auth/check-default-password`);
        if (response.ok) {
          const data = await response.json();
          setIsDefaultPassword(data.isDefaultPassword);
        }
      } catch (error) {
        logger.error('Error checking default password:', error);
      }
    };

    checkDefaultPassword();
  }, [baseUrl]);

  // Check for configuration issues
  useEffect(() => {
    const checkConfigIssues = async () => {
      try {
        const response = await authFetch(`${baseUrl}/api/auth/check-config-issues`);
        if (response.ok) {
          const data = await response.json();
          setConfigIssues(data.issues || []);
        }
      } catch (error) {
        logger.error('Error checking config issues:', error);
      }
    };

    checkConfigIssues();
  }, [baseUrl]);

  // TX status is now handled by useTxStatus hook

  // Check for version updates
  useEffect(() => {
    const checkForUpdates = async (interval: number) => {
      try {
        const response = await fetch(`${baseUrl}/api/version/check`);
        if (response.ok) {
          const data = await response.json();

          // Always update version info if a newer version exists
          if (data.latestVersion && data.latestVersion !== data.currentVersion) {
            setLatestVersion(data.latestVersion);
            setReleaseUrl(data.releaseUrl);
          }

          // Only show update available if images are ready
          if (data.updateAvailable) {
            setUpdateAvailable(true);
          } else {
            setUpdateAvailable(false);
          }

          // If auto-upgrade was triggered by the server, check for active upgrade status
          // This handles the case when auto-upgrade immediate is enabled
          if (data.autoUpgradeTriggered && !upgradeInProgress) {
            logger.info('Auto-upgrade was triggered by server, checking for active upgrade...');
            // The upgrade status will be picked up by the checkUpgradeStatus effect
            // but we can also immediately fetch it here
            try {
              const statusResponse = await authFetch(`${baseUrl}/api/upgrade/status`);
              if (statusResponse.ok) {
                const statusData = await statusResponse.json();
                if (statusData.activeUpgrade) {
                  setUpgradeInProgress(true);
                  setUpgradeId(statusData.activeUpgrade.upgradeId);
                  setUpgradeStatus(statusData.activeUpgrade.currentStep);
                  setUpgradeProgress(statusData.activeUpgrade.progress);
                  pollUpgradeStatus(statusData.activeUpgrade.upgradeId);
                }
              }
            } catch (statusError) {
              logger.debug('Failed to fetch upgrade status after auto-upgrade trigger:', statusError);
            }
          }
        } else if (response.status == 404) {
          clearInterval(interval);
        }
      } catch (error) {
        logger.error('Error checking for updates:', error);
      }
    };

    // Check for updates every 4 hours
    const interval = setInterval(checkForUpdates, 4 * 60 * 60 * 1000);

    checkForUpdates(interval);

    return () => clearInterval(interval);
  }, [baseUrl]);

  // Check if auto-upgrade is enabled and if an upgrade is already in progress
  useEffect(() => {
    const checkUpgradeStatus = async () => {
      try {
        const response = await authFetch(`${baseUrl}/api/upgrade/status`);
        if (response.ok) {
          const data = await response.json();
          setUpgradeEnabled(data.enabled && data.deploymentMethod === 'docker');

          // If an upgrade is already in progress (e.g., auto-upgrade was triggered),
          // set the upgrade state and start polling for status
          if (data.activeUpgrade && !upgradeInProgress) {
            logger.info('Active upgrade detected, resuming progress tracking');
            setUpgradeInProgress(true);
            setUpgradeId(data.activeUpgrade.upgradeId);
            setUpgradeStatus(data.activeUpgrade.currentStep);
            setUpgradeProgress(data.activeUpgrade.progress);
            setLatestVersion(data.activeUpgrade.toVersion);
            setUpdateAvailable(true);
            // Start polling for status updates
            pollUpgradeStatus(data.activeUpgrade.upgradeId);
          }
        }
      } catch (error) {
        logger.debug('Auto-upgrade not available:', error);
      }
    };

    checkUpgradeStatus();
  }, [baseUrl, authFetch]);

  // Cleanup upgrade polling on unmount
  useEffect(() => {
    return () => {
      if (upgradePollingIntervalRef.current) {
        clearInterval(upgradePollingIntervalRef.current);
        upgradePollingIntervalRef.current = null;
      }
    };
  }, []);

  // Handle upgrade trigger
  const handleUpgrade = async () => {
    if (!updateAvailable || upgradeInProgress) return;

    try {
      setUpgradeInProgress(true);
      setUpgradeStatus('Initiating upgrade...');
      setUpgradeProgress(0);

      const response = await authFetch(`${baseUrl}/api/upgrade/trigger`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          targetVersion: latestVersion,
          backup: true,
        }),
      });

      const data = await response.json();

      if (data.success) {
        setUpgradeId(data.upgradeId);
        setUpgradeStatus('Upgrade initiated...');
        showToast?.('Upgrade initiated! The application will restart shortly.', 'info');

        // Poll for status updates
        pollUpgradeStatus(data.upgradeId);
      } else {
        showToast?.(`Upgrade failed: ${data.message}`, 'error');
        setUpgradeInProgress(false);
        setUpgradeStatus('');
      }
    } catch (error) {
      logger.error('Error triggering upgrade:', error);
      showToast?.('Failed to trigger upgrade', 'error');
      setUpgradeInProgress(false);
      setUpgradeStatus('');
    }
  };

  // Poll upgrade status with exponential backoff
  const pollUpgradeStatus = (id: string) => {
    // Clear any existing polling interval
    if (upgradePollingIntervalRef.current) {
      clearInterval(upgradePollingIntervalRef.current);
      upgradePollingIntervalRef.current = null;
    }

    let attempts = 0;
    const maxAttempts = 60; // Max attempts before timeout
    const baseInterval = 10000; // Start at 10 seconds (reduced from 5s to limit server load)
    const maxInterval = 30000; // Cap at 30 seconds (increased from 15s)
    let currentInterval = baseInterval;

    const poll = async () => {
      attempts++;

      try {
        const response = await authFetch(`${baseUrl}/api/upgrade/status/${id}`);
        if (response.ok) {
          const data = await response.json();

          setUpgradeStatus(data.currentStep || data.status);
          setUpgradeProgress(data.progress || 0);

          // Update status messages
          if (data.status === 'complete') {
            if (upgradePollingIntervalRef.current) {
              clearInterval(upgradePollingIntervalRef.current);
              upgradePollingIntervalRef.current = null;
            }
            showToast?.('Upgrade complete! Reloading...', 'success');
            setUpgradeStatus('Complete! Reloading...');
            setUpgradeProgress(100);

            // Reload after 3 seconds
            setTimeout(() => {
              window.location.reload();
            }, 3000);
            return;
          } else if (data.status === 'failed') {
            if (upgradePollingIntervalRef.current) {
              clearInterval(upgradePollingIntervalRef.current);
              upgradePollingIntervalRef.current = null;
            }
            showToast?.('Upgrade failed. Check logs for details.', 'error');
            setUpgradeInProgress(false);
            setUpgradeStatus('Failed');
            return;
          }

          // Reset interval on successful response (application is responsive)
          currentInterval = baseInterval;
        }
      } catch (error) {
        // Connection may be lost during restart - this is expected
        // Use exponential backoff for retries
        currentInterval = Math.min(currentInterval * 1.5, maxInterval);
        logger.debug('Polling upgrade status (connection may be restarting):', error);
      }

      // Stop polling after max attempts
      if (attempts >= maxAttempts) {
        if (upgradePollingIntervalRef.current) {
          clearInterval(upgradePollingIntervalRef.current);
          upgradePollingIntervalRef.current = null;
        }
        setUpgradeInProgress(false);
        setUpgradeStatus('Upgrade timeout - check status manually');
        return;
      }

      // Schedule next poll with current interval
      upgradePollingIntervalRef.current = setTimeout(poll, currentInterval) as unknown as ReturnType<
        typeof setInterval
      >;
    };

    // Start polling
    poll();
  };

  // Debug effect to track selectedChannel changes and keep ref in sync
  useEffect(() => {
    logger.debug('🔄 selectedChannel state changed to:', selectedChannel);
    selectedChannelRef.current = selectedChannel;
  }, [selectedChannel]);

  // Keep refs in sync for interval closure
  useEffect(() => {
    showRebootModalRef.current = showRebootModal;
  }, [showRebootModal]);

  useEffect(() => {
    connectionStatusRef.current = connectionStatus;
  }, [connectionStatus]);

  // Traceroutes are now synced via the poll mechanism (processPollData)
  // This provides consistent data across Dashboard Widget, Node View, and Traceroute History Modal

  // Fetch neighbor info when connected (needed for both map display and Messages tab)
  useEffect(() => {
    if (shouldShowData()) {
      fetchNeighborInfo();
      // Only auto-refresh when connected (not when viewing cached data)
      if (connectionStatus === 'connected') {
        const interval = setInterval(fetchNeighborInfo, 60000); // Refresh every 60 seconds
        return () => clearInterval(interval);
      }
    }
  }, [connectionStatus]);

  // Fetch position history when a mobile node is selected
  useEffect(() => {
    if (!selectedNodeId) {
      setPositionHistory([]);
      return;
    }

    const selectedNode = nodes.find(n => n.user?.id === selectedNodeId);
    if (!selectedNode || !selectedNode.isMobile) {
      setPositionHistory([]);
      return;
    }

    const fetchPositionHistory = async () => {
      try {
        // Fetch all position history (no time limit) to show complete movement trail
        const response = await authFetch(`${baseUrl}/api/nodes/${selectedNodeId}/position-history`);
        if (response.ok) {
          const history = await response.json();
          setPositionHistory(history);
        }
      } catch (error) {
        logger.error('Error fetching position history:', error);
      }
    };

    fetchPositionHistory();
  }, [selectedNodeId, nodes, baseUrl]);

  // Open popup for selected node
  useEffect(() => {
    if (selectedNodeId) {
      // Delay opening popup to ensure MapCenterController completes first
      // This prevents competing pan operations
      const timer = setTimeout(() => {
        const marker = markerRefs.current.get(selectedNodeId);
        if (marker) {
          // Open popup without autopanning - let MapCenterController handle positioning
          const popup = marker.getPopup();
          if (popup) {
            popup.options.autoPan = false;
          }
          marker.openPopup();
        }
      }, 100); // Small delay to let MapCenterController start

      return () => clearTimeout(timer);
    }
  }, [selectedNodeId]);

  // Save node filters to localStorage whenever they change
  useEffect(() => {
    localStorage.setItem('nodeFilters', JSON.stringify(nodeFilters));
  }, [nodeFilters]);

  // Check if container is scrolled near bottom (within 100px)
  const isScrolledNearBottom = useCallback((container: HTMLDivElement | null): boolean => {
    if (!container) return true;
    const threshold = 100;
    const { scrollTop, scrollHeight, clientHeight } = container;
    return scrollHeight - scrollTop - clientHeight < threshold;
  }, []);

  // Check if container is scrolled near top (within 100px)
  const isScrolledNearTop = useCallback((container: HTMLDivElement | null): boolean => {
    if (!container) return false;
    return container.scrollTop < 100;
  }, []);

  // Load more channel messages (for infinite scroll)
  const loadMoreChannelMessages = useCallback(async () => {
    if (channelLoadingMore[selectedChannel] || channelHasMore[selectedChannel] === false) {
      return;
    }

    const currentMessages = channelMessages[selectedChannel] || [];
    const offset = currentMessages.length;
    const container = channelMessagesContainerRef.current;

    // Store scroll position before loading
    const scrollHeightBefore = container?.scrollHeight || 0;

    setChannelLoadingMore(prev => ({ ...prev, [selectedChannel]: true }));

    try {
      const result = await api.getChannelMessages(selectedChannel, 100, offset);

      if (result.messages.length > 0) {
        // Process timestamps for new messages
        const processedMessages = result.messages.map(msg => ({
          ...msg,
          timestamp: new Date(msg.timestamp),
        }));

        // Prepend older messages to the existing list, deduplicating by id
        setChannelMessages(prev => {
          const existingMessages = prev[selectedChannel] || [];
          const existingIds = new Set(existingMessages.map(m => m.id));
          const newMessages = processedMessages.filter(m => !existingIds.has(m.id));
          return {
            ...prev,
            [selectedChannel]: [...newMessages, ...existingMessages],
          };
        });

        // Restore scroll position after messages are prepended
        requestAnimationFrame(() => {
          if (container) {
            const scrollHeightAfter = container.scrollHeight;
            container.scrollTop = scrollHeightAfter - scrollHeightBefore;
          }
        });
      }

      setChannelHasMore(prev => ({ ...prev, [selectedChannel]: result.hasMore }));
    } catch (error) {
      logger.error('Failed to load more channel messages:', error);
      showToast(t('toast.failed_load_older_messages'), 'error');
    } finally {
      setChannelLoadingMore(prev => ({ ...prev, [selectedChannel]: false }));
    }
  }, [
    selectedChannel,
    channelLoadingMore,
    channelHasMore,
    channelMessages,
    setChannelMessages,
    setChannelHasMore,
    setChannelLoadingMore,
    showToast,
  ]);

  // Load more direct messages (for infinite scroll)
  const loadMoreDirectMessages = useCallback(async () => {
    if (!selectedDMNode || !currentNodeId) return;

    const dmKey = [currentNodeId, selectedDMNode].sort().join('_');
    if (dmLoadingMore[dmKey] || dmHasMore[dmKey] === false) {
      return;
    }

    // Get current DM messages from the messages array (channel -1 or direct messages)
    const currentDMs = messages.filter(
      msg =>
        (msg.fromNodeId === currentNodeId && msg.toNodeId === selectedDMNode) ||
        (msg.fromNodeId === selectedDMNode && msg.toNodeId === currentNodeId)
    );
    const offset = currentDMs.length;
    const container = dmMessagesContainerRef.current;

    // Store scroll position before loading
    const scrollHeightBefore = container?.scrollHeight || 0;

    setDmLoadingMore(prev => ({ ...prev, [dmKey]: true }));

    try {
      const result = await api.getDirectMessages(currentNodeId, selectedDMNode, 100, offset);

      if (result.messages.length > 0) {
        // Process timestamps for new messages
        const processedMessages = result.messages.map(msg => ({
          ...msg,
          timestamp: new Date(msg.timestamp),
        }));

        // Prepend older messages to the existing list
        setMessages(prev => {
          // Remove duplicates by id
          const existingIds = new Set(prev.map(m => m.id));
          const newMessages = processedMessages.filter(m => !existingIds.has(m.id));
          return [...newMessages, ...prev];
        });

        // Restore scroll position after messages are prepended
        requestAnimationFrame(() => {
          if (container) {
            const scrollHeightAfter = container.scrollHeight;
            container.scrollTop = scrollHeightAfter - scrollHeightBefore;
          }
        });
      }

      setDmHasMore(prev => ({ ...prev, [dmKey]: result.hasMore }));
    } catch (error) {
      logger.error('Failed to load more direct messages:', error);
      showToast(t('toast.failed_load_older_messages'), 'error');
    } finally {
      setDmLoadingMore(prev => ({ ...prev, [dmKey]: false }));
    }
  }, [
    selectedDMNode,
    currentNodeId,
    dmLoadingMore,
    dmHasMore,
    messages,
    setMessages,
    setDmHasMore,
    setDmLoadingMore,
    showToast,
  ]);

  // Handle scroll events to track scroll position (throttled for load-more)
  const handleChannelScroll = useCallback(() => {
    if (channelMessagesContainerRef.current) {
      const atBottom = isScrolledNearBottom(channelMessagesContainerRef.current);
      setIsChannelScrolledToBottom(atBottom);

      // Check if scrolled near top and trigger load more (throttled to 200ms)
      const now = Date.now();
      if (isScrolledNearTop(channelMessagesContainerRef.current) && now - lastScrollLoadTimeRef.current > 200) {
        lastScrollLoadTimeRef.current = now;
        loadMoreChannelMessages();
      }
    }
  }, [isScrolledNearBottom, isScrolledNearTop, loadMoreChannelMessages]);

  const handleDMScroll = useCallback(() => {
    if (dmMessagesContainerRef.current) {
      const atBottom = isScrolledNearBottom(dmMessagesContainerRef.current);
      setIsDMScrolledToBottom(atBottom);

      // Check if scrolled near top and trigger load more (throttled to 200ms)
      const now = Date.now();
      if (isScrolledNearTop(dmMessagesContainerRef.current) && now - lastScrollLoadTimeRef.current > 200) {
        lastScrollLoadTimeRef.current = now;
        loadMoreDirectMessages();
      }
    }
  }, [isScrolledNearBottom, isScrolledNearTop, loadMoreDirectMessages]);

  // Attach scroll event listeners
  useEffect(() => {
    const channelContainer = channelMessagesContainerRef.current;
    const dmContainer = dmMessagesContainerRef.current;

    if (channelContainer) {
      channelContainer.addEventListener('scroll', handleChannelScroll);
    }
    if (dmContainer) {
      dmContainer.addEventListener('scroll', handleDMScroll);
    }

    return () => {
      if (channelContainer) {
        channelContainer.removeEventListener('scroll', handleChannelScroll);
      }
      if (dmContainer) {
        dmContainer.removeEventListener('scroll', handleDMScroll);
      }
    };
  }, [handleChannelScroll, handleDMScroll]);

  // Force scroll to bottom when channel changes OR when switching to channels tab
  // Note: We track initial scroll per channel to avoid re-scrolling when user manually scrolls
  useEffect(() => {
    if (activeTab === 'channels' && selectedChannel >= 0) {
      const currentChannelMessages = channelMessages[selectedChannel] || [];
      const hasMessages = currentChannelMessages.length > 0;

      // Always scroll to bottom when entering the channels tab or changing channels
      if (hasMessages) {
        // Use setTimeout to ensure messages are rendered before scrolling
        setTimeout(() => {
          if (channelMessagesContainerRef.current) {
            channelMessagesContainerRef.current.scrollTop = channelMessagesContainerRef.current.scrollHeight;
            setIsChannelScrolledToBottom(true);
          }
        }, 100);
      }
    }
  }, [selectedChannel, activeTab]);

  // Auto-load more channel messages if container doesn't have a scrollbar
  // This fixes the case where a channel has no recent messages and infinite scroll never triggers
  useEffect(() => {
    if (activeTab === 'channels' && selectedChannel >= 0) {
      // Skip if we're already loading or know there are no more messages
      if (channelLoadingMore[selectedChannel] || channelHasMore[selectedChannel] === false) {
        return;
      }

      // Check after a delay to allow the DOM to render
      const checkTimer = setTimeout(() => {
        const container = channelMessagesContainerRef.current;
        if (container) {
          // If container doesn't have a scrollbar, load more messages
          const hasScrollbar = container.scrollHeight > container.clientHeight;
          if (!hasScrollbar) {
            loadMoreChannelMessages();
          }
        }
      }, 200);

      return () => clearTimeout(checkTimer);
    }
  }, [selectedChannel, activeTab, channelLoadingMore, channelHasMore, loadMoreChannelMessages]);

  // Force scroll to bottom when DM node changes OR when switching to messages tab
  useEffect(() => {
    if (activeTab === 'messages' && selectedDMNode && currentNodeId) {
      const currentDMMessages = messages.filter(
        msg =>
          (msg.fromNodeId === currentNodeId && msg.toNodeId === selectedDMNode) ||
          (msg.fromNodeId === selectedDMNode && msg.toNodeId === currentNodeId)
      );
      const hasMessages = currentDMMessages.length > 0;

      // Always scroll to bottom when entering the messages tab or changing conversations
      if (hasMessages) {
        setTimeout(() => {
          if (dmMessagesContainerRef.current) {
            dmMessagesContainerRef.current.scrollTop = dmMessagesContainerRef.current.scrollHeight;
            setIsDMScrolledToBottom(true);
          }
        }, 150);
      }
    }
  }, [selectedDMNode, activeTab, currentNodeId]);

  // Auto-load more DM messages if container doesn't have a scrollbar
  // This fixes the case where a conversation has no recent messages and infinite scroll never triggers
  useEffect(() => {
    if (activeTab === 'messages' && selectedDMNode && currentNodeId) {
      const dmKey = [currentNodeId, selectedDMNode].sort().join('_');

      // Skip if we're already loading or know there are no more messages
      if (dmLoadingMore[dmKey] || dmHasMore[dmKey] === false) {
        return;
      }

      // Check after a delay to allow the DOM to render
      const checkTimer = setTimeout(() => {
        const container = dmMessagesContainerRef.current;
        if (container) {
          // If container doesn't have a scrollbar, load more messages
          const hasScrollbar = container.scrollHeight > container.clientHeight;
          if (!hasScrollbar) {
            loadMoreDirectMessages();
          }
        }
      }, 200);

      return () => clearTimeout(checkTimer);
    }
  }, [selectedDMNode, activeTab, currentNodeId, dmLoadingMore, dmHasMore, loadMoreDirectMessages]);

  // Unread counts polling is now handled by useUnreadCounts hook in MessagingContext

  // Mark messages as read when viewing a channel
  useEffect(() => {
    if (activeTab === 'channels' && selectedChannel >= 0) {
      // Mark all messages in the selected channel as read
      console.log('📖 Marking channel messages as read:', selectedChannel);
      logger.debug('📖 Marking channel messages as read:', selectedChannel);
      markMessagesAsRead(undefined, selectedChannel);
    }
  }, [selectedChannel, activeTab, markMessagesAsRead]);

  // Mark messages as read when viewing a DM conversation
  useEffect(() => {
    if (activeTab === 'messages' && selectedDMNode) {
      // Mark all DMs with the selected node as read
      console.log('📖 Marking DM messages as read with node:', selectedDMNode);
      logger.debug('📖 Marking DM messages as read with node:', selectedDMNode);
      markMessagesAsRead(undefined, undefined, selectedDMNode);
    }
  }, [selectedDMNode, activeTab, markMessagesAsRead]);

  // Handle push notification navigation (click on notification -> navigate to channel/DM and scroll to message)
  useNotificationNavigationHandler(
    {
      setActiveTab,
      setSelectedChannel,
      setSelectedDMNode,
      selectedChannelRef,
    },
    {
      connectionStatus,
      channels,
      activeTab,
      selectedChannel,
      selectedDMNode,
    }
  );

  // Update favicon when unread counts change
  useEffect(() => {
    const hasUnreadChannels = unreadCountsData?.channels
      ? Object.values(unreadCountsData.channels).some(count => count > 0)
      : false;
    const hasUnreadDMs = unreadCountsData?.directMessages
      ? Object.values(unreadCountsData.directMessages).some(count => count > 0)
      : false;

    console.log('🔴 Unread counts updated:', {
      channels: unreadCountsData?.channels,
      directMessages: unreadCountsData?.directMessages,
      hasUnreadChannels,
      hasUnreadDMs,
    });
    logger.debug('🔴 Unread counts updated:', {
      channels: unreadCountsData?.channels,
      directMessages: unreadCountsData?.directMessages,
      hasUnreadChannels,
      hasUnreadDMs,
    });

    updateFavicon(hasUnreadChannels || hasUnreadDMs);

    // Track unread count for future features (notification sound now handled by message count)
    const channelUnreadTotal = unreadCountsData?.channels
      ? Object.values(unreadCountsData.channels).reduce((sum, count) => sum + count, 0)
      : 0;
    const dmUnreadTotal = unreadCountsData?.directMessages
      ? Object.values(unreadCountsData.directMessages).reduce((sum, count) => sum + count, 0)
      : 0;
    const totalUnread = channelUnreadTotal + dmUnreadTotal;
    previousUnreadTotal.current = totalUnread;
  }, [unreadCountsData, updateFavicon]);

  // Connection status check (every 5 seconds when not connected)
  // Note: Data polling is now handled by usePoll hook when connected
  useEffect(() => {
    const updateInterval = setInterval(() => {
      // Use refs to get current values without adding to deps (prevents interval multiplication)
      const currentConnectionStatus = connectionStatusRef.current;
      const currentShowRebootModal = showRebootModalRef.current;

      // Skip when user has manually disconnected or device is rebooting
      if (currentConnectionStatus === 'user-disconnected' || currentConnectionStatus === 'rebooting') {
        return;
      }

      // Skip when RebootModal is active
      if (currentShowRebootModal) {
        return;
      }

      // Only check connection status when not connected
      // Data polling when connected is handled by usePoll hook
      if (currentConnectionStatus !== 'connected') {
        checkConnectionStatus();
      }
    }, 5000);

    return () => clearInterval(updateInterval);
  }, []); // Empty deps - interval created only once, uses refs for current values

  // Scheduled node database refresh (every 60 minutes)
  useEffect(() => {
    const scheduleNodeRefresh = () => {
      if (connectionStatus === 'connected') {
        logger.debug('🔄 Performing scheduled node database refresh...');
        requestFullNodeDatabase();
      }
    };

    // Initial refresh after 5 minutes of being connected
    const initialRefreshTimer = setTimeout(() => {
      scheduleNodeRefresh();
    }, 5 * 60 * 1000);

    // Then every 60 minutes
    const regularRefreshInterval = setInterval(() => {
      scheduleNodeRefresh();
    }, 60 * 60 * 1000);

    return () => {
      clearTimeout(initialRefreshTimer);
      clearInterval(regularRefreshInterval);
    };
  }, [connectionStatus]);

  // Timer to update message status indicators (timeout detection after 30s)
  // Only runs when on channels/messages tabs to reduce CPU usage on mobile (#1769)
  const [, setStatusTick] = useState(0);
  useEffect(() => {
    // Only run timer when viewing messaging tabs where status indicators are visible
    if (activeTab !== 'channels' && activeTab !== 'messages') {
      return;
    }

    const interval = setInterval(() => {
      // Force re-render to update message status indicators
      setStatusTick(prev => prev + 1);
    }, 5000); // Update every 5 seconds (reduced from 1s for mobile performance)

    return () => clearInterval(interval);
  }, [activeTab]);

  const requestFullNodeDatabase = async () => {
    try {
      logger.debug('📡 Requesting full node database refresh...');
      const response = await authFetch(`${baseUrl}/api/nodes/refresh`, {
        method: 'POST',
      });

      if (response.ok) {
        logger.debug('✅ Node database refresh initiated');
        // Immediately update local data after refresh
        setTimeout(() => refetchPoll(), 2000);
      } else {
        logger.warn('⚠️ Node database refresh request failed');
      }
    } catch (error) {
      logger.error('❌ Error requesting node database refresh:', error);
    }
  };

  // Poll for device reconnection after a reboot
  const waitForDeviceReconnection = async (): Promise<boolean> => {
    try {
      // Wait 30 seconds for device to reboot
      logger.debug('⏳ Waiting 30 seconds for device to reboot...');
      await new Promise(resolve => setTimeout(resolve, 30000));

      // Try to reconnect - poll every 3 seconds for up to 60 seconds
      logger.debug('🔌 Attempting to reconnect...');
      const maxAttempts = 20; // 20 attempts * 3 seconds = 60 seconds
      let attempts = 0;

      while (attempts < maxAttempts) {
        try {
          const response = await authFetch(`${baseUrl}/api/connection`);
          if (response.ok) {
            const status = await response.json();
            if (status.connected) {
              logger.debug('✅ Device reconnected successfully!');
              // Trigger full reconnection sequence
              await checkConnectionStatus();
              return true;
            }
          }
        } catch (_error) {
          // Connection still not available, continue polling
        }

        attempts++;
        logger.debug(`🔄 Reconnection attempt ${attempts}/${maxAttempts}...`);
        await new Promise(resolve => setTimeout(resolve, 3000));
      }

      // Timeout - couldn't reconnect
      logger.error('❌ Failed to reconnect after 60 seconds');
      setConnectionStatus('disconnected');
      return false;
    } catch (error) {
      logger.error('❌ Error during reconnection:', error);
      setConnectionStatus('disconnected');
      return false;
    }
  };

  const handleConfigChangeTriggeringReboot = () => {
    logger.debug('⚙️ Config change sent, device will reboot to apply changes...');
    setConnectionStatus('rebooting');

    // Show reboot modal
    setShowRebootModal(true);
  };

  const handleRebootModalClose = () => {
    logger.debug('✅ Device reboot complete and verified');
    console.log('[App] Reboot modal closing - will trigger config refresh');
    setShowRebootModal(false);
    setConnectionStatus('connected');

    // Refresh all data after reboot - usePoll fetches nodes, messages, channels, config, telemetry
    refetchPoll();

    // Trigger config refresh in ConfigurationTab
    setConfigRefreshTrigger(prev => {
      const newValue = prev + 1;
      console.log(`[App] Incrementing configRefreshTrigger: ${prev} → ${newValue}`);
      return newValue;
    });
  };

  const handleRebootDevice = async (): Promise<boolean> => {
    try {
      logger.debug('🔄 Initiating device reboot sequence...');

      // Set status to rebooting
      setConnectionStatus('rebooting');

      // Send reboot command
      await api.rebootDevice(5);
      logger.debug('✅ Reboot command sent, device will restart in 5 seconds');

      // Wait for reconnection
      return await waitForDeviceReconnection();
    } catch (error) {
      logger.error('❌ Error during reboot sequence:', error);
      setConnectionStatus('disconnected');
      return false;
    }
  };

  const checkConnectionStatus = async (providedBaseUrl?: string) => {
    // Use the provided baseUrl or fall back to the state value
    const urlBase = providedBaseUrl !== undefined ? providedBaseUrl : baseUrl;

    try {
      // Use consolidated polling endpoint to check connection status
      const response = await authFetch(`${urlBase}/api/poll`);
      if (response.ok) {
        const pollData = await response.json();
        const status = pollData.connection;

        if (!status) {
          logger.error('No connection status in poll response');
          return;
        }

        logger.debug(
          `📡 Connection API response: connected=${status.connected}, nodeResponsive=${status.nodeResponsive}, configuring=${status.configuring}, userDisconnected=${status.userDisconnected}`
        );

        // Check if user has manually disconnected
        if (status.userDisconnected) {
          logger.debug('⏸️  User-initiated disconnect detected');
          setConnectionStatus('user-disconnected');

          // Still fetch cached data from backend on page load
          // This ensures we show cached data even after refresh
          try {
            await fetchChannels(urlBase);
            await refetchPoll();
          } catch (error) {
            logger.error('Failed to fetch cached data while disconnected:', error);
          }
          return;
        }

        // Check if node is in initial config capture phase
        if (status.connected && status.configuring) {
          logger.debug('⚙️  Node is downloading initial configuration');
          setConnectionStatus('configuring');
          setError(`Downloading initial configuration from node. The interface will be available shortly.`);
          return;
        }

        // Check if server connected but node is not responsive
        if (status.connected && !status.nodeResponsive) {
          logger.debug('⚠️  Server connected but node is not responsive');
          setConnectionStatus('node-offline');
          setError(
            `Connected to server, but Meshtastic node is not responding. Please check if the device is powered on and properly connected.`
          );
          return;
        }

        if (status.connected && status.nodeResponsive) {
          // Use updater function to get current state and decide whether to initialize
          setConnectionStatus(currentStatus => {
            logger.debug(`🔍 Current connection status: ${currentStatus}`);
            if (currentStatus !== 'connected') {
              logger.debug(`🔗 Connection established, will initialize... (transitioning from ${currentStatus})`);
              // Set to configuring and trigger initialization
              (async () => {
                setConnectionStatus('configuring');
                setError(null);

                // Improved initialization sequence
                try {
                  await fetchChannels(urlBase);
                  await refetchPoll();
                  setConnectionStatus('connected');
                  logger.debug('✅ Initialization complete, status set to connected');
                } catch (initError) {
                  logger.error('❌ Initialization failed:', initError);
                  setConnectionStatus('connected');
                }
              })();
              return 'configuring';
            } else {
              logger.debug('ℹ️ Already connected, skipping initialization');
              return currentStatus;
            }
          });
        } else {
          logger.debug('⚠️ Connection API returned connected=false');
          setConnectionStatus('disconnected');
          setError(
            `Cannot connect to Meshtastic node at ${nodeAddress}. Please ensure the node is reachable and has HTTP API enabled.`
          );
        }
      } else {
        logger.debug('⚠️ Connection API request failed');
        setConnectionStatus('disconnected');
        setError('Failed to get connection status from server');
      }
    } catch (err) {
      logger.debug('❌ Connection check error:', err);
      setConnectionStatus('disconnected');
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      setError(`Server connection error: ${errorMessage}`);
    }
  };

  // fetchTraceroutes removed - traceroutes are now synced via poll mechanism

  const fetchNeighborInfo = async () => {
    try {
      const response = await authFetch(`${baseUrl}/api/neighbor-info`);
      if (response.ok) {
        const data = await response.json();
        setNeighborInfo(data);
      }
    } catch (error) {
      logger.error('Error fetching neighbor info:', error);
    }
  };

  const fetchSystemStatus = async () => {
    try {
      const response = await authFetch(`${baseUrl}/api/system/status`);
      if (response.ok) {
        const data = await response.json();
        setSystemStatus(data);
        setShowStatusModal(true);
      }
    } catch (error) {
      logger.error('Error fetching system status:', error);
    }
  };

  const fetchChannels = useCallback(
    async (providedBaseUrl?: string) => {
      // Use the provided baseUrl or fall back to the state value
      const urlBase = providedBaseUrl !== undefined ? providedBaseUrl : baseUrl;
      try {
        const channelsResponse = await authFetch(`${urlBase}/api/channels`);
        if (channelsResponse.ok) {
          const channelsData = await channelsResponse.json();

          // Only update selected channel if this is the first time we're loading channels
          // and no channel is currently selected, or if the current selected channel no longer exists
          const currentSelectedChannel = selectedChannelRef.current;
          logger.debug('🔍 Channel update check:', {
            channelsLength: channelsData.length,
            hasSelectedInitialChannel: hasSelectedInitialChannelRef.current,
            selectedChannelState: selectedChannel,
            selectedChannelRef: currentSelectedChannel,
            firstChannelId: channelsData[0]?.id,
          });

          if (channelsData.length > 0) {
            if (!hasSelectedInitialChannelRef.current && currentSelectedChannel === -1) {
              // First time loading channels - select the first one
              logger.debug('🎯 Setting initial channel to:', channelsData[0].id);
              setSelectedChannel(channelsData[0].id);
              selectedChannelRef.current = channelsData[0].id; // Update ref immediately
              logger.debug('📝 Called setSelectedChannel (initial) with:', channelsData[0].id);
              hasSelectedInitialChannelRef.current = true;
            } else {
              // Check if the currently selected channel still exists
              const currentChannelExists = channelsData.some((ch: Channel) => ch.id === currentSelectedChannel);
              logger.debug('🔍 Channel exists check:', {
                selectedChannel: currentSelectedChannel,
                currentChannelExists,
              });
              if (!currentChannelExists && channelsData.length > 0) {
                // Current channel no longer exists, fallback to first channel
                logger.debug('⚠️ Current channel no longer exists, falling back to:', channelsData[0].id);
                setSelectedChannel(channelsData[0].id);
                selectedChannelRef.current = channelsData[0].id; // Update ref immediately
                logger.debug('📝 Called setSelectedChannel (fallback) with:', channelsData[0].id);
              } else {
                logger.debug('✅ Keeping current channel selection:', currentSelectedChannel);
              }
            }
          }

          setChannels(channelsData);
        }
      } catch (error) {
        logger.error('Error fetching channels:', error);
      }
    },
    [baseUrl, authFetch, selectedChannel, setSelectedChannel, setChannels]
  );

  // Process poll data from usePoll hook - handles all data processing from consolidated /api/poll endpoint
  const processPollData = useCallback(
    (data: PollData) => {
      if (!data) return;

      // Extract localNodeId early to use in message processing (don't wait for state update)
      const localNodeId = data.deviceConfig?.basic?.nodeId || data.config?.localNodeInfo?.nodeId || currentNodeId;

      // Store in ref for immediate access across functions (bypasses React state delay)
      if (localNodeId) {
        localNodeIdRef.current = localNodeId;
      }

      // Process nodes data
      if (data.nodes) {
        const pendingFavorite = pendingFavoriteRequests;
        const pendingIgnored = pendingIgnoredRequests;

        if (pendingFavorite.size === 0 && pendingIgnored.size === 0) {
          setNodes(data.nodes as DeviceInfo[]);
        } else {
          setNodes(
            (data.nodes as DeviceInfo[]).map((serverNode: DeviceInfo) => {
              let updatedNode = { ...serverNode };

              // Handle pending favorite requests
              const pendingFavoriteState = pendingFavorite.get(serverNode.nodeNum);
              if (pendingFavoriteState !== undefined) {
                if (serverNode.isFavorite === pendingFavoriteState) {
                  pendingFavorite.delete(serverNode.nodeNum);
                } else {
                  updatedNode.isFavorite = pendingFavoriteState;
                }
              }

              // Handle pending ignored requests
              const pendingIgnoredState = pendingIgnored.get(serverNode.nodeNum);
              if (pendingIgnoredState !== undefined) {
                if (serverNode.isIgnored === pendingIgnoredState) {
                  pendingIgnored.delete(serverNode.nodeNum);
                } else {
                  updatedNode.isIgnored = pendingIgnoredState;
                }
              }

              return updatedNode;
            })
          );
        }
      }

      // Process messages data
      if (data.messages) {
        const messagesData = data.messages;
        const processedMessages = messagesData.map((msg: any) => ({
          ...msg,
          timestamp: new Date(msg.timestamp),
        }));

        // Play notification sound if new messages arrived from OTHER users
        if (processedMessages.length > 0) {
          const currentNewestMessage = processedMessages[0];
          const currentNewestId = currentNewestMessage.id;

          if (newestMessageId.current && currentNewestId !== newestMessageId.current) {
            const isFromOther = currentNewestMessage.fromNodeId !== localNodeId;
            const isTextMessage = currentNewestMessage.portnum === 1;

            if (isFromOther && isTextMessage) {
              logger.debug('New message arrived from other user:', currentNewestMessage.fromNodeId);
              playNotificationSound();
            }
          }

          newestMessageId.current = currentNewestId;
        }

        // Check for matching messages to remove from pending
        const currentPending = pendingMessagesRef.current;
        let updatedPending = new Map(currentPending);
        let pendingChanged = false;

        if (currentPending.size > 0) {
          currentPending.forEach((pendingMsg, tempId) => {
            const isDM = pendingMsg.channel === -1;

            const matchingMessage = processedMessages.find((msg: MeshMessage) => {
              if (msg.text !== pendingMsg.text) return false;

              const senderMatches =
                (localNodeId && msg.from === localNodeId) ||
                msg.from === pendingMsg.from ||
                msg.fromNodeId === pendingMsg.fromNodeId;

              if (!senderMatches) return false;
              if (Math.abs(msg.timestamp.getTime() - pendingMsg.timestamp.getTime()) >= 30000) return false;

              if (isDM) {
                const matches =
                  msg.toNodeId === pendingMsg.toNodeId ||
                  (msg.to === pendingMsg.to && (msg.channel === 0 || msg.channel === -1));
                return matches;
              } else {
                return msg.channel === pendingMsg.channel;
              }
            });

            if (matchingMessage) {
              updatedPending.delete(tempId);
              pendingChanged = true;
            }
          });

          if (pendingChanged) {
            pendingMessagesRef.current = updatedPending;
            setPendingMessages(updatedPending);
          }
        }

        // Compute merged messages using setMessages callback to access current state
        // Preserve older DM messages loaded via infinite scroll (similar to channel messages)
        const pendingIds = new Set(Array.from(pendingMessagesRef.current.keys()));
        const pollMsgIds = new Set(processedMessages.map((m: MeshMessage) => m.id));

        setMessages(currentMessages => {
          // Keep older messages that aren't in the poll (they were loaded via infinite scroll)
          // Poll returns newest messages, so any messages not in poll are older
          const olderMsgs = (currentMessages || []).filter(m => {
            // If message is in poll results, don't keep it (poll version is authoritative)
            if (pollMsgIds.has(m.id)) return false;

            // For pending messages (temp IDs), only keep if still pending
            if (m.id.toString().startsWith('temp_')) {
              return pendingIds.has(m.id);
            }

            // Keep all other older messages (loaded via infinite scroll)
            return true;
          });

          // Combine: older messages + poll messages (poll messages are newer/updated)
          // Sort by timestamp to maintain order
          const merged = [...olderMsgs, ...processedMessages];
          merged.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
          return merged;
        });

        // Group messages by channel (use processedMessages since we don't need pending for channel groups)
        const channelGroups: { [key: number]: MeshMessage[] } = {};
        processedMessages.forEach((msg: MeshMessage) => {
          if (msg.channel === -1) return;
          if (!channelGroups[msg.channel]) {
            channelGroups[msg.channel] = [];
          }
          channelGroups[msg.channel].push(msg);
        });

        // Update unread counts from backend
        const currentSelected = selectedChannelRef.current;
        const newUnreadCounts: { [key: number]: number } = {};

        if (data.unreadCounts?.channels) {
          Object.entries(data.unreadCounts.channels).forEach(([channelId, count]) => {
            const chId = parseInt(channelId, 10);
            if (chId === currentSelected) {
              newUnreadCounts[chId] = 0;
            } else {
              newUnreadCounts[chId] = count as number;
            }
          });
        }

        setUnreadCounts(newUnreadCounts);

        // Merge poll messages with existing messages (preserve older messages loaded via infinite scroll)
        setChannelMessages(prev => {
          const merged: { [key: number]: MeshMessage[] } = {};

          // Get all channel IDs from both existing and new messages
          const allChannelIds = new Set([...Object.keys(prev).map(Number), ...Object.keys(channelGroups).map(Number)]);

          allChannelIds.forEach(channelId => {
            const existingMsgs = prev[channelId] || [];
            const pollMsgs = channelGroups[channelId] || [];

            // Create a map of poll message IDs for quick lookup
            const pollMsgIds = new Set(pollMsgs.map(m => m.id));

            // Keep older messages that aren't in the poll (they were loaded via infinite scroll)
            // Poll returns newest 100, so any messages not in poll are older
            // Also filter out pending messages that are no longer pending (they've been matched to real messages)
            const olderMsgs = existingMsgs.filter(m => {
              // If message is in poll results, don't keep it (poll version is authoritative)
              if (pollMsgIds.has(m.id)) return false;

              // For pending messages (temp IDs), only keep if still pending
              // Once matched/acknowledged, pendingIds won't contain it anymore
              // Channel messages use 'temp_' prefix, DMs use 'temp_dm_' prefix
              if (m.id.toString().startsWith('temp_')) {
                return pendingIds.has(m.id);
              }

              // Keep all other older messages (loaded via infinite scroll)
              return true;
            });

            // Combine: older messages + poll messages (poll messages are newer/updated)
            merged[channelId] = [...olderMsgs, ...pollMsgs];
          });

          return merged;
        });
      }

      // Process config data
      if (data.config) {
        setDeviceInfo(data.config);
      }

      // Process device configuration data
      if (data.deviceConfig) {
        setDeviceConfig(data.deviceConfig);
        if (data.deviceConfig.basic?.nodeId) {
          setCurrentNodeId(data.deviceConfig.basic.nodeId as string);
        }
      }

      // Fallback: Get currentNodeId from config.localNodeInfo
      if (!currentNodeId && data.config?.localNodeInfo?.nodeId) {
        setCurrentNodeId(data.config.localNodeInfo.nodeId);
      }

      // Process telemetry availability data
      if (data.telemetryNodes) {
        setNodesWithTelemetry(new Set(data.telemetryNodes.nodes || []));
        setNodesWithWeatherTelemetry(new Set(data.telemetryNodes.weather || []));
        setNodesWithEstimatedPosition(new Set(data.telemetryNodes.estimatedPosition || []));
        setNodesWithPKC(new Set(data.telemetryNodes.pkc || []));
      }

      // Process channels data
      if (data.channels) {
        setChannels(data.channels as Channel[]);
      }

      // Process traceroutes data (synced via poll for consistency across all views)
      if (data.traceroutes) {
        setTraceroutes(data.traceroutes);
      }
    },
    [currentNodeId, playNotificationSound, setTraceroutes]
  );

  // Process poll data when it changes (from usePoll hook)
  useEffect(() => {
    if (pollData) {
      processPollData(pollData);
    }
  }, [pollData, processPollData]);

  const getRecentTraceroute = (nodeId: string) => {
    const nodeNumStr = nodeId.replace('!', '');
    const nodeNum = parseInt(nodeNumStr, 16);

    // Get current node number
    const currentNodeNumStr = currentNodeId.replace('!', '');
    const currentNodeNum = parseInt(currentNodeNumStr, 16);

    // Find most recent traceroute between current node and selected node
    // Use 7 days for traceroute visibility (traceroutes are less frequent than node updates)
    const TRACEROUTE_DISPLAY_HOURS = 7 * 24; // 7 days
    const cutoff = Date.now() - TRACEROUTE_DISPLAY_HOURS * 60 * 60 * 1000;
    const recentTraceroutes = traceroutes
      .filter(tr => {
        const isRelevant =
          (tr.fromNodeNum === currentNodeNum && tr.toNodeNum === nodeNum) ||
          (tr.fromNodeNum === nodeNum && tr.toNodeNum === currentNodeNum);

        if (!isRelevant || tr.timestamp < cutoff) {
          return false;
        }

        // Include all traceroutes, even failed ones
        // null or 'null' = failed (no response received)
        // [] = successful with 0 hops (direct connection)
        // [hops] = successful with intermediate hops
        return true;
      })
      .sort((a, b) => b.timestamp - a.timestamp);

    return recentTraceroutes.length > 0 ? recentTraceroutes[0] : null;
  };

  // Helper to check if we should show cached data
  const shouldShowData = () => {
    return connectionStatus === 'connected' || connectionStatus === 'user-disconnected';
  };

  const handleDisconnect = async () => {
    try {
      await api.disconnectFromNode();
      setConnectionStatus('user-disconnected');
      showToast(t('toast.disconnected_from_node'), 'info');
    } catch (error) {
      logger.error('Failed to disconnect:', error);
      showToast(t('toast.failed_disconnect'), 'error');
    }
  };

  const handleReconnect = async () => {
    try {
      setConnectionStatus('connecting');
      await api.reconnectToNode();
      showToast(t('toast.reconnecting_to_node'), 'info');
      // Status will update via polling
    } catch (error) {
      logger.error('Failed to reconnect:', error);
      setConnectionStatus('user-disconnected');
      showToast(t('toast.failed_reconnect'), 'error');
    }
  };

  // Handler to open node info modal and fetch connection info
  const handleNodeClick = async () => {
    if (authStatus?.authenticated) {
      try {
        const info = await api.getConnectionInfo();
        setNodeConnectionInfo({
          nodeIp: info.nodeIp,
          tcpPort: info.tcpPort,
          defaultIp: info.defaultIp,
          defaultPort: info.defaultPort,
          isOverridden: info.isOverridden
        });
        setShowNodeInfoModal(true);
      } catch (error) {
        logger.error('Failed to get connection info:', error);
        showToast(t('toast.failed_connection_info'), 'error');
      }
    }
  };

  // Handler to change node IP/address
  const handleChangeNodeIp = async (newAddress: string) => {
    try {
      await api.configureConnection(newAddress);
      // Show success message and reload page to get fresh data from new node
      showToast(t('node_info.success'), 'success');
      setShowNodeInfoModal(false);
      // Reload page after a short delay to allow toast to be seen
      setTimeout(() => {
        window.location.reload();
      }, 1500);
    } catch (error) {
      logger.error('Failed to configure connection:', error);
      throw error; // Re-throw so the modal can display the error
    }
  };

  const handleTraceroute = async (nodeId: string) => {
    if (connectionStatus !== 'connected') {
      return;
    }

    try {
      // Set loading state
      setTracerouteLoading(nodeId);

      // Convert nodeId to node number
      const nodeNumStr = nodeId.replace('!', '');
      const nodeNum = parseInt(nodeNumStr, 16);

      await authFetch(`${baseUrl}/api/traceroute`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ destination: nodeNum }),
      });

      logger.debug(`🗺️ Traceroute request sent to ${nodeId}`);

      // Poll for traceroute results with increasing delays
      // This provides faster UI feedback instead of waiting for the 5s poll interval
      const pollDelays = [2000, 5000, 10000, 15000]; // 2s, 5s, 10s, 15s
      pollDelays.forEach(delay => {
        setTimeout(() => {
          refetchPoll();
        }, delay);
      });

      // Clear loading state after 30 seconds
      setTimeout(() => {
        setTracerouteLoading(null);
      }, 30000);
    } catch (error) {
      logger.error('Failed to send traceroute:', error);
      setTracerouteLoading(null);
    }
  };

  const handleExchangePosition = async (nodeId: string) => {
    if (connectionStatus !== 'connected') {
      return;
    }

    // Prevent duplicate requests (debounce logic)
    if (positionLoading === nodeId) {
      logger.debug(`📍 Position exchange already in progress for ${nodeId}`);
      return;
    }

    try {
      // Set loading state using dedicated position loading state
      setPositionLoading(nodeId);

      // Convert nodeId to node number for backend
      const nodeNumStr = nodeId.replace('!', '');
      const nodeNum = parseInt(nodeNumStr, 16);

      // Use direct fetch with CSRF token (consistent with other message endpoints)
      await authFetch(`${baseUrl}/api/position/request`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ destination: nodeNum }),
      });

      logger.debug(`📍 Position request sent to ${nodeId}`);

      // Trigger a poll to refresh messages immediately
      setTimeout(() => {
        // The poll will run and fetch the new system message
        // We use a small delay to ensure the backend has finished writing to DB
      }, 500);

      // Clear loading state after 30 seconds
      setTimeout(() => {
        setPositionLoading(null);
      }, 30000);
    } catch (error) {
      logger.error('Failed to send position request:', error);
      setPositionLoading(null);
    }
  };

  const handleExchangeNodeInfo = async (nodeId: string) => {
    if (connectionStatus !== 'connected') {
      return;
    }

    // Prevent duplicate requests (debounce logic)
    if (nodeInfoLoading === nodeId) {
      logger.debug(`🔑 NodeInfo exchange already in progress for ${nodeId}`);
      return;
    }

    try {
      // Set loading state
      setNodeInfoLoading(nodeId);

      // Convert nodeId to node number for backend
      const nodeNumStr = nodeId.replace('!', '');
      const nodeNum = parseInt(nodeNumStr, 16);

      // Use direct fetch with CSRF token
      await authFetch(`${baseUrl}/api/nodeinfo/request`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ destination: nodeNum }),
      });

      logger.debug(`🔑 NodeInfo request sent to ${nodeId}`);

      // Clear loading state after 30 seconds
      setTimeout(() => {
        setNodeInfoLoading(null);
      }, 30000);
    } catch (error) {
      logger.error('Failed to send nodeinfo request:', error);
      setNodeInfoLoading(null);
    }
  };

  const handleRequestNeighborInfo = async (nodeId: string) => {
    if (connectionStatus !== 'connected') {
      return;
    }

    // Prevent duplicate requests (debounce logic)
    if (neighborInfoLoading === nodeId) {
      logger.debug(`🏠 NeighborInfo request already in progress for ${nodeId}`);
      return;
    }

    try {
      // Set loading state
      setNeighborInfoLoading(nodeId);

      // Convert nodeId to node number for backend
      const nodeNumStr = nodeId.replace('!', '');
      const nodeNum = parseInt(nodeNumStr, 16);

      // Use direct fetch with CSRF token
      await authFetch(`${baseUrl}/api/neighborinfo/request`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ destination: nodeNum }),
      });

      logger.debug(`🏠 NeighborInfo request sent to ${nodeId}`);

      // Clear loading state after 30 seconds (firmware rate-limits to 3 min anyway)
      setTimeout(() => {
        setNeighborInfoLoading(null);
      }, 30000);
    } catch (error) {
      logger.error('Failed to send neighborinfo request:', error);
      setNeighborInfoLoading(null);
    }
  };

  const handleRequestTelemetry = async (nodeId: string, telemetryType: 'device' | 'environment' | 'airQuality' | 'power') => {
    if (connectionStatus !== 'connected') {
      return;
    }

    // Prevent duplicate requests (debounce logic)
    if (telemetryRequestLoading === nodeId) {
      logger.debug(`📊 Telemetry request already in progress for ${nodeId}`);
      return;
    }

    try {
      // Set loading state
      setTelemetryRequestLoading(nodeId);

      // Convert nodeId to node number for backend
      const nodeNumStr = nodeId.replace('!', '');
      const nodeNum = parseInt(nodeNumStr, 16);

      // Use direct fetch with CSRF token
      await authFetch(`${baseUrl}/api/telemetry/request`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ destination: nodeNum, telemetryType }),
      });

      logger.debug(`📊 Telemetry request (${telemetryType}) sent to ${nodeId}`);

      // Clear loading state after 30 seconds
      setTimeout(() => {
        setTelemetryRequestLoading(null);
      }, 30000);
    } catch (error) {
      logger.error('Failed to send telemetry request:', error);
      setTelemetryRequestLoading(null);
    }
  };

  const handleSendDirectMessage = async (destinationNodeId: string) => {
    if (!newMessage.trim() || connectionStatus !== 'connected') {
      return;
    }

    // Extract replyId from replyingTo message if present
    let replyId: number | undefined = undefined;
    if (replyingTo) {
      const idParts = replyingTo.id.split('_');
      if (idParts.length > 1) {
        replyId = parseInt(idParts[1], 10);
      }
    }

    // Create a temporary message ID for immediate display
    const tempId = `temp_dm_${Date.now()}_${Math.random()}`;
    // Use localNodeIdRef for immediate access (bypasses React state delay)
    const nodeId = localNodeIdRef.current || currentNodeId || 'me';
    const sentMessage: MeshMessage = {
      id: tempId,
      from: nodeId,
      to: destinationNodeId,
      fromNodeId: nodeId,
      toNodeId: destinationNodeId,
      text: newMessage,
      channel: -1, // -1 indicates a direct message
      timestamp: new Date(),
      isLocalMessage: true,
      acknowledged: false,
      portnum: 1, // Text message
      replyId: replyId,
    };

    // Add message to local state immediately for instant feedback
    setMessages(prev => [...prev, sentMessage]);

    // Add to pending acknowledgments
    setPendingMessages(prev => {
      const updated = new Map(prev).set(tempId, sentMessage);
      pendingMessagesRef.current = updated; // Update ref for interval access
      return updated;
    });

    // Scroll to bottom after sending message
    setTimeout(() => {
      if (dmMessagesContainerRef.current) {
        dmMessagesContainerRef.current.scrollTop = dmMessagesContainerRef.current.scrollHeight;
        setIsDMScrolledToBottom(true);
      }
    }, 50);

    // Clear the input and reply state
    const messageText = newMessage;
    setNewMessage('');
    setReplyingTo(null);

    try {
      const response = await authFetch(`${baseUrl}/api/messages/send`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text: messageText,
          channel: 0, // Backend may expect channel 0 for DMs
          destination: destinationNodeId,
          replyId: replyId,
        }),
      });

      if (response.ok) {
        logger.debug('Direct message sent successfully');
        // The message will be updated when we receive the acknowledgment from backend
      } else {
        logger.error('Failed to send direct message');
        // Remove the message from local state if sending failed
        setMessages(prev => prev.filter(msg => msg.id !== tempId));
        setError('Failed to send direct message');
      }
    } catch (error) {
      logger.error('Error sending direct message:', error);
      // Remove the message from local state if sending failed
      setMessages(prev => prev.filter(msg => msg.id !== tempId));
      setError(`Failed to send direct message: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  };

  const handleSendTapback = async (emoji: string, originalMessage: MeshMessage) => {
    if (connectionStatus !== 'connected') {
      setError('Cannot send reaction: not connected to mesh network');
      return;
    }

    // Extract replyId from original message
    const idParts = originalMessage.id.split('_');
    if (idParts.length < 2) {
      setError('Cannot send reaction: invalid message format');
      return;
    }
    const replyId = parseInt(idParts[1], 10);

    // Validate replyId is a valid number
    if (isNaN(replyId) || replyId < 0) {
      setError('Cannot send reaction: invalid message ID');
      return;
    }

    // Determine if this is a direct message or channel message
    const isDirectMessage = originalMessage.channel === -1;

    try {
      let requestBody;

      if (isDirectMessage) {
        // For DMs: send to the other party in the conversation
        // If the message is from someone else, reply to them
        // If the message is from me, send to the original recipient
        // Use localNodeIdRef for immediate access (bypasses React state delay)
        const nodeId = localNodeIdRef.current || currentNodeId;
        const toNodeId = originalMessage.fromNodeId === nodeId ? originalMessage.toNodeId : originalMessage.fromNodeId;

        requestBody = {
          text: emoji,
          destination: toNodeId, // Server expects 'destination' not 'toNodeId'
          replyId: replyId,
          emoji: EMOJI_FLAG,
        };
      } else {
        // For channel messages: use channel
        requestBody = {
          text: emoji,
          channel: originalMessage.channel,
          replyId: replyId,
          emoji: EMOJI_FLAG,
        };
      }

      const response = await authFetch(`${baseUrl}/api/messages/send`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      });

      if (response.ok) {
        // Refresh messages to show the new tapback
        setTimeout(() => refetchPoll(), 500);
      } else {
        const errorData = await response.json();
        setError(`Failed to send reaction: ${errorData.error || 'Unknown error'}`);
      }
    } catch (err) {
      setError(`Failed to send reaction: ${err instanceof Error ? err.message : 'Network error'}`);
    }
  };

  const handleDeleteMessage = async (message: MeshMessage) => {
    if (!window.confirm(t('messages.confirm_delete'))) {
      return;
    }

    try {
      const response = await authFetch(`${baseUrl}/api/messages/${message.id}`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (response.ok) {
        showToast(t('toast.message_deleted'), 'success');
        // Update local state to remove the message
        setMessages(prev => prev.filter(m => m.id !== message.id));
        setChannelMessages(prev => ({
          ...prev,
          [message.channel]: (prev[message.channel] || []).filter(m => m.id !== message.id),
        }));
        refetchPoll();
      } else {
        const errorData = await response.json();
        showToast(t('toast.failed_delete_message', { error: errorData.message || t('errors.unknown') }), 'error');
      }
    } catch (err) {
      showToast(
        t('toast.failed_delete_message', { error: err instanceof Error ? err.message : t('errors.network') }),
        'error'
      );
    }
  };

  const handlePurgeChannelMessages = async (channelId: number) => {
    const channel = channels.find(c => c.id === channelId);
    const channelName = channel?.name || `Channel ${channelId}`;

    if (
      !window.confirm(`Are you sure you want to purge ALL messages from ${channelName}? This action cannot be undone.`)
    ) {
      return;
    }

    try {
      const response = await authFetch(`${baseUrl}/api/messages/channels/${channelId}`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (response.ok) {
        const data = await response.json();
        showToast(t('toast.purged_messages_channel', { count: data.deletedCount, channel: channelName }), 'success');
        // Update local state
        setChannelMessages(prev => ({
          ...prev,
          [channelId]: [],
        }));
        refetchPoll();
      } else {
        const errorData = await response.json();
        showToast(t('toast.failed_purge_messages', { error: errorData.message || t('errors.unknown') }), 'error');
      }
    } catch (err) {
      showToast(
        t('toast.failed_purge_messages', { error: err instanceof Error ? err.message : t('errors.network') }),
        'error'
      );
    }
  };

  const handlePurgeDirectMessages = async (nodeNum: number) => {
    const node = nodes.find(n => n.nodeNum === nodeNum);
    const nodeName = node?.user?.shortName || node?.user?.longName || `Node ${nodeNum}`;

    if (
      !window.confirm(
        `Are you sure you want to purge ALL direct messages with ${nodeName}? This action cannot be undone.`
      )
    ) {
      return;
    }

    try {
      const response = await authFetch(`${baseUrl}/api/messages/direct-messages/${nodeNum}`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (response.ok) {
        const data = await response.json();
        showToast(t('toast.purged_messages_dm', { count: data.deletedCount, node: nodeName }), 'success');
        // Update local state to immediately reflect deletions
        const nodeId = node?.user?.id;
        if (nodeId) {
          setMessages(prev => prev.filter(m => !(m.fromNodeId === nodeId || m.toNodeId === nodeId)));
        }
        // Also refresh from backend to ensure consistency
        refetchPoll();
      } else {
        const errorData = await response.json();
        showToast(t('toast.failed_purge_messages', { error: errorData.message || t('errors.unknown') }), 'error');
      }
    } catch (err) {
      showToast(
        t('toast.failed_purge_messages', { error: err instanceof Error ? err.message : t('errors.network') }),
        'error'
      );
    }
  };

  const handlePurgeNodeTraceroutes = async (nodeNum: number) => {
    const node = nodes.find(n => n.nodeNum === nodeNum);
    const nodeName = node?.user?.shortName || node?.user?.longName || `Node ${nodeNum}`;

    if (
      !window.confirm(`Are you sure you want to purge ALL traceroutes for ${nodeName}? This action cannot be undone.`)
    ) {
      return;
    }

    try {
      const response = await authFetch(`${baseUrl}/api/messages/nodes/${nodeNum}/traceroutes`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (response.ok) {
        const data = await response.json();
        showToast(t('toast.purged_traceroutes', { count: data.deletedCount, node: nodeName }), 'success');
        // Refresh data from backend to ensure consistency
        refetchPoll();
      } else {
        const errorData = await response.json();
        showToast(t('toast.failed_purge_traceroutes', { error: errorData.message || t('errors.unknown') }), 'error');
      }
    } catch (err) {
      showToast(
        t('toast.failed_purge_traceroutes', { error: err instanceof Error ? err.message : t('errors.network') }),
        'error'
      );
    }
  };

  const handlePurgeNodeTelemetry = async (nodeNum: number) => {
    const node = nodes.find(n => n.nodeNum === nodeNum);
    const nodeName = node?.user?.shortName || node?.user?.longName || `Node ${nodeNum}`;

    if (
      !window.confirm(
        `Are you sure you want to purge ALL telemetry data for ${nodeName}? This action cannot be undone.`
      )
    ) {
      return;
    }

    try {
      const response = await authFetch(`${baseUrl}/api/messages/nodes/${nodeNum}/telemetry`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (response.ok) {
        const data = await response.json();
        showToast(t('toast.purged_telemetry', { count: data.deletedCount, node: nodeName }), 'success');
        // Refresh data from backend to ensure consistency
        refetchPoll();
      } else {
        const errorData = await response.json();
        showToast(t('toast.failed_purge_telemetry', { error: errorData.message || t('errors.unknown') }), 'error');
      }
    } catch (err) {
      showToast(
        t('toast.failed_purge_telemetry', { error: err instanceof Error ? err.message : t('errors.network') }),
        'error'
      );
    }
  };

  const handleDeleteNode = async (nodeNum: number) => {
    const node = nodes.find(n => n.nodeNum === nodeNum);
    const nodeName = node?.user?.shortName || node?.user?.longName || `Node ${nodeNum}`;

    if (
      !window.confirm(
        `Are you sure you want to DELETE ${nodeName} from the local database?\n\nThis will remove:\n- The node from the map and node list\n- All messages with this node\n- All traceroutes for this node\n- All telemetry data for this node\n\nThis action cannot be undone.`
      )
    ) {
      return;
    }

    try {
      const response = await authFetch(`${baseUrl}/api/messages/nodes/${nodeNum}`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (response.ok) {
        const data = await response.json();
        showToast(
          t('toast.deleted_node', {
            node: nodeName,
            messages: data.messagesDeleted,
            traceroutes: data.traceroutesDeleted,
            telemetry: data.telemetryDeleted,
          }),
          'success'
        );
        // Close the purge data modal if open
        setShowPurgeDataModal(false);
        // Clear the selected DM node if it's the one being deleted
        const deletedNode = nodes.find(n => n.nodeNum === nodeNum);
        if (deletedNode && selectedDMNode === deletedNode.user?.id) {
          setSelectedDMNode('');
        }
        // Refresh data from backend to ensure consistency
        refetchPoll();
      } else {
        const errorData = await response.json();
        showToast(t('toast.failed_delete_node', { error: errorData.message || t('errors.unknown') }), 'error');
      }
    } catch (err) {
      showToast(
        t('toast.failed_delete_node', { error: err instanceof Error ? err.message : t('errors.network') }),
        'error'
      );
    }
  };

  const handlePurgeNodeFromDevice = async (nodeNum: number) => {
    const node = nodes.find(n => n.nodeNum === nodeNum);
    const nodeName = node?.user?.shortName || node?.user?.longName || `Node ${nodeNum}`;

    if (
      !window.confirm(
        `Are you sure you want to PURGE ${nodeName} from BOTH the connected device AND the local database?\n\nThis will:\n- Send an admin command to remove the node from the device NodeDB\n- Remove the node from the map and node list\n- Delete all messages with this node\n- Delete all traceroutes for this node\n- Delete all telemetry data for this node\n\nThis action cannot be undone and affects both the device and local database.`
      )
    ) {
      return;
    }

    try {
      const response = await authFetch(`${baseUrl}/api/messages/nodes/${nodeNum}/purge-from-device`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (response.ok) {
        const data = await response.json();
        showToast(
          t('toast.purged_node_device', {
            node: nodeName,
            messages: data.messagesDeleted,
            traceroutes: data.traceroutesDeleted,
            telemetry: data.telemetryDeleted,
          }),
          'success'
        );
        // Close the purge data modal if open
        setShowPurgeDataModal(false);
        // Clear the selected DM node if it's the one being deleted
        const purgedNode = nodes.find(n => n.nodeNum === nodeNum);
        if (purgedNode && selectedDMNode === purgedNode.user?.id) {
          setSelectedDMNode('');
        }
        // Refresh data from backend to ensure consistency
        refetchPoll();
      } else {
        const errorData = await response.json();
        showToast(t('toast.failed_purge_node_device', { error: errorData.message || t('errors.unknown') }), 'error');
      }
    } catch (err) {
      showToast(
        t('toast.failed_purge_node_device', { error: err instanceof Error ? err.message : t('errors.network') }),
        'error'
      );
    }
  };

  const handlePositionOverrideSave = async (
    nodeNum: number,
    data: { enabled: boolean; latitude?: number; longitude?: number; altitude?: number }
  ) => {
    const node = nodes.find(n => n.nodeNum === nodeNum);
    const nodeId = node?.user?.id;
    if (!nodeId) {
      throw new Error('Node not found');
    }

    const response = await authFetch(`${baseUrl}/api/nodes/${nodeId}/position-override`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(data),
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.message || 'Failed to save position override');
    }

    showToast(t('position_override.save_success'), 'success');
    // Refresh data to get updated position
    refetchPoll();
  };

  const handleSendMessage = async (channel: number = 0) => {
    if (!newMessage.trim() || connectionStatus !== 'connected') {
      return;
    }

    // Use channel ID directly - no mapping needed
    const messageChannel = channel;

    // Extract replyId from replyingTo message if present
    let replyId: number | undefined = undefined;
    if (replyingTo) {
      const idParts = replyingTo.id.split('_');
      if (idParts.length > 1) {
        replyId = parseInt(idParts[1], 10);
      }
    }

    // Create a temporary message ID for immediate display
    const tempId = `temp_${Date.now()}_${Math.random()}`;
    // Use localNodeIdRef for immediate access (bypasses React state delay)
    const nodeId = localNodeIdRef.current || currentNodeId || 'me';
    const sentMessage: MeshMessage = {
      id: tempId,
      from: nodeId,
      to: '!ffffffff', // Broadcast
      fromNodeId: nodeId,
      toNodeId: '!ffffffff',
      text: newMessage,
      channel: messageChannel,
      timestamp: new Date(),
      isLocalMessage: true,
      acknowledged: false,
      replyId: replyId,
    };

    // Add message to local state immediately
    setMessages(prev => [...prev, sentMessage]);
    setChannelMessages(prev => ({
      ...prev,
      [messageChannel]: [...(prev[messageChannel] || []), sentMessage],
    }));

    // Add to pending acknowledgments
    console.log(`📤 Adding message to pending acknowledgments:`, {
      tempId,
      text: sentMessage.text,
      from: sentMessage.from,
      fromNodeId: sentMessage.fromNodeId,
      channel: sentMessage.channel,
    });
    setPendingMessages(prev => {
      const updated = new Map(prev).set(tempId, sentMessage);
      pendingMessagesRef.current = updated; // Update ref for interval access
      console.log(`📊 Pending messages map size after add: ${updated.size}`);
      return updated;
    });

    // Scroll to bottom after sending message
    setTimeout(() => {
      if (channelMessagesContainerRef.current) {
        channelMessagesContainerRef.current.scrollTop = channelMessagesContainerRef.current.scrollHeight;
        setIsChannelScrolledToBottom(true);
      }
    }, 50);

    // Clear the input and reply state
    const messageText = newMessage;
    setNewMessage('');
    setReplyingTo(null);

    try {
      const response = await authFetch(`${baseUrl}/api/messages/send`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text: messageText,
          channel: messageChannel,
          replyId: replyId,
        }),
      });

      if (response.ok) {
        // The message was sent successfully
        // We'll wait for it to appear in the backend data to confirm acknowledgment
        setTimeout(() => refetchPoll(), 1000);
      } else {
        const errorData = await response.json();
        setError(`Failed to send message: ${errorData.error}`);

        // Remove the message from local state if sending failed
        setMessages(prev => prev.filter(msg => msg.id !== tempId));
        setChannelMessages(prev => ({
          ...prev,
          [channel]: prev[channel]?.filter(msg => msg.id !== tempId) || [],
        }));
        setPendingMessages(prev => {
          const updated = new Map(prev);
          updated.delete(tempId);
          pendingMessagesRef.current = updated; // Update ref
          return updated;
        });
      }
    } catch (err) {
      setError(`Failed to send message: ${err instanceof Error ? err.message : 'Unknown error'}`);

      // Remove the message from local state if sending failed
      setMessages(prev => prev.filter(msg => msg.id !== tempId));
      setChannelMessages(prev => ({
        ...prev,
        [channel]: prev[channel]?.filter(msg => msg.id !== tempId) || [],
      }));
      setPendingMessages(prev => {
        const updated = new Map(prev);
        updated.delete(tempId);
        pendingMessagesRef.current = updated; // Update ref
        return updated;
      });
    }
  };

  // Resend a message (for own messages)
  const handleResendMessage = async (message: MeshMessage) => {
    if (!message.text?.trim() || connectionStatus !== 'connected') {
      return;
    }

    // Determine if this is a DM or channel message
    const isDM = message.channel === -1;
    const messageChannel = message.channel;
    const destinationNodeId = message.to || message.toNodeId;

    // Create a temporary message ID for immediate display
    const tempId = `temp_${Date.now()}_${Math.random()}`;
    const nodeId = localNodeIdRef.current || currentNodeId || 'me';
    const sentMessage: MeshMessage = {
      id: tempId,
      from: nodeId,
      to: isDM ? destinationNodeId : '!ffffffff',
      fromNodeId: nodeId,
      toNodeId: isDM ? destinationNodeId : '!ffffffff',
      text: message.text,
      channel: messageChannel,
      timestamp: new Date(),
      isLocalMessage: true,
      acknowledged: false,
      portnum: isDM ? 1 : undefined,
    };

    // Add message to local state immediately
    if (isDM) {
      setMessages(prev => [...prev, sentMessage]);
    } else {
      setMessages(prev => [...prev, sentMessage]);
      setChannelMessages(prev => ({
        ...prev,
        [messageChannel]: [...(prev[messageChannel] || []), sentMessage],
      }));
    }

    // Add to pending acknowledgments
    setPendingMessages(prev => {
      const updated = new Map(prev).set(tempId, sentMessage);
      pendingMessagesRef.current = updated;
      return updated;
    });

    // Scroll to bottom after sending
    setTimeout(() => {
      if (isDM) {
        if (dmMessagesContainerRef.current) {
          dmMessagesContainerRef.current.scrollTop = dmMessagesContainerRef.current.scrollHeight;
        }
      } else {
        if (channelMessagesContainerRef.current) {
          channelMessagesContainerRef.current.scrollTop = channelMessagesContainerRef.current.scrollHeight;
          setIsChannelScrolledToBottom(true);
        }
      }
    }, 50);

    try {
      // Use the same endpoint for both DMs and channel messages
      // DMs include a destination parameter, channel messages include a channel parameter
      const endpoint = `${baseUrl}/api/messages/send`;
      const body = isDM
        ? { text: message.text, destination: destinationNodeId }
        : { text: message.text, channel: messageChannel };

      const response = await authFetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (response.ok) {
        setTimeout(() => refetchPoll(), 1000);
      } else {
        const errorData = await response.json();
        setError(`Failed to resend message: ${errorData.error}`);

        // Remove the message from local state if sending failed
        setMessages(prev => prev.filter(msg => msg.id !== tempId));
        if (!isDM) {
          setChannelMessages(prev => ({
            ...prev,
            [messageChannel]: prev[messageChannel]?.filter(msg => msg.id !== tempId) || [],
          }));
        }
        setPendingMessages(prev => {
          const updated = new Map(prev);
          updated.delete(tempId);
          pendingMessagesRef.current = updated;
          return updated;
        });
      }
    } catch (err) {
      setError(`Failed to resend message: ${err instanceof Error ? err.message : 'Unknown error'}`);

      // Remove the message from local state if sending failed
      setMessages(prev => prev.filter(msg => msg.id !== tempId));
      if (!isDM) {
        setChannelMessages(prev => ({
          ...prev,
          [messageChannel]: prev[messageChannel]?.filter(msg => msg.id !== tempId) || [],
        }));
      }
      setPendingMessages(prev => {
        const updated = new Map(prev);
        updated.delete(tempId);
        pendingMessagesRef.current = updated;
        return updated;
      });
    }
  };

  // Use imported helpers with current nodes state
  const getNodeName = (nodeId: string): string => {
    const node = nodes.find(n => n.user?.id === nodeId);
    return node?.user?.longName || node?.user?.shortName || nodeId;
  };

  const getNodeShortName = (nodeId: string): string => {
    const node = nodes.find(n => n.user?.id === nodeId);
    return (node?.user?.shortName && node.user.shortName.trim()) || nodeId.substring(1, 5);
  };

  const getAvailableChannels = (): number[] => {
    const channelSet = new Set<number>();

    // Add channels from channel configurations first (these are authoritative)
    channels.forEach(ch => channelSet.add(ch.id));

    // Add channels from messages
    messages.forEach(msg => {
      channelSet.add(msg.channel);
    });

    // Filter out channel -1 (used for direct messages), disabled channels (role = 0),
    // and channels the user doesn't have permission to read
    return Array.from(channelSet)
      .filter(ch => {
        if (ch === -1) return false; // Exclude DM channel

        // Check if channel has a configuration
        const channelConfig = channels.find(c => c.id === ch);

        // If channel has config and role is Disabled (0), exclude it
        if (channelConfig && channelConfig.role === 0) {
          return false;
        }

        // Check if user has permission to read this channel
        if (!hasPermission(`channel_${ch}` as ResourceType, 'read')) {
          return false;
        }

        return true;
      })
      .sort((a, b) => a - b);
  };

  // Helper function to sort nodes
  const sortNodes = (nodes: DeviceInfo[], field: SortField, direction: SortDirection): DeviceInfo[] => {
    return [...nodes].sort((a, b) => {
      let aVal: any, bVal: any;

      switch (field) {
        case 'longName':
          aVal = a.user?.longName || `Node ${a.nodeNum}`;
          bVal = b.user?.longName || `Node ${b.nodeNum}`;
          break;
        case 'shortName':
          aVal = a.user?.shortName || '';
          bVal = b.user?.shortName || '';
          break;
        case 'id':
          aVal = a.user?.id || a.nodeNum;
          bVal = b.user?.id || b.nodeNum;
          break;
        case 'lastHeard':
          aVal = a.lastHeard || 0;
          bVal = b.lastHeard || 0;
          break;
        case 'snr':
          aVal = a.snr || -999;
          bVal = b.snr || -999;
          break;
        case 'battery':
          aVal = a.deviceMetrics?.batteryLevel || -1;
          bVal = b.deviceMetrics?.batteryLevel || -1;
          break;
        case 'hwModel':
          aVal = a.user?.hwModel || 0;
          bVal = b.user?.hwModel || 0;
          break;
        case 'hops': {
          // For nodes without hop data, use fallback values that push them to bottom
          // Ascending: use 999 (high value = bottom), Descending: use -1 (low value = bottom)
          const noHopFallback = direction === 'asc' ? 999 : -1;
          aVal = a.hopsAway !== undefined && a.hopsAway !== null ? a.hopsAway : noHopFallback;
          bVal = b.hopsAway !== undefined && b.hopsAway !== null ? b.hopsAway : noHopFallback;
          break;
        }
        default:
          return 0;
      }

      if (typeof aVal === 'string' && typeof bVal === 'string') {
        const comparison = aVal.toLowerCase().localeCompare(bVal.toLowerCase());
        return direction === 'asc' ? comparison : -comparison;
      } else {
        const comparison = aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
        return direction === 'asc' ? comparison : -comparison;
      }
    });
  };

  // Helper function to filter nodes
  const filterNodes = (nodes: DeviceInfo[], filter: string): DeviceInfo[] => {
    if (!filter.trim()) return nodes;

    const lowerFilter = filter.toLowerCase();
    return nodes.filter(node => {
      const longName = (node.user?.longName || '').toLowerCase();
      const shortName = (node.user?.shortName || '').toLowerCase();
      const id = (node.user?.id || '').toLowerCase();

      return longName.includes(lowerFilter) || shortName.includes(lowerFilter) || id.includes(lowerFilter);
    });
  };

  // Get processed (filtered and sorted) nodes
  const processedNodes = useMemo((): DeviceInfo[] => {
    const cutoffTime = Date.now() / 1000 - maxNodeAgeHours * 60 * 60;

    // Age filter (favorites are always visible)
    const ageFiltered = nodes.filter(node => {
      if (node.isFavorite) return true;
      if (!node.lastHeard) return false;
      return node.lastHeard >= cutoffTime;
    });

    // Only apply nodesNodeFilter when Nodes tab is active
    // Messages tab will apply its own messagesNodeFilter
    const textFiltered = activeTab === 'nodes' ? filterNodes(ageFiltered, nodesNodeFilter) : ageFiltered;

    // Apply advanced filters
    const advancedFiltered = textFiltered.filter(node => {
      const nodeId = node.user?.id;
      const isShowMode = nodeFilters.filterMode === 'show';

      // MQTT filter
      if (nodeFilters.showMqtt) {
        const matches = node.viaMqtt;
        if (isShowMode && !matches) return false; // Show mode: exclude non-matches
        if (!isShowMode && matches) return false; // Hide mode: exclude matches
      }

      // Telemetry filter
      if (nodeFilters.showTelemetry) {
        const matches = nodeId && nodesWithTelemetry.has(nodeId);
        if (isShowMode && !matches) return false;
        if (!isShowMode && matches) return false;
      }

      // Environment metrics filter
      if (nodeFilters.showEnvironment) {
        const matches = nodeId && nodesWithWeatherTelemetry.has(nodeId);
        if (isShowMode && !matches) return false;
        if (!isShowMode && matches) return false;
      }

      // Power source filter
      const batteryLevel = node.deviceMetrics?.batteryLevel;
      if (nodeFilters.powerSource !== 'both' && batteryLevel !== undefined) {
        const isPowered = batteryLevel === 101;
        if (nodeFilters.powerSource === 'powered' && !isPowered) {
          return false;
        }
        if (nodeFilters.powerSource === 'battery' && isPowered) {
          return false;
        }
      }

      // Position filter
      if (nodeFilters.showPosition) {
        const hasPosition = node.position && node.position.latitude != null && node.position.longitude != null;
        const matches = hasPosition;
        if (isShowMode && !matches) return false;
        if (!isShowMode && matches) return false;
      }

      // Hops filter (always applies regardless of mode)
      if (node.hopsAway != null) {
        if (node.hopsAway < nodeFilters.minHops || node.hopsAway > nodeFilters.maxHops) {
          return false;
        }
      }

      // PKI filter
      if (nodeFilters.showPKI) {
        const matches = nodeId && nodesWithPKC.has(nodeId);
        if (isShowMode && !matches) return false;
        if (!isShowMode && matches) return false;
      }

      // Remote Admin filter
      if (nodeFilters.showRemoteAdmin) {
        const matches = !!node.hasRemoteAdmin;
        if (isShowMode && !matches) return false;
        if (!isShowMode && matches) return false;
      }

      /**
       * Unknown nodes filter
       * Identifies nodes that lack both longName and shortName, which are typically
       * displayed as "Node 12345678" in the UI. These nodes have only been detected
       * but haven't provided identifying information yet.
       */
      if (nodeFilters.showUnknown) {
        const hasLongName = node.user?.longName && node.user.longName.trim() !== '';
        const hasShortName = node.user?.shortName && node.user.shortName.trim() !== '';
        const isUnknown = !hasLongName && !hasShortName;
        const matches = isUnknown;
        if (isShowMode && !matches) return false;
        if (!isShowMode && matches) return false;
      }

      // Ignored nodes filter - hide ignored nodes by default
      // When showIgnored is false (default): hide ignored nodes
      // When showIgnored is true: show ignored nodes
      if (!nodeFilters.showIgnored && node.isIgnored) {
        return false;
      }

      // Device role filter
      if (nodeFilters.deviceRoles.length > 0) {
        const role = typeof node.user?.role === 'number' ? node.user.role : parseInt(node.user?.role || '0');
        const matches = nodeFilters.deviceRoles.includes(role);
        if (isShowMode && !matches) return false;
        if (!isShowMode && matches) return false;
      }

      // Channel filter
      if (nodeFilters.channels.length > 0) {
        const nodeChannel = node.channel ?? -1;
        const matches = nodeFilters.channels.includes(nodeChannel);
        if (isShowMode && !matches) return false;
        if (!isShowMode && matches) return false;
      }

      return true;
    });

    // Separate favorites from non-favorites
    const favorites = advancedFiltered.filter(node => node.isFavorite);
    const nonFavorites = advancedFiltered.filter(node => !node.isFavorite);

    // Sort each group independently
    const sortedFavorites = sortNodes(favorites, sortField, sortDirection);
    const sortedNonFavorites = sortNodes(nonFavorites, sortField, sortDirection);

    // Concatenate: favorites first, then non-favorites
    return [...sortedFavorites, ...sortedNonFavorites];
  }, [
    nodes,
    maxNodeAgeHours,
    activeTab,
    nodesNodeFilter,
    sortField,
    sortDirection,
    nodeFilters,
    nodesWithTelemetry,
    nodesWithWeatherTelemetry,
    nodesWithPKC,
  ]);

  // Function to center map on a specific node
  const centerMapOnNode = useCallback((node: DeviceInfo) => {
    if (node.position && node.position.latitude != null && node.position.longitude != null) {
      setMapCenterTarget([node.position.latitude, node.position.longitude]);
    }
  }, []);

  // pendingFavoriteRequests is defined as a module-level variable to persist across remounts

  // Function to toggle node favorite status
  const toggleFavorite = async (node: DeviceInfo, event: React.MouseEvent) => {
    event.stopPropagation(); // Prevent node selection when clicking star

    if (!node.user?.id) {
      logger.error('Cannot toggle favorite: node has no user ID');
      return;
    }

    // Prevent multiple rapid clicks on the same node
    if (pendingFavoriteRequests.has(node.nodeNum)) {
      return;
    }

    // Store the original state before any updates
    const originalFavoriteStatus = node.isFavorite;
    const newFavoriteStatus = !originalFavoriteStatus;

    try {
      // Mark this request as pending with the expected new state
      pendingFavoriteRequests.set(node.nodeNum, newFavoriteStatus);

      // Optimistically update the UI - use flushSync to force immediate render
      // This prevents the polling from overwriting the optimistic update before it renders
      flushSync(() => {
        setNodes(prevNodes => {
          const updated = prevNodes.map(n =>
            n.nodeNum === node.nodeNum ? { ...n, isFavorite: newFavoriteStatus } : n
          );
          return updated;
        });
      });

      // Send update to backend (with device sync enabled by default)
      const response = await authFetch(`${baseUrl}/api/nodes/${node.user.id}/favorite`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          isFavorite: newFavoriteStatus,
          syncToDevice: true, // Enable two-way sync to Meshtastic device
        }),
      });

      if (!response.ok) {
        if (response.status === 403) {
          showToast(t('toast.insufficient_permissions_favorites'), 'error');
          // Revert to original state using the saved original value
          setNodes(prevNodes =>
            prevNodes.map(n => (n.nodeNum === node.nodeNum ? { ...n, isFavorite: originalFavoriteStatus } : n))
          );
          return;
        }
        throw new Error('Failed to update favorite status');
      }

      const result = await response.json();

      // Log the result including device sync status
      let statusMessage = `${newFavoriteStatus ? '⭐' : '☆'} Node ${node.user.id} favorite status updated`;
      if (result.deviceSync) {
        if (result.deviceSync.status === 'success') {
          statusMessage += ' (synced to device ✓)';
        } else if (result.deviceSync.status === 'failed') {
          // Only show error for actual failures (not firmware compatibility)
          statusMessage += ` (device sync failed: ${result.deviceSync.error || 'unknown error'})`;
        }
        // 'skipped' status (e.g., pre-2.7 firmware) is not shown to user - logged on server only
      }
      logger.debug(statusMessage);
    } catch (error) {
      logger.error('Error toggling favorite:', error);
      // Revert to original state using the saved original value
      setNodes(prevNodes =>
        prevNodes.map(n => (n.nodeNum === node.nodeNum ? { ...n, isFavorite: originalFavoriteStatus } : n))
      );
      // Remove from pending on error since we reverted
      pendingFavoriteRequests.delete(node.nodeNum);
      showToast(t('toast.failed_update_favorite'), 'error');
    }
    // Note: On success, the polling logic will remove from pendingFavoriteRequests
    // when it detects the server has caught up
  };

  // Function to toggle node ignored status
  const toggleIgnored = async (node: DeviceInfo, event: React.MouseEvent) => {
    event.stopPropagation(); // Prevent node selection when clicking ignore button

    if (!node.user?.id) {
      logger.error('Cannot toggle ignored: node has no user ID');
      return;
    }

    // Prevent multiple rapid clicks on the same node
    if (pendingIgnoredRequests.has(node.nodeNum)) {
      return;
    }

    // Store the original state before any updates
    const originalIgnoredStatus = node.isIgnored;
    const newIgnoredStatus = !originalIgnoredStatus;

    try {
      // Mark this request as pending with the expected new state
      pendingIgnoredRequests.set(node.nodeNum, newIgnoredStatus);

      // Optimistically update the UI - use flushSync to force immediate render
      // This prevents the polling from overwriting the optimistic update before it renders
      flushSync(() => {
        setNodes(prevNodes => {
          const updated = prevNodes.map(n => (n.nodeNum === node.nodeNum ? { ...n, isIgnored: newIgnoredStatus } : n));
          return updated;
        });
      });

      // Send update to backend (with device sync enabled by default)
      const response = await authFetch(`${baseUrl}/api/nodes/${node.user.id}/ignored`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          isIgnored: newIgnoredStatus,
          syncToDevice: true, // Enable two-way sync to Meshtastic device
        }),
      });

      if (!response.ok) {
        if (response.status === 403) {
          showToast(t('toast.insufficient_permissions_ignored'), 'error');
          // Revert to original state using the saved original value
          setNodes(prevNodes =>
            prevNodes.map(n => (n.nodeNum === node.nodeNum ? { ...n, isIgnored: originalIgnoredStatus } : n))
          );
          return;
        }
        throw new Error('Failed to update ignored status');
      }

      const result = await response.json();

      // Log the result including device sync status
      let statusMessage = `${newIgnoredStatus ? '🚫' : '✅'} Node ${node.user.id} ignored status updated`;
      if (result.deviceSync) {
        if (result.deviceSync.status === 'success') {
          statusMessage += ' (synced to device ✓)';
        } else if (result.deviceSync.status === 'failed') {
          // Only show error for actual failures (not firmware compatibility)
          statusMessage += ` (device sync failed: ${result.deviceSync.error || 'unknown error'})`;
        }
        // 'skipped' status (e.g., pre-2.7 firmware) is not shown to user - logged on server only
      }
      logger.debug(statusMessage);
    } catch (error) {
      logger.error('Error toggling ignored:', error);
      // Revert to original state using the saved original value
      setNodes(prevNodes =>
        prevNodes.map(n => (n.nodeNum === node.nodeNum ? { ...n, isIgnored: originalIgnoredStatus } : n))
      );
      // Remove from pending on error since we reverted
      pendingIgnoredRequests.delete(node.nodeNum);
      showToast(t('toast.failed_update_ignored'), 'error');
    }
    // Note: On success, the polling logic will remove from pendingIgnoredRequests
    // when it detects the server has caught up
  };

  // Function to handle sender icon clicks
  const handleSenderClick = useCallback((nodeId: string, event: React.MouseEvent) => {
    const rect = event.currentTarget.getBoundingClientRect();

    // Get actual sidebar width from the sidebar element itself
    // This handles expanded sidebar (240px) and calc() with safe-area-inset
    const sidebarElement = document.querySelector('.sidebar');
    const sidebarWidth = sidebarElement ? sidebarElement.getBoundingClientRect().width : 60;

    // Popup max-width is 300px, and it's centered with translateX(-50%)
    // So the left edge will be at x - 150px
    const popupHalfWidth = 150;
    let x = rect.left + rect.width / 2;
    let y = rect.top;

    // Ensure popup doesn't go under the sidebar (with 10px padding for safety)
    const minX = sidebarWidth + popupHalfWidth + 10;
    if (x < minX) {
      x = minX;
    }

    // Ensure popup doesn't go off the right edge of the screen
    const maxX = window.innerWidth - popupHalfWidth - 10;
    if (x > maxX) {
      x = maxX;
    }

    // Ensure popup doesn't go above the viewport (popup appears above click point)
    // Popup is approximately 300px tall max, and uses translateY(-100%)
    const minY = 320; // Approximate popup height + padding
    if (y < minY) {
      y = minY;
    }

    setNodePopup({
      nodeId,
      position: {
        x,
        y,
      },
    });
  }, []);

  // Close popup when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (nodePopup && !(event.target as Element).closest('.node-popup, .sender-dot')) {
        setNodePopup(null);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [nodePopup]);

  // Removed renderChannelsTab - using ChannelsTab component instead
  // Handler functions removed - using settings context setters directly

  // Purge handlers moved to SettingsTab component

  // Removed renderSettingsTab - using SettingsTab component instead

  // Create stable digests of nodes and traceroutes that only change when relevant data changes
  // This prevents unnecessary recalculation of traceroutePathsElements
  // Uses getEffectivePosition to respect position overrides (Issue #1526)
  const nodesPositionDigest = useMemo(() => {
    return nodes.map(n => {
      const effectivePos = getEffectivePosition(n);
      return {
        nodeNum: n.nodeNum,
        position: effectivePos.latitude != null && effectivePos.longitude != null
          ? {
              latitude: effectivePos.latitude,
              longitude: effectivePos.longitude,
            }
          : undefined,
        user: n.user
          ? {
              longName: n.user.longName,
              shortName: n.user.shortName,
              id: n.user.id,
            }
          : undefined,
      };
    });
  }, [nodes.map(n => {
    const pos = getEffectivePosition(n);
    return `${n.nodeNum}-${pos.latitude}-${pos.longitude}`;
  }).join(',')]);

  const traceroutesDigest = useMemo(() => {
    return traceroutes.map(tr => ({
      fromNodeNum: tr.fromNodeNum,
      toNodeNum: tr.toNodeNum,
      fromNodeId: tr.fromNodeId,
      toNodeId: tr.toNodeId,
      route: tr.route,
      routeBack: tr.routeBack,
      snrTowards: tr.snrTowards,
      snrBack: tr.snrBack,
      timestamp: tr.timestamp,
      createdAt: tr.createdAt,
    }));
  }, [
    traceroutes
      .map(tr => `${tr.fromNodeNum}-${tr.toNodeNum}-${tr.route}-${tr.routeBack}-${tr.timestamp || tr.createdAt}`)
      .join(','),
  ]);

  // Traceroute paths rendering - extracted to useTraceroutePaths hook
  const tracerouteCallbacks = useMemo(
    () => ({
      onSelectNode: (nodeId: string, position: [number, number]) => {
        setSelectedNodeId(nodeId);
        setMapCenterTarget(position);
      },
      onSelectRouteSegment: (nodeNum1: number, nodeNum2: number) => {
        setSelectedRouteSegment({ nodeNum1, nodeNum2 });
      },
    }),
    [setSelectedNodeId, setMapCenterTarget]
  );

  // Compute visible node numbers for traceroute path filtering
  // This ensures route segments are hidden when their connected nodes are filtered out (Issue #1102)
  const visibleNodeNums = useMemo(() => {
    // Start with processedNodes which already has age, text, and advanced filters applied
    // Then apply the same map-specific filters used in NodesTab for rendering markers
    const visibleNodes = processedNodes.filter(node => {
      // Must have position to be visible on map
      if (!node.position?.latitude || !node.position?.longitude) return false;
      // Apply MQTT filter
      if (!showMqttNodes && node.viaMqtt) return false;
      // Apply incomplete nodes filter
      if (!showIncompleteNodes && !isNodeComplete(node)) return false;
      // Apply estimated positions filter
      if (!showEstimatedPositions && node.user?.id && nodesWithEstimatedPosition.has(node.user.id)) return false;
      return true;
    });
    return new Set(visibleNodes.map(n => n.nodeNum));
  }, [processedNodes, showMqttNodes, showIncompleteNodes, showEstimatedPositions, nodesWithEstimatedPosition]);

  const { traceroutePathsElements, selectedNodeTraceroute, tracerouteNodeNums, tracerouteBounds } = useTraceroutePaths({
    showPaths,
    showRoute,
    selectedNodeId,
    currentNodeId,
    nodesPositionDigest,
    traceroutesDigest,
    distanceUnit,
    maxNodeAgeHours,
    themeColors,
    callbacks: tracerouteCallbacks,
    visibleNodeNums,
  });

  // If anonymous is disabled and user is not authenticated, show login page
  if (authStatus?.anonymousDisabled && !authStatus?.authenticated) {
    return <LoginPage />;
  }

  return (
    <div className="app">
      <AdvancedNodeFilterPopup
        isOpen={showNodeFilterPopup}
        nodeFilters={nodeFilters}
        securityFilter={securityFilter}
        channels={channels}
        onNodeFiltersChange={setNodeFilters}
        onSecurityFilterChange={setSecurityFilter}
        onClose={() => setShowNodeFilterPopup(false)}
      />
      <AppHeader
        baseUrl={baseUrl}
        nodeAddress={nodeAddress}
        currentNodeId={currentNodeId}
        nodes={nodes}
        deviceInfo={deviceInfo}
        authStatus={authStatus}
        connectionStatus={connectionStatus}
        webSocketConnected={webSocketConnected}
        hasPermission={hasPermission}
        onFetchSystemStatus={fetchSystemStatus}
        onDisconnect={handleDisconnect}
        onReconnect={handleReconnect}
        onShowLoginModal={() => setShowLoginModal(true)}
        onLogout={() => setActiveTab('nodes')}
        onNodeClick={handleNodeClick}
      />

      <AppBanners
        isDefaultPassword={isDefaultPassword}
        isTxDisabled={isTxDisabled}
        configIssues={configIssues}
        updateAvailable={updateAvailable}
        latestVersion={latestVersion}
        releaseUrl={releaseUrl}
        upgradeEnabled={upgradeEnabled}
        upgradeInProgress={upgradeInProgress}
        upgradeStatus={upgradeStatus}
        upgradeProgress={upgradeProgress}
        onUpgrade={handleUpgrade}
        onDismissUpdate={() => setUpdateAvailable(false)}
      />

      <LoginModal isOpen={showLoginModal} onClose={() => setShowLoginModal(false)} />
      <RebootModal isOpen={showRebootModal} onClose={handleRebootModalClose} />

      {/* Emoji Picker Modal */}
      <EmojiPickerModal
        message={emojiPickerMessage}
        onSelectEmoji={handleSendTapback}
        onClose={() => setEmojiPickerMessage(null)}
        customEmojis={tapbackEmojis}
      />

      {showTracerouteHistoryModal && selectedDMNode && (
        <TracerouteHistoryModal
          fromNodeNum={parseNodeId(currentNodeId)}
          toNodeNum={parseNodeId(selectedDMNode)}
          fromNodeName={getNodeName(currentNodeId)}
          toNodeName={getNodeName(selectedDMNode)}
          nodes={nodes}
          onClose={() => setShowTracerouteHistoryModal(false)}
        />
      )}

      <PurgeDataModal
        isOpen={showPurgeDataModal}
        selectedNode={selectedDMNode ? nodes.find(n => n.user?.id === selectedDMNode) || null : null}
        onClose={() => setShowPurgeDataModal(false)}
        onPurgeMessages={handlePurgeDirectMessages}
        onPurgeTraceroutes={handlePurgeNodeTraceroutes}
        onPurgeTelemetry={handlePurgeNodeTelemetry}
        onDeleteNode={handleDeleteNode}
        onPurgeFromDevice={handlePurgeNodeFromDevice}
        getNodeName={getNodeName}
      />

      <PositionOverrideModal
        isOpen={showPositionOverrideModal}
        selectedNode={selectedDMNode ? nodes.find(n => n.user?.id === selectedDMNode) || null : null}
        onClose={() => setShowPositionOverrideModal(false)}
        onSave={handlePositionOverrideSave}
        getNodeName={getNodeName}
        baseUrl={baseUrl}
      />

      <NodeInfoModal
        isOpen={showNodeInfoModal}
        onClose={() => setShowNodeInfoModal(false)}
        nodeInfo={deviceInfo?.localNodeInfo ? {
          longName: deviceInfo.localNodeInfo.longName,
          shortName: deviceInfo.localNodeInfo.shortName,
          nodeId: deviceInfo.localNodeInfo.nodeId
        } : null}
        nodeIp={nodeConnectionInfo?.nodeIp || nodeAddress}
        tcpPort={nodeConnectionInfo?.tcpPort || 4403}
        defaultIp={nodeConnectionInfo?.defaultIp || ''}
        defaultPort={nodeConnectionInfo?.defaultPort || 4403}
        isOverridden={nodeConnectionInfo?.isOverridden || false}
        isAdmin={authStatus?.user?.isAdmin || false}
        onChangeIp={handleChangeNodeIp}
      />

      {selectedRouteSegment && (
        <RouteSegmentTraceroutesModal
          nodeNum1={selectedRouteSegment.nodeNum1}
          nodeNum2={selectedRouteSegment.nodeNum2}
          traceroutes={traceroutes}
          nodes={nodes}
          onClose={() => setSelectedRouteSegment(null)}
        />
      )}

      <Sidebar
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        hasPermission={hasPermission}
        isAdmin={authStatus?.user?.isAdmin || false}
        isAuthenticated={authStatus?.authenticated || false}
        unreadCounts={unreadCounts}
        unreadCountsData={unreadCountsData}
        onMessagesClick={() => {
          // Save current channel selection before switching to Messages tab
          if (selectedChannel !== -1) {
            lastChannelSelectionRef.current = selectedChannel;
            logger.debug('💾 Saved channel selection before Messages tab:', selectedChannel);
          }
          setActiveTab('messages');
          // Clear unread count for direct messages (channel -1)
          setUnreadCounts(prev => ({ ...prev, [-1]: 0 }));
          // Set selected channel to -1 so new DMs don't create unread notifications
          setSelectedChannel(-1);
          selectedChannelRef.current = -1;
        }}
        onChannelsClick={() => {
          setActiveTab('channels');
          // Restore last channel selection if available
          if (lastChannelSelectionRef.current !== -1) {
            logger.debug('🔄 Restoring channel selection:', lastChannelSelectionRef.current);
            setSelectedChannel(lastChannelSelectionRef.current);
            selectedChannelRef.current = lastChannelSelectionRef.current;
            // Clear unread count for restored channel
            setUnreadCounts(prev => ({ ...prev, [lastChannelSelectionRef.current]: 0 }));
          } else if (channels.length > 0 && selectedChannel === -1) {
            // No saved selection, default to first channel
            logger.debug('📌 No saved selection, using first channel:', channels[0].id);
            setSelectedChannel(channels[0].id);
            selectedChannelRef.current = channels[0].id;
            setUnreadCounts(prev => ({ ...prev, [channels[0].id]: 0 }));
          }
        }}
        onNewsClick={() => {
          setForceShowAllNews(true);
          setShowNewsPopup(true);
        }}
        baseUrl={baseUrl}
        connectedNodeName={connectedNodeName}
        meshcoreEnabled={authStatus?.meshcoreEnabled || false}
      />

      <main className="app-main">
        {error && (
          <div className="error-panel">
            <h3>Connection Error</h3>
            <p>{error}</p>
            <div className="error-actions">
              <button onClick={() => checkConnectionStatus()} className="retry-btn">
                Retry Connection
              </button>
              <button onClick={() => setError(null)} className="dismiss-error">
                Dismiss
              </button>
            </div>
          </div>
        )}

        {activeTab === 'nodes' && (
          <NodesTab
            processedNodes={processedNodes}
            shouldShowData={shouldShowData}
            centerMapOnNode={centerMapOnNode}
            toggleFavorite={toggleFavorite}
            setActiveTab={setActiveTab}
            setSelectedDMNode={setSelectedDMNode}
            markerRefs={markerRefs}
            traceroutePathsElements={traceroutePathsElements}
            selectedNodeTraceroute={selectedNodeTraceroute}
            visibleNodeNums={visibleNodeNums}
            tracerouteNodeNums={tracerouteNodeNums}
            tracerouteBounds={tracerouteBounds}
            onTraceroute={handleTraceroute}
            connectionStatus={connectionStatus}
            tracerouteLoading={tracerouteLoading}
          />
        )}
        {activeTab === 'channels' && (
          <ChannelsTab
            channels={channels}
            channelDatabaseEntries={channelDatabaseEntries}
            channelMessages={channelMessages}
            messages={messages}
            currentNodeId={currentNodeId}
            connectionStatus={connectionStatus}
            selectedChannel={selectedChannel}
            setSelectedChannel={setSelectedChannel}
            selectedChannelRef={selectedChannelRef}
            showMqttMessages={showMqttMessages}
            setShowMqttMessages={setShowMqttMessages}
            newMessage={newMessage}
            setNewMessage={setNewMessage}
            replyingTo={replyingTo}
            setReplyingTo={setReplyingTo}
            unreadCounts={unreadCounts}
            setUnreadCounts={setUnreadCounts}
            markMessagesAsRead={markMessagesAsRead}
            channelInfoModal={channelInfoModal}
            setChannelInfoModal={setChannelInfoModal}
            showPsk={showPsk}
            setShowPsk={setShowPsk}
            timeFormat={timeFormat}
            dateFormat={dateFormat}
            hasPermission={hasPermission}
            handleSendMessage={handleSendMessage}
            handleResendMessage={handleResendMessage}
            handleDeleteMessage={handleDeleteMessage}
            handleSendTapback={handleSendTapback}
            handlePurgeChannelMessages={handlePurgeChannelMessages}
            handleSenderClick={handleSenderClick}
            shouldShowData={shouldShowData}
            getNodeName={getNodeName}
            getNodeShortName={getNodeShortName}
            isMqttBridgeMessage={isMqttBridgeMessage}
            setEmojiPickerMessage={setEmojiPickerMessage}
            channelMessagesContainerRef={channelMessagesContainerRef}
          />
        )}
        {activeTab === 'messages' && (
          <MessagesTab
            processedNodes={processedNodes}
            nodes={nodes}
            messages={messages}
            currentNodeId={currentNodeId}
            nodesWithTelemetry={nodesWithTelemetry}
            nodesWithWeatherTelemetry={nodesWithWeatherTelemetry}
            nodesWithPKC={nodesWithPKC}
            connectionStatus={connectionStatus}
            selectedDMNode={selectedDMNode}
            setSelectedDMNode={setSelectedDMNode}
            newMessage={newMessage}
            setNewMessage={setNewMessage}
            replyingTo={replyingTo}
            setReplyingTo={setReplyingTo}
            unreadCountsData={unreadCountsData}
            markMessagesAsRead={markMessagesAsRead}
            nodeFilter={_nodeFilter} // Deprecated - kept for backward compatibility
            setNodeFilter={_setNodeFilter} // Deprecated
            messagesNodeFilter={messagesNodeFilter}
            setMessagesNodeFilter={setMessagesNodeFilter}
            dmFilter={dmFilter}
            setDmFilter={setDmFilter}
            securityFilter={securityFilter}
            channelFilter={channelFilter}
            showIncompleteNodes={showIncompleteNodes}
            showNodeFilterPopup={showNodeFilterPopup}
            setShowNodeFilterPopup={setShowNodeFilterPopup}
            isMessagesNodeListCollapsed={isMessagesNodeListCollapsed}
            setIsMessagesNodeListCollapsed={setIsMessagesNodeListCollapsed}
            tracerouteLoading={tracerouteLoading}
            positionLoading={positionLoading}
            nodeInfoLoading={nodeInfoLoading}
            neighborInfoLoading={neighborInfoLoading}
            telemetryRequestLoading={telemetryRequestLoading}
            timeFormat={timeFormat}
            dateFormat={dateFormat}
            temperatureUnit={temperatureUnit}
            telemetryVisualizationHours={telemetryVisualizationHours}
            distanceUnit={distanceUnit}
            baseUrl={baseUrl}
            hasPermission={hasPermission}
            handleSendDirectMessage={handleSendDirectMessage}
            handleResendMessage={handleResendMessage}
            handleTraceroute={handleTraceroute}
            handleExchangePosition={handleExchangePosition}
            handleExchangeNodeInfo={handleExchangeNodeInfo}
            handleRequestNeighborInfo={handleRequestNeighborInfo}
            handleRequestTelemetry={handleRequestTelemetry}
            handleDeleteMessage={handleDeleteMessage}
            handleSenderClick={handleSenderClick}
            handleSendTapback={handleSendTapback}
            getRecentTraceroute={getRecentTraceroute}
            setShowTracerouteHistoryModal={setShowTracerouteHistoryModal}
            setShowPurgeDataModal={setShowPurgeDataModal}
            setShowPositionOverrideModal={setShowPositionOverrideModal}
            setEmojiPickerMessage={setEmojiPickerMessage}
            shouldShowData={shouldShowData}
            dmMessagesContainerRef={dmMessagesContainerRef}
            toggleIgnored={toggleIgnored}
            toggleFavorite={toggleFavorite}
            handleShowOnMap={(nodeId: string) => {
              const node = nodes.find(n => n.user?.id === nodeId);
              if (node?.position?.latitude != null && node?.position?.longitude != null) {
                setSelectedNodeId(nodeId);
                setMapCenterTarget([node.position.latitude, node.position.longitude]);
                setActiveTab('nodes');
              }
            }}
          />
        )}
        {activeTab === 'info' && (
          <InfoTab
            connectionStatus={connectionStatus}
            nodeAddress={nodeAddress}
            deviceInfo={deviceInfo}
            deviceConfig={deviceConfig}
            nodes={nodes}
            channels={channels}
            messages={messages}
            channelMessages={channelMessages}
            currentNodeId={currentNodeId}
            temperatureUnit={temperatureUnit}
            telemetryHours={telemetryVisualizationHours}
            baseUrl={baseUrl}
            getAvailableChannels={getAvailableChannels}
            distanceUnit={distanceUnit}
            timeFormat={timeFormat}
            dateFormat={dateFormat}
            isAuthenticated={authStatus?.authenticated || false}
          />
        )}
        {activeTab === 'dashboard' && (
          <Dashboard
            temperatureUnit={temperatureUnit}
            telemetryHours={telemetryVisualizationHours}
            favoriteTelemetryStorageDays={favoriteTelemetryStorageDays}
            baseUrl={baseUrl}
            currentNodeId={currentNodeId}
            canEdit={hasPermission('dashboard', 'write')}
          />
        )}
        {activeTab === 'settings' && (
          <SettingsTab
            maxNodeAgeHours={maxNodeAgeHours}
            inactiveNodeThresholdHours={inactiveNodeThresholdHours}
            inactiveNodeCheckIntervalMinutes={inactiveNodeCheckIntervalMinutes}
            inactiveNodeCooldownHours={inactiveNodeCooldownHours}
            temperatureUnit={temperatureUnit}
            distanceUnit={distanceUnit}
            positionHistoryLineStyle={positionHistoryLineStyle}
            telemetryVisualizationHours={telemetryVisualizationHours}
            favoriteTelemetryStorageDays={favoriteTelemetryStorageDays}
            preferredSortField={preferredSortField}
            preferredSortDirection={preferredSortDirection}
            timeFormat={timeFormat}
            dateFormat={dateFormat}
            mapTileset={mapTileset}
            mapPinStyle={mapPinStyle}
            theme={theme}
            language={language}
            solarMonitoringEnabled={solarMonitoringEnabled}
            solarMonitoringLatitude={solarMonitoringLatitude}
            solarMonitoringLongitude={solarMonitoringLongitude}
            solarMonitoringAzimuth={solarMonitoringAzimuth}
            solarMonitoringDeclination={solarMonitoringDeclination}
            currentNodeId={currentNodeId}
            nodes={nodes}
            baseUrl={baseUrl}
            onMaxNodeAgeChange={setMaxNodeAgeHours}
            onInactiveNodeThresholdHoursChange={setInactiveNodeThresholdHours}
            onInactiveNodeCheckIntervalMinutesChange={setInactiveNodeCheckIntervalMinutes}
            onInactiveNodeCooldownHoursChange={setInactiveNodeCooldownHours}
            onTemperatureUnitChange={setTemperatureUnit}
            onDistanceUnitChange={setDistanceUnit}
            onPositionHistoryLineStyleChange={setPositionHistoryLineStyle}
            onTelemetryVisualizationChange={setTelemetryVisualizationHours}
            onFavoriteTelemetryStorageDaysChange={setFavoriteTelemetryStorageDays}
            onPreferredSortFieldChange={setPreferredSortField}
            onPreferredSortDirectionChange={setPreferredSortDirection}
            onTimeFormatChange={setTimeFormat}
            onDateFormatChange={setDateFormat}
            onMapTilesetChange={setMapTileset}
            onMapPinStyleChange={setMapPinStyle}
            onThemeChange={setTheme}
            onLanguageChange={setLanguage}
            onSolarMonitoringEnabledChange={setSolarMonitoringEnabled}
            onSolarMonitoringLatitudeChange={setSolarMonitoringLatitude}
            onSolarMonitoringLongitudeChange={setSolarMonitoringLongitude}
            onSolarMonitoringAzimuthChange={setSolarMonitoringAzimuth}
            onSolarMonitoringDeclinationChange={setSolarMonitoringDeclination}
          />
        )}
        {activeTab === 'automation' && (
          <div className="settings-tab">
            <SectionNav
              items={[
                { id: 'auto-welcome', label: t('automation.welcome.title', 'Auto Welcome') },
                { id: 'auto-traceroute', label: t('automation.traceroute.title', 'Auto Traceroute') },
                { id: 'remote-admin-scanner', label: t('automation.remote_admin_scanner.title', 'Remote Admin Scanner') },
                { id: 'auto-time-sync', label: t('automation.time_sync.title', 'Auto Time Sync') },
                { id: 'auto-acknowledge', label: t('automation.acknowledge.title', 'Auto Acknowledge') },
                { id: 'auto-announce', label: t('automation.announce.title', 'Auto Announce') },
                { id: 'auto-responder', label: t('automation.auto_responder.title', 'Auto Responder') },
                { id: 'auto-key-management', label: t('automation.auto_key_management.title', 'Auto Key Management') },
                { id: 'timer-triggers', label: t('automation.timer_triggers.title', 'Timer Triggers') },
                { id: 'geofence-triggers', label: t('automation.geofence_triggers.title', 'Geofence Triggers') },
                { id: 'ignored-nodes', label: t('automation.ignored_nodes.title', 'Ignored Nodes') },
              ]}
            />
            <div className="settings-content">
              <div id="auto-welcome">
                <AutoWelcomeSection
                  enabled={autoWelcomeEnabled}
                  message={autoWelcomeMessage}
                  target={autoWelcomeTarget}
                  waitForName={autoWelcomeWaitForName}
                  maxHops={autoWelcomeMaxHops}
                  channels={channels}
                  baseUrl={baseUrl}
                  onEnabledChange={setAutoWelcomeEnabled}
                  onMessageChange={setAutoWelcomeMessage}
                  onTargetChange={setAutoWelcomeTarget}
                  onWaitForNameChange={setAutoWelcomeWaitForName}
                  onMaxHopsChange={setAutoWelcomeMaxHops}
                />
              </div>
              <div id="auto-traceroute">
                <AutoTracerouteSection
                  intervalMinutes={tracerouteIntervalMinutes}
                  baseUrl={baseUrl}
                  onIntervalChange={setTracerouteIntervalMinutes}
                />
              </div>
              <div id="remote-admin-scanner">
                <RemoteAdminScannerSection
                  baseUrl={baseUrl}
                />
              </div>
              <div id="auto-time-sync">
                <AutoTimeSyncSection
                  baseUrl={baseUrl}
                />
              </div>
              <div id="auto-acknowledge">
                <AutoAcknowledgeSection
                  enabled={autoAckEnabled}
                  regex={autoAckRegex}
                  message={autoAckMessage}
                  messageDirect={autoAckMessageDirect}
                  channels={channels}
                  enabledChannels={autoAckChannels}
                  directMessagesEnabled={autoAckDirectMessages}
                  useDM={autoAckUseDM}
                  skipIncompleteNodes={autoAckSkipIncompleteNodes}
                  tapbackEnabled={autoAckTapbackEnabled}
                  replyEnabled={autoAckReplyEnabled}
                  directEnabled={autoAckDirectEnabled}
                  directTapbackEnabled={autoAckDirectTapbackEnabled}
                  directReplyEnabled={autoAckDirectReplyEnabled}
                  multihopEnabled={autoAckMultihopEnabled}
                  multihopTapbackEnabled={autoAckMultihopTapbackEnabled}
                  multihopReplyEnabled={autoAckMultihopReplyEnabled}
                  testMessages={autoAckTestMessages}
                  baseUrl={baseUrl}
                  onEnabledChange={setAutoAckEnabled}
                  onRegexChange={setAutoAckRegex}
                  onMessageChange={setAutoAckMessage}
                  onMessageDirectChange={setAutoAckMessageDirect}
                  onChannelsChange={setAutoAckChannels}
                  onDirectMessagesChange={setAutoAckDirectMessages}
                  onUseDMChange={setAutoAckUseDM}
                  onSkipIncompleteNodesChange={setAutoAckSkipIncompleteNodes}
                  onTapbackEnabledChange={setAutoAckTapbackEnabled}
                  onReplyEnabledChange={setAutoAckReplyEnabled}
                  onDirectEnabledChange={setAutoAckDirectEnabled}
                  onDirectTapbackEnabledChange={setAutoAckDirectTapbackEnabled}
                  onDirectReplyEnabledChange={setAutoAckDirectReplyEnabled}
                  onMultihopEnabledChange={setAutoAckMultihopEnabled}
                  onMultihopTapbackEnabledChange={setAutoAckMultihopTapbackEnabled}
                  onMultihopReplyEnabledChange={setAutoAckMultihopReplyEnabled}
                  onTestMessagesChange={setAutoAckTestMessages}
                />
              </div>
              <div id="auto-announce">
                <AutoAnnounceSection
                  enabled={autoAnnounceEnabled}
                  intervalHours={autoAnnounceIntervalHours}
                  message={autoAnnounceMessage}
                  channelIndex={autoAnnounceChannelIndex}
                  announceOnStart={autoAnnounceOnStart}
                  useSchedule={autoAnnounceUseSchedule}
                  schedule={autoAnnounceSchedule}
                  channels={channels}
                  baseUrl={baseUrl}
                  onEnabledChange={setAutoAnnounceEnabled}
                  onIntervalChange={setAutoAnnounceIntervalHours}
                  onMessageChange={setAutoAnnounceMessage}
                  onChannelChange={setAutoAnnounceChannelIndex}
                  onAnnounceOnStartChange={setAutoAnnounceOnStart}
                  onUseScheduleChange={setAutoAnnounceUseSchedule}
                  onScheduleChange={setAutoAnnounceSchedule}
                  nodeInfoEnabled={autoAnnounceNodeInfoEnabled}
                  nodeInfoChannels={autoAnnounceNodeInfoChannels}
                  nodeInfoDelaySeconds={autoAnnounceNodeInfoDelaySeconds}
                  onNodeInfoEnabledChange={setAutoAnnounceNodeInfoEnabled}
                  onNodeInfoChannelsChange={setAutoAnnounceNodeInfoChannels}
                  onNodeInfoDelayChange={setAutoAnnounceNodeInfoDelaySeconds}
                />
              </div>
              <div id="auto-responder">
                <AutoResponderSection
                  enabled={autoResponderEnabled}
                  triggers={autoResponderTriggers}
                  channels={channels}
                  skipIncompleteNodes={autoResponderSkipIncompleteNodes}
                  baseUrl={baseUrl}
                  onEnabledChange={setAutoResponderEnabled}
                  onTriggersChange={setAutoResponderTriggers}
                  onSkipIncompleteNodesChange={setAutoResponderSkipIncompleteNodes}
                />
              </div>
              <div id="auto-key-management">
                <AutoKeyManagementSection
                  enabled={autoKeyManagementEnabled}
                  intervalMinutes={autoKeyManagementIntervalMinutes}
                  maxExchanges={autoKeyManagementMaxExchanges}
                  autoPurge={autoKeyManagementAutoPurge}
                  baseUrl={baseUrl}
                  onEnabledChange={setAutoKeyManagementEnabled}
                  onIntervalChange={setAutoKeyManagementIntervalMinutes}
                  onMaxExchangesChange={setAutoKeyManagementMaxExchanges}
                  onAutoPurgeChange={setAutoKeyManagementAutoPurge}
                />
              </div>
              <div id="timer-triggers">
                <TimerTriggersSection
                  triggers={timerTriggers}
                  channels={channels}
                  baseUrl={baseUrl}
                  onTriggersChange={setTimerTriggers}
                />
              </div>
              <div id="geofence-triggers">
                <GeofenceTriggersSection
                  triggers={geofenceTriggers}
                  channels={channels}
                  nodes={nodes}
                  baseUrl={baseUrl}
                  onTriggersChange={setGeofenceTriggers}
                />
              </div>
              <div id="ignored-nodes">
                <IgnoredNodesSection
                  baseUrl={baseUrl}
                />
              </div>
            </div>
          </div>
        )}
        {activeTab === 'configuration' && (
          <ConfigurationTab
            baseUrl={baseUrl}
            nodes={nodes}
            channels={channels}
            onRebootDevice={handleRebootDevice}
            onConfigChangeTriggeringReboot={handleConfigChangeTriggeringReboot}
            onChannelsUpdated={() => fetchChannels()}
            refreshTrigger={configRefreshTrigger}
          />
        )}
        {activeTab === 'notifications' && <NotificationsTab isAdmin={authStatus?.user?.isAdmin || false} />}
        {activeTab === 'users' && <UsersTab />}
        {activeTab === 'audit' && <AuditLogTab />}
        {activeTab === 'admin' && authStatus?.user?.isAdmin && (
          <AdminCommandsTab
            nodes={nodes}
            currentNodeId={currentNodeId}
            channels={channels}
            onChannelsUpdated={fetchChannels}
          />
        )}
        {activeTab === 'security' && (
          <SecurityTab onTabChange={setActiveTab} onSelectDMNode={setSelectedDMNode} setNewMessage={setNewMessage} />
        )}
        {activeTab === 'meshcore' && <MeshCoreTab />}
      </main>

      {/* Node Popup */}
      <NodePopup
        nodePopup={nodePopup}
        nodes={nodes}
        timeFormat={timeFormat}
        dateFormat={dateFormat}
        hasPermission={hasPermission}
        onDMNode={nodeId => {
          setSelectedDMNode(nodeId);
          setActiveTab('messages');
        }}
        onShowOnMap={(node: DeviceInfo) => {
          if (node.user?.id && node.position?.latitude != null && node.position?.longitude != null) {
            setSelectedNodeId(node.user.id);
            setMapCenterTarget([node.position.latitude, node.position.longitude]);
            setActiveTab('nodes');
          }
        }}
        onClose={() => setNodePopup(null)}
        traceroutes={traceroutes}
        currentNodeId={currentNodeId}
        distanceUnit={distanceUnit}
        onTraceroute={handleTraceroute}
        connectionStatus={connectionStatus}
        tracerouteLoading={tracerouteLoading}
      />

      {/* News Popup */}
      <NewsPopup
        isOpen={showNewsPopup}
        onClose={() => {
          setShowNewsPopup(false);
          setForceShowAllNews(false);
        }}
        forceShowAll={forceShowAllNews}
        isAuthenticated={authStatus?.authenticated || false}
      />

      {/* System Status Modal */}
      <SystemStatusModal
        isOpen={showStatusModal}
        systemStatus={systemStatus}
        onClose={() => setShowStatusModal(false)}
      />

      {/* SaveBar for unified save/dismiss actions */}
      <SaveBar />
    </div>
  );
}

const AppWithToast = () => {
  // Detect base URL for SettingsProvider
  const detectBaseUrl = () => {
    const pathname = window.location.pathname;
    const pathParts = pathname.split('/').filter(Boolean);

    if (pathParts.length > 0) {
      const appRoutes = ['nodes', 'channels', 'messages', 'settings', 'info', 'dashboard'];
      const baseSegments = [];

      for (const segment of pathParts) {
        if (appRoutes.includes(segment.toLowerCase())) {
          break;
        }
        baseSegments.push(segment);
      }

      if (baseSegments.length > 0) {
        return '/' + baseSegments.join('/');
      }
    }

    return '';
  };

  const initialBaseUrl = detectBaseUrl();

  return (
    <SettingsProvider baseUrl={initialBaseUrl}>
      <MapProvider>
        <DataProvider>
          <MessagingProvider baseUrl={initialBaseUrl}>
            <UIProvider>
              <ToastProvider>
                <SaveBarProvider>
                  <App />
                </SaveBarProvider>
              </ToastProvider>
            </UIProvider>
          </MessagingProvider>
        </DataProvider>
      </MapProvider>
    </SettingsProvider>
  );
};

export default AppWithToast;
