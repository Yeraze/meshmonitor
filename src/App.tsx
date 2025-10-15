import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { MapContainer, TileLayer, Marker, Popup, Polyline, Circle, useMap } from 'react-leaflet'
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import './App.css'
import TelemetryGraphs from './components/TelemetryGraphs'
import InfoTab from './components/InfoTab'
import SettingsTab from './components/SettingsTab'
import ConfigurationTab from './components/ConfigurationTab'
import UsersTab from './components/UsersTab'
import AuditLogTab from './components/AuditLogTab'
import Dashboard from './components/Dashboard'
import HopCountDisplay from './components/HopCountDisplay'
import AutoAcknowledgeSection from './components/AutoAcknowledgeSection'
import AutoTracerouteSection from './components/AutoTracerouteSection'
import AutoAnnounceSection from './components/AutoAnnounceSection'
import { ToastProvider, useToast } from './components/ToastContainer'
import { version } from '../package.json'
import { type TemperatureUnit } from './utils/temperature'
import { calculateDistance, formatDistance } from './utils/distance'
import { formatTime, formatDateTime } from './utils/datetime'
import { DeviceInfo, Channel } from './types/device'
import { MeshMessage } from './types/message'
import { MapCenterControllerProps, SortField, SortDirection } from './types/ui'
import api from './services/api'
import { logger } from './utils/logger'
import { createNodeIcon, getHopColor } from './utils/mapIcons'
import { getRoleName, generateArrowMarkers } from './utils/mapHelpers.tsx'
import { getHardwareModelName } from './utils/nodeHelpers'
import MapLegend from './components/MapLegend'
import ZoomHandler from './components/ZoomHandler'
import Sidebar from './components/Sidebar'
import { SettingsProvider, useSettings } from './contexts/SettingsContext'
import { MapProvider, useMapContext } from './contexts/MapContext'
import { DataProvider, useData } from './contexts/DataContext'
import { MessagingProvider, useMessaging } from './contexts/MessagingContext'
import { UIProvider, useUI } from './contexts/UIContext'
import { useAuth } from './contexts/AuthContext'
import { useCsrf } from './contexts/CsrfContext'
import LoginModal from './components/LoginModal'
import UserMenu from './components/UserMenu'

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

const MapCenterController: React.FC<MapCenterControllerProps> = ({ centerTarget, onCenterComplete }) => {
  const map = useMap();

  useEffect(() => {
    if (centerTarget) {
      // Listen for moveend event after setView completes, then pan to show popup
      map.once('moveend', () => {
        // Pan the map down by 150 pixels to account for popup height
        // This ensures both the marker and the popup above it are fully visible
        map.panBy([0, -150], { animate: true, duration: 0.3 });
      });

      map.setView(centerTarget, 15); // Zoom level 15 for close view
      onCenterComplete(); // Reset target after centering
    }
  }, [centerTarget, onCenterComplete]); // Removed 'map' from dependencies to prevent repeated re-centering

  return null;
};

function App() {
  const { authStatus, hasPermission } = useAuth();
  const { getToken: getCsrfToken, refreshToken: refreshCsrfToken } = useCsrf();
  const { showToast } = useToast();
  const [showLoginModal, setShowLoginModal] = useState(false);
  const [isDefaultPassword, setIsDefaultPassword] = useState(false);
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [latestVersion, setLatestVersion] = useState('');
  const [releaseUrl, setReleaseUrl] = useState('');
  const [channelInfoModal, setChannelInfoModal] = useState<number | null>(null);
  const [showPsk, setShowPsk] = useState(false);

  // Check if mobile viewport and default to collapsed on mobile
  const isMobileViewport = () => window.innerWidth <= 768;
  const [isNodeListCollapsed, setIsNodeListCollapsed] = useState(isMobileViewport());
  const [isMessagesNodeListCollapsed, setIsMessagesNodeListCollapsed] = useState(isMobileViewport());

  const hasSelectedInitialChannelRef = useRef<boolean>(false)
  const selectedChannelRef = useRef<number>(-1)

  // Constants for emoji tapbacks
  const EMOJI_FLAG = 1; // Protobuf flag indicating this is a tapback/reaction
  const TAPBACK_EMOJIS = [
    { emoji: '👍', title: 'Thumbs up' },
    { emoji: '👎', title: 'Thumbs down' },
    { emoji: '❓', title: 'Question' },
    { emoji: '❗', title: 'Exclamation' },
    { emoji: '😂', title: 'Laugh' },
    { emoji: '😢', title: 'Cry' },
    { emoji: '💩', title: 'Poop' }
  ] as const;

  // Meshtastic default PSK (base64 encoded single null byte = unencrypted)
  const DEFAULT_UNENCRYPTED_PSK = 'AQ==';

  const channelMessagesContainerRef = useRef<HTMLDivElement>(null)
  const dmMessagesContainerRef = useRef<HTMLDivElement>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
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
    preferredSortField,
    preferredSortDirection,
    timeFormat,
    dateFormat,
    setMaxNodeAgeHours,
    setTracerouteIntervalMinutes,
    setTemperatureUnit,
    setDistanceUnit,
    setTelemetryVisualizationHours,
    setPreferredSortField,
    setPreferredSortDirection,
    setTimeFormat,
    setDateFormat
  } = useSettings();

  // Map context
  const {
    showPaths,
    setShowPaths,
    showNeighborInfo,
    setShowNeighborInfo,
    showRoute,
    setShowRoute,
    showMotion,
    setShowMotion,
    mapCenterTarget,
    setMapCenterTarget,
    mapZoom,
    setMapZoom,
    traceroutes,
    setTraceroutes,
    neighborInfo,
    setNeighborInfo,
    positionHistory,
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
    nodesWithEstimatedPosition,
    setNodesWithEstimatedPosition,
    nodesWithPKC,
    setNodesWithPKC
  } = useData();

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
    pendingMessages,
    setPendingMessages,
    unreadCounts,
    setUnreadCounts,
    isChannelScrolledToBottom,
    setIsChannelScrolledToBottom,
    isDMScrolledToBottom,
    setIsDMScrolledToBottom
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
    setAutoAnnounceOnStart
  } = useUI();

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
  const authFetch = async (url: string, options?: RequestInit, retryCount = 0): Promise<Response> => {
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

    const response = await fetch(url, {
      ...options,
      headers,
      credentials: 'include',
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
          return authFetch(url, options, retryCount + 1);
        }
      }
    }

    // Silently handle auth errors to prevent console spam
    if (response.status === 401 || response.status === 403) {
      return response;
    }

    return response;
  };

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

  // Initialize notification sound with cleanup
  useEffect(() => {
    const audio = new Audio('data:audio/wav;base64,UklGRnoGAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQoGAACBhYqFbF1fdJivrJBhNjVgodDbq2EcBj+a2/LDciUFLIHO8tiJNwgZaLvt559NEAxQp+PwtmMcBjiR1/LMeSwFJHfH8N2QQAoUXrTp66hVFApGn+DyvmwhBiqG0PLSfzcGG2O56+OdTgwOUpzq66NRDwg+ltbyvW0qBSl+z/DV');
    audioRef.current = audio;
    audioRef.current.volume = 0.3;

    // Cleanup function to prevent memory leak
    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.src = '';
        audioRef.current = null;
      }
    };
  }, []);

  // Function to play notification sound - disabled for now
  // const playNotificationSound = () => {
  //   if (audioRef.current) {
  //     audioRef.current.currentTime = 0;
  //     audioRef.current.play().catch(err => logger.debug('Audio play failed:', err));
  //   }
  // };

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
        }

        // Check connection status with the loaded baseUrl
        await checkConnectionStatus(configBaseUrl);
      } catch (error) {
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

  // Check for version updates
  useEffect(() => {
    const checkForUpdates = async () => {
      try {
        const response = await fetch(`${baseUrl}/api/version/check`);
        if (response.ok) {
          const data = await response.json();
          if (data.updateAvailable) {
            setUpdateAvailable(true);
            setLatestVersion(data.latestVersion);
            setReleaseUrl(data.releaseUrl);
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

  // Debug effect to track selectedChannel changes and keep ref in sync
  useEffect(() => {
    logger.debug('🔄 selectedChannel state changed to:', selectedChannel);
    selectedChannelRef.current = selectedChannel;
  }, [selectedChannel]);

  // Fetch traceroutes when showPaths is enabled or Messages/Nodes tab is active
  useEffect(() => {
    if ((showPaths || activeTab === 'messages' || activeTab === 'nodes') && shouldShowData()) {
      fetchTraceroutes();
      // Only auto-refresh when connected (not when viewing cached data)
      if (connectionStatus === 'connected') {
        const interval = setInterval(fetchTraceroutes, 10000); // Refresh every 10 seconds
        return () => clearInterval(interval);
      }
    }
  }, [showPaths, activeTab, connectionStatus]);

  // Fetch neighbor info when showNeighborInfo is enabled
  useEffect(() => {
    if (showNeighborInfo && shouldShowData()) {
      fetchNeighborInfo();
      // Only auto-refresh when connected (not when viewing cached data)
      if (connectionStatus === 'connected') {
        const interval = setInterval(fetchNeighborInfo, 10000); // Refresh every 10 seconds
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
        const response = await authFetch(`${baseUrl}/api/nodes/${selectedNodeId}/position-history?hours=168`);
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
      const marker = markerRefs.current.get(selectedNodeId);
      if (marker) {
        marker.openPopup();
      }
    }
  }, [selectedNodeId]);

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

  // Regular data updates (every 5 seconds)
  useEffect(() => {
    const updateInterval = setInterval(() => {
      // Skip polling when user has manually disconnected or device is rebooting
      if (connectionStatus === 'user-disconnected' || connectionStatus === 'rebooting') {
        return;
      }

      if (connectionStatus === 'connected') {
        updateDataFromBackend();
      } else {
        checkConnectionStatus();
      }
    }, 5000);

    return () => clearInterval(updateInterval);
  }, [connectionStatus]);

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

  // Timer to update message status indicators (waiting -> delivered after 10s)
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
        } catch (error) {
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

  const handleConfigChangeTriggeringReboot = async () => {
    logger.debug('⚙️ Config change sent, device will reboot to apply changes...');
    setConnectionStatus('rebooting');

    // Wait for device to reboot and reconnect
    await waitForDeviceReconnection();
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
      const response = await authFetch(`${baseUrl}/api/connection`);
      if (response.ok) {
        const status = await response.json();
        logger.debug(`📡 Connection API response: connected=${status.connected}, userDisconnected=${status.userDisconnected}`);

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

        if (status.connected) {
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
      // Fetch nodes
      const nodesResponse = await authFetch(`${baseUrl}/api/nodes`);
      if (nodesResponse.ok) {
        const nodesData = await nodesResponse.json();
        setNodes(nodesData);
      }

      // Fetch messages
      const messagesResponse = await authFetch(`${baseUrl}/api/messages?limit=100`);
      if (messagesResponse.ok) {
        const messagesData = await messagesResponse.json();
        // Convert timestamp strings back to Date objects
        const processedMessages = messagesData.map((msg: any) => ({
          ...msg,
          timestamp: new Date(msg.timestamp)
        }));

        // Check for new messages by comparing message IDs
        const previousMessageIds = new Set(messages.map(m => m.id));
        const isInitialLoad = previousMessageIds.size === 0;
        const newMessages = processedMessages.filter((m: MeshMessage) => !previousMessageIds.has(m.id));

        // Notification sound disabled - too frequent
        // TODO: Add user-configurable notification settings
        // if (newMessages.length > 0 && !isInitialLoad) {
        //   const currentSelected = selectedChannelRef.current;
        //   const hasNewMessagesInOtherChannels = newMessages.some((m: MeshMessage) => m.channel !== currentSelected);
        //   const now = Date.now();
        //   const timeSinceLastNotification = now - lastNotificationTime.current;
        //   if (hasNewMessagesInOtherChannels && timeSinceLastNotification > 3000) {
        //     playNotificationSound();
        //     lastNotificationTime.current = now;
        //   }
        // }

        setMessages(processedMessages);

        // Group messages by channel
        const channelGroups: {[key: number]: MeshMessage[]} = {};
        processedMessages.forEach((msg: MeshMessage) => {
          if (!channelGroups[msg.channel]) {
            channelGroups[msg.channel] = [];
          }
          channelGroups[msg.channel].push(msg);
        });

        // Update unread counts ONLY for truly NEW messages (not on initial load)
        const currentSelected = selectedChannelRef.current;

        // Calculate new unread counts
        let newUnreadCounts: {[key: number]: number};

        if (isInitialLoad) {
          // On initial load, set all channels to 0 unread
          newUnreadCounts = {};
        } else {
          // Start with current counts
          newUnreadCounts = { ...unreadCounts };

          // Add ONLY the new messages that arrived in this polling cycle
          // for channels that are NOT currently selected
          // ALSO: Only count messages less than 10 seconds old to avoid counting
          // messages that were already in DB when viewing the channel
          const now = Date.now();
          newMessages.forEach((msg: MeshMessage) => {
            const messageAge = now - msg.timestamp.getTime();
            if (msg.channel !== currentSelected && messageAge < 10000) {
              newUnreadCounts[msg.channel] = (newUnreadCounts[msg.channel] || 0) + 1;
            }
          });
        }

        // ALWAYS set currently selected channel to 0
        // This ensures viewing a channel clears its unread count permanently
        newUnreadCounts[currentSelected] = 0;

        logger.debug('📊 Updating unread counts:', {
          currentSelected,
          newUnreadCounts,
          isInitialLoad
        });

        setUnreadCounts(newUnreadCounts);

        setChannelMessages(channelGroups);

        // Check for message acknowledgments
        if (pendingMessages.size > 0) {
          const updatedPending = new Map(pendingMessages);
          let hasUpdates = false;

          // For each pending message, check if a matching message appears in recent messages
          // Match by text content, channel, and approximate timestamp (within 30 seconds)
          updatedPending.forEach((pendingMsg, tempId) => {
            const matchingMessage = processedMessages.find((msg: MeshMessage) =>
              msg.text === pendingMsg.text &&
              msg.channel === pendingMsg.channel &&
              Math.abs(msg.timestamp.getTime() - pendingMsg.timestamp.getTime()) < 30000 &&
              msg.from === currentNodeId
            );

            if (matchingMessage) {
              // Found a matching message from server, so this message was acknowledged
              updatedPending.delete(tempId);
              hasUpdates = true;

              // Update the messages list to replace the temporary message with the server one
              setMessages(prev => prev.map(m => m.id === tempId ? matchingMessage : m));
              setChannelMessages(prev => ({
                ...prev,
                [pendingMsg.channel]: prev[pendingMsg.channel]?.map(m => m.id === tempId ? matchingMessage : m) || []
              }));
            }
          });

          if (hasUpdates) {
            setPendingMessages(updatedPending);
          }
        }
      }

      // Fetch device info
      const configResponse = await authFetch(`${baseUrl}/api/config`);
      if (configResponse.ok) {
        const configData = await configResponse.json();
        setDeviceInfo(configData);
      }

      // Fetch device configuration
      const deviceConfigResponse = await authFetch(`${baseUrl}/api/device-config`);
      if (deviceConfigResponse.ok) {
        const deviceConfigData = await deviceConfigResponse.json();
        setDeviceConfig(deviceConfigData);

        // Extract current node ID from device config
        if (deviceConfigData.basic?.nodeId) {
          setCurrentNodeId(deviceConfigData.basic.nodeId);
        }
      }

      // Fetch telemetry availability
      await fetchNodesWithTelemetry();
    } catch (error) {
      logger.error('Failed to update data from backend:', error);
    }
  };

  const getRecentTraceroute = (nodeId: string) => {
    const nodeNumStr = nodeId.replace('!', '');
    const nodeNum = parseInt(nodeNumStr, 16);

    // Find most recent traceroute from this node within last 24 hours
    const cutoff = Date.now() - (24 * 60 * 60 * 1000);
    const recentTraceroutes = traceroutes
      .filter(tr => tr.fromNodeNum === nodeNum && tr.timestamp >= cutoff)
      .sort((a, b) => b.timestamp - a.timestamp);

    return recentTraceroutes.length > 0 ? recentTraceroutes[0] : null;
  };

  const formatTracerouteRoute = (route: string, snr: string, fromNodeNum?: number, toNodeNum?: number) => {
    try {
      const routeArray = JSON.parse(route || '[]');
      const snrArray = JSON.parse(snr || '[]');

      const pathNodes: string[] = [];
      const nodeNums: number[] = [];
      let totalDistanceKm = 0;

      // Build full sequence of node numbers
      if (toNodeNum !== undefined) {
        nodeNums.push(toNodeNum);
      }
      nodeNums.push(...routeArray);
      if (fromNodeNum !== undefined) {
        nodeNums.push(fromNodeNum);
      }

      // Format each hop with SNR and distance
      nodeNums.forEach((nodeNum, idx) => {
        const node = nodes.find(n => n.nodeNum === nodeNum);
        const nodeName = node?.user?.longName || node?.user?.shortName || `!${nodeNum.toString(16)}`;

        // Get SNR for this hop
        const snrIdx = idx === 0 ? -1 : idx - 1; // First node has no SNR, subsequent nodes use previous indices
        const snrValue = snrIdx >= 0 && snrArray[snrIdx] !== undefined
          ? ` (${(snrArray[snrIdx]/4).toFixed(1)}dB)`
          : '';

        // Calculate distance to next hop if available
        let distanceStr = '';
        if (idx < nodeNums.length - 1) {
          const nextNodeNum = nodeNums[idx + 1];
          const nextNode = nodes.find(n => n.nodeNum === nextNodeNum);

          if (node?.position?.latitude && node?.position?.longitude &&
              nextNode?.position?.latitude && nextNode?.position?.longitude) {
            const distKm = calculateDistance(
              node.position.latitude, node.position.longitude,
              nextNode.position.latitude, nextNode.position.longitude
            );
            totalDistanceKm += distKm;
            distanceStr = ` [${formatDistance(distKm, distanceUnit)}]`;
          }
        }

        pathNodes.push(nodeName + snrValue + distanceStr);
      });

      if (pathNodes.length === 0) {
        return 'No route data';
      }

      if (pathNodes.length === 2 && routeArray.length === 0) {
        const distanceInfo = totalDistanceKm > 0 ? ` - ${formatDistance(totalDistanceKm, distanceUnit)} (direct)` : ' (direct)';
        return `${pathNodes[0]} ↔ ${pathNodes[1]}${distanceInfo}`;
      }

      const totalInfo = totalDistanceKm > 0 ? ` - Total: ${formatDistance(totalDistanceKm, distanceUnit)}` : '';
      return pathNodes.join(' → ') + totalInfo;
    } catch (error) {
      return 'Error parsing route';
    }
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

      // Clear loading state after 30 seconds
      setTimeout(() => {
        setTracerouteLoading(null);
      }, 30000);
    } catch (error) {
      logger.error('Failed to send traceroute:', error);
      setTracerouteLoading(null);
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
    const sentMessage: MeshMessage = {
      id: tempId,
      from: currentNodeId || 'me',
      to: destinationNodeId,
      fromNodeId: currentNodeId || 'me',
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
    setPendingMessages(prev => new Map(prev).set(tempId, sentMessage));

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
        const toNodeId = originalMessage.fromNodeId === currentNodeId
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
    const sentMessage: MeshMessage = {
      id: tempId,
      from: currentNodeId || 'me',
      to: '!ffffffff', // Broadcast
      fromNodeId: currentNodeId || 'me',
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
    setPendingMessages(prev => new Map(prev).set(tempId, sentMessage));

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

    // Filter out channel -1 (used for direct messages) and sort
    return Array.from(channelSet)
      .filter(ch => ch !== -1)
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
        case 'hops':
          // For nodes without hop data, use fallback values that push them to bottom
          // Ascending: use 999 (high value = bottom), Descending: use -1 (low value = bottom)
          const noHopFallback = direction === 'asc' ? 999 : -1;
          aVal = a.hopsAway !== undefined && a.hopsAway !== null ? a.hopsAway : noHopFallback;
          bVal = b.hopsAway !== undefined && b.hopsAway !== null ? b.hopsAway : noHopFallback;
          break;
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

    // Separate favorites from non-favorites
    const favorites = textFiltered.filter(node => node.isFavorite);
    const nonFavorites = textFiltered.filter(node => !node.isFavorite);

    // Sort each group independently
    const sortedFavorites = sortNodes(favorites, sortField, sortDirection);
    const sortedNonFavorites = sortNodes(nonFavorites, sortField, sortDirection);

    // Concatenate: favorites first, then non-favorites
    return [...sortedFavorites, ...sortedNonFavorites];
  }, [nodes, maxNodeAgeHours, nodeFilter, sortField, sortDirection]);

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

  // Function to toggle node favorite status
  const toggleFavorite = async (node: DeviceInfo, event: React.MouseEvent) => {
    event.stopPropagation(); // Prevent node selection when clicking star

    if (!node.user?.id) {
      logger.error('Cannot toggle favorite: node has no user ID');
      return;
    }

    try {
      const newFavoriteStatus = !node.isFavorite;

      // Optimistically update the UI
      setNodes(prevNodes =>
        prevNodes.map(n =>
          n.nodeNum === node.nodeNum
            ? { ...n, isFavorite: newFavoriteStatus }
            : n
        )
      );

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
          // Revert optimistic update
          setNodes(prevNodes =>
            prevNodes.map(n =>
              n.nodeNum === node.nodeNum
                ? { ...n, isFavorite: !node.isFavorite }
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
      // Revert optimistic update on error
      setNodes(prevNodes =>
        prevNodes.map(n =>
          n.nodeNum === node.nodeNum
            ? { ...n, isFavorite: !node.isFavorite }
            : n
        )
      );
      showToast('Failed to update favorite status. Please try again.', 'error');
    }
  };

  // Function to reset map center target
  const handleCenterComplete = useCallback(() => {
    setMapCenterTarget(null);
  }, []);

  // Function to handle sender icon clicks
  const handleSenderClick = useCallback((nodeId: string, event: React.MouseEvent) => {
    const rect = event.currentTarget.getBoundingClientRect();
    setNodePopup({
      nodeId,
      position: {
        x: rect.left + rect.width / 2,
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

  const renderNodesTab = () => {
    const nodesWithPosition = processedNodes.filter(node =>
      node.position &&
      node.position.latitude != null &&
      node.position.longitude != null
    );

    // Calculate center point of all nodes for initial map view
    const getMapCenter = (): [number, number] => {
      if (nodesWithPosition.length === 0) {
        return [25.7617, -80.1918]; // Default to Miami area
      }
      const avgLat = nodesWithPosition.reduce((sum, node) => sum + node.position!.latitude, 0) / nodesWithPosition.length;
      const avgLng = nodesWithPosition.reduce((sum, node) => sum + node.position!.longitude, 0) / nodesWithPosition.length;
      return [avgLat, avgLng];
    };

    return (
      <div className="nodes-split-view">
        {/* Floating Node List Panel */}
        <div className={`nodes-sidebar ${isNodeListCollapsed ? 'collapsed' : ''}`}>
          <div className="sidebar-header">
            <button
              className="collapse-nodes-btn"
              onClick={() => setIsNodeListCollapsed(!isNodeListCollapsed)}
              title={isNodeListCollapsed ? 'Expand node list' : 'Collapse node list'}
            >
              {isNodeListCollapsed ? '▶' : '◀'}
            </button>
            {!isNodeListCollapsed && (
            <div className="sidebar-header-content">
              <h3>Nodes ({processedNodes.length})</h3>
            </div>
            )}
            {!isNodeListCollapsed && (
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
                  value={sortField}
                  onChange={(e) => setSortField(e.target.value as SortField)}
                  className="sort-dropdown"
                  title="Sort nodes by"
                >
                  <option value="longName">Sort: Name</option>
                  <option value="shortName">Sort: Short Name</option>
                  <option value="id">Sort: ID</option>
                  <option value="lastHeard">Sort: Updated</option>
                  <option value="snr">Sort: Signal</option>
                  <option value="battery">Sort: Charge</option>
                  <option value="hwModel">Sort: Hardware</option>
                  <option value="hops">Sort: Hops</option>
                </select>
                <button
                  className="sort-direction-btn"
                  onClick={() => setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc')}
                  title={sortDirection === 'asc' ? 'Ascending' : 'Descending'}
                >
                  {sortDirection === 'asc' ? '↑' : '↓'}
                </button>
              </div>
            </div>
            )}
          </div>

          {!isNodeListCollapsed && (
          <div className="nodes-list">
            {shouldShowData() ? (
              processedNodes.length > 0 ? (
                <>
                {processedNodes.map(node => (
                  <div
                    key={node.nodeNum}
                    className={`node-item ${selectedNodeId === node.user?.id ? 'selected' : ''}`}
                    onClick={() => {
                      setSelectedNodeId(node.user?.id || null);
                      centerMapOnNode(node);
                    }}
                  >
                    <div className="node-header">
                      <div className="node-name">
                        <button
                          className="favorite-star"
                          title={node.isFavorite ? "Remove from favorites" : "Add to favorites"}
                          onClick={(e) => toggleFavorite(node, e)}
                        >
                          {node.isFavorite ? '⭐' : '☆'}
                        </button>
                        {node.user?.longName || `Node ${node.nodeNum}`}
                        {node.user?.role !== undefined && node.user?.role !== null && getRoleName(node.user.role) && (
                          <span className="node-role" title="Node Role"> {getRoleName(node.user.role)}</span>
                        )}
                      </div>
                      <div className="node-actions">
                        {hasPermission('messages', 'read') && (
                          <button
                            className="dm-icon"
                            title="Send Direct Message"
                            onClick={(e) => {
                              e.stopPropagation();
                              setSelectedDMNode(node.user?.id || '');
                              setActiveTab('messages');
                            }}
                          >
                            💬
                          </button>
                        )}
                        <div className="node-short">
                          {node.user?.shortName || '-'}
                        </div>
                      </div>
                    </div>

                    <div className="node-details">
                      <div className="node-stats">
                        {node.snr != null && (
                          <span className="stat" title="Signal-to-Noise Ratio">
                            📶 {node.snr.toFixed(1)}dB
                          </span>
                        )}
                        {node.deviceMetrics?.batteryLevel !== undefined && node.deviceMetrics.batteryLevel !== null && (
                          <span className="stat" title={node.deviceMetrics.batteryLevel === 101 ? "Plugged In" : "Battery Level"}>
                            {node.deviceMetrics.batteryLevel === 101 ? '🔌' : `🔋 ${node.deviceMetrics.batteryLevel}%`}
                          </span>
                        )}
                        {node.hopsAway != null && (
                          <span className="stat" title="Hops Away">
                            🔗 {node.hopsAway} hop{node.hopsAway !== 1 ? 's' : ''}
                          </span>
                        )}
                      </div>

                      <div className="node-time">
                        {node.lastHeard ?
                          formatDateTime(new Date(node.lastHeard * 1000), timeFormat, dateFormat)
                          : 'Never'
                        }
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
                ))}
                </>
              ) : (
                <div className="no-data">
                  {nodeFilter ? 'No nodes match filter' : 'No nodes detected'}
                </div>
              )
            ) : (
              <div className="no-data">
                Connect to Meshtastic node
              </div>
            )}
          </div>
          )}
        </div>

        {/* Right Side - Map */}
        <div className="map-container">
          {shouldShowData() ? (
            <>
              <div className="map-controls">
                <label className="map-control-item">
                  <input
                    type="checkbox"
                    checked={showPaths}
                    onChange={(e) => setShowPaths(e.target.checked)}
                  />
                  <span>Show Route Segments</span>
                </label>
                <label className="map-control-item">
                  <input
                    type="checkbox"
                    checked={showNeighborInfo}
                    onChange={(e) => setShowNeighborInfo(e.target.checked)}
                  />
                  <span>Show Neighbor Info</span>
                </label>
                <label className="map-control-item">
                  <input
                    type="checkbox"
                    checked={showRoute}
                    onChange={(e) => setShowRoute(e.target.checked)}
                  />
                  <span>Show Traceroute</span>
                </label>
                <label className="map-control-item">
                  <input
                    type="checkbox"
                    checked={showMotion}
                    onChange={(e) => setShowMotion(e.target.checked)}
                  />
                  <span>Show Position History</span>
                </label>
              </div>
              <MapContainer
                center={getMapCenter()}
                zoom={nodesWithPosition.length > 0 ? 10 : 8}
                style={{ height: '100%', width: '100%' }}
              >
                <MapCenterController
                  centerTarget={mapCenterTarget}
                  onCenterComplete={handleCenterComplete}
                />
                <TileLayer
                  attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
                  url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                />
                <ZoomHandler onZoomChange={setMapZoom} />
                <MapLegend />
                {nodesWithPosition.map(node => {
                  const roleNum = typeof node.user?.role === 'string'
                    ? parseInt(node.user.role, 10)
                    : (typeof node.user?.role === 'number' ? node.user.role : 0);
                  const isRouter = roleNum === 2;
                  const isSelected = selectedNodeId === node.user?.id;

                  // Get hop count for this node
                  // Local node always gets 0 hops (green), otherwise use hopsAway from protobuf
                  const isLocalNode = node.user?.id === currentNodeId;
                  const hops = isLocalNode ? 0 : (node.hopsAway ?? 999);
                  const showLabel = mapZoom >= 13; // Show labels when zoomed in

                  const markerIcon = createNodeIcon({
                    hops: hops, // 0 (local) = green, 999 (no hops_away data) = grey
                    isSelected,
                    isRouter,
                    shortName: node.user?.shortName,
                    showLabel
                  });

                  return (
                <Marker
                  key={node.nodeNum}
                  position={[node.position!.latitude, node.position!.longitude]}
                  eventHandlers={{
                    click: () => {
                      setSelectedNodeId(node.user?.id || null);
                      centerMapOnNode(node);
                    }
                  }}
                  icon={markerIcon}
                  ref={(ref) => {
                    if (ref && node.user?.id) {
                      markerRefs.current.set(node.user.id, ref);
                    }
                  }}
                >
                  <Popup autoPan={false}>
                    <div className="node-popup">
                      <div className="node-popup-header">
                        <div className="node-popup-title">{node.user?.longName || `Node ${node.nodeNum}`}</div>
                        {node.user?.shortName && (
                          <div className="node-popup-subtitle">{node.user.shortName}</div>
                        )}
                      </div>

                      <div className="node-popup-grid">
                        {node.user?.id && (
                          <div className="node-popup-item">
                            <span className="node-popup-icon">🆔</span>
                            <span className="node-popup-value">{node.user.id}</span>
                          </div>
                        )}

                        {node.user?.role !== undefined && (() => {
                          const roleNum = typeof node.user.role === 'string'
                            ? parseInt(node.user.role, 10)
                            : node.user.role;
                          const roleName = getRoleName(roleNum);
                          return roleName ? (
                            <div className="node-popup-item">
                              <span className="node-popup-icon">👤</span>
                              <span className="node-popup-value">{roleName}</span>
                            </div>
                          ) : null;
                        })()}

                        {node.user?.hwModel !== undefined && (() => {
                          const hwModelName = getHardwareModelName(node.user.hwModel);
                          return hwModelName ? (
                            <div className="node-popup-item">
                              <span className="node-popup-icon">🖥️</span>
                              <span className="node-popup-value">{hwModelName}</span>
                            </div>
                          ) : null;
                        })()}

                        {node.snr != null && (
                          <div className="node-popup-item">
                            <span className="node-popup-icon">📶</span>
                            <span className="node-popup-value">{node.snr.toFixed(1)} dB</span>
                          </div>
                        )}

                        {node.hopsAway != null && (
                          <div className="node-popup-item">
                            <span className="node-popup-icon">🔗</span>
                            <span className="node-popup-value">{node.hopsAway} hop{node.hopsAway !== 1 ? 's' : ''}</span>
                          </div>
                        )}

                        {node.position?.altitude != null && (
                          <div className="node-popup-item">
                            <span className="node-popup-icon">⛰️</span>
                            <span className="node-popup-value">{node.position.altitude}m</span>
                          </div>
                        )}

                        {node.deviceMetrics?.batteryLevel !== undefined && node.deviceMetrics.batteryLevel !== null && (
                          <div className="node-popup-item">
                            <span className="node-popup-icon">{node.deviceMetrics.batteryLevel === 101 ? '🔌' : '🔋'}</span>
                            <span className="node-popup-value">
                              {node.deviceMetrics.batteryLevel === 101 ? 'Plugged In' : `${node.deviceMetrics.batteryLevel}%`}
                            </span>
                          </div>
                        )}
                      </div>

                      {node.lastHeard && (
                        <div className="node-popup-footer">
                          <span className="node-popup-icon">🕐</span>
                          {formatDateTime(new Date(node.lastHeard * 1000), timeFormat, dateFormat)}
                        </div>
                      )}

                      {node.user?.id && hasPermission('messages', 'read') && (
                        <button
                          className="node-popup-btn"
                          onClick={() => {
                            setSelectedDMNode(node.user!.id);
                            setActiveTab('messages');
                          }}
                        >
                          💬 Direct Message
                        </button>
                      )}
                    </div>
                  </Popup>
                </Marker>
                  );
                })}

                {/* Draw uncertainty circles for estimated positions */}
                {nodesWithPosition
                  .filter(node => node.user?.id && nodesWithEstimatedPosition.has(node.user.id))
                  .map(node => {
                    // Calculate radius based on precision bits (higher precision = smaller circle)
                    // Meshtastic uses precision_bits to reduce coordinate precision
                    // Each precision bit reduces precision by ~1 bit, roughly doubling the uncertainty
                    // We'll use a base radius and scale it
                    const baseRadiusMeters = 500; // Base uncertainty radius
                    const radiusMeters = baseRadiusMeters; // Can be adjusted based on precision_bits if available

                    // Get hop color for the circle (same as marker)
                    const isLocalNode = node.user?.id === currentNodeId;
                    const hops = isLocalNode ? 0 : (node.hopsAway ?? 999);
                    const color = getHopColor(hops);

                    return (
                      <Circle
                        key={`estimated-${node.nodeNum}`}
                        center={[node.position!.latitude, node.position!.longitude]}
                        radius={radiusMeters}
                        pathOptions={{
                          color: color,
                          fillColor: color,
                          fillOpacity: 0.1,
                          opacity: 0.4,
                          weight: 2,
                          dashArray: '5, 5'
                        }}
                      />
                    );
                  })}

                {/* Draw traceroute paths */}
                {traceroutePathsElements}

                {/* Draw neighbor info connections */}
                {showNeighborInfo && neighborInfo.length > 0 && neighborInfo.map((ni, idx) => {
                  // Skip if either node doesn't have position
                  if (!ni.nodeLatitude || !ni.nodeLongitude || !ni.neighborLatitude || !ni.neighborLongitude) {
                    return null;
                  }

                  const positions: [number, number][] = [
                    [ni.nodeLatitude, ni.nodeLongitude],
                    [ni.neighborLatitude, ni.neighborLongitude]
                  ];

                  return (
                    <Polyline
                      key={`neighbor-${idx}`}
                      positions={positions}
                      color="#cba6f7"
                      weight={4}
                      opacity={0.7}
                      dashArray="5, 5"
                    >
                      <Popup>
                        <div className="route-popup">
                          <h4>Neighbor Connection</h4>
                          <div className="route-endpoints">
                            <strong>{ni.nodeName}</strong> ↔ <strong>{ni.neighborName}</strong>
                          </div>
                          {ni.snr !== null && ni.snr !== undefined && (
                            <div className="route-usage">
                              SNR: <strong>{ni.snr.toFixed(1)} dB</strong>
                            </div>
                          )}
                          <div className="route-usage">
                            Last seen: <strong>{formatDateTime(new Date(ni.timestamp), timeFormat, dateFormat)}</strong>
                          </div>
                        </div>
                      </Popup>
                    </Polyline>
                  );
                })}

                {/* Draw selected node's traceroute with separate forward and back paths */}
                {showRoute && selectedNodeId && (() => {
                  const selectedTrace = traceroutes.find(tr =>
                    tr.toNodeId === selectedNodeId || tr.fromNodeId === selectedNodeId
                  );

                  if (!selectedTrace) return null;

                  try {
                    const routeForward = JSON.parse(selectedTrace.route || '[]');
                    const routeBack = JSON.parse(selectedTrace.routeBack || '[]');

                    const fromNode = nodes.find(n => n.nodeNum === selectedTrace.fromNodeNum);
                    const toNode = nodes.find(n => n.nodeNum === selectedTrace.toNodeNum);
                    const fromName = fromNode?.user?.longName || fromNode?.user?.shortName || selectedTrace.fromNodeId;
                    const toName = toNode?.user?.longName || toNode?.user?.shortName || selectedTrace.toNodeId;

                    const paths = [];

                    // Forward path (from -> to)
                    // route contains intermediate hops but they're stored in reverse order
                    // Need to reverse the intermediate hops but keep endpoints correct
                    if (routeForward.length >= 0) {
                      // Build path: [source, ...intermediate hops reversed..., destination]
                      const forwardSequence: number[] = [selectedTrace.fromNodeNum, ...routeForward.slice().reverse(), selectedTrace.toNodeNum];
                      const forwardPositions: [number, number][] = [];

                      forwardSequence.forEach((nodeNum) => {
                        const node = processedNodes.find(n => n.nodeNum === nodeNum);
                        if (node?.position?.latitude && node?.position?.longitude) {
                          forwardPositions.push([node.position.latitude, node.position.longitude]);
                        }
                      });

                      if (forwardPositions.length >= 2) {
                        // Calculate total distance for forward path
                        let forwardTotalDistanceKm = 0;
                        for (let i = 0; i < forwardSequence.length - 1; i++) {
                          const node1 = processedNodes.find(n => n.nodeNum === forwardSequence[i]);
                          const node2 = processedNodes.find(n => n.nodeNum === forwardSequence[i + 1]);
                          if (node1?.position?.latitude && node1?.position?.longitude &&
                              node2?.position?.latitude && node2?.position?.longitude) {
                            forwardTotalDistanceKm += calculateDistance(
                              node1.position.latitude, node1.position.longitude,
                              node2.position.latitude, node2.position.longitude
                            );
                          }
                        }

                        paths.push(
                          <Polyline
                            key="selected-traceroute-forward"
                            positions={forwardPositions}
                            color="#f38ba8"
                            weight={4}
                            opacity={0.9}
                            dashArray="10, 5"
                          >
                            <Popup>
                              <div className="route-popup">
                                <h4>Forward Path</h4>
                                <div className="route-endpoints">
                                  <strong>{toName}</strong> → <strong>{fromName}</strong>
                                </div>
                                <div className="route-usage">
                                  Path: {forwardSequence.slice().reverse().map(num => {
                                    const n = nodes.find(nd => nd.nodeNum === num);
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
                          '#f38ba8',
                          paths.length
                        );
                        paths.push(...forwardArrows);
                      }
                    }

                    // Back path (to -> from) - routeBack contains hops from destination back to source
                    if (routeBack.length >= 0) {
                      // routeBack hops need to be reversed to get correct direction: destination -> hops -> source
                      const backSequence: number[] = [selectedTrace.toNodeNum, ...routeBack.slice().reverse(), selectedTrace.fromNodeNum];
                      const backPositions: [number, number][] = [];

                      backSequence.forEach((nodeNum) => {
                        const node = processedNodes.find(n => n.nodeNum === nodeNum);
                        if (node?.position?.latitude && node?.position?.longitude) {
                          backPositions.push([node.position.latitude, node.position.longitude]);
                        }
                      });

                      if (backPositions.length >= 2) {
                        // Calculate total distance for back path
                        let backTotalDistanceKm = 0;
                        for (let i = 0; i < backSequence.length - 1; i++) {
                          const node1 = processedNodes.find(n => n.nodeNum === backSequence[i]);
                          const node2 = processedNodes.find(n => n.nodeNum === backSequence[i + 1]);
                          if (node1?.position?.latitude && node1?.position?.longitude &&
                              node2?.position?.latitude && node2?.position?.longitude) {
                            backTotalDistanceKm += calculateDistance(
                              node1.position.latitude, node1.position.longitude,
                              node2.position.latitude, node2.position.longitude
                            );
                          }
                        }

                        paths.push(
                          <Polyline
                            key="selected-traceroute-back"
                            positions={backPositions}
                            color="#f38ba8"
                            weight={4}
                            opacity={0.9}
                            dashArray="5, 10"
                          >
                            <Popup>
                              <div className="route-popup">
                                <h4>Return Path</h4>
                                <div className="route-endpoints">
                                  <strong>{fromName}</strong> → <strong>{toName}</strong>
                                </div>
                                <div className="route-usage">
                                  Path: {backSequence.slice().reverse().map(num => {
                                    const n = nodes.find(nd => nd.nodeNum === num);
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
                          '#f38ba8',
                          paths.length
                        );
                        paths.push(...backArrows);
                      }
                    }

                    return paths;
                  } catch (error) {
                    logger.error('Error rendering traceroute:', error);
                    return null;
                  }
                })()}

                {/* Draw position history for mobile nodes */}
                {showMotion && positionHistory.length > 1 && (() => {
                  const historyPositions: [number, number][] = positionHistory.map(p =>
                    [p.latitude, p.longitude] as [number, number]
                  );

                  const elements: React.ReactElement[] = [];

                  // Draw blue line for position history
                  elements.push(
                    <Polyline
                      key="position-history-line"
                      positions={historyPositions}
                      color="#0066ff"
                      weight={3}
                      opacity={0.7}
                    >
                      <Popup>
                        <div className="route-popup">
                          <h4>Position History</h4>
                          <div className="route-usage">
                            {positionHistory.length} position{positionHistory.length !== 1 ? 's' : ''} recorded
                          </div>
                          <div className="route-usage">
                            {formatDateTime(new Date(positionHistory[0].timestamp), timeFormat, dateFormat)} - {formatDateTime(new Date(positionHistory[positionHistory.length - 1].timestamp), timeFormat, dateFormat)}
                          </div>
                        </div>
                      </Popup>
                    </Polyline>
                  );

                  // Generate arrow markers for position history
                  const historyArrows = generateArrowMarkers(
                    historyPositions,
                    'position-history',
                    '#0066ff',
                    0
                  );
                  elements.push(...historyArrows);

                  return elements;
                })()}
            </MapContainer>
            {nodesWithPosition.length === 0 && (
              <div className="map-overlay">
                <div className="overlay-content">
                  <h3>📍 No Node Locations</h3>
                  <p>No nodes in your network are currently sharing location data.</p>
                  <p>Nodes with GPS enabled will appear as markers on this map.</p>
                </div>
              </div>
            )}
            </>
          ) : (
            <div className="map-placeholder">
              <div className="placeholder-content">
                <h3>Map View</h3>
                <p>Connect to a Meshtastic node to view node locations on the map</p>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  };

  const renderChannelsTab = () => {
    const availableChannels = getAvailableChannels();
    return (
    <div className="tab-content">
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

                      // Filter traceroutes from Primary channel
                      const primaryChannel = channels.find(ch => ch.name === 'Primary');
                      if (primaryChannel && messageChannel === primaryChannel.id) {
                        messagesForChannel = messagesForChannel.filter(msg => msg.portnum !== 70);
                      }

                      // Sort messages by timestamp (oldest first)
                      messagesForChannel = messagesForChannel.sort((a, b) =>
                        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
                      );

                      return messagesForChannel && messagesForChannel.length > 0 ? (
                      messagesForChannel.map(msg => {
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

                        return (
                          <div key={msg.id} className={`message-bubble-container ${isMine ? 'mine' : 'theirs'}`}>
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
                                {hasPermission('channels', 'write') && (
                                  <div className="message-actions">
                                    <button
                                      className="reply-button"
                                      onClick={() => setReplyingTo(msg)}
                                      title="Reply to this message"
                                    >
                                      ↩
                                    </button>
                                    {TAPBACK_EMOJIS.map(({ emoji, title }) => (
                                      <button
                                        key={emoji}
                                        className="emoji-button"
                                        onClick={() => handleSendTapback(emoji, msg)}
                                        title={title}
                                      >
                                        {emoji}
                                      </button>
                                    ))}
                                  </div>
                                )}
                                <div className="message-text" style={{whiteSpace: 'pre-line'}}>
                                  {msg.text}
                                </div>
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
                                    {formatTime(msg.timestamp, timeFormat)}
                                    <HopCountDisplay hopStart={msg.hopStart} hopLimit={msg.hopLimit} />
                                  </span>
                                </div>
                              </div>
                            </div>
                            {isMine && (
                              <div className="message-status">
                                {(() => {
                                  const messageAge = Date.now() - msg.timestamp.getTime();
                                  const isWaiting = messageAge < 10000 && !msg.acknowledged;

                                  if (msg.ackFailed) {
                                    return <span className="status-failed" title="Failed to send">✗</span>;
                                  } else if (isWaiting) {
                                    return <span className="status-pending" title="Sending...">⏳</span>;
                                  } else {
                                    return <span className="status-delivered" title="Delivered">✓</span>;
                                  }
                                })()}
                              </div>
                            )}
                          </div>
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
                      {hasPermission('channels', 'write') && (
                        <div className="message-input-container">
                          <input
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
                          <button
                            onClick={() => handleSendMessage(selectedChannel)}
                            disabled={!newMessage.trim()}
                            className="send-btn"
                          >
                            Send
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
              </div>
            </div>
          </div>
        );
      })()}
    </div>
    );
  };

  const renderMessagesTab = () => {
    const nodesWithMessages = processedNodes
      .filter(node => node.user?.id !== currentNodeId) // Exclude local node
      .map(node => {
        const nodeId = node.user?.id;
        if (!nodeId) return {
          ...node,
          messageCount: 0,
          unreadCount: 0,
          lastMessageTime: 0
        };

        const dmMessages = getDMMessages(nodeId);
        const unreadCount = dmMessages.filter(msg => {
          return msg.from === nodeId && selectedDMNode !== nodeId;
        }).length;

        return {
          ...node,
          messageCount: dmMessages.length,
          unreadCount: unreadCount,
          lastMessageTime: dmMessages.length > 0 ? Math.max(...dmMessages.map(m => m.timestamp.getTime())) : 0
        };
      });

    // Sort with favorites first
    const favorites = nodesWithMessages.filter(node => node.isFavorite);
    const nonFavorites = nodesWithMessages.filter(node => !node.isFavorite);

    const sortByMessages = (a: any, b: any) => {
      if (a.unreadCount !== b.unreadCount) {
        return b.unreadCount - a.unreadCount;
      }
      if (a.lastMessageTime !== b.lastMessageTime) {
        return b.lastMessageTime - a.lastMessageTime;
      }
      return (b.lastHeard || 0) - (a.lastHeard || 0);
    };

    const sortedFavorites = [...favorites].sort(sortByMessages);
    const sortedNonFavorites = [...nonFavorites].sort(sortByMessages);
    const sortedNodesWithMessages = [...sortedFavorites, ...sortedNonFavorites];

    return (
      <div className="nodes-split-view">
        {/* Left Sidebar - Node List with Messages */}
        <div className={`nodes-sidebar ${isMessagesNodeListCollapsed ? 'collapsed' : ''}`}>
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
              <h3>Messages ({processedNodes.length})</h3>
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
            </div>
            )}
          </div>

          {!isMessagesNodeListCollapsed && (
          <div className="nodes-list">
            {shouldShowData() ? (
              processedNodes.length > 0 ? (
                <>
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
                    .map(node => (
                      <div
                        key={node.nodeNum}
                        className={`node-item ${selectedDMNode === node.user?.id ? 'selected' : ''}`}
                        onClick={() => {
                          setSelectedDMNode(node.user?.id || '');
                        }}
                      >
                        <div className="node-header">
                          <div className="node-name">
                            {node.isFavorite && <span className="favorite-indicator">⭐</span>}
                            {node.user?.longName || `Node ${node.nodeNum}`}
                            {node.unreadCount > 0 && (
                              <span className="unread-badge-inline">{node.unreadCount}</span>
                            )}
                          </div>
                          <div className="node-short">
                            {node.user?.shortName || '-'}
                          </div>
                        </div>

                        <div className="node-details">
                          <div className="node-stats">
                            <span className="stat" title="Total Messages">
                              💬 {node.messageCount}
                            </span>
                            {node.snr != null && (
                              <span className="stat" title="Signal-to-Noise Ratio">
                                📶 {node.snr.toFixed(1)}dB
                              </span>
                            )}
                            {node.deviceMetrics?.batteryLevel !== undefined && node.deviceMetrics.batteryLevel !== null && (
                              <span className="stat" title={node.deviceMetrics.batteryLevel === 101 ? "Plugged In" : "Battery Level"}>
                                {node.deviceMetrics.batteryLevel === 101 ? '🔌' : `🔋 ${node.deviceMetrics.batteryLevel}%`}
                              </span>
                            )}
                            {node.hopsAway != null && (
                              <span className="stat" title="Hops Away">
                                🔗 {node.hopsAway} hop{node.hopsAway !== 1 ? 's' : ''}
                              </span>
                            )}
                          </div>

                          <div className="node-time">
                            {node.lastMessageTime ?
                              formatDateTime(new Date(node.lastMessageTime), timeFormat, dateFormat)
                              : 'Never'
                            }
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
                  {hasPermission('traceroute', 'write') && (
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
                  )}
                </div>
                {(() => {
                  const recentTrace = getRecentTraceroute(selectedDMNode);
                  if (recentTrace) {
                    const age = Math.floor((Date.now() - recentTrace.timestamp) / (1000 * 60));
                    const ageStr = age < 60 ? `${age}m ago` : `${Math.floor(age / 60)}h ago`;

                    return (
                      <div className="traceroute-info">
                        <div className="traceroute-route">
                          <strong>→ Forward:</strong> {formatTracerouteRoute(recentTrace.route, recentTrace.snrTowards, recentTrace.fromNodeNum, recentTrace.toNodeNum)}
                        </div>
                        <div className="traceroute-route">
                          <strong>← Return:</strong> {formatTracerouteRoute(recentTrace.routeBack, recentTrace.snrBack, recentTrace.toNodeNum, recentTrace.fromNodeNum)}
                        </div>
                        <div className="traceroute-age">Last traced {ageStr}</div>
                      </div>
                    );
                  }
                  return null;
                })()}
              </div>

              <div className="messages-container" ref={dmMessagesContainerRef}>
                {(() => {
                  let dmMessages = getDMMessages(selectedDMNode);

                  // Sort messages by timestamp (oldest first, newest at bottom)
                  dmMessages = dmMessages.sort((a, b) =>
                    new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
                  );

                  return dmMessages.length > 0 ? (
                    dmMessages.map(msg => {
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

                      if (isTraceroute) {
                        // Keep traceroute messages in simple format
                        return (
                          <div key={msg.id} className="message-item traceroute">
                            <div className="message-header">
                              <span className="message-from">{getNodeName(msg.from)}</span>
                              <span className="message-time">
                                {formatTime(msg.timestamp, timeFormat)}
                                <HopCountDisplay hopStart={msg.hopStart} hopLimit={msg.hopLimit} />
                              </span>
                              <span className="traceroute-badge">TRACEROUTE</span>
                            </div>
                            <div className="message-text" style={{whiteSpace: 'pre-line', fontFamily: 'monospace'}}>{msg.text}</div>
                          </div>
                        );
                      }

                      return (
                        <div key={msg.id} className={`message-bubble-container ${isMine ? 'mine' : 'theirs'}`}>
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
                                    onClick={() => setReplyingTo(msg)}
                                    title="Reply to this message"
                                  >
                                    ↩
                                  </button>
                                  {TAPBACK_EMOJIS.map(({ emoji, title }) => (
                                    <button
                                      key={emoji}
                                      className="emoji-button"
                                      onClick={() => handleSendTapback(emoji, msg)}
                                      title={title}
                                    >
                                      {emoji}
                                    </button>
                                  ))}
                                </div>
                              )}
                              <div className="message-text" style={{whiteSpace: 'pre-line'}}>
                                {msg.text}
                              </div>
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
                                  {formatTime(msg.timestamp, timeFormat)}
                                  <HopCountDisplay hopStart={msg.hopStart} hopLimit={msg.hopLimit} />
                                </span>
                              </div>
                            </div>
                          </div>
                          {isMine && (
                            <div className="message-status">
                              {(() => {
                                const messageAge = Date.now() - msg.timestamp.getTime();
                                const isWaiting = messageAge < 10000 && !msg.acknowledged;

                                if (msg.ackFailed) {
                                  return <span className="status-failed" title="Failed to send">✗</span>;
                                } else if (isWaiting) {
                                  return <span className="status-pending" title="Sending...">⏳</span>;
                                } else {
                                  return <span className="status-delivered" title="Delivered">✓</span>;
                                }
                              })()}
                            </div>
                          )}
                        </div>
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
                      <input
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
                      <button
                        onClick={() => handleSendDirectMessage(selectedDMNode)}
                        disabled={!newMessage.trim()}
                        className="send-btn"
                      >
                        Send
                      </button>
                    </div>
                  )}
                </div>
              )}

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

  // Memoize traceroute path rendering to prevent chart flickering
  const traceroutePathsElements = useMemo(() => {
    if (!showPaths) return null;

    // Calculate segment usage counts and collect SNR values with timestamps
    const segmentUsage = new Map<string, number>();
    const segmentSNRs = new Map<string, Array<{snr: number; timestamp: number}>>();
    const segmentsList: Array<{
      key: string;
      positions: [number, number][];
      nodeNums: number[];
    }> = [];

    traceroutes.forEach((tr, idx) => {
      try {
        // Process forward path
        const routeForward = JSON.parse(tr.route || '[]');
        const snrForward = JSON.parse(tr.snrTowards || '[]');
        const timestamp = tr.timestamp || tr.createdAt || Date.now();
        // Reverse intermediate hops to get correct direction: source -> hops -> destination
        const forwardSequence: number[] = [tr.fromNodeNum, ...routeForward.slice().reverse(), tr.toNodeNum];
        const forwardPositions: Array<{nodeNum: number; pos: [number, number]}> = [];

        // Build forward sequence with positions
        forwardSequence.forEach((nodeNum) => {
          const node = nodes.find(n => n.nodeNum === nodeNum);
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

        // Process return path
        const routeBack = JSON.parse(tr.routeBack || '[]');
        const snrBack = JSON.parse(tr.snrBack || '[]');
        // routeBack hops need to be reversed to get correct direction: destination -> hops -> source
        const backSequence: number[] = [tr.toNodeNum, ...routeBack.slice().reverse(), tr.fromNodeNum];
        const backPositions: Array<{nodeNum: number; pos: [number, number]}> = [];

        // Build back sequence with positions
        backSequence.forEach((nodeNum) => {
          const node = nodes.find(n => n.nodeNum === nodeNum);
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
    return segmentsList.map((segment) => {
      const segmentKey = segment.nodeNums.sort().join('-');
      const usage = segmentUsage.get(segmentKey) || 1;
      // Base weight 2, add 1 per usage, max 8
      const weight = Math.min(2 + usage, 8);

      // Get node names for popup
      const node1 = nodes.find(n => n.nodeNum === segment.nodeNums[0]);
      const node2 = nodes.find(n => n.nodeNum === segment.nodeNums[1]);
      const node1Name = node1?.user?.longName || node1?.user?.shortName || `!${segment.nodeNums[0].toString(16)}`;
      const node2Name = node2?.user?.longName || node2?.user?.shortName || `!${segment.nodeNums[1].toString(16)}`;

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
          color="#cba6f7"
          weight={weight}
          opacity={0.7}
        >
          <Popup>
            <div className="route-popup">
              <h4>Route Segment</h4>
              <div className="route-endpoints">
                <strong>{node1Name}</strong> ↔ <strong>{node2Name}</strong>
              </div>
              <div className="route-usage">
                Used in <strong>{usage}</strong> traceroute{usage !== 1 ? 's' : ''}
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
  }, [showPaths, traceroutes, nodes, distanceUnit]);

  return (
    <div className="app">
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
                    title={`Connected to: ${nodeAddress}`}
                    style={{ cursor: 'help' }}
                  >
                    {longName} ({shortName}) - {nodeId}
                  </span>
                );
              }

              if (localNode && localNode.user) {
                return (
                  <span
                    className="node-address"
                    title={`Connected to: ${nodeAddress}`}
                    style={{ cursor: 'help' }}
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
              <span>{connectionStatus === 'user-disconnected' ? 'Disconnected' : connectionStatus === 'configuring' ? 'initializing' : connectionStatus}</span>
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
        <div style={{
          backgroundColor: '#dc2626',
          color: 'white',
          padding: '8px 16px',
          textAlign: 'center',
          fontSize: '14px',
          fontWeight: '500',
          borderBottom: '2px solid #991b1b'
        }}>
          ⚠️ Security Warning: The admin account is using the default password. Please change it immediately in the Users tab.
        </div>
      )}

      {updateAvailable && (
        <div style={{
          backgroundColor: '#3b82f6',
          color: 'white',
          padding: '8px 16px',
          textAlign: 'center',
          fontSize: '14px',
          fontWeight: '500',
          borderBottom: '2px solid #1d4ed8'
        }}>
          🔔 Update Available: Version {latestVersion} is now available.{' '}
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
        </div>
      )}

      <LoginModal isOpen={showLoginModal} onClose={() => setShowLoginModal(false)} />

      <Sidebar
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        hasPermission={hasPermission}
        isAdmin={authStatus?.user?.isAdmin || false}
        unreadCounts={unreadCounts}
        onMessagesClick={() => {
          setActiveTab('messages');
          // Clear unread count for direct messages (channel -1)
          setUnreadCounts(prev => ({ ...prev, [-1]: 0 }));
          // Set selected channel to -1 so new DMs don't create unread notifications
          setSelectedChannel(-1);
          selectedChannelRef.current = -1;
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

        {activeTab === 'nodes' && renderNodesTab()}
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
          />
        )}
        {activeTab === 'dashboard' && (
          <Dashboard
            temperatureUnit={temperatureUnit}
            telemetryHours={telemetryVisualizationHours}
            baseUrl={baseUrl}
          />
        )}
        {activeTab === 'settings' && (
          <SettingsTab
            maxNodeAgeHours={maxNodeAgeHours}
            temperatureUnit={temperatureUnit}
            distanceUnit={distanceUnit}
            telemetryVisualizationHours={telemetryVisualizationHours}
            preferredSortField={preferredSortField}
            preferredSortDirection={preferredSortDirection}
            timeFormat={timeFormat}
            dateFormat={dateFormat}
            baseUrl={baseUrl}
            onMaxNodeAgeChange={setMaxNodeAgeHours}
            onTemperatureUnitChange={setTemperatureUnit}
            onDistanceUnitChange={setDistanceUnit}
            onTelemetryVisualizationChange={setTelemetryVisualizationHours}
            onPreferredSortFieldChange={setPreferredSortField}
            onPreferredSortDirectionChange={setPreferredSortDirection}
            onTimeFormatChange={setTimeFormat}
            onDateFormatChange={setDateFormat}
          />
        )}
        {activeTab === 'automation' && (
          <div className="settings-tab">
            <div className="settings-content">
              <AutoTracerouteSection
                intervalMinutes={tracerouteIntervalMinutes}
                baseUrl={baseUrl}
                onIntervalChange={setTracerouteIntervalMinutes}
              />
              <AutoAcknowledgeSection
                enabled={autoAckEnabled}
                regex={autoAckRegex}
                baseUrl={baseUrl}
                onEnabledChange={setAutoAckEnabled}
                onRegexChange={setAutoAckRegex}
              />
              <AutoAnnounceSection
                enabled={autoAnnounceEnabled}
                intervalHours={autoAnnounceIntervalHours}
                message={autoAnnounceMessage}
                channelIndex={autoAnnounceChannelIndex}
                announceOnStart={autoAnnounceOnStart}
                channels={channels}
                baseUrl={baseUrl}
                onEnabledChange={setAutoAnnounceEnabled}
                onIntervalChange={setAutoAnnounceIntervalHours}
                onMessageChange={setAutoAnnounceMessage}
                onChannelChange={setAutoAnnounceChannelIndex}
                onAnnounceOnStartChange={setAutoAnnounceOnStart}
              />
            </div>
          </div>
        )}
        {activeTab === 'configuration' && (
          <ConfigurationTab
            baseUrl={baseUrl}
            nodes={nodes}
            onRebootDevice={handleRebootDevice}
            onConfigChangeTriggeringReboot={handleConfigChangeTriggeringReboot}
          />
        )}
        {activeTab === 'users' && <UsersTab />}
        {activeTab === 'audit' && <AuditLogTab />}
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

      {/* Footer */}
      <footer className="app-footer">
        <div className="footer-content">
          <span className="footer-title">MeshMonitor</span>
          <span className="footer-version">v{version}</span>
          <a
            href="https://github.com/Yeraze/meshmonitor"
            target="_blank"
            rel="noopener noreferrer"
            className="footer-link"
          >
            GitHub
          </a>
        </div>
      </footer>
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
          <MessagingProvider>
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
