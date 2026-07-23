import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
// Popup and Polyline moved to useTraceroutePaths hook
// Recharts imports moved to useTraceroutePaths hook
// L (leaflet default export) moved with markerRefs to useSourceView (#3962 5.4 PR4)
import 'leaflet/dist/leaflet.css';
import './App.css';
import './components/map/leafletDefaultIcon';

import InfoTab from './components/InfoTab';
import SettingsTab from './components/SettingsTab';
import ConfigurationTab from './components/ConfigurationTab';
import MqttBridgeConfigurationView from './components/MQTT/MqttBridgeConfigurationView';
import NotificationsTab from './components/NotificationsTab';
import UsersTab from './components/UsersTab';
import AuditLogTab from './components/AuditLogTab';
import { SecurityTab } from './components/SecurityTab';
import AdminCommandsTab from './components/AdminCommandsTab';
import Dashboard from './components/Dashboard';
import NodesTab from './components/NodesTab';
import MessagesTab from './components/MessagesTab';
import ChannelsTab from './components/ChannelsTab';
import PacketMonitorPanel from './components/PacketMonitorPanel';
import MqttPacketMonitorView from './components/MQTT/MqttPacketMonitorView';
import AutomationTab from './components/AutomationTab';
import { ToastProvider, useToast } from './components/ToastContainer';
import DeviceNotificationToaster from './components/DeviceNotificationToaster';
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
import { NodeFilters } from './types/ui';
import { getHashTabRedirectTarget } from './utils/tabHashRedirect';
import { ResourceType } from './types/permission';
import api, { type ChannelDatabaseEntry } from './services/api';
import { getPacketStats } from './services/packetApi';
import { logger } from './utils/logger';
// generateArrowMarkers moved to useTraceroutePaths hook
// isNodeComplete/getEffectivePosition/effectiveMapMaxAgeHours/
// nodePassesTransportFilter/transportCutoffSec moved with processedNodes/
// visibleNodeNums/centerMapOnNode to useSourceView (#3962 5.4 PR4)
import { settingsToMatrix } from './utils/autoAckMatrix';
import { applyHomoglyphOptimization } from './utils/homoglyph';
import Sidebar from './components/Sidebar';
import { SearchModal } from './components/SearchModal/SearchModal.js';
import { SettingsProvider, useSettings } from './contexts/SettingsContext';
import { MapProvider, useMapContext } from './contexts/MapContext';
import type { PositionHistoryItem } from './contexts/MapContext';
import { DataProvider, useData } from './contexts/DataContext';
import { MessagingProvider, useMessaging } from './contexts/MessagingContext';
import { UIProvider, useUI } from './contexts/UIContext';
import { AutomationProvider, useAutomation } from './contexts/AutomationContext';
import { useAuth } from './contexts/AuthContext';
import { useCsrf } from './contexts/CsrfContext';
import { useSource } from './contexts/SourceContext';
import { useNavigate, useLocation, Routes, Route, Navigate } from 'react-router-dom';
import { useWebSocketConnected } from './contexts/WebSocketContext';
import { useHealth } from './hooks/useHealth';
import { useTxStatus } from './hooks/useTxStatus';
import { useVersionCheck } from './hooks/useVersionCheck';
import { useQueryClient } from '@tanstack/react-query';
import { usePoll, type PollData } from './hooks/usePoll';
import { useNodes, useChannels, setNodeFieldInCache } from './hooks/useServerData';
import { useSourceView } from './hooks/useSourceView';
import { useMessagingView } from './hooks/useMessagingView';
import { useNotificationNavigationHandler } from './hooks/useNotificationNavigationHandler';
import { appBasename } from './init';
import LoginModal from './components/LoginModal';
import LoginPage from './components/LoginPage';
import { SaveBarProvider, SaveBarGroup } from './contexts/SaveBarContext';
import { SaveBar } from './components/SaveBar';
import ErrorBoundary from './components/common/ErrorBoundary';

// Pending favorite/ignored/hide-from-map toggle tracking lives in
// src/utils/pendingToggles.ts as module-level singletons. Favorite/
// favoriteLock (and the sweepAll/reconciliation-on-read step, now
// applyPendingNodeOverrides) moved fully into useSourceView.ts /
// useServerData.ts's useNodes() (#3962 5.4 PR4 + PR8); toggleIgnored/
// toggleHideFromMap below still use pendingIgnoredRequests/
// pendingHideFromMapRequests/favoritePendingKey directly for their
// rapid-click guard and pending-state bookkeeping.
import {
  favoritePendingKey,
  pendingIgnoredRequests,
  pendingHideFromMapRequests,
} from './utils/pendingToggles';
import TracerouteHistoryModal from './components/TracerouteHistoryModal';
import RouteSegmentTraceroutesModal from './components/RouteSegmentTraceroutesModal';

// Icons and helpers are now imported from utils/

function App() {
  const { t } = useTranslation();
  const { authStatus, hasPermission, loading: authLoading } = useAuth();
  const { getToken: getCsrfToken, refreshToken: refreshCsrfToken } = useCsrf();
  const { sourceId, sourceName, sourceType } = useSource();
  // MQTT Bridge mirror dashboard — strip send capability + device-config
  // surfaces; the bridge feeds us inbound packets only.
  const isMqttBridge = sourceType === 'mqtt_bridge';
  const isMqttBroker = sourceType === 'mqtt_broker';
  const isMqtt = isMqttBridge || isMqttBroker;
  const navigate = useNavigate();
  const location = useLocation();

  // Hash->path redirect shim (#3962 5.4 PR1, kept >= 1 release). See
  // getHashTabRedirectTarget for the full rationale + enumerated
  // bookmark/embed refs it covers. Forward `state` (e.g. focusDmNodeId) so
  // downstream effects that read location.state still see it after redirect.
  useEffect(() => {
    const target = getHashTabRedirectTarget(location.pathname, location.hash);
    if (target) {
      void navigate(target, { replace: true, state: location.state });
    }
  }, [location.hash, location.pathname, location.state, navigate]);

  const webSocketConnected = useWebSocketConnected();
  const { showToast } = useToast();
  const [showLoginModal, setShowLoginModal] = useState(false);
  const [configIssues, setConfigIssues] = useState<
    Array<{
      type: 'cookie_secure' | 'allowed_origins';
      severity: 'error' | 'warning';
      message: string;
      docsUrl: string;
    }>
  >([]);
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
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [focusMessageId, setFocusMessageId] = useState<string | null>(null);
  const [packetLogEnabled, setPacketLogEnabled] = useState(false);

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
        if (parsed.showFavoriteLocked === undefined) {
          parsed.showFavoriteLocked = false;
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
      showFavoriteLocked: false,
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
  // pendingMessagesRef, the container refs, and channelMessagesRef/messagesRef
  // moved into useMessagingView (#3962 5.4 PR7) — that hook now owns them and
  // returns pendingMessagesRef/channelMessagesContainerRef/dmMessagesContainerRef
  // for the send/resend/tapback handlers below to keep using.
  const homoglyphEnabledRef = useRef<boolean>(false); // Track homoglyph setting for send handlers

  // Constants for emoji tapbacks
  const EMOJI_FLAG = 1; // Protobuf flag indicating this is a tapback/reaction

  // baseUrl = appBasename (imported from './init'), the deployment base
  // path. App used to hand-roll its own copy of this by walking the current
  // pathname (detectBaseUrl); that duplicated logic — and a second copy in
  // AppWithToast below — are gone as of #3962 5.4 PR8. appBasename is
  // derived once from the server-injected <base> tag before React mounts,
  // and is already the value react-router's BrowserRouter trusts for every
  // route in the app (main.tsx `basename={appBasename}`), so App no longer
  // needs its own state for it.
  const baseUrl = appBasename;

  // Monitor server health and auto-reload on version change (e.g., after auto-upgrade)
  useHealth({ baseUrl, reloadOnVersionChange: true });

  // Monitor device TX status to show warning banner when TX is disabled
  const { isTxDisabled } = useTxStatus({ baseUrl, sourceId });

  // Check for version updates. TanStack Query's refetchInterval replaces the
  // hand-rolled setInterval (#3962 Phase 5.1); the hook stops polling on a 404
  // (version checking disabled server-side, env.versionCheckDisabled).
  const { updateAvailable, latestVersion, releaseUrl, deploymentMethod } = useVersionCheck(baseUrl);

  // Settings from context
  const {
    maxNodeAgeHours,
    inactiveNodeThresholdHours,
    inactiveNodeCheckIntervalMinutes,
    inactiveNodeCooldownHours,
    temperatureUnit,
    distanceUnit,
    telemetryVisualizationHours,
    favoriteTelemetryStorageDays,
    preferredSortField,
    preferredSortDirection,
    timeFormat,
    dateFormat,
    mapTilesetLight,
    mapTilesetDark,
    mapPinStyle,
    iconStyle,
    theme,
    language,
    solarMonitoringEnabled,
    solarMonitoringLatitude,
    solarMonitoringLongitude,
    solarMonitoringAzimuth,
    solarMonitoringDeclination,
    tapbackEmojis,
    setMaxNodeAgeHours,
    setInactiveNodeThresholdHours,
    setInactiveNodeCheckIntervalMinutes,
    setInactiveNodeCooldownHours,
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
    setMapTilesets,
    setMapPinStyle,
    setIconStyle,
    setLanguage,
    setSolarMonitoringEnabled,
    setSolarMonitoringLatitude,
    setSolarMonitoringLongitude,
    setSolarMonitoringAzimuth,
    setSolarMonitoringDeclination,
    overlayColors: schemeColors,
  } = useSettings();

  // isChannelMuted/isDMMuted moved into useMessagingView (#3962 5.4 PR7) —
  // its only consumer (applyPollMessages' notification-sound logic) lives
  // there now, which calls useNotificationMuteSettings() itself.

  // Map context
  // showPaths/showRoute/showMqttNodes/showUdpNodes/showRfNodes/
  // showEstimatedPositions/mapZoom/mapMaxAgeHours moved out of this
  // destructure — their only consumers (processedNodes/visibleNodeNums/
  // useTraceroutePaths) now live in useSourceView, which calls
  // useMapContext() itself (#3962 5.4 PR4).
  const {
    setMapCenterTarget,
    traceroutes,
    setTraceroutes,
    setNeighborInfo,
    setPositionHistory,
    selectedNodeId,
    setSelectedNodeId,
  } = useMapContext();

  // effectiveMapMaxAge (#3322) moved into useSourceView (#3962 5.4 PR4) —
  // its only consumers (visibleNodeNums, useTraceroutePaths) live there now,
  // and the hook recomputes it itself from useMapContext()/useSettings().

  // Data context. `nodes`/`channels` no longer live here — DataContext
  // stopped mirroring poll-derived server data for them (#3962 5.4 PR8); they
  // now come straight from the poll query cache via useNodes()/useChannels()
  // below. `connectionStatus` stays: it is a client-driven state machine
  // ('rebooting'/'configuring'/'node-offline'/'connecting'/etc, set from
  // checkConnectionStatus/handleReboot*/handleDisconnect/handleReconnect/
  // FirmwareUpdateSection) with no poll-cache equivalent — useConnectionInfo()
  // only exposes the boolean connected/nodeResponsive/configuring/
  // userDisconnected flags the server reports, not this richer client state
  // machine, so it does not map cleanly onto DataContext deletion.
  const {
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
  } = useData();

  // nodes/channels sourced from the poll query cache (#3962 5.4 PR8).
  // queryClient backs the optimistic toggleIgnored/toggleHideFromMap writes
  // below (setNodeFieldInCache) — the query-cache-native replacement for the
  // old DataContext setNodes(...) writes.
  const { nodes } = useNodes();
  const { channels } = useChannels();
  const queryClient = useQueryClient();

  // Telemetry availability Sets (nodesWithTelemetry/nodesWithWeatherTelemetry/
  // nodesWithEstimatedPosition/nodesWithPKC) were sourced here directly from
  // the poll cache (#3962 5.4 PR2) but were consumed ONLY by processedNodes/
  // visibleNodeNums, both now owned by useSourceView (#3962 5.4 PR4), which
  // calls useTelemetryNodes() itself.

  // messages/channelMessages (+ their channelHasMore/channelLoadingMore/
  // dmHasMore/dmLoadingMore pagination state) were sourced here directly from
  // DataContext but are not pure poll-cache mirrors — the optimistic-send
  // merge and infinite-scroll pagination logic they need now live in
  // useMessagingView (#3962 5.4 PR7), which owns this state itself.

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

  // Merge overlay scheme colors into theme colors for traceroute rendering
  const mergedThemeColors = useMemo(() => ({
    ...themeColors,
    tracerouteForward: schemeColors.tracerouteForward,
    tracerouteReturn: schemeColors.tracerouteReturn,
    mqttSegment: schemeColors.mqttSegment,
    neighborLine: schemeColors.neighborLine,
    snrColors: schemeColors.snrColors,
  }), [themeColors, schemeColors]);

  // Channel Database entries for displaying names of server-decrypted channels.
  // For non-admins the backend filters this to entries they may read, so a
  // non-empty list also means "the user can read at least one virtual channel".
  const [channelDatabaseEntries, setChannelDatabaseEntries] = useState<ChannelDatabaseEntry[]>([]);
  // Whether the channel-database fetch has completed at least once. Used to
  // defer the Channels-tab permission redirect until virtual-channel access is
  // known, so a virtual-channel-only user isn't bounced off #channels during
  // the async load.
  const [channelDatabaseLoaded, setChannelDatabaseLoaded] = useState(false);

  // Fetch Channel Database entries (names for server-decrypted / virtual
  // channels). Anonymous is a real permissioned account too: the backend
  // honors its per-entry virtual-channel `canRead` grants and returns the
  // PSK-masked list, so fetch regardless of login state (fails silently with
  // 403 for users who have no virtual-channel access).
  useEffect(() => {
    const fetchChannelDatabaseEntries = async () => {
      if (!authStatus) return;
      try {
        const response = await api.getChannelDatabaseEntries();
        if (response.success && response.data) {
          setChannelDatabaseEntries(response.data);
        }
      } catch (err) {
        // Channel database might not be accessible to all users, fail silently
        logger.debug('Failed to fetch channel database entries:', err);
      } finally {
        setChannelDatabaseLoaded(true);
      }
    };
    void fetchChannelDatabaseEntries();
  }, [authStatus]);

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
    void checkUnreadNews();
  }, [authStatus?.authenticated]);

  // Check if packet logging is enabled on the server
  // Re-check when auth status changes (permissions may have changed)
  useEffect(() => {
    const checkPacketLogStatus = async () => {
      try {
        const stats = await getPacketStats();
        setPacketLogEnabled(stats.enabled === true);
      } catch {
        // 403 means no permission - packet log may still be enabled but user can't see it
        setPacketLogEnabled(false);
      }
    };
    void checkPacketLogStatus();
  }, [authStatus]);

  // Messaging context
  const {
    selectedDMNode,
    setSelectedDMNode,
    selectedChannel,
    setSelectedChannel,
    newMessage,
    setNewMessage,
    openDmWithDraft,
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

  // The unreadCountsData ref-bridge for the poll callback (App's
  // processPollData is memoized without unreadCountsData in its deps) moved
  // into useMessagingView (#3962 5.4 PR7) — applyPollMessages needs it, the
  // favicon effect below reads unreadCountsData directly from context.

  // UI context
  const {
    activeTab,
    setActiveTab,
    showMqttMessages,
    setShowMqttMessages,
    error,
    setError,
    // tracerouteLoading still consumed below (messages block, NodePopup);
    // setTracerouteLoading's only consumer (handleTraceroute) moved into
    // useSourceView, which calls useUI() itself (#3962 5.4 PR4).
    tracerouteLoading,
    nodeFilter: _nodeFilter, // Deprecated - kept for backward compatibility
    setNodeFilter: _setNodeFilter, // Deprecated
    // nodesNodeFilter/sortField/sortDirection's only consumer (processedNodes)
    // moved into useSourceView, which reads them itself via useUI().
    messagesNodeFilter,
    setMessagesNodeFilter,
    securityFilter,
    setSecurityFilter,
    channelFilter,
    dmFilter,
    setDmFilter,
    setSortField: _setSortField,
    setSortDirection: _setSortDirection,
    showStatusModal,
    setShowStatusModal,
    systemStatus,
    setSystemStatus,
    nodePopup,
    setNodePopup,
    showNodeFilterPopup,
    setShowNodeFilterPopup,
    showIncompleteNodes,
    setShowIncompleteNodes,
  } = useUI();

  // When the user clicks a source row in the Unified map's node popup, we
  // navigate here (this source) with `state.focusDmNodeId` set. Open that
  // node's direct-message conversation once on mount. The active tab itself
  // comes from the `#messages` hash, so we only need to focus the DM target.
  const focusDmFromNavRef = useRef(false);
  useEffect(() => {
    if (focusDmFromNavRef.current) return;
    const navState = location.state as { focusDmNodeId?: string } | null;
    const focusId = navState?.focusDmNodeId;
    if (!focusId) return;
    focusDmFromNavRef.current = true;
    setActiveTab('messages');
    setSelectedChannel(-1);
    setSelectedDMNode(focusId);
  }, [location.state, setActiveTab, setSelectedChannel, setSelectedDMNode]);

  // Automation context. App no longer renders the automation tab directly
  // (moved to AutomationTab, which reads the full context itself — #3962
  // 5.4 PR6) but still needs these setters for the legacy /api/config
  // settings-load effect below, which hydrates AutomationContext state from
  // the server response on mount.
  const {
    setAutoAckEnabled,
    setAutoAckRegex,
    setAutoAckMessage,
    setAutoAckMessageDirect,
    setAutoAckChannels,
    setAutoAckSkipIncompleteNodes,
    setAutoAckIgnoredNodes,
    setAutoAckMatrix,
    setAutoAckCooldownSeconds,
    setAutoAckPreSendDelaySeconds,
    setAutoAckMaxAttempts,
    setAutoAckTestMessages,
    setAutoAnnounceEnabled,
    setAutoAnnounceIntervalHours,
    setAutoAnnounceMessage,
    setAutoAnnounceChannelIndexes,
    setAutoAnnounceOnStart,
    setAutoAnnounceUseSchedule,
    setAutoAnnounceSchedule,
    setAutoAnnounceNodeInfoEnabled,
    setAutoAnnounceNodeInfoChannels,
    setAutoAnnounceNodeInfoDelaySeconds,
    setAutoWelcomeEnabled,
    setAutoWelcomeMessage,
    setAutoWelcomeTarget,
    setAutoWelcomeWaitForName,
    setAutoWelcomeMaxHops,
    setAutoWelcomeDelay,
    setAutoResponderEnabled,
    setAutoResponderTriggers,
    setAutoResponderSkipIncompleteNodes,
    setAutoKeyManagementEnabled,
    setAutoKeyManagementIntervalMinutes,
    setAutoKeyManagementMaxExchanges,
    setAutoKeyManagementAutoPurge,
    setAutoKeyManagementImmediatePurge,
    setTimerTriggers,
    setGeofenceTriggers,
    setAutoDeleteByDistanceEnabled,
    setAutoDeleteByDistanceIntervalHours,
    setAutoDeleteByDistanceThresholdKm,
    setAutoDeleteByDistanceLat,
    setAutoDeleteByDistanceLon,
    setAutoDeleteByDistanceAction,
  } = useAutomation();

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

    // Mirrors Sidebar.tsx hasAnyChannelPermission — channels tab is reachable
    // if the user can read at least one channel: a physical slot
    // (channel_0..channel_7) OR a virtual (Channel Database) channel. The
    // backend filters channelDatabaseEntries to entries this user may read, so
    // any entry present authorizes the Channels surface. This is what makes the
    // tab reachable for virtual-channel-only users (e.g. anonymous on an MQTT
    // source with per-entry canRead grants).
    const hasAnyChannelPermission = () => {
      for (let i = 0; i < 8; i++) {
        if (hasPermission(`channel_${i}` as ResourceType, 'read')) {
          return true;
        }
      }
      return channelDatabaseEntries.length > 0;
    };

    // Define permission requirements for each protected tab.
    // For MQTT Bridge sources, `configuration` (Device Config) and `admin`
    // (Remote Admin) surfaces are intentionally unavailable — the bridge has
    // no transmit path to a device — so we deny those tabs outright.
    const tabPermissions: Record<string, () => boolean> = {
      dashboard: () => hasPermission('dashboard', 'read'),
      info: () => hasPermission('info', 'read'),
      messages: () => hasPermission('messages', 'read'),
      channels: hasAnyChannelPermission,
      settings: () => hasPermission('settings', 'read'),
      automation: () => !isMqttBridge && hasPermission('automation', 'read'),
      configuration: () => !isMqttBridge && hasPermission('configuration', 'read'),
      'mqtt-config': () => isMqttBridge && hasPermission('sources', 'read'),
      notifications: () => isAuthenticated,
      users: () => isAdmin,
      admin: () => !isMqttBridge && isAdmin,
      audit: () => hasPermission('audit', 'read'),
      security: () => hasPermission('security', 'read'),
      packetmonitor: () => isMqtt
        ? hasPermission('packetmonitor', 'read')
        : (packetLogEnabled && hasPermission('packetmonitor', 'read')),
    };

    // Check if current tab requires permission. `activeTab` is user-controllable
    // (via URL hash) so only look it up when it is an own-property on the
    // hard-coded `tabPermissions` object — this prevents walking the
    // prototype chain into things like `toString`.
    const permissionCheck = Object.prototype.hasOwnProperty.call(tabPermissions, activeTab)
      ? (tabPermissions as Record<string, () => boolean>)[activeTab]
      : undefined;
    if (typeof permissionCheck === 'function' && !permissionCheck()) {
      // The Channels tab may be authorized purely by virtual-channel access,
      // which isn't known until the channel-database fetch resolves. Defer the
      // redirect until then so a virtual-channel-only user isn't bounced off
      // #channels during the async load.
      if (activeTab === 'channels' && !channelDatabaseLoaded) {
        return;
      }
      // User doesn't have permission - redirect to nodes tab
      logger.info(`[Auth] Redirecting from '${activeTab}' tab - insufficient permissions`);
      setActiveTab('nodes');
    }
  }, [activeTab, authStatus, authLoading, hasPermission, setActiveTab, packetLogEnabled, isMqttBridge, isMqttBroker, isMqtt, channelDatabaseEntries, channelDatabaseLoaded]);

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

  // newestMessageId moved into useMessagingView (#3962 5.4 PR7) — its only
  // consumer (applyPollMessages' new-message-sound detection) lives there now.

  // Position exchange loading state (separate from traceroute loading)
  const [positionLoading, setPositionLoading] = useState<string | null>(null);

  // NodeInfo exchange loading state (for key exchange / user info request)
  const [nodeInfoLoading, setNodeInfoLoading] = useState<string | null>(null);

  // NeighborInfo request loading state
  const [neighborInfoLoading, setNeighborInfoLoading] = useState<string | null>(null);

  // Telemetry request loading state
  const [telemetryRequestLoading, setTelemetryRequestLoading] = useState<string | null>(null);

  // playNotificationSound moved into useMessagingView (#3962 5.4 PR7) — its
  // only consumer (applyPollMessages) lives there now.

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
    const localNode = currentNodeId ? nodes.find(n => n.user?.id === currentNodeId) : null;

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

  // Shared node/traceroute/map orchestration — processedNodes, marker refs,
  // traceroute path rendering, favorite/delete/purge handlers (#3962 5.4
  // PR4, task54_spec.md §7). This is the block that makes the nodes route
  // (and the not-yet-migrated messages/dashboard blocks that still consume
  // these same handlers) work; see src/hooks/useSourceView.ts.
  const {
    processedNodes,
    shouldShowData,
    centerMapOnNode,
    toggleFavorite,
    toggleFavoriteLock,
    markerRefs,
    traceroutePathsElements,
    selectedNodeTraceroute,
    visibleNodeNums,
    tracerouteNodeNums,
    tracerouteBounds,
    handleTraceroute,
    handleDeleteNode,
    handlePurgeNodeFromDevice,
  } = useSourceView({
    baseUrl,
    authFetch,
    refetchPoll,
    nodeFilters,
    mergedThemeColors,
    setSelectedRouteSegment,
    setShowPurgeDataModal,
  });

  // Messaging state machinery — messages/channelMessages state (moved off
  // DataContext), optimistic pendingMessages merge, channel/direct
  // pagination, and the 8 activeTab-gated scroll/auto-load/mark-as-read
  // effects (#3962 5.4 PR7, task54_spec.md §3 row 7). The send/resend/
  // tapback handlers below still consume messages/setMessages/
  // channelMessages/setChannelMessages/pendingMessagesRef/the two container
  // refs exactly as they consumed the old DataContext fields — see
  // src/hooks/useMessagingView.ts.
  const {
    messages,
    setMessages,
    channelMessages,
    setChannelMessages,
    pendingMessagesRef,
    channelMessagesContainerRef,
    dmMessagesContainerRef,
    applyPollMessages,
  } = useMessagingView();

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

  // Load configuration and check connection status on startup
  useEffect(() => {
    const initializeApp = async () => {
      try {
        // Load configuration from server. The base path itself no longer
        // comes from here (#3962 5.4 PR8 deleted App's local
        // detectBaseUrl/baseUrl-state duplicate) — appBasename (src/init.ts)
        // is derived from the server-injected <base> tag before React even
        // mounts, and is what react-router's own BrowserRouter already
        // trusts for every route in this app.
        try {
          const config = await api.getConfig();
          setNodeAddress(config.meshtasticNodeIp);
        } catch (error) {
          logger.error('Failed to load config:', error);
          // Don't assert a hardcoded fallback address (#3611) — that would show
          // the wrong IP for a configured source. Leave it empty; the per-source
          // address arrives with the next poll (status.nodeIp).
          setNodeAddress('');
        }

        // Load settings from server (per-source if a sourceId is active, so
        // per-source automation values win over global defaults)
        const settingsQuery = sourceId ? `?sourceId=${encodeURIComponent(sourceId)}` : '';
        const settingsResponse = await authFetch(`${appBasename}/api/settings${settingsQuery}`);
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

          // Homoglyph optimization setting - stored in ref for use in send handlers
          if (settings.homoglyphEnabled !== undefined) {
            homoglyphEnabledRef.current = settings.homoglyphEnabled === 'true';
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

          if (settings.autoAckSkipIncompleteNodes !== undefined) {
            setAutoAckSkipIncompleteNodes(settings.autoAckSkipIncompleteNodes === 'true');
          }

          if (settings.autoAckIgnoredNodes !== undefined) {
            setAutoAckIgnoredNodes(settings.autoAckIgnoredNodes);
          }

          setAutoAckMatrix(settingsToMatrix(settings));

          if (settings.autoAckCooldownSeconds !== undefined) {
            setAutoAckCooldownSeconds(parseInt(settings.autoAckCooldownSeconds) || 60);
          }
          if (settings.autoAckPreSendDelaySeconds !== undefined) {
            setAutoAckPreSendDelaySeconds(parseInt(settings.autoAckPreSendDelaySeconds) || 0);
          }
          if (settings.autoAckMaxAttempts !== undefined) {
            setAutoAckMaxAttempts(Math.min(3, Math.max(1, parseInt(settings.autoAckMaxAttempts) || 3)));
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

          if (settings.autoAnnounceChannelIndexes) {
            try {
              const channels = JSON.parse(settings.autoAnnounceChannelIndexes);
              if (Array.isArray(channels)) {
                setAutoAnnounceChannelIndexes(channels);
              }
            } catch (e) {
              console.error('Failed to parse autoAnnounceChannelIndexes:', e);
            }
          } else if (settings.autoAnnounceChannelIndex !== undefined) {
            // Legacy migration: convert single index to array
            const value = parseInt(settings.autoAnnounceChannelIndex);
            setAutoAnnounceChannelIndexes([value]);
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

          if (settings.autoWelcomeDelay !== undefined && settings.autoWelcomeDelay !== null) {
            setAutoWelcomeDelay(parseInt(settings.autoWelcomeDelay));
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
          if (settings.autoKeyManagementImmediatePurge !== undefined) {
            setAutoKeyManagementImmediatePurge(settings.autoKeyManagementImmediatePurge === 'true');
          }

          // Auto delete by distance settings
          if (settings.autoDeleteByDistanceEnabled !== undefined) {
            setAutoDeleteByDistanceEnabled(settings.autoDeleteByDistanceEnabled === 'true');
          }
          if (settings.autoDeleteByDistanceIntervalHours !== undefined) {
            setAutoDeleteByDistanceIntervalHours(parseInt(settings.autoDeleteByDistanceIntervalHours) || 24);
          }
          if (settings.autoDeleteByDistanceThresholdKm !== undefined) {
            setAutoDeleteByDistanceThresholdKm(parseFloat(settings.autoDeleteByDistanceThresholdKm) || 100);
          }
          if (settings.autoDeleteByDistanceLat !== undefined) {
            setAutoDeleteByDistanceLat(settings.autoDeleteByDistanceLat ? parseFloat(settings.autoDeleteByDistanceLat) : null);
          }
          if (settings.autoDeleteByDistanceLon !== undefined) {
            setAutoDeleteByDistanceLon(settings.autoDeleteByDistanceLon ? parseFloat(settings.autoDeleteByDistanceLon) : null);
          }
          if (settings.autoDeleteByDistanceAction !== undefined) {
            setAutoDeleteByDistanceAction(settings.autoDeleteByDistanceAction === 'ignore' ? 'ignore' : 'delete');
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

        // Check connection status
        await checkConnectionStatus();
      } catch (_error) {
        // Avoid asserting a hardcoded fallback address (#3611); leave empty so a
        // wrong IP never appears for a configured source.
        setNodeAddress('');
        setError('Failed to load configuration');
      }
    };

    void initializeApp();
  }, []);

  // Check for default admin password
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

    void checkConfigIssues();
  }, [baseUrl]);

  // TX status is now handled by useTxStatus hook
  // Version update checking is now handled by useVersionCheck hook (above)

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
      void fetchNeighborInfo();
      // Only auto-refresh when connected (not when viewing cached data)
      if (connectionStatus === 'connected') {
        const interval = setInterval(fetchNeighborInfo, 60000); // Refresh every 60 seconds
        return () => clearInterval(interval);
      }
    }
  }, [connectionStatus, sourceId]);

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

    let cancelled = false;

    // Progressively load the ENTIRE position history in bounded pages (#3791).
    // The server caps each response at 1500 telemetry rows (~300 fixes), so we
    // walk backwards in time using the oldest fix of each page as a `before`
    // cursor, appending until a page comes back empty. State is updated after
    // every page so the trail fills in progressively rather than all at once.
    const fetchAllPositionHistory = async () => {
      const accumulated: PositionHistoryItem[] = [];
      let beforeCursor: number | undefined;
      const MAX_PAGES = 50; // safety bound (~15k fixes) against a runaway loop

      try {
        for (let page = 0; page < MAX_PAGES; page++) {
          const params = new URLSearchParams();
          if (sourceId) params.set('sourceId', sourceId);
          if (beforeCursor !== undefined) params.set('before', String(beforeCursor));
          const qs = params.toString();
          const response = await authFetch(
            `${baseUrl}/api/nodes/${selectedNodeId}/position-history${qs ? `?${qs}` : ''}`
          );
          if (cancelled) return;
          if (!response.ok) break;

          const pageItems: PositionHistoryItem[] = await response.json();
          if (cancelled) return;
          if (pageItems.length === 0) break; // reached the start of history

          // Server returns fixes oldest-first; prepend each older page so the
          // accumulated array stays chronological as we page back in time.
          accumulated.unshift(...pageItems);
          setPositionHistory([...accumulated]);

          // Next page: strictly older than the oldest fix just received. A
          // boundary fix split by the row cap is always older than this, so it
          // re-assembles on the next page without duplicating an emitted fix.
          const oldest = pageItems[0].timestamp;
          if (beforeCursor !== undefined && oldest >= beforeCursor) break; // no-progress guard
          beforeCursor = oldest;

          // Gentle pacing so we neither hammer the server nor block rendering.
          await new Promise(resolve => setTimeout(resolve, 150));
          if (cancelled) return;
        }
      } catch (error) {
        if (!cancelled) logger.error('Error fetching position history:', error);
      }
    };

    void fetchAllPositionHistory();
    return () => { cancelled = true; };
  }, [selectedNodeId, nodes, baseUrl, sourceId]);

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

  // Message scroll-position tracking / infinite-scroll pagination / auto-load
  // / mark-as-read effects (isScrolledNearBottom/isScrolledNearTop through
  // the DM mark-as-read effect) moved into useMessagingView (#3962 5.4 PR7)
  // — see src/hooks/useMessagingView.ts.

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
        void checkConnectionStatus();
      }
    }, 5000);

    return () => clearInterval(updateInterval);
  }, []); // Empty deps - interval created only once, uses refs for current values

  // Scheduled node database refresh (every 60 minutes)
  useEffect(() => {
    const scheduleNodeRefresh = () => {
      if (connectionStatus === 'connected') {
        logger.debug('🔄 Performing scheduled node database refresh...');
        void requestFullNodeDatabase();
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

  // The message-status-indicator re-render timer (5s tick, gated to
  // channels/messages tabs) moved into useMessagingView (#3962 5.4 PR7).

  const requestFullNodeDatabase = async () => {
    try {
      logger.debug('📡 Requesting full node database refresh...');
      const refreshQuery = sourceId ? `?sourceId=${encodeURIComponent(sourceId)}` : '';
      const response = await authFetch(`${baseUrl}/api/nodes/refresh${refreshQuery}`, {
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
          const connQuery = sourceId ? `?sourceId=${encodeURIComponent(sourceId)}` : '';
          const response = await authFetch(`${baseUrl}/api/connection${connQuery}`);
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
    void refetchPoll();

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

  const checkConnectionStatus = async () => {
    try {
      // Use consolidated polling endpoint to check connection status.
      // When inside a SourceProvider (multi-source dashboard), pass sourceId
      // so the server reads from the correct manager — otherwise the header
      // would show the legacy singleton's status, which is "disconnected" in
      // 4.0 multi-source mode.
      const pollQuery = sourceId ? `?sourceId=${encodeURIComponent(sourceId)}` : '';
      const response = await authFetch(`${appBasename}/api/poll${pollQuery}`);
      if (response.ok) {
        const pollData = await response.json();
        const status = pollData.connection;

        if (!status) {
          logger.error('No connection status in poll response');
          return;
        }

        // Keep the displayed/error address in sync with the per-source address
        // the server resolved for THIS poll (status.nodeIp comes from the active
        // manager's own getConfig().nodeIp). This makes reconnects always show
        // the configured source's address instead of a stale value or the env
        // default (#3611). Anonymous users don't receive nodeIp — leave the
        // existing value untouched in that case.
        if (typeof status.nodeIp === 'string' && status.nodeIp) {
          setNodeAddress(status.nodeIp);
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
            await fetchChannels();
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
              void (async () => {
                setConnectionStatus('configuring');
                setError(null);

                // Improved initialization sequence
                try {
                  await fetchChannels();
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
          // Prefer the address the server just resolved for this source; fall
          // back to the stored nodeAddress. Never interpolate an unresolved
          // value (empty string / 'Loading...') — omit the address phrase
          // entirely if it isn't known yet (#3611).
          const resolvedAddress =
            (typeof status.nodeIp === 'string' && status.nodeIp) ? status.nodeIp : nodeAddress;
          setError(
            resolvedAddress && resolvedAddress !== 'Loading...'
              ? `Cannot connect to Meshtastic node at ${resolvedAddress}. Please ensure the node is reachable and has HTTP API enabled.`
              : `Cannot connect to the Meshtastic node. Please ensure the node is reachable and has HTTP API enabled.`
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
    if (!sourceId) return;
    try {
      const url = `${baseUrl}/api/sources/${encodeURIComponent(sourceId)}/neighbor-info`;
      const response = await authFetch(url);
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
    async () => {
      try {
        const channelsUrl = sourceId ? `${appBasename}/api/channels?sourceId=${encodeURIComponent(sourceId)}` : `${appBasename}/api/channels`;
        const channelsResponse = await authFetch(channelsUrl);
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

          // channelsData itself is no longer stored — useChannels() reads
          // channels from the poll cache (#3962 5.4 PR8); this fetch exists
          // to resolve the initial/fallback selectedChannel above ahead of
          // the next poll response.
        }
      } catch (error) {
        logger.error('Error fetching channels:', error);
      }
    },
    [authFetch, selectedChannel, setSelectedChannel, sourceId]
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

      // Nodes are no longer processed here (#3962 5.4 PR8): DataContext
      // stopped mirroring poll-derived nodes, and the pending
      // favorite/ignored/hide-from-map reconciliation that used to run here
      // moved to applyPendingNodeOverrides() (src/utils/pendingToggles.ts),
      // applied by useNodes() (src/hooks/useServerData.ts) on every read of
      // the poll cache — the same cache `data` already came from.

      // Process messages data — optimistic-merge + pagination-preserving
      // logic lives in useMessagingView (#3962 5.4 PR7); this just feeds it
      // the poll payload + the two App-local values it needs (localNodeId
      // computed above, and the currently-selected channel so the unread
      // count for an open channel zeroes instead of incrementing).
      if (data.messages) {
        applyPollMessages(data, localNodeId, selectedChannelRef.current);
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

      // Telemetry availability data is now sourced directly from the poll
      // cache via useTelemetryNodes() (#3962 5.4 PR2) — no longer written
      // into DataContext here.

      // Channels are no longer processed here either (#3962 5.4 PR8) — they
      // come straight from the poll cache via useChannels().

      // Process traceroutes data (synced via poll for consistency across all views)
      if (data.traceroutes) {
        setTraceroutes(data.traceroutes);
      }
    },
    [currentNodeId, setTraceroutes, applyPollMessages]
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

  // shouldShowData moved to useSourceView (#3962 5.4 PR4)

  const handleDisconnect = async () => {
    try {
      await api.disconnectFromNode(sourceId);
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
      await api.reconnectToNode(sourceId);
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
        const info = await api.getConnectionInfo(sourceId);
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

  // handleTraceroute moved to useSourceView (#3962 5.4 PR4)

  const handleExchangePosition = async (nodeId: string, channel?: number) => {
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
        body: JSON.stringify({ destination: nodeNum, sourceId: sourceId || undefined, ...(channel !== undefined && { channel }) }),
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

  const handleExchangeNodeInfo = async (nodeId: string, channel?: number) => {
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
        body: JSON.stringify({ destination: nodeNum, sourceId: sourceId || undefined, ...(channel !== undefined && { channel }) }),
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

      if (sourceType === 'meshcore' && sourceId) {
        const normalized = nodeId.toLowerCase();
        if (!/^[0-9a-f]{64}$/.test(normalized)) {
          logger.warn(`🏠 Invalid MeshCore publicKey: ${nodeId.substring(0, 16)}…`);
          setNeighborInfoLoading(null);
          return;
        }
        await authFetch(`${baseUrl}/api/sources/${sourceId}/meshcore/neighbors/request`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ publicKey: normalized }),
        });
        logger.debug(`🏠 MeshCore neighbors request sent for ${normalized.substring(0, 16)}…`);
      } else {
        // Meshtastic: convert hex nodeId to numeric destination
        const nodeNumStr = nodeId.replace('!', '');
        const nodeNum = parseInt(nodeNumStr, 16);
        await authFetch(`${baseUrl}/api/neighborinfo/request`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ destination: nodeNum, sourceId: sourceId || undefined }),
        });
        logger.debug(`🏠 NeighborInfo request sent to ${nodeId}`);
      }

      // Clear loading state after 30 seconds
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

      // Use direct fetch with CSRF token. Pass sourceId so the request is routed
      // through the correct source's manager AND the destination channel is looked
      // up on that source (issue #3573) — omitting it let the backend cross-source
      // match a wrong channel and send the request unanswerably.
      const response = await authFetch(`${baseUrl}/api/telemetry/request`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ destination: nodeNum, telemetryType, sourceId: sourceId || undefined }),
      });

      if (!response.ok) {
        const detail = await response.json().catch(() => ({}));
        throw new Error(detail.error || `Telemetry request failed (${response.status})`);
      }

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

    // Extract replyId from replyingTo message if present.
    // Message ID format is `${sourceId}_${nodeNum}_${packetId}` — the packetId
    // is always the last segment, so use slice(-1) to be robust to format changes.
    let replyId: number | undefined = undefined;
    if (replyingTo) {
      const idParts = replyingTo.id.split('_');
      if (idParts.length >= 2) {
        replyId = parseInt(idParts[idParts.length - 1], 10);
      }
    }

    // Create a temporary message ID for immediate display
    const tempId = `temp_dm_${Date.now()}_${Math.random()}`;
    // Use localNodeIdRef for immediate access (bypasses React state delay)
    const nodeId = localNodeIdRef.current || currentNodeId || 'me';
    // Apply homoglyph optimization to match what the backend will store,
    // so dedup text comparison works correctly (#2027)
    const displayText = homoglyphEnabledRef.current ? applyHomoglyphOptimization(newMessage) : newMessage;
    const sentMessage: MeshMessage = {
      id: tempId,
      from: nodeId,
      to: destinationNodeId,
      fromNodeId: nodeId,
      toNodeId: destinationNodeId,
      text: displayText,
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
    // Update ref immediately (before React batches the state update) so processPollData
    // can always find the pending message even if a WebSocket event arrives before React commits
    pendingMessagesRef.current = new Map(pendingMessagesRef.current).set(tempId, sentMessage);
    setPendingMessages(pendingMessagesRef.current);

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
          sourceId: sourceId || undefined,
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

    // Extract replyId from original message.
    // Message ID format is `${sourceId}_${nodeNum}_${packetId}` — the packetId
    // is always the last segment, so use slice(-1) to be robust to format changes.
    const idParts = originalMessage.id.split('_');
    if (idParts.length < 2) {
      setError('Cannot send reaction: invalid message format');
      return;
    }
    const replyId = parseInt(idParts[idParts.length - 1], 10);

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
          sourceId: sourceId || undefined,
        };
      } else {
        // For channel messages: use channel
        requestBody = {
          text: emoji,
          channel: originalMessage.channel,
          replyId: replyId,
          emoji: EMOJI_FLAG,
          sourceId: sourceId || undefined,
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
        void refetchPoll();
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
        body: JSON.stringify({ sourceId }),
      });

      if (response.ok) {
        const data = await response.json();
        showToast(t('toast.purged_messages_channel', { count: data.deletedCount, channel: channelName }), 'success');
        // Update local state
        setChannelMessages(prev => ({
          ...prev,
          [channelId]: [],
        }));
        void refetchPoll();
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
        body: JSON.stringify({ sourceId }),
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
        void refetchPoll();
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
        body: JSON.stringify({ sourceId }),
      });

      if (response.ok) {
        const data = await response.json();
        showToast(t('toast.purged_traceroutes', { count: data.deletedCount, node: nodeName }), 'success');
        // Refresh data from backend to ensure consistency
        void refetchPoll();
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
        body: JSON.stringify({ sourceId }),
      });

      if (response.ok) {
        const data = await response.json();
        showToast(t('toast.purged_telemetry', { count: data.deletedCount, node: nodeName }), 'success');
        // Refresh data from backend to ensure consistency
        void refetchPoll();
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

  const handlePurgePositionHistory = async (nodeNum: number) => {
    const node = nodes.find(n => n.nodeNum === nodeNum);
    const nodeName = node?.user?.shortName || node?.user?.longName || `Node ${nodeNum}`;

    if (
      !window.confirm(
        `Are you sure you want to purge position history for ${nodeName}? This action cannot be undone.`
      )
    ) {
      return;
    }

    try {
      const response = await authFetch(`${baseUrl}/api/messages/nodes/${nodeNum}/position-history`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ sourceId }),
      });

      if (response.ok) {
        const data = await response.json();
        showToast(t('toast.purged_position_history', { count: data.deletedCount, node: nodeName }), 'success');
        void refetchPoll();
      } else {
        const errorData = await response.json();
        showToast(t('toast.failed_purge_position_history', { error: errorData.message || t('errors.unknown') }), 'error');
      }
    } catch (err) {
      showToast(
        t('toast.failed_purge_position_history', { error: err instanceof Error ? err.message : t('errors.network') }),
        'error'
      );
    }
  };

  // handleDeleteNode + handlePurgeNodeFromDevice moved to useSourceView
  // (#3962 5.4 PR4)

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
      body: JSON.stringify({ ...data, sourceId }),
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.message || 'Failed to save position override');
    }

    showToast(t('position_override.save_success'), 'success');
    // Refresh data to get updated position
    void refetchPoll();
  };

  const handleSendMessage = async (channel: number = 0) => {
    if (!newMessage.trim() || connectionStatus !== 'connected') {
      return;
    }

    // Use channel ID directly - no mapping needed
    const messageChannel = channel;

    // Extract replyId from replyingTo message if present.
    // Message ID format is `${sourceId}_${nodeNum}_${packetId}` — the packetId
    // is always the last segment, so use slice(-1) to be robust to format changes.
    let replyId: number | undefined = undefined;
    if (replyingTo) {
      const idParts = replyingTo.id.split('_');
      if (idParts.length >= 2) {
        replyId = parseInt(idParts[idParts.length - 1], 10);
      }
    }

    // Create a temporary message ID for immediate display
    const tempId = `temp_${Date.now()}_${Math.random()}`;
    // Use localNodeIdRef for immediate access (bypasses React state delay)
    const nodeId = localNodeIdRef.current || currentNodeId || 'me';
    // Apply homoglyph optimization to match what the backend will store,
    // so dedup text comparison works correctly (#2027)
    const displayText = homoglyphEnabledRef.current ? applyHomoglyphOptimization(newMessage) : newMessage;
    const sentMessage: MeshMessage = {
      id: tempId,
      from: nodeId,
      to: '!ffffffff', // Broadcast
      fromNodeId: nodeId,
      toNodeId: '!ffffffff',
      text: displayText,
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
    // Update ref immediately (before React batches the state update) so processPollData
    // can always find the pending message even if a WebSocket event arrives before React commits
    pendingMessagesRef.current = new Map(pendingMessagesRef.current).set(tempId, sentMessage);
    console.log(`📊 Pending messages map size after add: ${pendingMessagesRef.current.size}`);
    setPendingMessages(pendingMessagesRef.current);

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
          sourceId: sourceId || undefined,
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

  // Send a bell character (0x07) on a channel, optionally prepended to current text
  const handleSendBell = async (channel: number, currentText: string) => {
    if (connectionStatus !== 'connected') return;

    const bellText = currentText.trim() ? `\x07${currentText}` : '\x07';
    setNewMessage('');

    try {
      const response = await authFetch(`${baseUrl}/api/messages/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: bellText, channel, sourceId: sourceId || undefined }),
      });

      if (response.ok) {
        setTimeout(() => refetchPoll(), 1000);
      } else {
        const errorData = await response.json();
        setError(`Failed to send bell: ${errorData.error}`);
      }
    } catch (err) {
      setError(`Failed to send bell: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  };

  // Send a bell character (0x07) as a direct message
  const handleSendBellDM = async (destinationNodeId: string, currentText: string) => {
    if (connectionStatus !== 'connected') return;

    const bellText = currentText.trim() ? `\x07${currentText}` : '\x07';
    setNewMessage('');

    try {
      const response = await authFetch(`${baseUrl}/api/messages/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: bellText, channel: 0, destination: destinationNodeId, sourceId: sourceId || undefined }),
      });

      if (response.ok) {
        logger.debug('Bell DM sent successfully');
      } else {
        setError('Failed to send bell DM');
      }
    } catch (err) {
      setError(`Failed to send bell DM: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  };

  // Broadcast local node's position on a channel
  const handleSendPosition = async (channel: number) => {
    if (connectionStatus !== 'connected') return;

    try {
      const response = await authFetch(`${baseUrl}/api/position/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ destination: 4294967295, channel }),
      });

      if (response.ok) {
        setTimeout(() => refetchPoll(), 1000);
      } else {
        const errorData = await response.json();
        setError(`Failed to send position: ${errorData.error}`);
      }
    } catch (err) {
      setError(`Failed to send position: ${err instanceof Error ? err.message : 'Unknown error'}`);
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
        ? { text: message.text, destination: destinationNodeId, sourceId: sourceId || undefined }
        : { text: message.text, channel: messageChannel, sourceId: sourceId || undefined };

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
    return (node?.user?.shortName && node.user.shortName.trim()) || nodeId.slice(-4);
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

  // sortNodes, filterNodes, processedNodes, and centerMapOnNode moved to
  // useSourceView (#3962 5.4 PR4)

  // toggleFavorite + toggleFavoriteLock moved to useSourceView (#3962 5.4
  // PR4) — toggleIgnored/toggleHideFromMap below are messages-tab-only
  // (not in the NodesTab census) and stay here until PR7.

  // Function to toggle node ignored status
  const toggleIgnored = async (node: DeviceInfo, event: React.MouseEvent) => {
    event.stopPropagation(); // Prevent node selection when clicking ignore button

    if (!node.user?.id) {
      logger.error('Cannot toggle ignored: node has no user ID');
      return;
    }

    // Prevent multiple rapid clicks on the same node (scoped to current source)
    const ignKey = favoritePendingKey(sourceId, node.nodeNum);
    if (pendingIgnoredRequests.get(ignKey) !== undefined) {
      return;
    }

    // Store the original state before any updates
    const originalIgnoredStatus = node.isIgnored;
    const newIgnoredStatus = !originalIgnoredStatus;

    try {
      // Mark this request as pending with the expected new state
      pendingIgnoredRequests.set(ignKey, newIgnoredStatus);

      // Optimistically update the UI by writing straight into the poll
      // query cache (#3962 5.4 PR8) — useNodes() re-derives via
      // applyPendingNodeOverrides on every cache change.
      setNodeFieldInCache(queryClient, sourceId, node.nodeNum, { isIgnored: newIgnoredStatus });

      // Send update to backend (with device sync enabled by default)
      const response = await authFetch(`${baseUrl}/api/nodes/${node.user.id}/ignored`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          isIgnored: newIgnoredStatus,
          syncToDevice: true, // Enable two-way sync to Meshtastic device
          sourceId,
        }),
      });

      if (!response.ok) {
        if (response.status === 403) {
          showToast(t('toast.insufficient_permissions_ignored'), 'error');
          // Revert to original state using the saved original value
          setNodeFieldInCache(queryClient, sourceId, node.nodeNum, { isIgnored: originalIgnoredStatus });
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
      setNodeFieldInCache(queryClient, sourceId, node.nodeNum, { isIgnored: originalIgnoredStatus });
      // Remove from pending on error since we reverted
      pendingIgnoredRequests.delete(ignKey);
      showToast(t('toast.failed_update_ignored'), 'error');
    }
    // Note: On success, the polling logic will remove from pendingIgnoredRequests
    // when it detects the server has caught up
  };

  // Toggle the per-node "Hide from Map" flag (issue #3549). Display-only: the
  // node stays visible everywhere except map markers. Mirrors toggleIgnored's
  // optimistic-update + per-source pending-request pattern, minus device sync.
  //
  // #4137: App.tsx is only ever mounted per-source (via SourceProvider under
  // /source/:sourceId/*) — there is no separate "unified" caller of this
  // toggle today. But since mergeNodesAcrossSources now ORs hideFromMap across
  // sources for every cross-source consumer (Dashboard, Map Analysis, the
  // unified node list — see mergeNodesAcrossSources.ts), a node stays hidden
  // there forever unless EVERY source that ever hid it gets cleared. A
  // per-source-only clear reproduces the exact "can't un-hide" bug reported
  // in #4137. This is the only hide/show entry point in the UI, so it always
  // converges the flag across every source for this nodeNum (allSources:
  // true) rather than only the row for the currently-viewed source.
  // sourceId is still sent and still required server-side — it remains the
  // permission anchor for the write, just not the update scope.
  const toggleHideFromMap = async (node: DeviceInfo, event: React.MouseEvent) => {
    event.stopPropagation();

    if (!node.user?.id) {
      logger.error('Cannot toggle hideFromMap: node has no user ID');
      return;
    }

    const hfmKey = favoritePendingKey(sourceId, node.nodeNum);
    if (pendingHideFromMapRequests.get(hfmKey) !== undefined) {
      return;
    }

    const originalStatus = Boolean(node.hideFromMap);
    const newStatus = !originalStatus;

    try {
      pendingHideFromMapRequests.set(hfmKey, newStatus);

      // Optimistically update the UI by writing straight into the poll
      // query cache (#3962 5.4 PR8) — useNodes() re-derives via
      // applyPendingNodeOverrides on every cache change.
      setNodeFieldInCache(queryClient, sourceId, node.nodeNum, { hideFromMap: newStatus });

      const response = await authFetch(`${baseUrl}/api/nodes/${node.user.id}/hide-from-map`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          hideFromMap: newStatus,
          sourceId,
          allSources: true,
        }),
      });

      if (!response.ok) {
        if (response.status === 403) {
          showToast(t('toast.insufficient_permissions_hide_from_map', 'You do not have permission to change map visibility'), 'error');
          setNodeFieldInCache(queryClient, sourceId, node.nodeNum, { hideFromMap: originalStatus });
          pendingHideFromMapRequests.delete(hfmKey);
          return;
        }
        throw new Error('Failed to update hideFromMap status');
      }

      logger.debug(`🗺️ Node ${node.user.id} hideFromMap → ${newStatus}`);
    } catch (error) {
      logger.error('Error toggling hideFromMap:', error);
      setNodeFieldInCache(queryClient, sourceId, node.nodeNum, { hideFromMap: originalStatus });
      pendingHideFromMapRequests.delete(hfmKey);
      showToast(t('toast.failed_update_hide_from_map', 'Failed to update map visibility'), 'error');
    }
    // Note: On success, the polling logic will remove from pendingHideFromMapRequests
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
      if (nodePopup && !(event.target as Element).closest('.node-popup-overlay, .sender-dot')) {
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

  // nodesPositionDigest, traceroutesDigest, tracerouteCallbacks,
  // visibleNodeNums, and the useTraceroutePaths() call all moved to
  // useSourceView (#3962 5.4 PR4)

  // Navigate to message from search result
  const handleNavigateToMessage = useCallback((result: { id: string; source: string; channel?: number; fromNodeId?: string; fromNodeNum?: number }) => {
    setIsSearchOpen(false);
    setFocusMessageId(result.id);
    if (result.channel === -1) {
      setActiveTab('messages');
      // Navigate to DM conversation with the sender
      if (result.fromNodeId) {
        setSelectedDMNode(result.fromNodeId);
      } else if (result.fromNodeNum) {
        // Fallback: convert nodeNum to hex ID format
        setSelectedDMNode(`!${result.fromNodeNum.toString(16)}`);
      }
    } else {
      setActiveTab('channels');
      // Navigate to the specific channel
      if (result.channel !== undefined) {
        setSelectedChannel(result.channel);
        selectedChannelRef.current = result.channel;
      }
    }
  }, [setActiveTab, setSelectedDMNode, setSelectedChannel]);

  // Ctrl+K / Cmd+K keyboard shortcut to toggle search modal
  const canSearch = hasPermission('messages', 'read') ||
    Array.from({ length: 8 }, (_, i) =>
      hasPermission(`channel_${i}` as ResourceType, 'read')
    ).some(Boolean);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        if (canSearch) setIsSearchOpen(prev => !prev);
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [canSearch]);

  // If anonymous is disabled and user is not authenticated, show login page
  if (authStatus?.anonymousDisabled && !authStatus?.authenticated) {
    return <LoginPage />;
  }

  return (
    <div className="app">
      <a href="#main-content" className="skip-to-content">
        Skip to content
      </a>
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
        sourceName={sourceName}
        onBackToSources={sourceId ? () => navigate('/', { state: { showList: true } }) : undefined}
        mqttReadOnly={isMqttBridge}
      />

      <AppBanners
        isTxDisabled={isTxDisabled}
        configIssues={configIssues}
        updateAvailable={updateAvailable}
        latestVersion={latestVersion}
        releaseUrl={releaseUrl}
        deploymentMethod={deploymentMethod}
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
          sourceId={sourceId}
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
        onPurgePositionHistory={handlePurgePositionHistory}
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
        packetLogEnabled={packetLogEnabled}
        onSearchClick={() => setIsSearchOpen(true)}
        hasReadableVirtualChannels={channelDatabaseEntries.length > 0}
        mqttReadOnly={isMqttBridge}
      />

      <main id="main-content" className="app-main">
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

        {/*
          Tab region nested Routes (#3962 5.4 PR1). All 15 tabs are now
          `<Route>` elements (task54_spec.md §3) — the `path="*"` fallback
          below renders nothing, preserving prior blank-fallback behavior for
          an unrecognized sub-path. `audit` was the PR1 proof leaf; PR3
          migrated the other leaf tabs; PR4 migrated `nodes` (the default/
          index tab) alongside extracting its shared node/traceroute/map
          orchestration into `useSourceView` (src/hooks/useSourceView.ts);
          PR5 migrated info/dashboard/configuration; PR6 migrated settings/
          automation; PR7 migrated channels/messages alongside extracting
          their messaging state machinery into `useMessagingView`
          (src/hooks/useMessagingView.ts) — see that file's doc comment.
        */}
        <Routes>
          <Route index element={<Navigate to="nodes" replace />} />
          <Route
            path="audit"
            element={<ErrorBoundary fallbackTitle="Audit Log failed to load"><AuditLogTab /></ErrorBoundary>}
          />
          <Route
            path="notifications"
            element={<ErrorBoundary fallbackTitle="Notifications failed to load"><NotificationsTab isAdmin={authStatus?.user?.isAdmin || false} /></ErrorBoundary>}
          />
          <Route
            path="users"
            element={<ErrorBoundary fallbackTitle="Users failed to load"><UsersTab /></ErrorBoundary>}
          />
          <Route
            path="security"
            element={<ErrorBoundary fallbackTitle="Security failed to load"><SecurityTab onTabChange={setActiveTab} onSelectDMNode={setSelectedDMNode} openDmWithDraft={openDmWithDraft} /></ErrorBoundary>}
          />
          <Route
            path="admin"
            element={authStatus?.user?.isAdmin ? (
              <ErrorBoundary fallbackTitle="Admin Commands failed to load">
                <AdminCommandsTab
                  key={sourceId || 'default'}
                  nodes={nodes}
                  currentNodeId={currentNodeId}
                  channels={channels}
                  onChannelsUpdated={fetchChannels}
                />
              </ErrorBoundary>
            ) : null}
          />
          <Route
            path="mqtt-config"
            element={isMqttBridge && sourceId ? (
              <ErrorBoundary fallbackTitle="Configuration failed to load">
                <MqttBridgeConfigurationView key={sourceId} sourceId={sourceId} />
              </ErrorBoundary>
            ) : null}
          />
          <Route
            path="packetmonitor"
            element={
              <ErrorBoundary fallbackTitle="Packet Monitor failed to load">
                <div style={{ height: 'calc(100dvh - var(--header-height, 60px) - 4rem)', overflow: 'hidden' }}>
                  {isMqtt && sourceId ? (
                    <MqttPacketMonitorView baseUrl={baseUrl} sourceId={sourceId} />
                  ) : (
                    <PacketMonitorPanel onClose={() => setActiveTab('nodes')} />
                  )}
                </div>
              </ErrorBoundary>
            }
          />
          <Route
            path="info"
            element={
              <ErrorBoundary fallbackTitle="Info failed to load">
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
              </ErrorBoundary>
            }
          />
          <Route
            path="dashboard"
            element={
              <ErrorBoundary fallbackTitle="Dashboard failed to load">
                <Dashboard
                  temperatureUnit={temperatureUnit}
                  telemetryHours={telemetryVisualizationHours}
                  favoriteTelemetryStorageDays={favoriteTelemetryStorageDays}
                  baseUrl={baseUrl}
                  currentNodeId={currentNodeId}
                  canEdit={hasPermission('dashboard', 'write')}
                  onOpenNodeDetails={(nodeId: string) => {
                    setSelectedDMNode(nodeId);
                    setActiveTab('messages');
                  }}
                />
              </ErrorBoundary>
            }
          />
          <Route
            path="configuration"
            element={
              <ErrorBoundary fallbackTitle="Configuration failed to load">
                <ConfigurationTab
                  key={sourceId || 'default'}
                  baseUrl={baseUrl}
                  nodes={nodes}
                  channels={channels}
                  onRebootDevice={handleRebootDevice}
                  onConfigChangeTriggeringReboot={handleConfigChangeTriggeringReboot}
                  onChannelsUpdated={() => fetchChannels()}
                  refreshTrigger={configRefreshTrigger}
                />
              </ErrorBoundary>
            }
          />
          <Route
            path="nodes"
            element={
              <ErrorBoundary fallbackTitle="Nodes failed to load">
                <NodesTab
                  processedNodes={processedNodes}
                  shouldShowData={shouldShowData}
                  centerMapOnNode={centerMapOnNode}
                  toggleFavorite={toggleFavorite}
                  toggleFavoriteLock={toggleFavoriteLock}
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
                  onDeleteNode={handleDeleteNode}
                  onPurgeNodeFromDevice={handlePurgeNodeFromDevice}
                />
              </ErrorBoundary>
            }
          />
          <Route
            path="automation"
            element={
              <ErrorBoundary fallbackTitle="Automation failed to load">
                <AutomationTab baseUrl={baseUrl} channels={channels} nodes={nodes} currentNodeId={currentNodeId} />
              </ErrorBoundary>
            }
          />
          <Route
            path="settings"
            element={
              <ErrorBoundary fallbackTitle="Settings failed to load">
                <SaveBarGroup id="settings">
                  <SettingsTab
                    mode="source"
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
                    mapTilesetLight={mapTilesetLight}
                    mapTilesetDark={mapTilesetDark}
                    mapPinStyle={mapPinStyle}
                    iconStyle={iconStyle}
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
                    onMapTilesetsChange={setMapTilesets}
                    onMapPinStyleChange={setMapPinStyle}
                    onIconStyleChange={setIconStyle}
                    onLanguageChange={setLanguage}
                    onSolarMonitoringEnabledChange={setSolarMonitoringEnabled}
                    onSolarMonitoringLatitudeChange={setSolarMonitoringLatitude}
                    onSolarMonitoringLongitudeChange={setSolarMonitoringLongitude}
                    onSolarMonitoringAzimuthChange={setSolarMonitoringAzimuth}
                    onSolarMonitoringDeclinationChange={setSolarMonitoringDeclination}
                  />
                </SaveBarGroup>
              </ErrorBoundary>
            }
          />
          <Route
            path="channels"
            element={
              <ErrorBoundary fallbackTitle="Channels failed to load">
          <ChannelsTab
            channels={channels}
            channelDatabaseEntries={channelDatabaseEntries}
            channelMessages={channelMessages}
            messages={messages}
            currentNodeId={currentNodeId}
            sourceId={sourceId}
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
            onSendBell={handleSendBell}
            onSendPosition={handleSendPosition}
            shouldShowData={shouldShowData}
            getNodeName={getNodeName}
            getNodeShortName={getNodeShortName}
            isMqttBridgeMessage={isMqttBridgeMessage}
            setEmojiPickerMessage={setEmojiPickerMessage}
            channelMessagesContainerRef={channelMessagesContainerRef}
            focusMessageId={focusMessageId}
            onFocusMessageHandled={() => setFocusMessageId(null)}
            mqttReadOnly={isMqttBridge}
          />
              </ErrorBoundary>
            }
          />
          <Route
            path="messages"
            element={
              <ErrorBoundary fallbackTitle="Messages failed to load">
          <MessagesTab
            processedNodes={processedNodes}
            nodes={nodes}
            messages={messages}
            currentNodeId={currentNodeId}
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
            channels={channels}
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
            onSendBell={handleSendBellDM}
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
            focusMessageId={focusMessageId}
            onFocusMessageHandled={() => setFocusMessageId(null)}
            mqttReadOnly={isMqttBridge}
            toggleIgnored={toggleIgnored}
            toggleHideFromMap={toggleHideFromMap}
            toggleFavorite={toggleFavorite}
            toggleFavoriteLock={toggleFavoriteLock}
            handleShowOnMap={(nodeId: string) => {
              const node = nodes.find(n => n.user?.id === nodeId);
              if (node?.position?.latitude != null && node?.position?.longitude != null) {
                setSelectedNodeId(nodeId);
                setMapCenterTarget([node.position.latitude, node.position.longitude]);
                setActiveTab('nodes');
              }
            }}
          />
              </ErrorBoundary>
            }
          />
          {/* 'audit' migrated to <Route path="audit"> above (#3962 5.4 PR1 proof leaf) */}
          {/* 'notifications', 'users', 'admin', 'security', 'mqtt-config', 'packetmonitor'
              migrated to <Route> elements above (#3962 5.4 PR3 leaf tab group) */}
          {/* 'automation', 'settings' migrated to <Route> elements above (#3962 5.4 PR6) */}
          {/* 'info', 'dashboard', 'configuration' migrated to <Route> elements above
              (#3962 5.4 PR5) */}
          {/* 'channels', 'messages' migrated to <Route> elements above (#3962 5.4 PR7) —
              every tab is now a route; this catch-all preserves the prior blank-fallback
              behavior for an unrecognized sub-path. */}
          <Route path="*" element={null} />
        </Routes>
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
        onDeleteNode={handleDeleteNode}
        onPurgeNodeFromDevice={handlePurgeNodeFromDevice}
        currentNodeNum={currentNodeId ? (nodes.find(n => n.user?.id === currentNodeId)?.nodeNum ?? null) : null}
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

      {/* Message Search Modal */}
      <SearchModal
        isOpen={isSearchOpen}
        onClose={() => setIsSearchOpen(false)}
        onNavigateToMessage={handleNavigateToMessage}
        channels={channels
          .filter(ch => hasPermission(`channel_${ch.id}` as ResourceType, 'read'))
          .map(ch => ({ id: ch.id, name: ch.name }))}
        nodes={nodes.map(n => ({
          nodeId: n.user?.id || String(n.nodeNum),
          longName: n.user?.longName || `!${n.nodeNum.toString(16)}`,
          shortName: n.user?.shortName || '????',
        }))}
        canSearchDms={hasPermission('messages', 'read')}
        canSearchMeshcore={false}
      />

      {/* SaveBar for unified save/dismiss actions */}
      <SaveBar />
    </div>
  );
}

const AppWithToast = () => {
  // Second detectBaseUrl copy deleted (#3962 5.4 PR8) — see the comment on
  // App's own `baseUrl` above. Same appBasename constant for all three
  // providers.
  return (
    <SettingsProvider baseUrl={appBasename}>
      <MapProvider>
        <DataProvider>
          <UIProvider>
            <MessagingProvider baseUrl={appBasename}>
              <AutomationProvider baseUrl={appBasename}>
              <ToastProvider>
                <DeviceNotificationToaster />
                <SaveBarProvider>
                  <App />
                </SaveBarProvider>
              </ToastProvider>
              </AutomationProvider>
            </MessagingProvider>
          </UIProvider>
        </DataProvider>
      </MapProvider>
    </SettingsProvider>
  );
};

export default AppWithToast;
