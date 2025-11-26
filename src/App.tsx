import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { flushSync } from 'react-dom'
import { Popup, Polyline } from 'react-leaflet'
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import './App.css'
import TelemetryGraphs from './components/TelemetryGraphs'
import NodeDetailsBlock from './components/NodeDetailsBlock'
import InfoTab from './components/InfoTab'
import SettingsTab from './components/SettingsTab'
import ConfigurationTab from './components/ConfigurationTab'
import NotificationsTab from './components/NotificationsTab'
import UsersTab from './components/UsersTab'
import AuditLogTab from './components/AuditLogTab'
import { SecurityTab } from './components/SecurityTab'
import Dashboard from './components/Dashboard'
import NodesTab from './components/NodesTab'
import HopCountDisplay from './components/HopCountDisplay'
import AutoAcknowledgeSection from './components/AutoAcknowledgeSection'
import AutoTracerouteSection from './components/AutoTracerouteSection'
import AutoAnnounceSection from './components/AutoAnnounceSection'
import AutoWelcomeSection from './components/AutoWelcomeSection'
import AutoResponderSection from './components/AutoResponderSection'
import { ToastProvider, useToast } from './components/ToastContainer'
import { RebootModal } from './components/RebootModal'
// import { version } from '../package.json' // Removed - footer no longer displayed
import { type TemperatureUnit } from './utils/temperature'
import { calculateDistance, formatDistance } from './utils/distance'
import { formatDateTime, formatRelativeTime, formatMessageTime, getMessageDateSeparator, shouldShowDateSeparator } from './utils/datetime'
import { formatTracerouteRoute } from './utils/traceroute'
import { getUtf8ByteLength, formatByteCount } from './utils/text'
import { renderMessageWithLinks } from './utils/linkRenderer'
import { DeviceInfo, Channel } from './types/device'
import { MeshMessage, MessageDeliveryState } from './types/message'
import { SortField, SortDirection } from './types/ui'
import { ResourceType } from './types/permission'
import api from './services/api'
import { logger } from './utils/logger'
import { generateArrowMarkers } from './utils/mapHelpers.tsx'
import { ROLE_NAMES } from './constants'
import { getHardwareModelName, getRoleName } from './utils/nodeHelpers'
import Sidebar from './components/Sidebar'
import LinkPreview from './components/LinkPreview'
import { SettingsProvider, useSettings } from './contexts/SettingsContext'
import { MapProvider, useMapContext } from './contexts/MapContext'
import { DataProvider, useData } from './contexts/DataContext'
import { MessagingProvider, useMessaging } from './contexts/MessagingContext'
import { UIProvider, useUI } from './contexts/UIContext'
import { useAuth } from './contexts/AuthContext'
import { useCsrf } from './contexts/CsrfContext'
import LoginModal from './components/LoginModal'
import LoginPage from './components/LoginPage'
import UserMenu from './components/UserMenu'

// Track pending favorite requests outside component to persist across remounts
// Maps nodeNum -> expected isFavorite state
const pendingFavoriteRequests = new Map<number, boolean>()
import TracerouteHistoryModal from './components/TracerouteHistoryModal'
import RouteSegmentTraceroutesModal from './components/RouteSegmentTraceroutesModal'
import { NodeFilterPopup } from './components/NodeFilterPopup'

// Fix for default markers in React-Leaflet
delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjQiIGhlaWdodD0iMjQiIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPHBhdGggZD0iTTEyIDJDOS4yNCAyIDcgNC4yNCA3IDdDNyAxMy40NyAxMiAyMiAxMiAyMkMxMiAyMiAxNyAxMy40NyAxNyA3QzE3IDQuMjQgMTQuNzYgMiAxMiAyWk0xMiA5LjVDMTAuNjIgOS41IDkuNSA4LjM4IDkuNSA3UzkuNTEgNC41IDExIDQuNVMxNS41IDUuNjIgMTUuNSA3UzE0LjM4IDkuNSAxMiA5LjVaIiBmaWxsPSIjZmY2NjY2Ii8+Cjwvc3ZnPg==',
  iconUrl: 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjQiIGhlaWdodD0iMjQiIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPHBhdGggZD0iTTEyIDJDOS4yNCAyIDcgNC4yNCA3IDdDNyAxMy40NyAxMiAyMiAxMiAyMkMxMiAyMiAxNyAxMy40NyAxNyA3QzE3IDQuMjQgMTQuNzYgMiAxMiAyWk0xMiA5LjVDMTAuNjIgOS41IDkuNSA4LjM4IDkuNSA3UzkuNTEgNC41IDExIDQuNVMxNS41IDUuNjIgMTUuNSA7UzE0LjM4IDkuNSAxMiA5LjVaIiBmaWxsPSIjNjY5OGY1Ii8+Cjwvc3ZnPg==',
  shadowUrl: 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjQiIGhlaWdodD0iMjQiIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPHBhdGggZD0iTTEyIDJDOS4yNCAyIDcgNC4yNCA3IDdDNyAxMy40NyAxMiAyMiAxMiAyMkMxMiAyMiAxNyAxMy40NyAxNyA3QzE3IDQuMjQgMTQuNzYgMiAxMiAyWk0xMiA5LjVDMTAuNjIgOS41IDkuNSA4LjM4IDkuNSA3UzkuNTEgNC41IDExIDQuNVMxNS41IDUuNjIgMTUuNSA3UzE0LjM4IDkuNSAxMiA5LjVaIiBmaWxsPSIjMDAwIiBmaWxsLW9wYWNpdHk9IjAuMyIvPgo8L3N2Zz4K',
  iconSize: [24, 24],
  iconAnchor: [12, 24],
  popupAnchor: [0, -24]
});

// Icons and helpers are now imported from utils/

/**
 * Render enhanced message delivery status indicator
 * @param msg The message to render status for
 * @returns JSX element with status icon and tooltip
 */
function renderMessageStatus(msg: MeshMessage): React.ReactElement {
  const messageAge = Date.now() - msg.timestamp.getTime();
  const TIMEOUT_MS = 30000; // 30 seconds

  // Check for explicit failures first
  if (msg.ackFailed || msg.routingErrorReceived || msg.deliveryState === MessageDeliveryState.FAILED) {
    return (
      <span className="status-failed" title="Failed to send - routing error or max retries exceeded">
        ❌
      </span>
    );
  }

  // Check delivery state for granular status
  if (msg.deliveryState === MessageDeliveryState.CONFIRMED) {
    // Only DMs can be confirmed (received by target)
    return (
      <span className="status-confirmed" title="Received by target node">
        🔒
      </span>
    );
  }

  if (msg.deliveryState === MessageDeliveryState.DELIVERED) {
    // Transmitted to mesh
    return (
      <span className="status-delivered" title="Transmitted to mesh">
        ✅
      </span>
    );
  }

  // If waiting for acknowledgment
  if (messageAge < TIMEOUT_MS) {
    // Still waiting for acknowledgment
    return (
      <span className="status-pending" title="Sending...">
        ⏳
      </span>
    );
  }

  // Timeout - no acknowledgment received within 30 seconds
  return (
    <span className="status-timeout" title="No acknowledgment received (timeout)">
      ⏱️
    </span>
  );
}

function App() {
  const { authStatus, hasPermission } = useAuth();
  const { getToken: getCsrfToken, refreshToken: refreshCsrfToken } = useCsrf();
  const { showToast } = useToast();
  const [showLoginModal, setShowLoginModal] = useState(false);
  const [isDefaultPassword, setIsDefaultPassword] = useState(false);
  const [isTxDisabled, setIsTxDisabled] = useState(false);
  const [configIssues, setConfigIssues] = useState<Array<{
    type: 'cookie_secure' | 'allowed_origins';
    severity: 'error' | 'warning';
    message: string;
    docsUrl: string;
  }>>([]);
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
  const [selectedRouteSegment, setSelectedRouteSegment] = useState<{nodeNum1: number; nodeNum2: number} | null>(null);
  const [emojiPickerMessage, setEmojiPickerMessage] = useState<MeshMessage | null>(null);

  // Check if mobile viewport and default to collapsed on mobile
  const isMobileViewport = () => window.innerWidth <= 768;
  const [isMessagesNodeListCollapsed, setIsMessagesNodeListCollapsed] = useState(isMobileViewport());

  /**
   * Node filter configuration interface
   * Controls which nodes are displayed in the node list based on various criteria
   */
  interface NodeFilters {
    filterMode: 'show' | 'hide';
    showMqtt: boolean;
    showTelemetry: boolean;
    showEnvironment: boolean;
    powerSource: 'powered' | 'battery' | 'both';
    showPosition: boolean;
    minHops: number;
    maxHops: number;
    showPKI: boolean;
    showUnknown: boolean;
    deviceRoles: number[];
    channels: number[];
  }

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
      showUnknown: false,
      deviceRoles: [] as number[], // Empty array means show all roles
      channels: [] as number[]
    };
  });

  const hasSelectedInitialChannelRef = useRef<boolean>(false)
  const selectedChannelRef = useRef<number>(-1)
  const lastChannelSelectionRef = useRef<number>(-1) // Track last selected channel before switching to Messages tab
  const showRebootModalRef = useRef<boolean>(false) // Track reboot modal state for interval closure
  const connectionStatusRef = useRef<string>('disconnected') // Track connection status for interval closure
  const localNodeIdRef = useRef<string>('') // Track local node ID for immediate access (bypasses React state delay)
  const pendingMessagesRef = useRef<Map<string, MeshMessage>>(new Map()) // Track pending messages for interval access (bypasses closure stale state)
  const upgradePollingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null) // Track upgrade polling interval for cleanup
  const initialVersionRef = useRef<string | null>(null) // Track initial backend version to detect upgrades

  // Constants for emoji tapbacks
  const EMOJI_FLAG = 1; // Protobuf flag indicating this is a tapback/reaction
  const TAPBACK_EMOJIS = [
    // Common reactions (compatible with Meshtastic OLED displays)
    { emoji: '👍', title: 'Thumbs up' },
    { emoji: '👎', title: 'Thumbs down' },
    { emoji: '❤️', title: 'Heart' },
    { emoji: '😂', title: 'Laugh' },
    { emoji: '😢', title: 'Cry' },
    { emoji: '😮', title: 'Wow' },
    { emoji: '😡', title: 'Angry' },
    { emoji: '🎉', title: 'Celebrate' },
    // Questions and alerts
    { emoji: '❓', title: 'Question' },
    { emoji: '❗', title: 'Exclamation' },
    { emoji: '‼️', title: 'Double exclamation' },
    // Fun emojis (OLED compatible)
    { emoji: '💩', title: 'Poop' },
    { emoji: '👋', title: 'Wave' },
    { emoji: '🤠', title: 'Cowboy' },
    { emoji: '🐭', title: 'Mouse' },
    { emoji: '😈', title: 'Devil' },
    // Weather (OLED compatible)
    { emoji: '☀️', title: 'Sunny' },
    { emoji: '☔', title: 'Rain' },
    { emoji: '☁️', title: 'Cloudy' },
    { emoji: '🌫️', title: 'Foggy' },
    // Additional useful reactions
    { emoji: '✅', title: 'Check' },
    { emoji: '❌', title: 'X' },
    { emoji: '🔥', title: 'Fire' },
    { emoji: '💯', title: '100' }
  ] as const;

  // Meshtastic default PSK (base64 encoded single null byte = unencrypted)
  const DEFAULT_UNENCRYPTED_PSK = 'AQ==';

  const channelMessagesContainerRef = useRef<HTMLDivElement>(null)
  const dmMessagesContainerRef = useRef<HTMLDivElement>(null)
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

  // Settings from context
  const {
    maxNodeAgeHours,
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
    solarMonitoringEnabled,
    solarMonitoringLatitude,
    solarMonitoringLongitude,
    solarMonitoringAzimuth,
    solarMonitoringDeclination,
    setMaxNodeAgeHours,
    setTracerouteIntervalMinutes,
    setTemperatureUnit,
    setDistanceUnit,
    setTelemetryVisualizationHours,
    setFavoriteTelemetryStorageDays,
    setPreferredSortField,
    setPreferredSortDirection,
    setTimeFormat,
    setDateFormat,
    setMapTileset,
    setMapPinStyle,
    setTheme,
    setSolarMonitoringEnabled,
    setSolarMonitoringLatitude,
    setSolarMonitoringLongitude,
    setSolarMonitoringAzimuth,
    setSolarMonitoringDeclination
  } = useSettings();

  // Map context
  const {
    showPaths,
    showRoute,
    showNeighborInfo,
    setMapCenterTarget,
    traceroutes,
    setTraceroutes,
    setNeighborInfo,
    setPositionHistory,
    selectedNodeId,
    setSelectedNodeId
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
    setNodesWithEstimatedPosition,
    nodesWithPKC,
    setNodesWithPKC
  } = useData();

  // Get computed CSS color values for Leaflet Polyline components (which don't support CSS variables)
  const [themeColors, setThemeColors] = useState({
    mauve: '#cba6f7', // Default to Mocha theme colors
    red: '#f38ba8'
  });

  // Update theme colors when theme changes
  useEffect(() => {
    const rootStyle = getComputedStyle(document.documentElement);
    const mauve = rootStyle.getPropertyValue('--ctp-mauve').trim();
    const red = rootStyle.getPropertyValue('--ctp-red').trim();

    if (mauve && red) {
      setThemeColors({ mauve, red });
    }
  }, [theme]);

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
    isChannelScrolledToBottom,
    setIsChannelScrolledToBottom,
    isDMScrolledToBottom,
    setIsDMScrolledToBottom,
    markMessagesAsRead,
    fetchUnreadCounts,
    unreadCountsData
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
    nodeFilter,
    setNodeFilter,
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
    autoWelcomeMaxHops,
    setAutoWelcomeMaxHops,
    autoResponderEnabled,
    setAutoResponderEnabled,
    autoResponderTriggers,
    setAutoResponderTriggers,
    showNodeFilterPopup,
    setShowNodeFilterPopup
  } = useUI();

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

  // Refs for message input fields (to focus on reply)
  const channelMessageInputRef = useRef<HTMLInputElement>(null);
  const dmMessageInputRef = useRef<HTMLInputElement>(null);

  // Play notification sound using Web Audio API
  const playNotificationSound = useCallback(() => {
    try {
      console.log('🔊 playNotificationSound called');
      logger.debug('🔊 playNotificationSound called');

      const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
      console.log('🔊 AudioContext created, state:', audioContext.state);
      logger.debug('🔊 AudioContext created, state:', audioContext.state);

      // Resume context if suspended (browser autoplay policy)
      if (audioContext.state === 'suspended') {
        audioContext.resume().then(() => {
          console.log('🔊 AudioContext resumed');
        });
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

      console.log('🔊 Sound started successfully');
      logger.debug('🔊 Sound started successfully');
    } catch (error) {
      console.error('❌ Failed to play notification sound:', error);
      logger.error('❌ Failed to play notification sound:', error);
    }
  }, []);

  // Update favicon with red dot when there are unread messages
  const updateFavicon = useCallback((hasUnread: boolean) => {
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
  }, [baseUrl]);

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
  const authFetch = useCallback(async (url: string, options?: RequestInit, retryCount = 0, timeoutMs = 10000): Promise<Response> => {
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
      if ((error instanceof DOMException && error.name === 'AbortError') ||
          (error instanceof Error && error.name === 'AbortError')) {
        throw new Error(`Request timeout after ${timeoutMs}ms`);
      }
      throw error;
    } finally {
      // Always clear timeout to prevent memory leaks
      clearTimeout(timeoutId);
    }
  }, [getCsrfToken, refreshCsrfToken]);

  // Function to detect MQTT/bridge messages that should be filtered
  const isMqttBridgeMessage = (msg: MeshMessage): boolean => {
    // Filter messages from unknown senders
    if (msg.from === 'unknown' || msg.fromNodeId === 'unknown') {
      return true;
    }

    // Filter MQTT-related text patterns
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
  const markerRefs = useRef<Map<string, L.Marker>>(new Map())

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
            const channels = settings.autoAckChannels.split(',').map((c: string) => parseInt(c.trim())).filter((n: number) => !isNaN(n));
            setAutoAckChannels(channels);
          }

          if (settings.autoAckDirectMessages !== undefined) {
            setAutoAckDirectMessages(settings.autoAckDirectMessages === 'true');
          }

          if (settings.autoAckUseDM !== undefined) {
            setAutoAckUseDM(settings.autoAckUseDM === 'true');
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

  // Check if TX is disabled
  useEffect(() => {
    const checkTxStatus = async () => {
      try {
        const response = await authFetch(`${baseUrl}/api/device/tx-status`);
        if (response.ok) {
          const data = await response.json();
          setIsTxDisabled(!data.txEnabled);
        }
      } catch (error) {
        logger.error('Error checking TX status:', error);
      }
    };

    checkTxStatus();
    // Recheck TX status periodically (every 30 seconds)
    const interval = setInterval(checkTxStatus, 30000);
    return () => clearInterval(interval);
  }, [baseUrl]);

  // Check for version updates
  useEffect(() => {
    const checkForUpdates = async () => {
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
        }
      } catch (error) {
        logger.error('Error checking for updates:', error);
      }
    };

    checkForUpdates();

    // Check for updates every 4 hours
    const interval = setInterval(checkForUpdates, 4 * 60 * 60 * 1000);

    return () => clearInterval(interval);
  }, [baseUrl]);

  // Check if auto-upgrade is enabled
  useEffect(() => {
    const checkUpgradeStatus = async () => {
      try {
        const response = await authFetch(`${baseUrl}/api/upgrade/status`);
        if (response.ok) {
          const data = await response.json();
          setUpgradeEnabled(data.enabled && data.deploymentMethod === 'docker');
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
          backup: true
        })
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
      upgradePollingIntervalRef.current = setTimeout(poll, currentInterval) as unknown as ReturnType<typeof setInterval>;
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

  // Fetch traceroutes when showPaths or showRoute is enabled or Messages/Nodes tab is active
  useEffect(() => {
    if ((showPaths || showRoute || activeTab === 'messages' || activeTab === 'nodes') && shouldShowData()) {
      fetchTraceroutes();
      // Only auto-refresh when connected (not when viewing cached data)
      if (connectionStatus === 'connected') {
        const interval = setInterval(fetchTraceroutes, 60000); // Refresh every 60 seconds
        return () => clearInterval(interval);
      }
    }
  }, [showPaths, showRoute, activeTab, connectionStatus]);

  // Fetch neighbor info when showNeighborInfo is enabled
  useEffect(() => {
    if (showNeighborInfo && shouldShowData()) {
      fetchNeighborInfo();
      // Only auto-refresh when connected (not when viewing cached data)
      if (connectionStatus === 'connected') {
        const interval = setInterval(fetchNeighborInfo, 60000); // Refresh every 60 seconds
        return () => clearInterval(interval);
      }
    }
  }, [showNeighborInfo, connectionStatus]);

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

  // Handle scroll events to track scroll position
  const handleChannelScroll = useCallback(() => {
    if (channelMessagesContainerRef.current) {
      const atBottom = isScrolledNearBottom(channelMessagesContainerRef.current);
      setIsChannelScrolledToBottom(atBottom);
    }
  }, [isScrolledNearBottom]);

  const handleDMScroll = useCallback(() => {
    if (dmMessagesContainerRef.current) {
      const atBottom = isScrolledNearBottom(dmMessagesContainerRef.current);
      setIsDMScrolledToBottom(atBottom);
    }
  }, [isScrolledNearBottom]);

  // Auto-scroll to bottom when messages change or channel changes (only if user is at bottom)
  const scrollToBottom = useCallback((force: boolean = false) => {
    // Scroll the appropriate container based on active tab
    if (activeTab === 'channels' && channelMessagesContainerRef.current) {
      if (force || isChannelScrolledToBottom) {
        channelMessagesContainerRef.current.scrollTop = channelMessagesContainerRef.current.scrollHeight;
        setIsChannelScrolledToBottom(true);
      }
    } else if (activeTab === 'messages' && dmMessagesContainerRef.current) {
      if (force || isDMScrolledToBottom) {
        dmMessagesContainerRef.current.scrollTop = dmMessagesContainerRef.current.scrollHeight;
        setIsDMScrolledToBottom(true);
      }
    }
  }, [activeTab, isChannelScrolledToBottom, isDMScrolledToBottom]);

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

  // Force scroll to bottom when channel changes (new conversation)
  useEffect(() => {
    if (activeTab === 'channels') {
      // Use setTimeout to ensure messages are rendered before scrolling
      setTimeout(() => {
        scrollToBottom(true);
      }, 100);
    }
  }, [selectedChannel, activeTab, scrollToBottom]);

  // Force scroll to bottom when DM node changes (new conversation)
  useEffect(() => {
    if (activeTab === 'messages' && selectedDMNode) {
      // Use setTimeout to ensure messages are rendered before scrolling
      setTimeout(() => {
        if (dmMessagesContainerRef.current) {
          dmMessagesContainerRef.current.scrollTop = dmMessagesContainerRef.current.scrollHeight;
          setIsDMScrolledToBottom(true);
        }
      }, 150);
    }
  }, [selectedDMNode, activeTab]);

  // Fetch unread counts on initial load and periodically
  useEffect(() => {
    // Initial fetch
    fetchUnreadCounts();

    // Set up periodic refresh (every 10 seconds)
    const unreadInterval = setInterval(() => {
      fetchUnreadCounts();
    }, 10000);

    return () => clearInterval(unreadInterval);
  }, [fetchUnreadCounts]);

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
      hasUnreadDMs
    });
    logger.debug('🔴 Unread counts updated:', {
      channels: unreadCountsData?.channels,
      directMessages: unreadCountsData?.directMessages,
      hasUnreadChannels,
      hasUnreadDMs
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

  // Regular data updates (every 5 seconds)
  useEffect(() => {
    const updateInterval = setInterval(() => {
      // Use refs to get current values without adding to deps (prevents interval multiplication)
      const currentConnectionStatus = connectionStatusRef.current;
      const currentShowRebootModal = showRebootModalRef.current;

      // Skip polling when user has manually disconnected or device is rebooting
      if (currentConnectionStatus === 'user-disconnected' || currentConnectionStatus === 'rebooting') {
        return;
      }

      // Skip polling when RebootModal is active
      if (currentShowRebootModal) {
        return;
      }

      if (currentConnectionStatus === 'connected') {
        updateDataFromBackend();
      } else {
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
  const [, setStatusTick] = useState(0);
  useEffect(() => {
    const interval = setInterval(() => {
      // Force re-render to update message status indicators
      setStatusTick(prev => prev + 1);
    }, 1000); // Update every second

    return () => clearInterval(interval);
  }, []);

  const requestFullNodeDatabase = async () => {
    try {
      logger.debug('📡 Requesting full node database refresh...');
      const response = await authFetch(`${baseUrl}/api/nodes/refresh`, {
        method: 'POST'
      });

      if (response.ok) {
        logger.debug('✅ Node database refresh initiated');
        // Immediately update local data after refresh
        setTimeout(() => updateDataFromBackend(), 2000);
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

    // Refresh data after reboot
    fetchNodesWithTelemetry();
    fetchChannels();

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

        logger.debug(`📡 Connection API response: connected=${status.connected}, nodeResponsive=${status.nodeResponsive}, configuring=${status.configuring}, userDisconnected=${status.userDisconnected}`);

        // Check if user has manually disconnected
        if (status.userDisconnected) {
          logger.debug('⏸️  User-initiated disconnect detected');
          setConnectionStatus('user-disconnected');

          // Still fetch cached data from backend on page load
          // This ensures we show cached data even after refresh
          try {
            await fetchChannels(urlBase);
            await updateDataFromBackend();
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
          setError(`Connected to server, but Meshtastic node is not responding. Please check if the device is powered on and properly connected.`);
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
                  await updateDataFromBackend();
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
          setError(`Cannot connect to Meshtastic node at ${nodeAddress}. Please ensure the node is reachable and has HTTP API enabled.`);
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

  const fetchTraceroutes = async () => {
    try {
      const response = await fetch(`${baseUrl}/api/traceroutes/recent`, {
        credentials: 'include'
      });
      if (response.ok) {
        const data = await response.json();
        setTraceroutes(data);
      }
    } catch (error) {
      logger.error('Error fetching traceroutes:', error);
    }
  };

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

  const fetchNodesWithTelemetry = async () => {
    try {
      const response = await authFetch(`${baseUrl}/api/telemetry/available/nodes`);
      if (response.ok) {
        const data = await response.json();
        setNodesWithTelemetry(new Set(data.nodes));
        setNodesWithWeatherTelemetry(new Set(data.weather || []));
        setNodesWithEstimatedPosition(new Set(data.estimatedPosition || []));
        setNodesWithPKC(new Set(data.pkc || []));
      }
    } catch (error) {
      logger.error('Error fetching telemetry availability:', error);
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

  const fetchChannels = async (providedBaseUrl?: string) => {
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
          firstChannelId: channelsData[0]?.id
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
            logger.debug('🔍 Channel exists check:', { selectedChannel: currentSelectedChannel, currentChannelExists });
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
  };

  const updateDataFromBackend = async () => {
    try {
      // Use consolidated polling endpoint to reduce API calls from 8 to 1
      const pollResponse = await authFetch(`${baseUrl}/api/poll`);
      if (!pollResponse.ok) {
        logger.error('Failed to fetch consolidated poll data:', pollResponse.status);
        return;
      }

      const pollData = await pollResponse.json();

      // Check for backend version change (e.g., after auto-upgrade) and reload if changed
      // Use health endpoint since it always returns version and doesn't require auth
      try {
        const healthResponse = await fetch(`${baseUrl}/api/health`);
        if (healthResponse.ok) {
          const healthData = await healthResponse.json();
          if (healthData.version) {
            if (initialVersionRef.current === null) {
              // First check - store the initial version
              initialVersionRef.current = healthData.version;
              logger.info(`Initial backend version: ${healthData.version}`);
            } else if (initialVersionRef.current !== healthData.version) {
              // Version changed - backend was upgraded
              logger.info(`Backend version changed from ${initialVersionRef.current} to ${healthData.version} - reloading page`);
              window.location.reload();
              return; // Don't process rest of the response since we're reloading
            }
          }
        }
      } catch (error) {
        // Ignore health check errors - don't want to break polling if health endpoint fails
        logger.debug('Health check for version monitoring failed:', error);
      }

      // Extract localNodeId early to use in message processing (don't wait for state update)
      const localNodeId = pollData.deviceConfig?.basic?.nodeId || pollData.config?.localNodeInfo?.nodeId || currentNodeId;

      // Store in ref for immediate access across functions (bypasses React state delay)
      if (localNodeId) {
        localNodeIdRef.current = localNodeId;
      }

      // Process nodes data
      if (pollData.nodes) {
        // Merge server data with local optimistic updates for nodes with pending favorite changes
        // This prevents polling from overwriting optimistic UI updates
        const pendingRequests = pendingFavoriteRequests;

        console.log('[POLL] Received nodes:', pollData.nodes.length, 'Pending requests:', pendingRequests.size);

        if (pendingRequests.size === 0) {
          // No pending updates, safe to use server data as-is
          setNodes(pollData.nodes);
        } else {
          console.log('[POLL] Merging with pending favorites:', Array.from(pendingRequests.entries()));
          // Merge: keep optimistic isFavorite for nodes with pending requests
          setNodes(pollData.nodes.map((serverNode: DeviceInfo) => {
            const pendingState = pendingRequests.get(serverNode.nodeNum);
            if (pendingState !== undefined) {
              // Check if server data now matches our pending update
              if (serverNode.isFavorite === pendingState) {
                // Server has caught up, remove from pending
                console.log('[POLL] Server caught up for node:', serverNode.nodeNum);
                pendingRequests.delete(serverNode.nodeNum);
                return serverNode;
              }
              // Server hasn't caught up yet, preserve the local optimistic value
              console.log('[POLL] Preserving optimistic value for node:', serverNode.nodeNum, 'pending:', pendingState, 'server:', serverNode.isFavorite);
              return { ...serverNode, isFavorite: pendingState };
            }
            // Use server data for nodes without pending updates
            return serverNode;
          }));
        }
      }

      // Process messages data
      if (pollData.messages) {
        const messagesData = pollData.messages;
        // Convert timestamp strings back to Date objects
        const processedMessages = messagesData.map((msg: any) => ({
          ...msg,
          timestamp: new Date(msg.timestamp)
        }));

        // Play notification sound if new messages arrived from OTHER users (not your own messages)
        // Track by newest message ID instead of count (count stays at 100 due to API limit)
        if (processedMessages.length > 0) {
          const currentNewestMessage = processedMessages[0]; // Messages are sorted newest first
          const currentNewestId = currentNewestMessage.id;


          // Check if this is a new message (different ID than before)
          if (newestMessageId.current && currentNewestId !== newestMessageId.current) {
            // New message detected! Check if it's from someone else and is a text message
            const isFromOther = currentNewestMessage.fromNodeId !== localNodeId;
            const isTextMessage = currentNewestMessage.portnum === 1; // Only TEXT_MESSAGE_APP

            if (isFromOther && isTextMessage) {
              logger.debug('New message arrived from other user:', currentNewestMessage.fromNodeId);
              playNotificationSound();
            }
          }

          // Update the tracked newest message ID
          newestMessageId.current = currentNewestId;
        }

        // Check for matching messages to remove from pending
        const currentPending = pendingMessagesRef.current;
        let updatedPending = new Map(currentPending);
        let pendingChanged = false;

        if (currentPending.size > 0) {
          // For each pending message, check if a matching message appears in backend response
          currentPending.forEach((pendingMsg, tempId) => {
            const isDM = pendingMsg.channel === -1;

            const matchingMessage = processedMessages.find((msg: MeshMessage) => {
              if (msg.text !== pendingMsg.text) return false;

              // Match by sender
              const senderMatches = (localNodeId && msg.from === localNodeId) ||
                                   (msg.from === pendingMsg.from) ||
                                   (msg.fromNodeId === pendingMsg.fromNodeId);

              if (!senderMatches) return false;
              if (Math.abs(msg.timestamp.getTime() - pendingMsg.timestamp.getTime()) >= 30000) return false;

              if (isDM) {
                const matches = msg.toNodeId === pendingMsg.toNodeId ||
                       (msg.to === pendingMsg.to && (msg.channel === 0 || msg.channel === -1));
                return matches;
              } else {
                return msg.channel === pendingMsg.channel;
              }
            });

            if (matchingMessage) {
              // Remove from pending - backend now has this message
              updatedPending.delete(tempId);
              pendingChanged = true;
            }
          });

          // Only update state once after all deletions
          if (pendingChanged) {
            pendingMessagesRef.current = updatedPending;
            setPendingMessages(updatedPending);
          }
        }

        // Compute merged messages BEFORE updating state (so we can use the same array for channelGroups)
        const pendingIds = new Set(Array.from(pendingMessagesRef.current.keys()));

        // Build merged messages from current messages state
        const currentMessages = messages || [];
        const pendingToKeep = currentMessages.filter(m => pendingIds.has(m.id));

        // Trust the backend's acknowledged field - no frontend override
        const mergedMessages = [...processedMessages, ...pendingToKeep];

        // Update messages state
        setMessages(mergedMessages);

        // Group messages by channel using the SAME mergedMessages array (not processedMessages)
        const channelGroups: {[key: number]: MeshMessage[]} = {};

        // Process merged messages (which already have acknowledged status preserved)
        mergedMessages.forEach((msg: MeshMessage) => {
          if (msg.channel === -1) return; // Skip DMs for channel grouping

          if (!channelGroups[msg.channel]) {
            channelGroups[msg.channel] = [];
          }

          channelGroups[msg.channel].push(msg);
        });

        // Use database-backed unread counts instead of time-based client-side calculation
        // The backend now tracks read status persistently in the database
        const currentSelected = selectedChannelRef.current;

        // Fetch the latest unread counts from the backend
        // This is done periodically via useEffect, but we also use the current state
        let newUnreadCounts: {[key: number]: number};

        if (unreadCountsData?.channels) {
          // Use database-backed counts
          newUnreadCounts = { ...unreadCountsData.channels };
        } else {
          // Fallback to empty counts if data not yet loaded
          newUnreadCounts = { ...unreadCounts };
        }

        // Currently selected channel should always show 0 unread
        newUnreadCounts[currentSelected] = 0;

        logger.debug('📊 Updating unread counts:', {
          currentSelected,
          newUnreadCounts
        });

        setUnreadCounts(newUnreadCounts);

        setChannelMessages(channelGroups);
      }

      // Process config data
      if (pollData.config) {
        setDeviceInfo(pollData.config);
      }

      // Process device configuration data
      if (pollData.deviceConfig) {
        setDeviceConfig(pollData.deviceConfig);

        // Extract current node ID from device config
        if (pollData.deviceConfig.basic?.nodeId) {
          setCurrentNodeId(pollData.deviceConfig.basic.nodeId);
        }
      }

      // Fallback: Get currentNodeId from config.localNodeInfo if deviceConfig isn't available
      // (deviceConfig requires configuration:read permission, but localNodeInfo doesn't)
      if (!currentNodeId && pollData.config?.localNodeInfo?.nodeId) {
        console.log('🔧 Setting currentNodeId from config.localNodeInfo:', pollData.config.localNodeInfo.nodeId);
        setCurrentNodeId(pollData.config.localNodeInfo.nodeId);
      }

      // Process telemetry availability data
      if (pollData.telemetryNodes) {
        setNodesWithTelemetry(new Set(pollData.telemetryNodes.nodes || []));
        setNodesWithWeatherTelemetry(new Set(pollData.telemetryNodes.weather || []));
        setNodesWithEstimatedPosition(new Set(pollData.telemetryNodes.estimatedPosition || []));
        setNodesWithPKC(new Set(pollData.telemetryNodes.pkc || []));
      }

      // Process channels data (if available)
      if (pollData.channels) {
        setChannels(pollData.channels);
      }
    } catch (error) {
      logger.error('Failed to update data from backend:', error);
      // Server is offline - update status to disconnected
      setConnectionStatus('disconnected');
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      setError(`Server connection lost: ${errorMessage}`);
    }
  };

  const getRecentTraceroute = (nodeId: string) => {
    const nodeNumStr = nodeId.replace('!', '');
    const nodeNum = parseInt(nodeNumStr, 16);

    // Get current node number
    const currentNodeNumStr = currentNodeId.replace('!', '');
    const currentNodeNum = parseInt(currentNodeNumStr, 16);

    // Find most recent traceroute between current node and selected node using maxNodeAgeHours setting
    const cutoff = Date.now() - (maxNodeAgeHours * 60 * 60 * 1000);
    const recentTraceroutes = traceroutes
      .filter(tr => {
        const isRelevant = (
          (tr.fromNodeNum === currentNodeNum && tr.toNodeNum === nodeNum) ||
          (tr.fromNodeNum === nodeNum && tr.toNodeNum === currentNodeNum)
        );

        if (!isRelevant || tr.timestamp < cutoff) {
          return false;
        }

        // Filter out failed traceroutes (where both directions are null)
        // null or 'null' = failed (no response received)
        // [] = successful with 0 hops (direct connection)
        // [hops] = successful with intermediate hops
        let routeData = null;
        let routeBackData = null;

        try {
          if (tr.route && tr.route !== 'null') {
            routeData = JSON.parse(tr.route);
          }
          if (tr.routeBack && tr.routeBack !== 'null') {
            routeBackData = JSON.parse(tr.routeBack);
          }
        } catch (e) {
          // If parsing fails, treat as null (failed)
          console.error('Error parsing traceroute data:', e);
        }

        // A traceroute is successful if at least one direction has data (even if empty array)
        const hasForwardData = routeData !== null;
        const hasReturnData = routeBackData !== null;

        return hasForwardData || hasReturnData;
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
      showToast('Disconnected from node', 'info');
    } catch (error) {
      logger.error('Failed to disconnect:', error);
      showToast('Failed to disconnect', 'error');
    }
  };

  const handleReconnect = async () => {
    try {
      setConnectionStatus('connecting');
      await api.reconnectToNode();
      showToast('Reconnecting to node...', 'info');
      // Status will update via polling
    } catch (error) {
      logger.error('Failed to reconnect:', error);
      setConnectionStatus('user-disconnected');
      showToast('Failed to reconnect', 'error');
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
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ destination: nodeNum })
      });

      logger.debug(`🗺️ Traceroute request sent to ${nodeId}`);

      // Poll for traceroute results with increasing delays
      // This provides faster UI feedback instead of waiting for the 60s interval
      const pollDelays = [2000, 5000, 10000, 15000]; // 2s, 5s, 10s, 15s
      pollDelays.forEach((delay) => {
        setTimeout(() => {
          fetchTraceroutes();
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
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ destination: nodeNum })
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
      replyId: replyId
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
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          text: messageText,
          channel: 0, // Backend may expect channel 0 for DMs
          destination: destinationNodeId,
          replyId: replyId
        })
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
        const toNodeId = originalMessage.fromNodeId === nodeId
          ? originalMessage.toNodeId
          : originalMessage.fromNodeId;

        requestBody = {
          text: emoji,
          destination: toNodeId,  // Server expects 'destination' not 'toNodeId'
          replyId: replyId,
          emoji: EMOJI_FLAG
        };
      } else {
        // For channel messages: use channel
        requestBody = {
          text: emoji,
          channel: originalMessage.channel,
          replyId: replyId,
          emoji: EMOJI_FLAG
        };
      }

      const response = await authFetch(`${baseUrl}/api/messages/send`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody)
      });

      if (response.ok) {
        // Refresh messages to show the new tapback
        setTimeout(() => updateDataFromBackend(), 500);
      } else {
        const errorData = await response.json();
        setError(`Failed to send reaction: ${errorData.error || 'Unknown error'}`);
      }
    } catch (err) {
      setError(`Failed to send reaction: ${err instanceof Error ? err.message : 'Network error'}`);
    }
  };

  const handleDeleteMessage = async (message: MeshMessage) => {
    if (!window.confirm('Are you sure you want to delete this message?')) {
      return;
    }

    try {
      const response = await authFetch(`${baseUrl}/api/messages/${message.id}`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json'
        }
      });

      if (response.ok) {
        showToast('Message deleted successfully', 'success');
        // Update local state to remove the message
        setMessages(prev => prev.filter(m => m.id !== message.id));
        setChannelMessages(prev => ({
          ...prev,
          [message.channel]: (prev[message.channel] || []).filter(m => m.id !== message.id)
        }));
        updateDataFromBackend();
      } else {
        const errorData = await response.json();
        showToast(`Failed to delete message: ${errorData.message || 'Unknown error'}`, 'error');
      }
    } catch (err) {
      showToast(`Failed to delete message: ${err instanceof Error ? err.message : 'Network error'}`, 'error');
    }
  };

  const handlePurgeChannelMessages = async (channelId: number) => {
    const channel = channels.find(c => c.id === channelId);
    const channelName = channel?.name || `Channel ${channelId}`;

    if (!window.confirm(`Are you sure you want to purge ALL messages from ${channelName}? This action cannot be undone.`)) {
      return;
    }

    try {
      const response = await authFetch(`${baseUrl}/api/messages/channels/${channelId}`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json'
        }
      });

      if (response.ok) {
        const data = await response.json();
        showToast(`Purged ${data.deletedCount} messages from ${channelName}`, 'success');
        // Update local state
        setChannelMessages(prev => ({
          ...prev,
          [channelId]: []
        }));
        updateDataFromBackend();
      } else {
        const errorData = await response.json();
        showToast(`Failed to purge messages: ${errorData.message || 'Unknown error'}`, 'error');
      }
    } catch (err) {
      showToast(`Failed to purge messages: ${err instanceof Error ? err.message : 'Network error'}`, 'error');
    }
  };

  const handlePurgeDirectMessages = async (nodeNum: number) => {
    const node = nodes.find(n => n.nodeNum === nodeNum);
    const nodeName = node?.user?.shortName || node?.user?.longName || `Node ${nodeNum}`;

    if (!window.confirm(`Are you sure you want to purge ALL direct messages with ${nodeName}? This action cannot be undone.`)) {
      return;
    }

    try {
      const response = await authFetch(`${baseUrl}/api/messages/direct-messages/${nodeNum}`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json'
        }
      });

      if (response.ok) {
        const data = await response.json();
        showToast(`Purged ${data.deletedCount} messages with ${nodeName}`, 'success');
        // Update local state to immediately reflect deletions
        const nodeId = node?.user?.id;
        if (nodeId) {
          setMessages(prev => prev.filter(m =>
            !(m.fromNodeId === nodeId || m.toNodeId === nodeId)
          ));
        }
        // Also refresh from backend to ensure consistency
        updateDataFromBackend();
      } else {
        const errorData = await response.json();
        showToast(`Failed to purge messages: ${errorData.message || 'Unknown error'}`, 'error');
      }
    } catch (err) {
      showToast(`Failed to purge messages: ${err instanceof Error ? err.message : 'Network error'}`, 'error');
    }
  };

  const handlePurgeNodeTraceroutes = async (nodeNum: number) => {
    const node = nodes.find(n => n.nodeNum === nodeNum);
    const nodeName = node?.user?.shortName || node?.user?.longName || `Node ${nodeNum}`;

    if (!window.confirm(`Are you sure you want to purge ALL traceroutes for ${nodeName}? This action cannot be undone.`)) {
      return;
    }

    try {
      const response = await authFetch(`${baseUrl}/api/messages/nodes/${nodeNum}/traceroutes`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json'
        }
      });

      if (response.ok) {
        const data = await response.json();
        showToast(`Purged ${data.deletedCount} traceroutes for ${nodeName}`, 'success');
        // Refresh data from backend to ensure consistency
        updateDataFromBackend();
      } else {
        const errorData = await response.json();
        showToast(`Failed to purge traceroutes: ${errorData.message || 'Unknown error'}`, 'error');
      }
    } catch (err) {
      showToast(`Failed to purge traceroutes: ${err instanceof Error ? err.message : 'Network error'}`, 'error');
    }
  };

  const handlePurgeNodeTelemetry = async (nodeNum: number) => {
    const node = nodes.find(n => n.nodeNum === nodeNum);
    const nodeName = node?.user?.shortName || node?.user?.longName || `Node ${nodeNum}`;

    if (!window.confirm(`Are you sure you want to purge ALL telemetry data for ${nodeName}? This action cannot be undone.`)) {
      return;
    }

    try {
      const response = await authFetch(`${baseUrl}/api/messages/nodes/${nodeNum}/telemetry`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json'
        }
      });

      if (response.ok) {
        const data = await response.json();
        showToast(`Purged ${data.deletedCount} telemetry records for ${nodeName}`, 'success');
        // Refresh data from backend to ensure consistency
        updateDataFromBackend();
      } else {
        const errorData = await response.json();
        showToast(`Failed to purge telemetry: ${errorData.message || 'Unknown error'}`, 'error');
      }
    } catch (err) {
      showToast(`Failed to purge telemetry: ${err instanceof Error ? err.message : 'Network error'}`, 'error');
    }
  };

  const handleDeleteNode = async (nodeNum: number) => {
    const node = nodes.find(n => n.nodeNum === nodeNum);
    const nodeName = node?.user?.shortName || node?.user?.longName || `Node ${nodeNum}`;

    if (!window.confirm(`Are you sure you want to DELETE ${nodeName} from the local database?\n\nThis will remove:\n- The node from the map and node list\n- All messages with this node\n- All traceroutes for this node\n- All telemetry data for this node\n\nThis action cannot be undone.`)) {
      return;
    }

    try {
      const response = await authFetch(`${baseUrl}/api/messages/nodes/${nodeNum}`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json'
        }
      });

      if (response.ok) {
        const data = await response.json();
        showToast(`Deleted ${nodeName} - ${data.messagesDeleted} messages, ${data.traceroutesDeleted} traceroutes, ${data.telemetryDeleted} telemetry records`, 'success');
        // Close the purge data modal if open
        setShowPurgeDataModal(false);
        // Clear the selected DM node if it's the one being deleted
        const deletedNode = nodes.find(n => n.nodeNum === nodeNum);
        if (deletedNode && selectedDMNode === deletedNode.user?.id) {
          setSelectedDMNode('');
        }
        // Refresh data from backend to ensure consistency
        updateDataFromBackend();
      } else {
        const errorData = await response.json();
        showToast(`Failed to delete node: ${errorData.message || 'Unknown error'}`, 'error');
      }
    } catch (err) {
      showToast(`Failed to delete node: ${err instanceof Error ? err.message : 'Network error'}`, 'error');
    }
  };

  const handlePurgeNodeFromDevice = async (nodeNum: number) => {
    const node = nodes.find(n => n.nodeNum === nodeNum);
    const nodeName = node?.user?.shortName || node?.user?.longName || `Node ${nodeNum}`;

    if (!window.confirm(`Are you sure you want to PURGE ${nodeName} from BOTH the connected device AND the local database?\n\nThis will:\n- Send an admin command to remove the node from the device NodeDB\n- Remove the node from the map and node list\n- Delete all messages with this node\n- Delete all traceroutes for this node\n- Delete all telemetry data for this node\n\nThis action cannot be undone and affects both the device and local database.`)) {
      return;
    }

    try {
      const response = await authFetch(`${baseUrl}/api/messages/nodes/${nodeNum}/purge-from-device`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        }
      });

      if (response.ok) {
        const data = await response.json();
        showToast(`Purged ${nodeName} from device and database - ${data.messagesDeleted} messages, ${data.traceroutesDeleted} traceroutes, ${data.telemetryDeleted} telemetry records`, 'success');
        // Close the purge data modal if open
        setShowPurgeDataModal(false);
        // Clear the selected DM node if it's the one being deleted
        const purgedNode = nodes.find(n => n.nodeNum === nodeNum);
        if (purgedNode && selectedDMNode === purgedNode.user?.id) {
          setSelectedDMNode('');
        }
        // Refresh data from backend to ensure consistency
        updateDataFromBackend();
      } else {
        const errorData = await response.json();
        showToast(`Failed to purge node from device: ${errorData.message || 'Unknown error'}`, 'error');
      }
    } catch (err) {
      showToast(`Failed to purge node from device: ${err instanceof Error ? err.message : 'Network error'}`, 'error');
    }
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
      replyId: replyId
    };

    // Add message to local state immediately
    setMessages(prev => [...prev, sentMessage]);
    setChannelMessages(prev => ({
      ...prev,
      [messageChannel]: [...(prev[messageChannel] || []), sentMessage]
    }));

    // Add to pending acknowledgments
    console.log(`📤 Adding message to pending acknowledgments:`, {
      tempId,
      text: sentMessage.text,
      from: sentMessage.from,
      fromNodeId: sentMessage.fromNodeId,
      channel: sentMessage.channel
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
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          text: messageText,
          channel: messageChannel,
          replyId: replyId
        })
      });

      if (response.ok) {
        // The message was sent successfully
        // We'll wait for it to appear in the backend data to confirm acknowledgment
        setTimeout(() => updateDataFromBackend(), 1000);
      } else {
        const errorData = await response.json();
        setError(`Failed to send message: ${errorData.error}`);

        // Remove the message from local state if sending failed
        setMessages(prev => prev.filter(msg => msg.id !== tempId));
        setChannelMessages(prev => ({
          ...prev,
          [channel]: prev[channel]?.filter(msg => msg.id !== tempId) || []
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
        [channel]: prev[channel]?.filter(msg => msg.id !== tempId) || []
      }));
      setPendingMessages(prev => {
        const updated = new Map(prev);
        updated.delete(tempId);
        pendingMessagesRef.current = updated; // Update ref
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

  const isMyMessage = (msg: MeshMessage): boolean => {
    return msg.from === currentNodeId || (msg.isLocalMessage === true);
  };

  const getChannelName = (channelNum: number): string => {
    // Look for a channel configuration with this ID
    const channel = channels.find(ch => ch.id === channelNum);
    if (channel) {
      return channel.name;
    }

    // Fallback to generic channel names - no special cases
    return `Channel ${channelNum}`;
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

  const getDMMessages = (nodeId: string): MeshMessage[] => {
    return messages.filter(msg =>
      (msg.from === nodeId || msg.to === nodeId) &&
      msg.to !== '!ffffffff' && // Exclude broadcasts
      msg.channel === -1 && // Only direct messages
      msg.portnum === 1 // Only text messages, exclude traceroutes (portnum 70)
    );
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

      return longName.includes(lowerFilter) ||
             shortName.includes(lowerFilter) ||
             id.includes(lowerFilter);
    });
  };


  // Get processed (filtered and sorted) nodes
  const processedNodes = useMemo((): DeviceInfo[] => {
    const cutoffTime = Date.now() / 1000 - (maxNodeAgeHours * 60 * 60);

    const ageFiltered = nodes.filter(node => {
      if (!node.lastHeard) return false;
      return node.lastHeard >= cutoffTime;
    });

    const textFiltered = filterNodes(ageFiltered, nodeFilter);

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
        const hasPosition = node.position &&
          node.position.latitude != null &&
          node.position.longitude != null;
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
  }, [nodes, maxNodeAgeHours, nodeFilter, sortField, sortDirection, nodeFilters, nodesWithTelemetry, nodesWithWeatherTelemetry, nodesWithPKC]);

  // Memoize selected channel config for modal
  const selectedChannelConfig = useMemo(() => {
    if (channelInfoModal === null) return null;
    return channels.find(ch => ch.id === channelInfoModal) || null;
  }, [channelInfoModal, channels]);

  // Handle Escape key for modal
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && channelInfoModal !== null) {
        setChannelInfoModal(null);
        setShowPsk(false); // Reset PSK visibility when closing modal
      }
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [channelInfoModal]);

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

    console.log('[FAVORITE] Toggle called for node:', node.nodeNum, 'current:', node.isFavorite);

    if (!node.user?.id) {
      logger.error('Cannot toggle favorite: node has no user ID');
      return;
    }

    // Prevent multiple rapid clicks on the same node
    if (pendingFavoriteRequests.has(node.nodeNum)) {
      console.log('[FAVORITE] Already pending for node:', node.nodeNum);
      return;
    }

    // Store the original state before any updates
    const originalFavoriteStatus = node.isFavorite;
    const newFavoriteStatus = !originalFavoriteStatus;

    console.log('[FAVORITE] Will update to:', newFavoriteStatus);

    try {
      // Mark this request as pending with the expected new state
      pendingFavoriteRequests.set(node.nodeNum, newFavoriteStatus);
      console.log('[FAVORITE] Set pending for node:', node.nodeNum, 'Map size:', pendingFavoriteRequests.size, 'Map contents:', Array.from(pendingFavoriteRequests.entries()));

      console.log('[FAVORITE] About to call setNodes...');
      // Optimistically update the UI - use flushSync to force immediate render
      // This prevents the polling from overwriting the optimistic update before it renders
      flushSync(() => {
        setNodes(prevNodes => {
          console.log('[FAVORITE] setNodes callback executing, prevNodes length:', prevNodes.length);
          const updated = prevNodes.map(n =>
            n.nodeNum === node.nodeNum
              ? { ...n, isFavorite: newFavoriteStatus }
              : n
          );
          console.log('[FAVORITE] setNodes callback complete');
          return updated;
        });
      });

      // Send update to backend (with device sync enabled by default)
      const response = await authFetch(`${baseUrl}/api/nodes/${node.user.id}/favorite`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          isFavorite: newFavoriteStatus,
          syncToDevice: true  // Enable two-way sync to Meshtastic device
        })
      });

      if (!response.ok) {
        if (response.status === 403) {
          showToast('Insufficient permissions to update favorites', 'error');
          // Revert to original state using the saved original value
          setNodes(prevNodes =>
            prevNodes.map(n =>
              n.nodeNum === node.nodeNum
                ? { ...n, isFavorite: originalFavoriteStatus }
                : n
            )
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
        prevNodes.map(n =>
          n.nodeNum === node.nodeNum
            ? { ...n, isFavorite: originalFavoriteStatus }
            : n
        )
      );
      // Remove from pending on error since we reverted
      pendingFavoriteRequests.delete(node.nodeNum);
      showToast('Failed to update favorite status. Please try again.', 'error');
    }
    // Note: On success, the polling logic will remove from pendingFavoriteRequests
    // when it detects the server has caught up
  };

  // Function to handle sender icon clicks
  const handleSenderClick = useCallback((nodeId: string, event: React.MouseEvent) => {
    const rect = event.currentTarget.getBoundingClientRect();

    // Get sidebar width from CSS variable to avoid overlap
    const sidebarWidth = parseInt(
      getComputedStyle(document.documentElement).getPropertyValue('--sidebar-width') || '60px'
    );

    // Popup max-width is 280px, and it's centered with translateX(-50%)
    // So the left edge will be at x - 140px
    const popupHalfWidth = 140;
    let x = rect.left + rect.width / 2;

    // Ensure popup doesn't go under the sidebar (with 10px padding for safety)
    const minX = sidebarWidth + popupHalfWidth + 10;
    if (x < minX) {
      x = minX;
    }

    setNodePopup({
      nodeId,
      position: {
        x,
        y: rect.top
      }
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

  // Helper function to find a message by its ID
  const findMessageById = (messageId: number, channelId: number): MeshMessage | null => {
    const messagesForChannel = channelMessages[channelId] || [];
    return messagesForChannel.find(msg => {
      const msgIdNum = parseInt(msg.id.split('_')[1] || '0');
      return msgIdNum === messageId;
    }) || null;
  };

  const renderNodeFilterPopup = () => {
    if (!showNodeFilterPopup) return null;

    return (
      <div className="filter-popup-overlay" onClick={() => setShowNodeFilterPopup(false)}>
        <div className="filter-popup" onClick={(e) => e.stopPropagation()}>
          <div className="filter-popup-header">
            <h4>Filter Nodes</h4>
            <button
              className="filter-popup-close"
              onClick={() => setShowNodeFilterPopup(false)}
            >
              ✕
            </button>
          </div>
          <div className="filter-popup-content">
            <div className="filter-section">
              <div className="filter-section-title">Filter Mode</div>
              <div className="filter-toggle-group">
                <button
                  className={`filter-toggle-btn ${nodeFilters.filterMode === 'show' ? 'active' : ''}`}
                  onClick={() => setNodeFilters({...nodeFilters, filterMode: 'show'})}
                >
                  Show only
                </button>
                <button
                  className={`filter-toggle-btn ${nodeFilters.filterMode === 'hide' ? 'active' : ''}`}
                  onClick={() => setNodeFilters({...nodeFilters, filterMode: 'hide'})}
                >
                  Hide matching
                </button>
              </div>
              <div className="filter-mode-description">
                {nodeFilters.filterMode === 'show'
                  ? 'Show only nodes that match all selected filters'
                  : 'Hide nodes that match any selected filters'}
              </div>
            </div>

            <div className="filter-section">
              <div className="filter-section-title">
                <span className="filter-icon-wrapper"><span className="filter-icon">⚠️</span></span>
                <span>Security</span>
              </div>
              <div className="filter-radio-group">
                <label className="filter-radio">
                  <input
                    type="radio"
                    name="securityFilter"
                    value="all"
                    checked={securityFilter === 'all'}
                    onChange={(e) => setSecurityFilter(e.target.value as any)}
                  />
                  <span>All Nodes</span>
                </label>
                <label className="filter-radio">
                  <input
                    type="radio"
                    name="securityFilter"
                    value="flaggedOnly"
                    checked={securityFilter === 'flaggedOnly'}
                    onChange={(e) => setSecurityFilter(e.target.value as any)}
                  />
                  <span>⚠️ Flagged Only</span>
                </label>
                <label className="filter-radio">
                  <input
                    type="radio"
                    name="securityFilter"
                    value="hideFlagged"
                    checked={securityFilter === 'hideFlagged'}
                    onChange={(e) => setSecurityFilter(e.target.value as any)}
                  />
                  <span>Hide Flagged</span>
                </label>
              </div>
            </div>

            <div className="filter-section">
              <div className="filter-section-title">Node Features</div>

              <label className="filter-checkbox">
                <input
                  type="checkbox"
                  checked={nodeFilters.showTelemetry}
                  onChange={(e) => setNodeFilters({...nodeFilters, showTelemetry: e.target.checked})}
                />
                <span className="filter-label-with-icon">
                  <span className="filter-icon">📊</span>
                  <span>Telemetry data</span>
                </span>
              </label>

              <label className="filter-checkbox">
                <input
                  type="checkbox"
                  checked={nodeFilters.showEnvironment}
                  onChange={(e) => setNodeFilters({...nodeFilters, showEnvironment: e.target.checked})}
                />
                <span className="filter-label-with-icon">
                  <span className="filter-icon">☀️</span>
                  <span>Environment metrics</span>
                </span>
              </label>

              <label className="filter-checkbox">
                <input
                  type="checkbox"
                  checked={nodeFilters.showPosition}
                  onChange={(e) => setNodeFilters({...nodeFilters, showPosition: e.target.checked})}
                />
                <span className="filter-label-with-icon">
                  <span className="filter-icon">📍</span>
                  <span>Position data</span>
                </span>
              </label>

              <label className="filter-checkbox">
                <input
                  type="checkbox"
                  checked={nodeFilters.showPKI}
                  onChange={(e) => setNodeFilters({...nodeFilters, showPKI: e.target.checked})}
                />
                <span className="filter-label-with-icon">
                  <span className="filter-icon">🔐</span>
                  <span>Public Key Crypto</span>
                </span>
              </label>

              <label className="filter-checkbox">
                <input
                  type="checkbox"
                  checked={nodeFilters.showMqtt}
                  onChange={(e) => setNodeFilters({...nodeFilters, showMqtt: e.target.checked})}
                />
                <span className="filter-label-with-icon">
                  <span className="filter-icon">🌐</span>
                  <span>MQTT nodes</span>
                </span>
              </label>

              <label className="filter-checkbox">
                <input
                  type="checkbox"
                  checked={nodeFilters.showUnknown}
                  onChange={(e) => setNodeFilters({...nodeFilters, showUnknown: e.target.checked})}
                />
                <span className="filter-label-with-icon">
                  <span className="filter-icon">❓</span>
                  <span>Unknown nodes</span>
                </span>
              </label>
            </div>

            <div className="filter-section">
              <div className="filter-section-title">
                <span className="filter-icon-wrapper"><span className="filter-icon">🔋</span></span>
                <span>Power Source</span>
              </div>
              <div className="filter-radio-group">
                <label className="filter-radio">
                  <input
                    type="radio"
                    name="powerSource"
                    value="both"
                    checked={nodeFilters.powerSource === 'both'}
                    onChange={(e) => setNodeFilters({...nodeFilters, powerSource: e.target.value as 'both'})}
                  />
                  <span>Both</span>
                </label>
                <label className="filter-radio">
                  <input
                    type="radio"
                    name="powerSource"
                    value="powered"
                    checked={nodeFilters.powerSource === 'powered'}
                    onChange={(e) => setNodeFilters({...nodeFilters, powerSource: e.target.value as 'powered'})}
                  />
                  <span>🔌 Powered only</span>
                </label>
                <label className="filter-radio">
                  <input
                    type="radio"
                    name="powerSource"
                    value="battery"
                    checked={nodeFilters.powerSource === 'battery'}
                    onChange={(e) => setNodeFilters({...nodeFilters, powerSource: e.target.value as 'battery'})}
                  />
                  <span>🔋 Battery only</span>
                </label>
              </div>
            </div>

            <div className="filter-section">
              <div className="filter-section-title">
                <span className="filter-icon-wrapper"><span className="filter-icon">🔗</span></span>
                <span>Hops Away</span>
              </div>
              <div className="filter-range-group">
                <div className="filter-range-input">
                  <label>Min:</label>
                  <input
                    type="number"
                    min="0"
                    max="10"
                    value={nodeFilters.minHops}
                    onChange={(e) => setNodeFilters({...nodeFilters, minHops: parseInt(e.target.value) || 0})}
                  />
                </div>
                <div className="filter-range-input">
                  <label>Max:</label>
                  <input
                    type="number"
                    min="0"
                    max="10"
                    value={nodeFilters.maxHops}
                    onChange={(e) => {
                      const val = parseInt(e.target.value);
                      setNodeFilters({...nodeFilters, maxHops: isNaN(val) ? 10 : val});
                    }}
                  />
                </div>
              </div>
            </div>

            <div className="filter-section">
              <div className="filter-section-title">
                <span className="filter-icon-wrapper"><span className="filter-icon">👤</span></span>
                <span>Device Role</span>
              </div>
              <div className="filter-role-group">
                {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(roleNum => (
                  <label key={roleNum} className="filter-checkbox">
                    <input
                      type="checkbox"
                      checked={nodeFilters.deviceRoles.length === 0 || nodeFilters.deviceRoles.includes(roleNum)}
                      onChange={(e) => {
                        const allRoles = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

                        if (e.target.checked) {
                          // If all were selected (empty array), keep it empty (already showing all)
                          if (nodeFilters.deviceRoles.length === 0) {
                            // Already showing all, do nothing
                            return;
                          } else {
                            // Add this role to the array
                            const newRoles = [...nodeFilters.deviceRoles, roleNum];
                            // If all are now selected, set to empty array (show all)
                            if (newRoles.length === 13) {
                              setNodeFilters({...nodeFilters, deviceRoles: []});
                            } else {
                              setNodeFilters({...nodeFilters, deviceRoles: newRoles});
                            }
                          }
                        } else {
                          // Unchecking a role
                          if (nodeFilters.deviceRoles.length === 0) {
                            // All were selected (empty array), now exclude this one
                            const newRoles = allRoles.filter((r: number) => r !== roleNum);
                            setNodeFilters({...nodeFilters, deviceRoles: newRoles});
                          } else {
                            // Remove this role from the array
                            const newRoles = nodeFilters.deviceRoles.filter((r: number) => r !== roleNum);
                            setNodeFilters({...nodeFilters, deviceRoles: newRoles});
                          }
                        }
                      }}
                    />
                    <span>{ROLE_NAMES[roleNum]}</span>
                  </label>
                ))}
              </div>
            </div>

            <div className="filter-section">
              <div className="filter-section-title">
                <span className="filter-icon-wrapper"><span className="filter-icon">📡</span></span>
                <span>Channel</span>
              </div>
              <div className="filter-role-group">
                {(channels || []).map(ch => (
                  <label key={ch.id} className="filter-checkbox">
                    <input
                      type="checkbox"
                      checked={nodeFilters.channels.length === 0 || nodeFilters.channels.includes(ch.id)}
                      onChange={(e) => {
                        const allChannels = (channels || []).map(c => c.id);

                        if (e.target.checked) {
                          if (nodeFilters.channels.length === 0) {
                            return;
                          } else {
                            const newChannels = [...nodeFilters.channels, ch.id];
                            if (newChannels.length === (channels || []).length) {
                              setNodeFilters({...nodeFilters, channels: []});
                            } else {
                              setNodeFilters({...nodeFilters, channels: newChannels});
                            }
                          }
                        } else {
                          if (nodeFilters.channels.length === 0) {
                            const newChannels = allChannels.filter((c: number) => c !== ch.id);
                            setNodeFilters({...nodeFilters, channels: newChannels});
                          } else {
                            const newChannels = nodeFilters.channels.filter((c: number) => c !== ch.id);
                            setNodeFilters({...nodeFilters, channels: newChannels});
                          }
                        }
                      }}
                    />
                    <span>Channel {ch.id}{ch.name ? ` (${ch.name})` : ""}</span>
                  </label>
                ))}
              </div>
            </div>

          </div>
          <div className="filter-popup-actions">
            <button
              className="filter-reset-btn"
              onClick={() => setNodeFilters({
                filterMode: 'show',
                showMqtt: false,
                showTelemetry: false,
                showEnvironment: false,
                powerSource: 'both',
                showPosition: false,
                minHops: 0,
                maxHops: 10,
                showPKI: false,
                showUnknown: false,
                deviceRoles: [],
                channels: []
              })}
            >
              Reset All
            </button>
            <button
              className="filter-apply-btn"
              onClick={() => setShowNodeFilterPopup(false)}
            >
              Apply
            </button>
          </div>
        </div>
      </div>
    );
  };


  const renderChannelsTab = () => {
    const availableChannels = getAvailableChannels();
    return (
    <div className="tab-content channels-tab-content">
      <div className="channels-header">
        <h2>Channels ({availableChannels.length})</h2>
        <div className="channels-controls">
          <label className="mqtt-toggle">
            <input
              type="checkbox"
              checked={showMqttMessages}
              onChange={(e) => setShowMqttMessages(e.target.checked)}
            />
            Show MQTT/Bridge Messages
          </label>
        </div>
      </div>
      {shouldShowData() ? (
        availableChannels.length > 0 ? (
          <>
            {/* Mobile Channel Dropdown */}
            <div className="channel-dropdown-mobile">
              <select
                className="channel-dropdown-select"
                value={selectedChannel}
                onChange={(e) => {
                  const channelId = parseInt(e.target.value);
                  logger.debug('👆 User selected channel from dropdown:', channelId);
                  setSelectedChannel(channelId);
                  selectedChannelRef.current = channelId;
                  setReplyingTo(null); // Clear reply state when switching channels
                  setUnreadCounts(prev => {
                    const updated = { ...prev, [channelId]: 0 };
                    logger.debug('📝 Setting unread counts:', updated);
                    return updated;
                  });
                }}
              >
                {availableChannels.map(channelId => {
                  const channelConfig = channels.find(ch => ch.id === channelId);
                  const displayName = channelConfig?.name || getChannelName(channelId);
                  const unread = unreadCounts[channelId] || 0;
                  const encrypted = channelConfig?.psk && channelConfig.psk !== DEFAULT_UNENCRYPTED_PSK;
                  const uplink = channelConfig?.uplinkEnabled ? '↑' : '';
                  const downlink = channelConfig?.downlinkEnabled ? '↓' : '';

                  return (
                    <option key={channelId} value={channelId}>
                      {encrypted ? '🔒' : '🔓'} {displayName} #{channelId} {uplink}{downlink} {unread > 0 ? `(${unread})` : ''}
                    </option>
                  );
                })}
              </select>
            </div>

            {/* Channel Buttons */}
            <div className="channels-grid">
              {availableChannels.map(channelId => {
                const channelConfig = channels.find(ch => ch.id === channelId);
                const displayName = channelConfig?.name || getChannelName(channelId);
                return (
                <button
                  key={channelId}
                  className={`channel-button ${selectedChannel === channelId ? 'selected' : ''}`}
                  onClick={() => {
                    logger.debug('👆 User clicked channel:', channelId, 'Previous selected:', selectedChannel);
                    setSelectedChannel(channelId);
                    selectedChannelRef.current = channelId; // Update ref immediately
                    setReplyingTo(null); // Clear reply state when switching channels
                    setUnreadCounts(prev => {
                      const updated = { ...prev, [channelId]: 0 };
                      logger.debug('📝 Setting unread counts:', updated);
                      return updated;
                    });
                  }}
                >
                  <div className="channel-button-content">
                    <div className="channel-button-left">
                      <div className="channel-button-header">
                        <span className="channel-name">{displayName}</span>
                        <span className="channel-id">#{channelId}</span>
                      </div>
                      <div className="channel-button-indicators">
                        {channelConfig?.psk && channelConfig.psk !== DEFAULT_UNENCRYPTED_PSK ? (
                          <span className="encryption-icon encrypted" title="Encrypted">🔒</span>
                        ) : (
                          <span className="encryption-icon unencrypted" title="Unencrypted">🔓</span>
                        )}
                        <a
                          href="#"
                          className="channel-info-link"
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            setChannelInfoModal(channelId);
                          }}
                          title="Show channel info"
                        >
                          info
                        </a>
                      </div>
                    </div>
                    <div className="channel-button-right">
                      {unreadCounts[channelId] > 0 && (
                        <span className="unread-badge">{unreadCounts[channelId]}</span>
                      )}
                      <div className="channel-button-status">
                        <span className={`arrow-icon uplink ${channelConfig?.uplinkEnabled ? 'enabled' : 'disabled'}`} title="MQTT Uplink">
                          ↑
                        </span>
                        <span className={`arrow-icon downlink ${channelConfig?.downlinkEnabled ? 'enabled' : 'disabled'}`} title="MQTT Downlink">
                          ↓
                        </span>
                      </div>
                    </div>
                  </div>
                </button>
                );
              })}
            </div>

            {/* Selected Channel Messaging */}
            {selectedChannel !== -1 && (
              <div className="channel-conversation-section">
                <h3>
                  {getChannelName(selectedChannel)}
                  <span className="channel-id-label">#{selectedChannel}</span>
                </h3>

                <div className="channel-conversation">
                  <div className="messages-container" ref={channelMessagesContainerRef}>
                    {(() => {
                      // Use selected channel ID directly - no mapping needed
                      const messageChannel = selectedChannel;
                      let messagesForChannel = channelMessages[messageChannel] || [];

                      // Filter MQTT messages if the option is disabled
                      if (!showMqttMessages) {
                        messagesForChannel = messagesForChannel.filter(msg => !isMqttBridgeMessage(msg));
                      }

                      // Filter traceroutes from Primary channel (channel 0)
                      if (messageChannel === 0) {
                        messagesForChannel = messagesForChannel.filter(msg => msg.portnum !== 70);
                      }

                      // Sort messages by timestamp (oldest first)
                      messagesForChannel = messagesForChannel.sort((a, b) =>
                        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
                      );

                      return messagesForChannel && messagesForChannel.length > 0 ? (
                      messagesForChannel.map((msg, index) => {
                        const isMine = isMyMessage(msg);
                        const repliedMessage = msg.replyId ? findMessageById(msg.replyId, messageChannel) : null;
                        const isReaction = msg.emoji === 1;

                        // Hide reactions (tapbacks) from main message list
                        // They will be shown inline under the original message if it exists
                        if (isReaction) {
                          return null;
                        }

                        // Find ALL reactions in the full channel message list (not filtered)
                        const allChannelMessages = channelMessages[messageChannel] || [];
                        const reactions = allChannelMessages.filter(m =>
                          m.emoji === 1 && m.replyId && m.replyId.toString() === msg.id.split('_')[1]
                        );

                        // Check if we should show a date separator
                        const currentDate = new Date(msg.timestamp);
                        const prevMsg = index > 0 ? messagesForChannel[index - 1] : null;
                        const prevDate = prevMsg ? new Date(prevMsg.timestamp) : null;
                        const showSeparator = shouldShowDateSeparator(prevDate, currentDate);

                        return (
                          <React.Fragment key={msg.id}>
                            {showSeparator && (
                              <div className="date-separator">
                                <span className="date-separator-text">
                                  {getMessageDateSeparator(currentDate, dateFormat)}
                                </span>
                              </div>
                            )}
                            <div className={`message-bubble-container ${isMine ? 'mine' : 'theirs'}`}>
                            {!isMine && (
                              <div
                                className="sender-dot clickable"
                                title={`Click for ${getNodeName(msg.from)} details`}
                                onClick={(e) => handleSenderClick(msg.from, e)}
                              >
                                {getNodeShortName(msg.from)}
                              </div>
                            )}
                            <div className="message-content">
                              {msg.replyId && !isReaction && (
                                <div className="replied-message">
                                  <div className="reply-arrow">↳</div>
                                  <div className="reply-content">
                                    {repliedMessage ? (
                                      <>
                                        <div className="reply-from">{getNodeShortName(repliedMessage.from)}</div>
                                        <div className="reply-text">{repliedMessage.text || "Empty Message"}</div>
                                      </>
                                    ) : (
                                      <div className="reply-text" style={{ fontStyle: 'italic', opacity: 0.6 }}>
                                        Message not available
                                      </div>
                                    )}
                                  </div>
                                </div>
                              )}
                              <div className={`message-bubble ${isMine ? 'mine' : 'theirs'}`}>
                                {hasPermission(`channel_${selectedChannel}` as ResourceType, 'write') && (
                                  <div className="message-actions">
                                    <button
                                      className="reply-button"
                                      onClick={() => {
                                        setReplyingTo(msg);
                                        channelMessageInputRef.current?.focus();
                                      }}
                                      title="Reply to this message"
                                    >
                                      ↩
                                    </button>
                                    <button
                                      className="emoji-picker-button"
                                      onClick={() => setEmojiPickerMessage(msg)}
                                      title="React with emoji"
                                    >
                                      😄
                                    </button>
                                    <button
                                      className="delete-button"
                                      onClick={() => handleDeleteMessage(msg)}
                                      title="Delete this message"
                                    >
                                      🗑️
                                    </button>
                                  </div>
                                )}
                                <div className="message-text" style={{whiteSpace: 'pre-line'}}>
                                  {renderMessageWithLinks(msg.text)}
                                </div>
                                <LinkPreview text={msg.text} />
                                {reactions.length > 0 && (
                                  <div className="message-reactions">
                                    {reactions.map(reaction => (
                                      <span
                                        key={reaction.id}
                                        className="reaction"
                                        title={`From ${getNodeShortName(reaction.from)} - Click to send same reaction`}
                                        onClick={() => handleSendTapback(reaction.text, msg)}
                                      >
                                        {reaction.text}
                                      </span>
                                    ))}
                                  </div>
                                )}
                                <div className="message-meta">
                                  <span className="message-time">
                                    {formatMessageTime(currentDate, timeFormat, dateFormat)}
                                    <HopCountDisplay hopStart={msg.hopStart} hopLimit={msg.hopLimit} />
                                  </span>
                                </div>
                              </div>
                            </div>
                            {isMine && (
                              <div className="message-status">
                                {renderMessageStatus(msg)}
                              </div>
                            )}
                          </div>
                          </React.Fragment>
                        );
                      })
                    ) : (
                      <p className="no-messages">No messages in this channel yet</p>
                    );
                    })()}
                  </div>

                  {/* Send message form */}
                  {connectionStatus === 'connected' && (
                    <div className="send-message-form">
                      {replyingTo && (
                        <div className="reply-indicator">
                          <div className="reply-indicator-content">
                            <div className="reply-indicator-label">Replying to {getNodeName(replyingTo.from)}</div>
                            <div className="reply-indicator-text">{replyingTo.text}</div>
                          </div>
                          <button
                            className="reply-indicator-close"
                            onClick={() => setReplyingTo(null)}
                            title="Cancel reply"
                          >
                            ×
                          </button>
                        </div>
                      )}
                      {hasPermission(`channel_${selectedChannel}` as ResourceType, 'write') && (
                        <div className="message-input-container">
                          <div className="input-with-counter">
                            <input
                              ref={channelMessageInputRef}
                              type="text"
                              value={newMessage}
                              onChange={(e) => setNewMessage(e.target.value)}
                              placeholder={`Send message to ${getChannelName(selectedChannel)}...`}
                              className="message-input"
                              onKeyPress={(e) => {
                                if (e.key === 'Enter') {
                                  handleSendMessage(selectedChannel);
                                }
                              }}
                            />
                            <div className={formatByteCount(getUtf8ByteLength(newMessage)).className}>
                              {formatByteCount(getUtf8ByteLength(newMessage)).text}
                            </div>
                          </div>
                          <button
                            onClick={() => handleSendMessage(selectedChannel)}
                            disabled={!newMessage.trim()}
                            className="send-btn"
                          >
                            →
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}

            {selectedChannel === -1 && (
              <p className="no-data">Select a channel above to view messages and send messages</p>
            )}
          </>
        ) : (
          <p className="no-data">No channel configurations discovered yet. Waiting for mesh updates...</p>
        )
      ) : (
        <p className="no-data">Connect to a Meshtastic node to view channel configurations</p>
      )}

      {/* Channel Info Modal */}
      {channelInfoModal !== null && selectedChannelConfig && (() => {
        const displayName = selectedChannelConfig.name || getChannelName(channelInfoModal);
        const handleCloseModal = () => {
          setChannelInfoModal(null);
          setShowPsk(false);
        };

        return (
          <div className="modal-overlay" onClick={handleCloseModal}>
            <div className="modal-content channel-info-modal" onClick={(e) => e.stopPropagation()}>
              <div className="modal-header">
                <h2>Channel Information</h2>
                <button className="modal-close" onClick={handleCloseModal}>×</button>
              </div>
              <div className="modal-body">
                <div className="channel-info-grid">
                  <div className="info-row">
                    <span className="info-label">Channel Name:</span>
                    <span className="info-value">{displayName}</span>
                  </div>
                  <div className="info-row">
                    <span className="info-label">Channel Number:</span>
                    <span className="info-value">#{channelInfoModal}</span>
                  </div>
                  <div className="info-row">
                    <span className="info-label">Encryption:</span>
                    <span className="info-value">
                      {selectedChannelConfig.psk && selectedChannelConfig.psk !== DEFAULT_UNENCRYPTED_PSK ? (
                        <span className="status-encrypted">🔒 Encrypted</span>
                      ) : (
                        <span className="status-unencrypted">🔓 Unencrypted</span>
                      )}
                    </span>
                  </div>
                  {selectedChannelConfig.psk && (
                    <div className="info-row">
                      <span className="info-label">PSK (Base64):</span>
                      <span className="info-value info-value-code" style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                        {showPsk ? selectedChannelConfig.psk : '••••••••'}
                        <button
                          onClick={() => setShowPsk(!showPsk)}
                          style={{
                            padding: '0.25rem 0.5rem',
                            fontSize: '0.75rem',
                            background: 'var(--ctp-surface1)',
                            border: '1px solid var(--ctp-surface2)',
                            borderRadius: '4px',
                            color: 'var(--ctp-text)',
                            cursor: 'pointer',
                            transition: 'all 0.2s'
                          }}
                          onMouseOver={(e) => e.currentTarget.style.background = 'var(--ctp-surface2)'}
                          onMouseOut={(e) => e.currentTarget.style.background = 'var(--ctp-surface1)'}
                        >
                          {showPsk ? 'Hide' : 'Show'}
                        </button>
                      </span>
                    </div>
                  )}
                  <div className="info-row">
                    <span className="info-label">MQTT Uplink:</span>
                    <span className="info-value">
                      {selectedChannelConfig.uplinkEnabled ? (
                        <span className="status-enabled">✓ Enabled</span>
                      ) : (
                        <span className="status-disabled">✗ Disabled</span>
                      )}
                    </span>
                  </div>
                  <div className="info-row">
                    <span className="info-label">MQTT Downlink:</span>
                    <span className="info-value">
                      {selectedChannelConfig.downlinkEnabled ? (
                        <span className="status-enabled">✓ Enabled</span>
                      ) : (
                        <span className="status-disabled">✗ Disabled</span>
                      )}
                    </span>
                  </div>
                  {selectedChannelConfig.createdAt && (
                    <div className="info-row">
                      <span className="info-label">Discovered:</span>
                      <span className="info-value">{new Date(selectedChannelConfig.createdAt).toLocaleString()}</span>
                    </div>
                  )}
                  {selectedChannelConfig.updatedAt && (
                    <div className="info-row">
                      <span className="info-label">Last Updated:</span>
                      <span className="info-value">{new Date(selectedChannelConfig.updatedAt).toLocaleString()}</span>
                    </div>
                  )}
                </div>
                {hasPermission(`channel_${channelInfoModal}` as ResourceType, 'write') && channelInfoModal !== -1 && (
                  <div style={{
                    marginTop: '1.5rem',
                    paddingTop: '1rem',
                    borderTop: '1px solid var(--ctp-surface2)'
                  }}>
                    <button
                      onClick={() => {
                        handleCloseModal();
                        handlePurgeChannelMessages(channelInfoModal);
                      }}
                      style={{
                        width: '100%',
                        padding: '0.75rem',
                        backgroundColor: '#dc3545',
                        color: 'white',
                        border: 'none',
                        borderRadius: '4px',
                        cursor: 'pointer',
                        fontWeight: 'bold',
                        fontSize: '0.95rem'
                      }}
                      title="Purge all messages from this channel"
                    >
                      Purge All Messages
                    </button>
                    <p style={{
                      marginTop: '0.5rem',
                      fontSize: '0.85rem',
                      color: 'var(--ctp-subtext0)',
                      textAlign: 'center'
                    }}>
                      This action cannot be undone
                    </p>
                  </div>
                )}
              </div>
            </div>
          </div>
        );
      })()}
    </div>
    );
  };

  const renderMessagesTab = () => {
    // Use processedNodes which already has sorting applied from the Map page logic
    const nodesWithMessages = processedNodes
      .filter(node => node.user?.id !== currentNodeId) // Exclude local node
      .map(node => {
        const nodeId = node.user?.id;
        if (!nodeId) return {
          ...node,
          messageCount: 0,
          unreadCount: 0,
          lastMessageTime: 0,
          lastMessageText: ''
        };

        const dmMessages = getDMMessages(nodeId);
        // Get unread count from database-backed tracking instead of counting all messages
        const unreadCount = unreadCountsData?.directMessages?.[nodeId] || 0;

        // Get last message text (most recent message)
        const lastMessage = dmMessages.length > 0
          ? dmMessages.reduce((latest, msg) =>
              msg.timestamp.getTime() > latest.timestamp.getTime() ? msg : latest
            )
          : null;

        const lastMessageText = lastMessage
          ? (lastMessage.text || '').substring(0, 50) + (lastMessage.text && lastMessage.text.length > 50 ? '...' : '')
          : '';

        return {
          ...node,
          messageCount: dmMessages.length,
          unreadCount: unreadCount,
          lastMessageTime: dmMessages.length > 0 ? Math.max(...dmMessages.map(m => m.timestamp.getTime())) : 0,
          lastMessageText
        };
      });

    // Sort by most recent message first (feature request #490)
    const sortedNodesWithMessages = [...nodesWithMessages].sort((a, b) => {
      // Favorites first
      if (a.isFavorite && !b.isFavorite) return -1;
      if (!a.isFavorite && b.isFavorite) return 1;

      // Then by last message time (most recent first)
      return b.lastMessageTime - a.lastMessageTime;
    })

    // Apply DM filter
    .filter(node => {
      if (dmFilter === 'unread') {
        return node.unreadCount > 0;
      } else if (dmFilter === 'recent') {
        // Show only nodes with messages in last 24 hours
        const oneDayAgo = Date.now() - (24 * 60 * 60 * 1000);
        return node.lastMessageTime > oneDayAgo;
      }
      return true; // 'all' filter
    });

    return (
      <div className="nodes-split-view messages-split-view">
        {/* Left Sidebar - Node List with Messages */}
        <div className={`nodes-sidebar messages-sidebar ${isMessagesNodeListCollapsed ? 'collapsed' : ''}`}>
          <div className="sidebar-header">
            <button
              className="collapse-nodes-btn"
              onClick={() => setIsMessagesNodeListCollapsed(!isMessagesNodeListCollapsed)}
              title={isMessagesNodeListCollapsed ? 'Expand node list' : 'Collapse node list'}
            >
              {isMessagesNodeListCollapsed ? '▶' : '◀'}
            </button>
            {!isMessagesNodeListCollapsed && (
            <div className="sidebar-header-content">
              <h3>Nodes</h3>
            </div>
            )}
            {!isMessagesNodeListCollapsed && (
            <div className="node-controls">
              <input
                type="text"
                placeholder="Filter nodes..."
                value={nodeFilter}
                onChange={(e) => setNodeFilter(e.target.value)}
                className="filter-input-small"
              />
              <div className="sort-controls">
                <select
                  value={dmFilter}
                  onChange={(e) => setDmFilter(e.target.value as 'all' | 'unread' | 'recent')}
                  className="sort-dropdown"
                  title="Filter conversations"
                >
                  <option value="all">All Conversations</option>
                  <option value="unread">Unread Only</option>
                  <option value="recent">Recent (24h)</option>
                </select>
              </div>
            </div>
            )}
          </div>

          <NodeFilterPopup
            isOpen={showNodeFilterPopup}
            onClose={() => setShowNodeFilterPopup(false)}
          />

          {!isMessagesNodeListCollapsed && (
          <div className="nodes-list">
            {shouldShowData() ? (
              processedNodes.length > 0 ? (
                <>
                  {sortedNodesWithMessages
                    .filter(node => {
                      // Apply security filter
                      if (securityFilter === 'flaggedOnly') {
                        if (!node.keyIsLowEntropy && !node.duplicateKeyDetected) return false;
                      } else if (securityFilter === 'hideFlagged') {
                        if (node.keyIsLowEntropy || node.duplicateKeyDetected) return false;
                      }
                      // Apply channel filter
                      if (channelFilter !== 'all') {
                        const nodeChannel = node.channel ?? 0;
                        if (nodeChannel !== channelFilter) return false;
                      }
                      // Apply text filter
                      if (!nodeFilter) return true;
                      const searchTerm = nodeFilter.toLowerCase();
                      return (
                        node.user?.longName?.toLowerCase().includes(searchTerm) ||
                        node.user?.shortName?.toLowerCase().includes(searchTerm) ||
                        node.user?.id?.toLowerCase().includes(searchTerm)
                      );
                    })
                    .map(node => (
                      <div
                        key={node.nodeNum}
                        className={`node-item ${selectedDMNode === node.user?.id ? 'selected' : ''}`}
                        onClick={() => {
                          setSelectedDMNode(node.user?.id || '');
                          setReplyingTo(null); // Clear reply state when switching DM nodes
                        }}
                      >
                        <div className="node-header">
                          <div className="node-name">
                            {node.isFavorite && <span className="favorite-indicator">⭐</span>}
                            <span className="node-name-text">
                              {node.user?.longName || `Node ${node.nodeNum}`}
                            </span>
                          </div>
                          <div className="node-actions">
                            {(node.keyIsLowEntropy || node.duplicateKeyDetected) && (
                              <span
                                className="security-warning-icon"
                                title={node.keySecurityIssueDetails || 'Key security issue detected'}
                                style={{
                                  fontSize: '16px',
                                  color: '#f44336',
                                  marginLeft: '4px',
                                  cursor: 'help'
                                }}
                              >
                                ⚠️
                              </span>
                            )}
                            <div className="node-short">
                              {node.user?.shortName || '-'}
                            </div>
                          </div>
                        </div>

                        <div className="node-details" style={{ width: '100%' }}>
                          <div style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                            gap: '0.5rem',
                            width: '100%'
                          }}>
                            {/* Left: Message preview */}
                            <div className="last-message-preview" style={{
                              fontSize: '0.85rem',
                              color: 'var(--ctp-subtext0)',
                              fontStyle: 'italic',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                              flex: '1',
                              minWidth: 0
                            }}>
                              {node.lastMessageText || 'No messages'}
                            </div>

                            {/* Right: Message count and time */}
                            <div style={{
                              display: 'flex',
                              gap: '0.5rem',
                              alignItems: 'center',
                              flexShrink: 0,
                              fontSize: '0.85rem'
                            }}>
                              <span className="stat" title="Total Messages">
                                💬 {node.messageCount}
                              </span>
                              {node.lastMessageTime > 0 && (
                                <span
                                  className="stat"
                                  title={formatDateTime(new Date(node.lastMessageTime), timeFormat, dateFormat)}
                                  style={node.unreadCount > 0 ? {
                                    border: '2px solid var(--ctp-red)',
                                    borderRadius: '12px',
                                    padding: '2px 6px',
                                    backgroundColor: 'var(--ctp-surface0)'
                                  } : undefined}
                                >
                                  🕒 {formatRelativeTime(node.lastMessageTime)}
                                </span>
                              )}
                            </div>
                          </div>
                        </div>

                        <div className="node-indicators">
                          {node.position && node.position.latitude != null && node.position.longitude != null && (
                            <div className="node-location" title="Location">
                              📍 {node.position.latitude.toFixed(3)}, {node.position.longitude.toFixed(3)}
                              {node.isMobile && <span title="Mobile Node (position varies > 1km)" style={{ marginLeft: '4px' }}>🚶</span>}
                            </div>
                          )}
                          {node.user?.id && nodesWithTelemetry.has(node.user.id) && (
                            <div className="node-telemetry" title="Has Telemetry Data">
                              📊
                            </div>
                          )}
                          {node.user?.id && nodesWithWeatherTelemetry.has(node.user.id) && (
                            <div className="node-weather" title="Has Weather Data">
                              ☀️
                            </div>
                          )}
                          {node.user?.id && nodesWithPKC.has(node.user.id) && (
                            <div className="node-pkc" title="Has Public Key Cryptography">
                              🔐
                            </div>
                          )}
                        </div>
                      </div>
                    ))
                  }
                </>
              ) : (
                <div className="no-data">No nodes available</div>
              )
            ) : (
              <div className="no-data">Connect to a Meshtastic node to view messages</div>
            )}
          </div>
          )}
        </div>

        {/* Right Panel - Conversation View */}
        <div className="nodes-main-content">
          {/* Mobile Node Dropdown - Always visible on mobile */}
          <div className="node-dropdown-mobile">
            <select
              className="node-dropdown-select"
              value={selectedDMNode || ''}
              onChange={(e) => {
                const nodeId = e.target.value;
                logger.debug('👆 User selected node from dropdown:', nodeId);
                setSelectedDMNode(nodeId);
                setReplyingTo(null); // Clear reply state when switching DM nodes
              }}
            >
              <option value="">Select a conversation...</option>
              {sortedNodesWithMessages
                .filter(node => {
                  if (!nodeFilter) return true;
                  const searchTerm = nodeFilter.toLowerCase();
                  return (
                    node.user?.longName?.toLowerCase().includes(searchTerm) ||
                    node.user?.shortName?.toLowerCase().includes(searchTerm) ||
                    node.user?.id?.toLowerCase().includes(searchTerm)
                  );
                })
                .map(node => {
                  const displayName = node.user?.longName || `Node ${node.nodeNum}`;
                  const shortName = node.user?.shortName || '-';
                  const snr = node.snr != null ? ` ${node.snr.toFixed(1)}dB` : '';
                  const battery = node.deviceMetrics?.batteryLevel !== undefined && node.deviceMetrics.batteryLevel !== null
                    ? (node.deviceMetrics.batteryLevel === 101 ? ' 🔌' : ` ${node.deviceMetrics.batteryLevel}%`)
                    : '';
                  const unread = node.unreadCount > 0 ? ` (${node.unreadCount})` : '';

                  return (
                    <option key={node.user?.id || node.nodeNum} value={node.user?.id || ''}>
                      {node.isFavorite ? '⭐ ' : ''}{displayName} ({shortName}){snr}{battery}{unread}
                    </option>
                  );
                })}
            </select>
          </div>

          {selectedDMNode ? (
            <div className="dm-conversation-panel">
              <div className="dm-header">
                <div className="dm-header-top">
                  <h3>
                    Conversation with {getNodeName(selectedDMNode)}
                    {(() => {
                      const selectedNode = nodes.find(n => n.user?.id === selectedDMNode);
                      if (selectedNode?.lastHeard) {
                        return (
                          <div style={{ fontSize: '0.75em', fontWeight: 'normal', color: '#888', marginTop: '4px' }}>
                            Last seen: {formatDateTime(new Date(selectedNode.lastHeard * 1000), timeFormat, dateFormat)}
                          </div>
                        );
                      }
                      return null;
                    })()}
                  </h3>
                </div>
              </div>

              {/* Security Warning Bar */}
              {(() => {
                const selectedNode = nodes.find(n => n.user?.id === selectedDMNode);
                if (selectedNode && (selectedNode.keyIsLowEntropy || selectedNode.duplicateKeyDetected)) {
                  return (
                    <div style={{
                      backgroundColor: '#f44336',
                      color: 'white',
                      padding: '12px',
                      marginBottom: '10px',
                      borderRadius: '4px',
                      fontWeight: 'bold',
                      textAlign: 'center'
                    }}>
                      ⚠️ This node is a security risk
                    </div>
                  );
                }
                return null;
              })()}

              <div className="messages-container" ref={dmMessagesContainerRef}>
                {(() => {
                  let dmMessages = getDMMessages(selectedDMNode);

                  // Sort messages by timestamp (oldest first, newest at bottom)
                  dmMessages = dmMessages.sort((a, b) =>
                    new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
                  );

                  return dmMessages.length > 0 ? (
                    dmMessages.map((msg, index) => {
                      const isTraceroute = msg.portnum === 70;
                      const isMine = isMyMessage(msg);
                      const isReaction = msg.emoji === 1;

                      // Hide reactions (tapbacks) from main message list
                      if (isReaction) {
                        return null;
                      }

                      // Find ALL reactions to this message
                      const allDMMessages = getDMMessages(selectedDMNode);
                      const reactions = allDMMessages.filter(m =>
                        m.emoji === 1 && m.replyId && m.replyId.toString() === msg.id.split('_')[1]
                      );

                      // Find replied message if this is a reply
                      const repliedMessage = msg.replyId ? allDMMessages.find(m =>
                        m.id.split('_')[1] === msg.replyId?.toString()
                      ) : null;

                      // Check if we should show a date separator
                      const currentDate = new Date(msg.timestamp);
                      const prevMsg = index > 0 ? dmMessages[index - 1] : null;
                      const prevDate = prevMsg ? new Date(prevMsg.timestamp) : null;
                      const showSeparator = shouldShowDateSeparator(prevDate, currentDate);

                      if (isTraceroute) {
                        // Keep traceroute messages in simple format
                        return (
                          <React.Fragment key={msg.id}>
                            {showSeparator && (
                              <div className="date-separator">
                                <span className="date-separator-text">
                                  {getMessageDateSeparator(currentDate, dateFormat)}
                                </span>
                              </div>
                            )}
                            <div className="message-item traceroute">
                            <div className="message-header">
                              <span className="message-from">{getNodeName(msg.from)}</span>
                              <span className="message-time">
                                {formatMessageTime(currentDate, timeFormat, dateFormat)}
                                <HopCountDisplay hopStart={msg.hopStart} hopLimit={msg.hopLimit} />
                              </span>
                              <span className="traceroute-badge">TRACEROUTE</span>
                            </div>
                            <div className="message-text" style={{whiteSpace: 'pre-line', fontFamily: 'monospace'}}>{renderMessageWithLinks(msg.text)}</div>
                          </div>
                          </React.Fragment>
                        );
                      }

                      return (
                        <React.Fragment key={msg.id}>
                          {showSeparator && (
                            <div className="date-separator">
                              <span className="date-separator-text">
                                {getMessageDateSeparator(currentDate, dateFormat)}
                              </span>
                            </div>
                          )}
                          <div className={`message-bubble-container ${isMine ? 'mine' : 'theirs'}`}>
                          {!isMine && (
                            <div
                              className="sender-dot clickable"
                              title={`Click for ${getNodeName(msg.from)} details`}
                              onClick={(e) => handleSenderClick(msg.from, e)}
                            >
                              {getNodeShortName(msg.from)}
                            </div>
                          )}
                          <div className="message-content">
                            {msg.replyId && (
                              <div className="replied-message">
                                <div className="reply-arrow">↳</div>
                                <div className="reply-content">
                                  {repliedMessage ? (
                                    <>
                                      <div className="reply-from">{getNodeShortName(repliedMessage.from)}</div>
                                      <div className="reply-text">{repliedMessage.text || "Empty Message"}</div>
                                    </>
                                  ) : (
                                    <div className="reply-text" style={{ fontStyle: 'italic', opacity: 0.6 }}>
                                      Message not available
                                    </div>
                                  )}
                                </div>
                              </div>
                            )}
                            <div className={`message-bubble ${isMine ? 'mine' : 'theirs'}`}>
                              {hasPermission('messages', 'write') && (
                                <div className="message-actions">
                                  <button
                                    className="reply-button"
                                    onClick={() => {
                                      setReplyingTo(msg);
                                      dmMessageInputRef.current?.focus();
                                    }}
                                    title="Reply to this message"
                                  >
                                    ↩
                                  </button>
                                  <button
                                    className="emoji-picker-button"
                                    onClick={() => setEmojiPickerMessage(msg)}
                                    title="React with emoji"
                                  >
                                    😄
                                  </button>
                                  <button
                                    className="delete-button"
                                    onClick={() => handleDeleteMessage(msg)}
                                    title="Delete this message"
                                  >
                                    🗑️
                                  </button>
                                </div>
                              )}
                              <div className="message-text" style={{whiteSpace: 'pre-line'}}>
                                {renderMessageWithLinks(msg.text)}
                              </div>
                              <LinkPreview text={msg.text} />
                              {reactions.length > 0 && (
                                <div className="message-reactions">
                                  {reactions.map(reaction => (
                                    <span
                                      key={reaction.id}
                                      className="reaction"
                                      title={`From ${getNodeShortName(reaction.from)} - Click to send same reaction`}
                                      onClick={() => handleSendTapback(reaction.text, msg)}
                                    >
                                      {reaction.text}
                                    </span>
                                  ))}
                                </div>
                              )}
                              <div className="message-meta">
                                <span className="message-time">
                                  {formatMessageTime(currentDate, timeFormat, dateFormat)}
                                  <HopCountDisplay hopStart={msg.hopStart} hopLimit={msg.hopLimit} />
                                </span>
                              </div>
                            </div>
                          </div>
                          {isMine && (
                            <div className="message-status">
                              {renderMessageStatus(msg)}
                            </div>
                          )}
                        </div>
                        </React.Fragment>
                      );
                    })
                  ) : (
                    <p className="no-messages">No direct messages with this node yet</p>
                  );
                })()}
              </div>

              {/* Send DM form */}
              {connectionStatus === 'connected' && (
                <div className="send-message-form">
                  {replyingTo && (
                    <div className="reply-indicator">
                      <div className="reply-indicator-content">
                        <div className="reply-indicator-label">Replying to {getNodeName(replyingTo.from)}</div>
                        <div className="reply-indicator-text">{replyingTo.text}</div>
                      </div>
                      <button
                        className="reply-indicator-close"
                        onClick={() => setReplyingTo(null)}
                        title="Cancel reply"
                      >
                        ×
                      </button>
                    </div>
                  )}
                  {hasPermission('messages', 'write') && (
                    <div className="message-input-container">
                      <div className="input-with-counter">
                        <input
                          ref={dmMessageInputRef}
                          type="text"
                          value={newMessage}
                          onChange={(e) => setNewMessage(e.target.value)}
                          placeholder={`Send direct message to ${getNodeName(selectedDMNode)}...`}
                          className="message-input"
                          onKeyPress={(e) => {
                            if (e.key === 'Enter') {
                              handleSendDirectMessage(selectedDMNode);
                            }
                          }}
                        />
                        <div className={formatByteCount(getUtf8ByteLength(newMessage)).className}>
                          {formatByteCount(getUtf8ByteLength(newMessage)).text}
                        </div>
                      </div>
                      <button
                        onClick={() => handleSendDirectMessage(selectedDMNode)}
                        disabled={!newMessage.trim()}
                        className="send-btn"
                      >
                        →
                      </button>
                    </div>
                  )}
                </div>
              )}

              {/* Traceroute and Purge Section */}
              <div style={{ marginTop: '1rem' }}>
                {/* Buttons Row */}
                <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                  {hasPermission('traceroute', 'write') && (
                    <>
                      <button
                        onClick={() => handleTraceroute(selectedDMNode)}
                        disabled={connectionStatus !== 'connected' || tracerouteLoading === selectedDMNode}
                        className="traceroute-btn"
                        title="Run traceroute to this node"
                      >
                        🗺️ Traceroute
                        {tracerouteLoading === selectedDMNode && (
                          <span className="spinner"></span>
                        )}
                      </button>
                      <button
                        onClick={() => setShowTracerouteHistoryModal(true)}
                        className="traceroute-btn"
                        title="View traceroute history for this node"
                      >
                        📜 Show History
                      </button>
                    </>
                  )}
                  {hasPermission('messages', 'write') && (
                    <button
                      onClick={() => handleExchangePosition(selectedDMNode)}
                      disabled={connectionStatus !== 'connected' || positionLoading === selectedDMNode}
                      className="traceroute-btn"
                      title="Request position exchange with this node"
                    >
                      📍 Exchange Position
                      {positionLoading === selectedDMNode && (
                        <span className="spinner"></span>
                      )}
                    </button>
                  )}
                  {hasPermission('messages', 'write') && selectedDMNode !== null && (
                    <button
                      onClick={() => setShowPurgeDataModal(true)}
                      className="danger-btn"
                      style={{
                        backgroundColor: '#dc3545',
                        color: 'white',
                        border: 'none',
                        padding: '0.5rem 1rem',
                        borderRadius: '4px',
                        cursor: 'pointer',
                        fontWeight: 'bold'
                      }}
                    >
                      🗑️ Purge Data
                    </button>
                  )}
                </div>

                {/* Traceroute Display */}
                {hasPermission('traceroute', 'write') && (() => {
                  const recentTrace = getRecentTraceroute(selectedDMNode);
                  if (recentTrace) {
                    const age = Math.floor((Date.now() - recentTrace.timestamp) / (1000 * 60));
                    const ageStr = age < 60 ? `${age}m ago` : `${Math.floor(age / 60)}h ago`;

                    return (
                      <div className="traceroute-info" style={{ marginTop: '1rem' }}>
                        <div className="traceroute-route">
                          <strong>→ Forward:</strong> {formatTracerouteRoute(recentTrace.route, recentTrace.snrTowards, recentTrace.fromNodeNum, recentTrace.toNodeNum, nodes, distanceUnit)}
                        </div>
                        <div className="traceroute-route">
                          <strong>← Return:</strong> {formatTracerouteRoute(recentTrace.routeBack, recentTrace.snrBack, recentTrace.toNodeNum, recentTrace.fromNodeNum, nodes, distanceUnit)}
                        </div>
                        <div className="traceroute-age">Last traced {ageStr}</div>
                      </div>
                    );
                  }
                  return null;
                })()}
              </div>

              {(() => {
                const selectedNode = nodes.find(n => n.user?.id === selectedDMNode);
                return selectedNode ? (
                  <NodeDetailsBlock
                    node={selectedNode}
                    timeFormat={timeFormat}
                    dateFormat={dateFormat}
                  />
                ) : null;
              })()}

              {/* Security Details Section */}
              {(() => {
                const selectedNode = nodes.find(n => n.user?.id === selectedDMNode);
                if (selectedNode && (selectedNode.keyIsLowEntropy || selectedNode.duplicateKeyDetected) && selectedNode.keySecurityIssueDetails) {
                  // Parse node IDs from the details string (format: "Key shared with nodes: 1234, 5678")
                  const match = selectedNode.keySecurityIssueDetails.match(/nodes?: ([\d, ]+)/);
                  const sharedNodeNums = match ? match[1].split(',').map(s => parseInt(s.trim(), 10)) : [];

                  return (
                    <div className="node-details-block" style={{ marginTop: '1rem' }}>
                      <h3 className="node-details-title" style={{ color: '#f44336' }}>⚠️ Security Issue</h3>
                      <div className="node-details-grid">
                        <div className="node-detail-card" style={{ gridColumn: '1 / -1', borderLeft: '4px solid #f44336' }}>
                          <div className="node-detail-label">Issue Details</div>
                          <div className="node-detail-value" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                            {selectedNode.keyIsLowEntropy && 'This node uses a known low-entropy cryptographic key. '}
                            {selectedNode.duplicateKeyDetected && sharedNodeNums.length > 0 && (
                              <>
                                This key is shared with: {sharedNodeNums.map((nodeNum, idx) => {
                                  const sharedNode = nodes.find(n => n.nodeNum === nodeNum);
                                  const displayName = sharedNode?.user?.longName || `Node ${nodeNum}`;
                                  const shortName = sharedNode?.user?.shortName || '?';
                                  return (
                                    <span key={nodeNum}>
                                      {idx > 0 && ', '}
                                      <button
                                        onClick={() => {
                                          if (sharedNode?.user?.id) {
                                            setSelectedDMNode(sharedNode.user.id);
                                          }
                                        }}
                                        style={{
                                          background: 'none',
                                          border: 'none',
                                          color: '#6698f5',
                                          textDecoration: 'underline',
                                          cursor: 'pointer',
                                          padding: 0,
                                          font: 'inherit'
                                        }}
                                        title={`Switch to ${displayName}`}
                                      >
                                        {displayName} ({shortName})
                                      </button>
                                    </span>
                                  );
                                })}
                              </>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                }
                return null;
              })()}

              <TelemetryGraphs nodeId={selectedDMNode} temperatureUnit={temperatureUnit} telemetryHours={telemetryVisualizationHours} baseUrl={baseUrl} />
            </div>
          ) : (
            <div className="no-selection">
              <p>Select a conversation from the list to view messages</p>
            </div>
          )}
        </div>
      </div>
    );
  };

  // Removed renderInfoTab - using InfoTab component instead
  // Handler functions removed - using settings context setters directly

  // Purge handlers moved to SettingsTab component

  // Removed renderSettingsTab - using SettingsTab component instead

  // Create stable digests of nodes and traceroutes that only change when relevant data changes
  // This prevents unnecessary recalculation of traceroutePathsElements
  const nodesPositionDigest = useMemo(() => {
    return nodes.map(n => ({
      nodeNum: n.nodeNum,
      position: n.position ? {
        latitude: n.position.latitude,
        longitude: n.position.longitude
      } : undefined,
      user: n.user ? {
        longName: n.user.longName,
        shortName: n.user.shortName,
        id: n.user.id
      } : undefined
    }));
  }, [nodes.map(n => `${n.nodeNum}-${n.position?.latitude}-${n.position?.longitude}`).join(',')]);

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
      createdAt: tr.createdAt
    }));
  }, [traceroutes.map(tr => `${tr.fromNodeNum}-${tr.toNodeNum}-${tr.route}-${tr.routeBack}-${tr.timestamp || tr.createdAt}`).join(',')]);

  // Memoize base traceroute paths (showPaths) - doesn't depend on selectedNodeId
  // This prevents re-rendering markers when clicking to select a node
  const traceroutePathsElements = useMemo(() => {
    if (!showPaths) return null;

    // Use digest arrays for stable references
    const nodesForRender = nodesPositionDigest;
    const traceroutesForRender = traceroutesDigest;

    // Collect all map elements to return
    const allElements: React.ReactElement[] = [];

    // Calculate segment usage counts and collect SNR values with timestamps (only if showPaths is enabled)
    const segmentUsage = new Map<string, number>();
    const segmentSNRs = new Map<string, Array<{snr: number; timestamp: number}>>();
    const segmentsList: Array<{
      key: string;
      positions: [number, number][];
      nodeNums: number[];
    }> = [];

    if (showPaths) {
      // Filter traceroutes by age using the same maxNodeAgeHours setting
      const cutoffTime = Date.now() - (maxNodeAgeHours * 60 * 60 * 1000);
      const recentTraceroutes = traceroutesForRender.filter(tr => {
        const timestamp = tr.timestamp || tr.createdAt || 0;
        return timestamp >= cutoffTime;
      });

      // Deduplicate: keep only the most recent traceroute per node pair
      const tracerouteMap = new Map<string, typeof traceroutesForRender[0]>();
      recentTraceroutes.forEach(tr => {
        // Create a bidirectional key (same for A→B and B→A)
        const key = [tr.fromNodeNum, tr.toNodeNum].sort().join('-');
        const existing = tracerouteMap.get(key);
        const timestamp = tr.timestamp || tr.createdAt || 0;
        const existingTimestamp = existing?.timestamp || existing?.createdAt || 0;

        // Keep the most recent traceroute for this node pair
        if (!existing || timestamp > existingTimestamp) {
          tracerouteMap.set(key, tr);
        }
      });

      // Convert back to array for processing
      const deduplicatedTraceroutes = Array.from(tracerouteMap.values());

      deduplicatedTraceroutes.forEach((tr, idx) => {
      try {
        // Skip traceroutes with null or invalid route data (failed traceroutes)
        if (!tr.route || tr.route === 'null' || tr.route === '' ||
            !tr.routeBack || tr.routeBack === 'null' || tr.routeBack === '') {
          return; // Skip this traceroute - no valid route data to display
        }

        // Process forward path
        const routeForward = JSON.parse(tr.route);
        const routeBack = JSON.parse(tr.routeBack);

        // Note: Empty arrays are valid (direct path with no intermediate hops)
        // Actual failures are caught by the null/invalid check above or by insufficient positions below

        const snrForward = tr.snrTowards && tr.snrTowards !== 'null' && tr.snrTowards !== ''
          ? JSON.parse(tr.snrTowards)
          : [];
        const timestamp = tr.timestamp || tr.createdAt || Date.now();
        // Build forward path: responder -> route -> requester (fromNodeNum -> toNodeNum)
        const forwardSequence: number[] = [tr.fromNodeNum, ...routeForward, tr.toNodeNum];
        const forwardPositions: Array<{nodeNum: number; pos: [number, number]}> = [];

        // Build forward sequence with positions
        forwardSequence.forEach((nodeNum) => {
          const node = nodesForRender.find(n => n.nodeNum === nodeNum);
          if (node?.position?.latitude && node?.position?.longitude) {
            forwardPositions.push({
              nodeNum,
              pos: [node.position.latitude, node.position.longitude]
            });
          }
        });

        // Create forward segments and count usage
        for (let i = 0; i < forwardPositions.length - 1; i++) {
          const from = forwardPositions[i];
          const to = forwardPositions[i + 1];
          const segmentKey = [from.nodeNum, to.nodeNum].sort().join('-');

          segmentUsage.set(segmentKey, (segmentUsage.get(segmentKey) || 0) + 1);

          // Collect SNR value with timestamp for this segment
          // SNR array is in order of path: snrForward[i] is for the i-th link
          if (snrForward[i] !== undefined) {
            const snrValue = snrForward[i] / 4; // Scale SNR value
            if (!segmentSNRs.has(segmentKey)) {
              segmentSNRs.set(segmentKey, []);
            }
            segmentSNRs.get(segmentKey)!.push({snr: snrValue, timestamp});
          }

          segmentsList.push({
            key: `tr-${idx}-fwd-seg-${i}`,
            positions: [from.pos, to.pos],
            nodeNums: [from.nodeNum, to.nodeNum]
          });
        }

        // Process return path (already parsed above for validation)
        const snrBack = tr.snrBack && tr.snrBack !== 'null' && tr.snrBack !== ''
          ? JSON.parse(tr.snrBack)
          : [];
        // Build return path: requester -> routeBack -> responder (toNodeNum -> fromNodeNum)
        const backSequence: number[] = [tr.toNodeNum, ...routeBack, tr.fromNodeNum];
        const backPositions: Array<{nodeNum: number; pos: [number, number]}> = [];

        // Build back sequence with positions
        backSequence.forEach((nodeNum) => {
          const node = nodesForRender.find(n => n.nodeNum === nodeNum);
          if (node?.position?.latitude && node?.position?.longitude) {
            backPositions.push({
              nodeNum,
              pos: [node.position.latitude, node.position.longitude]
            });
          }
        });

        // Create back segments and count usage
        for (let i = 0; i < backPositions.length - 1; i++) {
          const from = backPositions[i];
          const to = backPositions[i + 1];
          const segmentKey = [from.nodeNum, to.nodeNum].sort().join('-');

          segmentUsage.set(segmentKey, (segmentUsage.get(segmentKey) || 0) + 1);

          // Collect SNR value with timestamp for this segment
          if (snrBack[i] !== undefined) {
            const snrValue = snrBack[i] / 4; // Scale SNR value
            if (!segmentSNRs.has(segmentKey)) {
              segmentSNRs.set(segmentKey, []);
            }
            segmentSNRs.get(segmentKey)!.push({snr: snrValue, timestamp});
          }

          segmentsList.push({
            key: `tr-${idx}-back-seg-${i}`,
            positions: [from.pos, to.pos],
            nodeNums: [from.nodeNum, to.nodeNum]
          });
        }
      } catch (error) {
        logger.error('Error parsing traceroute:', error);
      }
    });

      // Render segments with weighted lines
      const segmentElements = segmentsList.map((segment) => {
      const segmentKey = segment.nodeNums.sort().join('-');
      const usage = segmentUsage.get(segmentKey) || 1;
      // Base weight 2, add 1 per usage, max 8
      const weight = Math.min(2 + usage, 8);

      // Get node names for popup
      const BROADCAST_ADDR = 4294967295;
      const node1 = nodesForRender.find(n => n.nodeNum === segment.nodeNums[0]);
      const node2 = nodesForRender.find(n => n.nodeNum === segment.nodeNums[1]);
      const node1Name = segment.nodeNums[0] === BROADCAST_ADDR ? '(unknown)' :
                        (node1?.user?.longName || node1?.user?.shortName || `!${segment.nodeNums[0].toString(16)}`);
      const node2Name = segment.nodeNums[1] === BROADCAST_ADDR ? '(unknown)' :
                        (node2?.user?.longName || node2?.user?.shortName || `!${segment.nodeNums[1].toString(16)}`);

      // Calculate distance if both nodes have position data
      let segmentDistanceKm = 0;
      if (node1?.position?.latitude && node1?.position?.longitude &&
          node2?.position?.latitude && node2?.position?.longitude) {
        segmentDistanceKm = calculateDistance(
          node1.position.latitude, node1.position.longitude,
          node2.position.latitude, node2.position.longitude
        );
      }

      // Calculate SNR statistics
      const snrData = segmentSNRs.get(segmentKey) || [];
      let snrStats = null;
      let chartData = null;
      if (snrData.length > 0) {
        const snrValues = snrData.map(d => d.snr);
        const minSNR = Math.min(...snrValues);
        const maxSNR = Math.max(...snrValues);
        const avgSNR = snrValues.reduce((sum, val) => sum + val, 0) / snrValues.length;
        snrStats = {
          min: minSNR.toFixed(1),
          max: maxSNR.toFixed(1),
          avg: avgSNR.toFixed(1),
          count: snrData.length
        };

        // Prepare chart data for 3+ samples (sorted by time of day)
        if (snrData.length >= 3) {
          chartData = snrData.map(d => {
            const date = new Date(d.timestamp);
            const hours = date.getHours();
            const minutes = date.getMinutes();
            // Convert to decimal hours (0-24) for continuous time axis
            const timeDecimal = hours + (minutes / 60);
            return {
              timeDecimal,
              timeLabel: `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`,
              snr: parseFloat(d.snr.toFixed(1)),
              fullTimestamp: d.timestamp
            };
          }).sort((a, b) => a.timeDecimal - b.timeDecimal);
        }
      }

      return (
        <Polyline
          key={segment.key}
          positions={segment.positions}
          color={themeColors.mauve}
          weight={weight}
          opacity={0.7}
        >
          <Popup>
            <div className="route-popup">
              <h4>Route Segment</h4>
              <div className="route-endpoints">
                <strong
                  onClick={(e) => {
                    e.stopPropagation();
                    // Look up fresh node data by nodeNum from segment
                    const freshNode = nodesForRender.find(n => n.nodeNum === segment.nodeNums[0]);
                    if (freshNode?.user?.id && freshNode?.position?.latitude && freshNode?.position?.longitude) {
                      setSelectedNodeId(freshNode.user.id);
                      setMapCenterTarget([freshNode.position.latitude, freshNode.position.longitude]);
                    }
                  }}
                  style={{ cursor: node1?.user?.id ? 'pointer' : 'default', color: node1?.user?.id ? 'var(--ctp-blue)' : 'inherit' }}
                  title={node1?.user?.id ? 'Click to select and center on this node' : ''}
                >
                  {node1Name}
                </strong>
                {' ↔ '}
                <strong
                  onClick={(e) => {
                    e.stopPropagation();
                    // Look up fresh node data by nodeNum from segment
                    const freshNode = nodesForRender.find(n => n.nodeNum === segment.nodeNums[1]);
                    if (freshNode?.user?.id && freshNode?.position?.latitude && freshNode?.position?.longitude) {
                      setSelectedNodeId(freshNode.user.id);
                      setMapCenterTarget([freshNode.position.latitude, freshNode.position.longitude]);
                    }
                  }}
                  style={{ cursor: node2?.user?.id ? 'pointer' : 'default', color: node2?.user?.id ? 'var(--ctp-blue)' : 'inherit' }}
                  title={node2?.user?.id ? 'Click to select and center on this node' : ''}
                >
                  {node2Name}
                </strong>
              </div>
              <div className="route-usage">
                Used in{' '}
                <strong
                  onClick={(e) => {
                    e.stopPropagation();
                    setSelectedRouteSegment({ nodeNum1: segment.nodeNums[0], nodeNum2: segment.nodeNums[1] });
                  }}
                  style={{ cursor: 'pointer', color: 'var(--ctp-blue)', textDecoration: 'underline' }}
                  title="Click to view all traceroutes using this segment"
                >
                  {usage}
                </strong>
                {' '}traceroute{usage !== 1 ? 's' : ''}
              </div>
              {segmentDistanceKm > 0 && (
                <div className="route-usage">
                  Distance: <strong>{formatDistance(segmentDistanceKm, distanceUnit)}</strong>
                </div>
              )}
              {snrStats && (
                <div className="route-snr-stats">
                  {snrStats.count === 1 ? (
                    <>
                      <h5>SNR:</h5>
                      <div className="snr-stat-row">
                        <span className="stat-value">{snrStats.min} dB</span>
                      </div>
                    </>
                  ) : snrStats.count === 2 ? (
                    <>
                      <h5>SNR Statistics:</h5>
                      <div className="snr-stat-row">
                        <span className="stat-label">Min:</span>
                        <span className="stat-value">{snrStats.min} dB</span>
                      </div>
                      <div className="snr-stat-row">
                        <span className="stat-label">Max:</span>
                        <span className="stat-value">{snrStats.max} dB</span>
                      </div>
                      <div className="snr-stat-row">
                        <span className="stat-label">Samples:</span>
                        <span className="stat-value">{snrStats.count}</span>
                      </div>
                    </>
                  ) : (
                    <>
                      <h5>SNR Statistics:</h5>
                      <div className="snr-stat-row">
                        <span className="stat-label">Min:</span>
                        <span className="stat-value">{snrStats.min} dB</span>
                      </div>
                      <div className="snr-stat-row">
                        <span className="stat-label">Max:</span>
                        <span className="stat-value">{snrStats.max} dB</span>
                      </div>
                      <div className="snr-stat-row">
                        <span className="stat-label">Average:</span>
                        <span className="stat-value">{snrStats.avg} dB</span>
                      </div>
                      <div className="snr-stat-row">
                        <span className="stat-label">Samples:</span>
                        <span className="stat-value">{snrStats.count}</span>
                      </div>
                      {chartData && (
                        <div className="snr-timeline-chart">
                          <ResponsiveContainer width="100%" height={150}>
                            <LineChart data={chartData} margin={{ top: 10, right: 10, left: -20, bottom: 5 }}>
                              <CartesianGrid strokeDasharray="3 3" stroke="var(--ctp-surface2)" />
                              <XAxis
                                dataKey="timeDecimal"
                                type="number"
                                domain={[0, 24]}
                                ticks={[0, 6, 12, 18, 24]}
                                tickFormatter={(value) => {
                                  const hours = Math.floor(value);
                                  const minutes = Math.round((value - hours) * 60);
                                  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
                                }}
                                tick={{ fill: 'var(--ctp-subtext1)', fontSize: 10 }}
                                stroke="var(--ctp-surface2)"
                              />
                              <YAxis
                                tick={{ fill: 'var(--ctp-subtext1)', fontSize: 10 }}
                                stroke="var(--ctp-surface2)"
                                label={{ value: 'SNR (dB)', angle: -90, position: 'insideLeft', style: { fill: 'var(--ctp-subtext1)', fontSize: 10 } }}
                              />
                              <Tooltip
                                contentStyle={{
                                  backgroundColor: 'var(--ctp-surface0)',
                                  border: '1px solid var(--ctp-surface2)',
                                  borderRadius: '4px',
                                  fontSize: '12px'
                                }}
                                labelStyle={{ color: 'var(--ctp-text)' }}
                                labelFormatter={(value) => {
                                  const item = chartData.find(d => d.timeDecimal === value);
                                  return item ? item.timeLabel : value;
                                }}
                              />
                              <Line
                                type="monotone"
                                dataKey="snr"
                                stroke="var(--ctp-mauve)"
                                strokeWidth={2}
                                dot={{ fill: 'var(--ctp-mauve)', r: 3 }}
                              />
                            </LineChart>
                          </ResponsiveContainer>
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          </Popup>
        </Polyline>
      );
    });

      // Add route segments to elements
      allElements.push(...segmentElements);
    } // End of if (showPaths)

    return allElements;
  }, [showPaths, traceroutesDigest, nodesPositionDigest, distanceUnit, maxNodeAgeHours]);

  // Separate memoization for selected node traceroute (showRoute)
  // This can change independently without re-rendering the base map markers
  const selectedNodeTraceroute = useMemo(() => {
    // Skip rendering traceroute if the selected node is the current/local node (traceroute to yourself doesn't make sense)
    if (!showRoute || !selectedNodeId || selectedNodeId === currentNodeId) return null;

    // Use digest arrays for stable references
    const nodesForRender = nodesPositionDigest;
    const traceroutesForRender = traceroutesDigest;

    const allElements: React.ReactElement[] = [];

    if (showRoute && selectedNodeId && selectedNodeId !== currentNodeId) {
      const selectedTrace = traceroutesForRender.find(tr =>
        tr.toNodeId === selectedNodeId || tr.fromNodeId === selectedNodeId
      );

      if (selectedTrace) {
        // Skip if the traceroute has null or invalid route data (failed traceroute)
        if (!selectedTrace.route || selectedTrace.route === 'null' || selectedTrace.route === '' ||
            !selectedTrace.routeBack || selectedTrace.routeBack === 'null' || selectedTrace.routeBack === '') {
          // Don't render anything for failed traceroutes
        } else {
        try {
          // Route arrays are stored exactly as Meshtastic provides them (no backend reversal)
          // fromNodeNum = responder (remote), toNodeNum = requester (local)
          // route = intermediate hops from requester toward responder
          // routeBack = intermediate hops from responder toward requester
          const routeForward = JSON.parse(selectedTrace.route);  // Forward: local -> remote
          const routeBack = JSON.parse(selectedTrace.routeBack);  // Return: remote -> local

          // Note: Empty arrays are valid (direct path with no intermediate hops)
          // Actual failures are caught by the null/invalid check above or by insufficient positions below

          const fromNode = nodesForRender.find(n => n.nodeNum === selectedTrace.fromNodeNum);
          const toNode = nodesForRender.find(n => n.nodeNum === selectedTrace.toNodeNum);
          const fromName = fromNode?.user?.longName || fromNode?.user?.shortName || selectedTrace.fromNodeId;
          const toName = toNode?.user?.longName || toNode?.user?.shortName || selectedTrace.toNodeId;

          // Forward path: responder -> requester (for correct visualization)
          if (routeForward.length >= 0) {
              // Build path: fromNodeNum (responder) → route intermediates → toNodeNum (requester)
              const forwardSequence: number[] = [selectedTrace.fromNodeNum, ...routeForward, selectedTrace.toNodeNum];
              const forwardPositions: [number, number][] = [];

              forwardSequence.forEach((nodeNum) => {
                const node = nodesForRender.find(n => n.nodeNum === nodeNum);
                if (node?.position?.latitude && node?.position?.longitude) {
                  forwardPositions.push([node.position.latitude, node.position.longitude]);
                }
              });

              if (forwardPositions.length >= 2) {
                // Calculate total distance for forward path
                let forwardTotalDistanceKm = 0;
                for (let i = 0; i < forwardSequence.length - 1; i++) {
                  const node1 = nodesForRender.find(n => n.nodeNum === forwardSequence[i]);
                  const node2 = nodesForRender.find(n => n.nodeNum === forwardSequence[i + 1]);
                  if (node1?.position?.latitude && node1?.position?.longitude &&
                      node2?.position?.latitude && node2?.position?.longitude) {
                    forwardTotalDistanceKm += calculateDistance(
                      node1.position.latitude, node1.position.longitude,
                      node2.position.latitude, node2.position.longitude
                    );
                  }
                }

                allElements.push(
                  <Polyline
                    key="selected-traceroute-forward"
                    positions={forwardPositions}
                    color={themeColors.red}
                    weight={4}
                    opacity={0.9}
                    dashArray="10, 5"
                  >
                    <Popup>
                      <div className="route-popup">
                        <h4>Forward Path</h4>
                        <div className="route-endpoints">
                          <strong>{fromName}</strong> → <strong>{toName}</strong>
                        </div>
                        <div className="route-usage">
                          Path: {forwardSequence.map(num => {
                            const n = nodesForRender.find(nd => nd.nodeNum === num);
                            return n?.user?.longName || n?.user?.shortName || `!${num.toString(16)}`;
                          }).join(' → ')}
                        </div>
                        {forwardTotalDistanceKm > 0 && (
                          <div className="route-usage">
                            Distance: <strong>{formatDistance(forwardTotalDistanceKm, distanceUnit)}</strong>
                          </div>
                        )}
                      </div>
                    </Popup>
                  </Polyline>
                );

                // Generate arrow markers for forward path
                const forwardArrows = generateArrowMarkers(
                  forwardPositions,
                  'forward',
                  themeColors.red,
                  allElements.length
                );
                allElements.push(...forwardArrows);
              }
            }

            // Return path: requester -> responder (using routeBack array)
            if (routeBack.length >= 0) {
              // Build path: toNodeNum (requester) → routeBack intermediates → fromNodeNum (responder)
              const backSequence: number[] = [selectedTrace.toNodeNum, ...routeBack, selectedTrace.fromNodeNum];
              const backPositions: [number, number][] = [];

              backSequence.forEach((nodeNum) => {
                const node = nodesForRender.find(n => n.nodeNum === nodeNum);
                if (node?.position?.latitude && node?.position?.longitude) {
                  backPositions.push([node.position.latitude, node.position.longitude]);
                }
              });

              if (backPositions.length >= 2) {
                // Calculate total distance for back path
                let backTotalDistanceKm = 0;
                for (let i = 0; i < backSequence.length - 1; i++) {
                  const node1 = nodesForRender.find(n => n.nodeNum === backSequence[i]);
                  const node2 = nodesForRender.find(n => n.nodeNum === backSequence[i + 1]);
                  if (node1?.position?.latitude && node1?.position?.longitude &&
                      node2?.position?.latitude && node2?.position?.longitude) {
                    backTotalDistanceKm += calculateDistance(
                      node1.position.latitude, node1.position.longitude,
                      node2.position.latitude, node2.position.longitude
                    );
                  }
                }

                allElements.push(
                  <Polyline
                    key="selected-traceroute-back"
                    positions={backPositions}
                    color={themeColors.red}
                    weight={4}
                    opacity={0.9}
                    dashArray="5, 10"
                  >
                    <Popup>
                      <div className="route-popup">
                        <h4>Return Path</h4>
                        <div className="route-endpoints">
                          <strong>{toName}</strong> → <strong>{fromName}</strong>
                        </div>
                        <div className="route-usage">
                          Path: {backSequence.map(num => {
                            const n = nodesForRender.find(nd => nd.nodeNum === num);
                            return n?.user?.longName || n?.user?.shortName || `!${num.toString(16)}`;
                          }).join(' → ')}
                        </div>
                        {backTotalDistanceKm > 0 && (
                          <div className="route-usage">
                            Distance: <strong>{formatDistance(backTotalDistanceKm, distanceUnit)}</strong>
                          </div>
                        )}
                      </div>
                    </Popup>
                  </Polyline>
                );

                // Generate arrow markers for back path
                const backArrows = generateArrowMarkers(
                  backPositions,
                  'back',
                  themeColors.red,
                  allElements.length
                );
                allElements.push(...backArrows);
              }
            }
        } catch (error) {
          logger.error('Error rendering selected node traceroute:', error);
        }
        } // End of else block for valid route data
      }
    }

    return allElements;
  }, [showRoute, selectedNodeId, traceroutesDigest, nodesPositionDigest, currentNodeId]);

  // If anonymous is disabled and user is not authenticated, show login page
  if (authStatus?.anonymousDisabled && !authStatus?.authenticated) {
    return <LoginPage />;
  }

  return (
    <div className="app">
      {renderNodeFilterPopup()}
      <header className="app-header">
        <div className="header-left">
          <div className="header-title">
            <img src={`${baseUrl}/logo.png`} alt="MeshMonitor Logo" className="header-logo" />
            <h1>MeshMonitor</h1>
          </div>
          <div className="node-info">
            {(() => {
              // Find the local node from the nodes array
              // Try by currentNodeId first (available when user has config read permission)
              let localNode = currentNodeId ? nodes.find(n => n.user?.id === currentNodeId) : null;

              // If currentNodeId isn't available, use localNodeInfo from /api/config
              // which is accessible to all users including anonymous
              if (!localNode && deviceInfo?.localNodeInfo) {
                const { nodeId, longName, shortName } = deviceInfo.localNodeInfo;
                return (
                  <span
                    className="node-address"
                    title={authStatus?.authenticated ? `Connected to: ${nodeAddress}` : undefined}
                    style={{ cursor: authStatus?.authenticated ? 'help' : 'default' }}
                  >
                    {longName} ({shortName}) - {nodeId}
                  </span>
                );
              }

              if (localNode && localNode.user) {
                return (
                  <span
                    className="node-address"
                    title={authStatus?.authenticated ? `Connected to: ${nodeAddress}` : undefined}
                    style={{ cursor: authStatus?.authenticated ? 'help' : 'default' }}
                  >
                    {localNode.user.longName} ({localNode.user.shortName}) - {localNode.user.id}
                  </span>
                );
              }

              return <span className="node-address">{nodeAddress}</span>;
            })()}
          </div>
        </div>
        <div className="header-right" style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          <div className="connection-status-container" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <div className="connection-status" onClick={fetchSystemStatus} style={{ cursor: 'pointer' }} title="Click for system status">
              <span className={`status-indicator ${connectionStatus === 'user-disconnected' ? 'disconnected' : connectionStatus}`}></span>
              <span>{
                connectionStatus === 'user-disconnected' ? 'Disconnected' :
                connectionStatus === 'configuring' ? 'initializing' :
                connectionStatus === 'node-offline' ? 'Node Offline' :
                connectionStatus
              }</span>
            </div>

            {/* Show disconnect/reconnect buttons based on connection status and permissions */}
            {hasPermission('connection', 'write') && connectionStatus === 'connected' && (
              <button
                onClick={handleDisconnect}
                className="connection-control-btn"
                title="Disconnect from node"
              >
                Disconnect
              </button>
            )}

            {hasPermission('connection', 'write') && connectionStatus === 'user-disconnected' && (
              <button
                onClick={handleReconnect}
                className="connection-control-btn reconnect"
                title="Reconnect to node"
              >
                Connect
              </button>
            )}
          </div>
          {authStatus?.authenticated ? (
            <UserMenu onLogout={() => setActiveTab('nodes')} />
          ) : (
            <button className="login-button" onClick={() => setShowLoginModal(true)}>
              <span>🔒</span>
              <span>Login</span>
            </button>
          )}
        </div>
      </header>

      {/* Default Password Warning Banner */}
      {isDefaultPassword && (
        <div className="warning-banner">
          ⚠️ Security Warning: The admin account is using the default password. Please change it immediately in the Users tab.
        </div>
      )}

      {/* TX Disabled Warning Banner */}
      {isTxDisabled && (
        <div className="warning-banner" style={{
          top: isDefaultPassword ? 'calc(var(--header-height) + var(--banner-height))' : 'var(--header-height)'
        }}>
          ⚠️ Transmit Disabled: Your device cannot send messages. TX is currently disabled in the LoRa configuration. Enable it via the Meshtastic app or re-import your configuration.
        </div>
      )}

      {/* Configuration Issue Warning Banners */}
      {configIssues.map((issue, index) => {
        // Calculate how many banners are above this one
        const bannersAbove = [isDefaultPassword, isTxDisabled].filter(Boolean).length + index;
        const topOffset = bannersAbove === 0
          ? 'var(--header-height)'
          : `calc(var(--header-height) + (var(--banner-height) * ${bannersAbove}))`;

        return (
          <div key={issue.type} className="warning-banner" style={{ top: topOffset }}>
            ⚠️ Configuration Error: {issue.message}{' '}
            <a
              href={issue.docsUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: 'inherit', textDecoration: 'underline' }}
            >
              Learn more →
            </a>
          </div>
        );
      })}

      {/* Don't show banner until images are confirmed ready - no point notifying users about builds in progress */}

      {updateAvailable && (() => {
        // Calculate total warning banners above the update banner
        const warningBannersCount = [isDefaultPassword, isTxDisabled].filter(Boolean).length + configIssues.length;
        const topOffset = warningBannersCount === 0
          ? 'var(--header-height)'
          : `calc(var(--header-height) + (var(--banner-height) * ${warningBannersCount}))`;

        return (
        <div className="update-banner" style={{ top: topOffset }}>
          <div style={{ flex: 1, textAlign: 'center', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '1rem' }}>
            {upgradeInProgress ? (
              <>
                <span>⚙️ Upgrading to {latestVersion}...</span>
                <span style={{ fontSize: '0.9em', opacity: 0.9 }}>{upgradeStatus}</span>
                {upgradeProgress > 0 && (
                  <span style={{ fontSize: '0.9em', opacity: 0.9 }}>({upgradeProgress}%)</span>
                )}
              </>
            ) : (
              <>
                <span>🔔 Update Available: Version {latestVersion} is now available.</span>
                <a
                  href={releaseUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    color: 'white',
                    textDecoration: 'underline',
                    fontWeight: '600'
                  }}
                >
                  View Release Notes →
                </a>
                {upgradeEnabled && (
                  <button
                    onClick={handleUpgrade}
                    style={{
                      padding: '0.4rem 1rem',
                      backgroundColor: '#10b981',
                      color: 'white',
                      border: 'none',
                      borderRadius: '4px',
                      cursor: 'pointer',
                      fontWeight: '600',
                      fontSize: '0.9em',
                      transition: 'background-color 0.2s'
                    }}
                    onMouseEnter={(e) => e.currentTarget.style.backgroundColor = '#059669'}
                    onMouseLeave={(e) => e.currentTarget.style.backgroundColor = '#10b981'}
                    title="Automatically upgrade to the latest version"
                  >
                    Upgrade Now
                  </button>
                )}
              </>
            )}
          </div>
          {!upgradeInProgress && (
            <button
              className="banner-dismiss"
              onClick={() => setUpdateAvailable(false)}
              aria-label="Dismiss update notification"
              title="Dismiss"
            >
              ✕
            </button>
          )}
        </div>
        );
      })()}

      <LoginModal isOpen={showLoginModal} onClose={() => setShowLoginModal(false)} />
      <RebootModal isOpen={showRebootModal} onClose={handleRebootModalClose} />

      {/* Emoji Picker Modal */}
      {emojiPickerMessage && (
        <div className="modal-overlay" onClick={() => setEmojiPickerMessage(null)}>
          <div className="emoji-picker-modal" onClick={(e) => e.stopPropagation()}>
            <div className="emoji-picker-header">
              <h3>React with an emoji</h3>
              <button
                className="emoji-picker-close"
                onClick={() => setEmojiPickerMessage(null)}
                title="Close"
              >
                ×
              </button>
            </div>
            <div className="emoji-picker-grid">
              {TAPBACK_EMOJIS.map(({ emoji, title }) => (
                <button
                  key={emoji}
                  className="emoji-picker-item"
                  onClick={() => {
                    handleSendTapback(emoji, emojiPickerMessage);
                    setEmojiPickerMessage(null);
                  }}
                  title={title}
                >
                  {emoji}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

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

      {/* Purge Data Modal */}
      {showPurgeDataModal && selectedDMNode && (
        <div className="modal-overlay" onClick={() => setShowPurgeDataModal(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '500px' }}>
            <div className="modal-header">
              <h2>⚠️ Purge Data for {getNodeName(selectedDMNode)}</h2>
              <button className="modal-close" onClick={() => setShowPurgeDataModal(false)}>&times;</button>
            </div>
            <div className="modal-body">
              <p style={{ marginBottom: '1.5rem', color: '#dc3545', fontWeight: 'bold' }}>
                These actions cannot be undone. All data for this node will be permanently deleted.
              </p>
              <div style={{ display: 'flex', flexDirection: 'row', gap: '0.75rem', flexWrap: 'wrap' }}>
                <button
                  onClick={() => {
                    const selectedNode = nodes.find(n => n.user?.id === selectedDMNode);
                    if (selectedNode) {
                      handlePurgeDirectMessages(selectedNode.nodeNum);
                      setShowPurgeDataModal(false);
                    }
                  }}
                  className="danger-btn"
                  style={{
                    backgroundColor: '#dc3545',
                    color: 'white',
                    border: 'none',
                    padding: '0.75rem 1rem',
                    borderRadius: '4px',
                    cursor: 'pointer',
                    fontWeight: 'bold',
                    fontSize: '1rem'
                  }}
                >
                  🗑️ Purge All Messages
                </button>
                <button
                  onClick={() => {
                    const selectedNode = nodes.find(n => n.user?.id === selectedDMNode);
                    if (selectedNode) {
                      handlePurgeNodeTraceroutes(selectedNode.nodeNum);
                      setShowPurgeDataModal(false);
                    }
                  }}
                  className="danger-btn"
                  style={{
                    backgroundColor: '#dc3545',
                    color: 'white',
                    border: 'none',
                    padding: '0.75rem 1rem',
                    borderRadius: '4px',
                    cursor: 'pointer',
                    fontWeight: 'bold',
                    fontSize: '1rem'
                  }}
                >
                  🗺️ Purge Traceroutes
                </button>
                <button
                  onClick={() => {
                    const selectedNode = nodes.find(n => n.user?.id === selectedDMNode);
                    if (selectedNode) {
                      handlePurgeNodeTelemetry(selectedNode.nodeNum);
                      setShowPurgeDataModal(false);
                    }
                  }}
                  className="danger-btn"
                  style={{
                    backgroundColor: '#dc3545',
                    color: 'white',
                    border: 'none',
                    padding: '0.75rem 1rem',
                    borderRadius: '4px',
                    cursor: 'pointer',
                    fontWeight: 'bold',
                    fontSize: '1rem'
                  }}
                >
                  📊 Purge Telemetry
                </button>
              </div>
              <hr style={{ margin: '1.5rem 0', borderColor: '#dee2e6' }} />
              <p style={{ marginBottom: '1rem', fontWeight: 'bold' }}>
                Delete Node Completely:
              </p>
              <p style={{ marginBottom: '1rem', fontSize: '0.9rem', color: '#6c757d' }}>
                Choose how to delete the node - from local database only, or from both the device and database.
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                <button
                  onClick={() => {
                    const selectedNode = nodes.find(n => n.user?.id === selectedDMNode);
                    if (selectedNode) {
                      handleDeleteNode(selectedNode.nodeNum);
                    }
                  }}
                  className="danger-btn"
                  style={{
                    backgroundColor: '#721c24',
                    color: 'white',
                    border: 'none',
                    padding: '0.75rem 1rem',
                    borderRadius: '4px',
                    cursor: 'pointer',
                    fontWeight: 'bold',
                    fontSize: '1rem',
                    width: '100%'
                  }}
                >
                  ❌ Delete Node (Local Database Only)
                </button>
                <button
                  onClick={() => {
                    const selectedNode = nodes.find(n => n.user?.id === selectedDMNode);
                    if (selectedNode) {
                      handlePurgeNodeFromDevice(selectedNode.nodeNum);
                    }
                  }}
                  className="danger-btn"
                  style={{
                    backgroundColor: '#5a0a0a',
                    color: 'white',
                    border: 'none',
                    padding: '0.75rem 1rem',
                    borderRadius: '4px',
                    cursor: 'pointer',
                    fontWeight: 'bold',
                    fontSize: '1rem',
                    width: '100%'
                  }}
                >
                  🗑️ Purge from Device AND Database
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

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
        baseUrl={baseUrl}
        connectedNodeName={connectedNodeName}
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
          />
        )}
        {activeTab === 'channels' && renderChannelsTab()}
        {activeTab === 'messages' && renderMessagesTab()}
        {activeTab === 'info' && (
          <InfoTab
            connectionStatus={connectionStatus}
            nodeAddress={nodeAddress}
            deviceInfo={deviceInfo}
            deviceConfig={deviceConfig}
            nodes={nodes}
            channels={channels}
            messages={messages}
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
          />
        )}
        {activeTab === 'settings' && (
          <SettingsTab
            maxNodeAgeHours={maxNodeAgeHours}
            temperatureUnit={temperatureUnit}
            distanceUnit={distanceUnit}
            telemetryVisualizationHours={telemetryVisualizationHours}
            favoriteTelemetryStorageDays={favoriteTelemetryStorageDays}
            preferredSortField={preferredSortField}
            preferredSortDirection={preferredSortDirection}
            timeFormat={timeFormat}
            dateFormat={dateFormat}
            mapTileset={mapTileset}
            mapPinStyle={mapPinStyle}
            theme={theme}
            solarMonitoringEnabled={solarMonitoringEnabled}
            solarMonitoringLatitude={solarMonitoringLatitude}
            solarMonitoringLongitude={solarMonitoringLongitude}
            solarMonitoringAzimuth={solarMonitoringAzimuth}
            solarMonitoringDeclination={solarMonitoringDeclination}
            currentNodeId={currentNodeId}
            nodes={nodes}
            baseUrl={baseUrl}
            onMaxNodeAgeChange={setMaxNodeAgeHours}
            onTemperatureUnitChange={setTemperatureUnit}
            onDistanceUnitChange={setDistanceUnit}
            onTelemetryVisualizationChange={setTelemetryVisualizationHours}
            onFavoriteTelemetryStorageDaysChange={setFavoriteTelemetryStorageDays}
            onPreferredSortFieldChange={setPreferredSortField}
            onPreferredSortDirectionChange={setPreferredSortDirection}
            onTimeFormatChange={setTimeFormat}
            onDateFormatChange={setDateFormat}
            onMapTilesetChange={setMapTileset}
            onMapPinStyleChange={setMapPinStyle}
            onThemeChange={setTheme}
            onSolarMonitoringEnabledChange={setSolarMonitoringEnabled}
            onSolarMonitoringLatitudeChange={setSolarMonitoringLatitude}
            onSolarMonitoringLongitudeChange={setSolarMonitoringLongitude}
            onSolarMonitoringAzimuthChange={setSolarMonitoringAzimuth}
            onSolarMonitoringDeclinationChange={setSolarMonitoringDeclination}
          />
        )}
        {activeTab === 'automation' && (
          <div className="settings-tab">
            <div className="settings-content">
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
              <AutoTracerouteSection
                intervalMinutes={tracerouteIntervalMinutes}
                baseUrl={baseUrl}
                onIntervalChange={setTracerouteIntervalMinutes}
              />
              <AutoAcknowledgeSection
                enabled={autoAckEnabled}
                regex={autoAckRegex}
                message={autoAckMessage}
                messageDirect={autoAckMessageDirect}
                channels={channels}
                enabledChannels={autoAckChannels}
                directMessagesEnabled={autoAckDirectMessages}
                useDM={autoAckUseDM}
                baseUrl={baseUrl}
                onEnabledChange={setAutoAckEnabled}
                onRegexChange={setAutoAckRegex}
                onMessageChange={setAutoAckMessage}
                onMessageDirectChange={setAutoAckMessageDirect}
                onChannelsChange={setAutoAckChannels}
                onDirectMessagesChange={setAutoAckDirectMessages}
                onUseDMChange={setAutoAckUseDM}
              />
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
              />
              <AutoResponderSection
                enabled={autoResponderEnabled}
                triggers={autoResponderTriggers}
                channels={channels}
                baseUrl={baseUrl}
                onEnabledChange={setAutoResponderEnabled}
                onTriggersChange={setAutoResponderTriggers}
              />
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
        {activeTab === 'security' && <SecurityTab onTabChange={setActiveTab} onSelectDMNode={setSelectedDMNode} setNewMessage={setNewMessage} />}
      </main>

      {/* Node Popup */}
      {nodePopup && (() => {
        const node = nodes.find(n => n.user?.id === nodePopup.nodeId);
        if (!node) return null;

        return (
          <div
            className="route-popup node-popup"
            style={{
              position: 'fixed',
              left: nodePopup.position.x,
              top: nodePopup.position.y - 10,
              transform: 'translateX(-50%) translateY(-100%)',
              zIndex: 1000
            }}
          >
            <h4>{node.user?.longName || `Node ${node.nodeNum}`}</h4>
            {node.user?.shortName && (
              <div className="route-endpoints">
                <strong>{node.user.shortName}</strong>
              </div>
            )}

            {node.user?.id && (
              <div className="route-usage">ID: {node.user.id}</div>
            )}

            {node.user?.role !== undefined && (() => {
              const roleNum = typeof node.user.role === 'string'
                ? parseInt(node.user.role, 10)
                : node.user.role;
              const roleName = getRoleName(roleNum);
              return roleName ? <div className="route-usage">Role: {roleName}</div> : null;
            })()}

            {node.user?.hwModel !== undefined && (() => {
              const hwModelName = getHardwareModelName(node.user.hwModel);
              return hwModelName ? <div className="route-usage">Hardware: {hwModelName}</div> : null;
            })()}

            {node.snr != null && (
              <div className="route-usage">SNR: {node.snr.toFixed(1)} dB</div>
            )}

            {node.deviceMetrics?.batteryLevel !== undefined && node.deviceMetrics.batteryLevel !== null && (
              <div className="route-usage">
                {node.deviceMetrics.batteryLevel === 101 ? 'Power: Plugged In' : `Battery: ${node.deviceMetrics.batteryLevel}%`}
              </div>
            )}

            {node.lastHeard && (
              <div className="route-usage">Last Seen: {formatDateTime(new Date(node.lastHeard * 1000), timeFormat, dateFormat)}</div>
            )}

            {node.user?.id && hasPermission('messages', 'read') && (
              <button
                className="popup-dm-btn"
                onClick={() => {
                  setSelectedDMNode(node.user!.id);
                  setActiveTab('messages');
                  setNodePopup(null);
                }}
              >
                💬 Direct Message
              </button>
            )}
          </div>
        );
      })()}

      {/* System Status Modal */}
      {showStatusModal && systemStatus && (
        <div className="modal-overlay" onClick={() => setShowStatusModal(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>System Status</h2>
              <button className="modal-close" onClick={() => setShowStatusModal(false)}>&times;</button>
            </div>
            <div className="modal-body">
              <div className="status-grid">
                <div className="status-item">
                  <strong>Version:</strong>
                  <span>{systemStatus.version}</span>
                </div>
                <div className="status-item">
                  <strong>Node.js Version:</strong>
                  <span>{systemStatus.nodeVersion}</span>
                </div>
                <div className="status-item">
                  <strong>Uptime:</strong>
                  <span>{systemStatus.uptime}</span>
                </div>
                <div className="status-item">
                  <strong>Platform:</strong>
                  <span>{systemStatus.platform} ({systemStatus.architecture})</span>
                </div>
                <div className="status-item">
                  <strong>Environment:</strong>
                  <span>{systemStatus.environment}</span>
                </div>
                <div className="status-item">
                  <strong>Memory (Heap Used):</strong>
                  <span>{systemStatus.memoryUsage.heapUsed}</span>
                </div>
                <div className="status-item">
                  <strong>Memory (Heap Total):</strong>
                  <span>{systemStatus.memoryUsage.heapTotal}</span>
                </div>
                <div className="status-item">
                  <strong>Memory (RSS):</strong>
                  <span>{systemStatus.memoryUsage.rss}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

    </div>
  )
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
                <App />
              </ToastProvider>
            </UIProvider>
          </MessagingProvider>
        </DataProvider>
      </MapProvider>
    </SettingsProvider>
  );
};

export default AppWithToast
