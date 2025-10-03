import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { MapContainer, TileLayer, Marker, Popup, Polyline, useMap } from 'react-leaflet'
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import './App.css'
import TelemetryGraphs from './components/TelemetryGraphs'
import InfoTab from './components/InfoTab'
import SettingsTab from './components/SettingsTab'
import Dashboard from './components/Dashboard'
import { version } from '../package.json'
import { type TemperatureUnit } from './utils/temperature'
import { calculateDistance, formatDistance } from './utils/distance'
import { DeviceInfo, Channel } from './types/device'
import { MeshMessage } from './types/message'
import { TabType, SortField, SortDirection, ConnectionStatus, MapCenterControllerProps } from './types/ui'
import api from './services/api'
import { defaultIcon, selectedIcon, routerIcon, selectedRouterIcon } from './utils/mapIcons'
import { getRoleName, generateArrowMarkers } from './utils/mapHelpers.tsx'
import { getHardwareModelName } from './utils/nodeHelpers'

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
      map.setView(centerTarget, 15); // Zoom level 15 for close view
      onCenterComplete(); // Reset target after centering
    }
  }, [centerTarget, onCenterComplete]); // Removed 'map' from dependencies to prevent repeated re-centering

  return null;
};

function App() {
  const [activeTab, setActiveTab] = useState<TabType>('nodes')
  const [nodes, setNodes] = useState<DeviceInfo[]>([])
  const [channels, setChannels] = useState<Channel[]>([])
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('disconnected')
  const [messages, setMessages] = useState<MeshMessage[]>([])
  const [selectedDMNode, setSelectedDMNode] = useState<string>('')
  const [channelMessages, setChannelMessages] = useState<{[key: number]: MeshMessage[]}>({})
  const [selectedChannel, setSelectedChannel] = useState<number>(-1)
  const hasSelectedInitialChannelRef = useRef<boolean>(false)
  const selectedChannelRef = useRef<number>(-1)
  const [showMqttMessages, setShowMqttMessages] = useState<boolean>(false)
  const [newMessage, setNewMessage] = useState<string>('')
  const [error, setError] = useState<string | null>(null)
  const [nodeAddress, setNodeAddress] = useState<string>('Loading...')
  const [deviceInfo, setDeviceInfo] = useState<any>(null)
  const [deviceConfig, setDeviceConfig] = useState<any>(null)
  const [currentNodeId, setCurrentNodeId] = useState<string>('')
  const channelMessagesContainerRef = useRef<HTMLDivElement>(null)
  const dmMessagesContainerRef = useRef<HTMLDivElement>(null)
  const [pendingMessages, setPendingMessages] = useState<Map<string, MeshMessage>>(new Map())
  const [unreadCounts, setUnreadCounts] = useState<{[key: number]: number}>({})
  const audioRef = useRef<HTMLAudioElement | null>(null)
  // const lastNotificationTime = useRef<number>(0) // Disabled for now
  const [tracerouteLoading, setTracerouteLoading] = useState<string | null>(null)
  const [showPaths, setShowPaths] = useState<boolean>(false)
  const [showRoute, setShowRoute] = useState<boolean>(true)
  const [showMotion, setShowMotion] = useState<boolean>(true)
  const [traceroutes, setTraceroutes] = useState<any[]>([])
  const [nodesWithTelemetry, setNodesWithTelemetry] = useState<Set<string>>(new Set())
  const [nodesWithWeatherTelemetry, setNodesWithWeatherTelemetry] = useState<Set<string>>(new Set())
  const [positionHistory, setPositionHistory] = useState<{latitude: number; longitude: number; timestamp: number}[]>([])
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

  // Settings
  const [maxNodeAgeHours, setMaxNodeAgeHours] = useState<number>(() => {
    const saved = localStorage.getItem('maxNodeAgeHours');
    return saved ? parseInt(saved) : 24;
  });
  const [tracerouteIntervalMinutes, setTracerouteIntervalMinutes] = useState<number>(() => {
    const saved = localStorage.getItem('tracerouteIntervalMinutes');
    return saved ? parseInt(saved) : 3;
  });
  const [temperatureUnit, setTemperatureUnit] = useState<TemperatureUnit>(() => {
    const saved = localStorage.getItem('temperatureUnit');
    return (saved === 'F' ? 'F' : 'C') as TemperatureUnit;
  });
  const [distanceUnit, setDistanceUnit] = useState<'km' | 'mi'>(() => {
    const saved = localStorage.getItem('distanceUnit');
    return (saved === 'mi' ? 'mi' : 'km') as 'km' | 'mi';
  });
  const [telemetryVisualizationHours, setTelemetryVisualizationHours] = useState<number>(() => {
    const saved = localStorage.getItem('telemetryVisualizationHours');
    return saved ? parseInt(saved) : 24;
  });

  // New state for node list features
  const [nodeFilter, setNodeFilter] = useState<string>('')
  const [sortField, setSortField] = useState<SortField>('longName')
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc')

  // System status modal state
  const [showStatusModal, setShowStatusModal] = useState<boolean>(false)
  const [systemStatus, setSystemStatus] = useState<any>(null)

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
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [mapCenterTarget, setMapCenterTarget] = useState<[number, number] | null>(null)
  const [nodePopup, setNodePopup] = useState<{nodeId: string, position: {x: number, y: number}} | null>(null)
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
  //     audioRef.current.play().catch(err => console.log('Audio play failed:', err));
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
          console.error('Failed to load config:', error);
          setNodeAddress('192.168.1.100');
          setBaseUrl('');
        }

        // Load settings from server
        const settingsResponse = await fetch(`${configBaseUrl}/api/settings`);
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

  // Debug effect to track selectedChannel changes and keep ref in sync
  useEffect(() => {
    console.log('🔄 selectedChannel state changed to:', selectedChannel);
    selectedChannelRef.current = selectedChannel;
  }, [selectedChannel]);

  // Fetch traceroutes when showPaths is enabled or Messages/Nodes tab is active
  useEffect(() => {
    if ((showPaths || activeTab === 'messages' || activeTab === 'nodes') && connectionStatus === 'connected') {
      fetchTraceroutes();
      const interval = setInterval(fetchTraceroutes, 10000); // Refresh every 10 seconds
      return () => clearInterval(interval);
    }
  }, [showPaths, activeTab, connectionStatus]);

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
        const response = await fetch(`${baseUrl}/api/nodes/${selectedNodeId}/position-history?hours=168`);
        if (response.ok) {
          const history = await response.json();
          setPositionHistory(history);
        }
      } catch (error) {
        console.error('Error fetching position history:', error);
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

  // Auto-scroll to bottom when messages change or channel changes
  const scrollToBottom = useCallback(() => {
    // Scroll the appropriate container based on active tab
    if (activeTab === 'channels' && channelMessagesContainerRef.current) {
      channelMessagesContainerRef.current.scrollTop = channelMessagesContainerRef.current.scrollHeight;
    } else if (activeTab === 'nodes' && dmMessagesContainerRef.current) {
      dmMessagesContainerRef.current.scrollTop = dmMessagesContainerRef.current.scrollHeight;
    }
  }, [activeTab]);

  useEffect(() => {
    if (activeTab === 'channels') {
      scrollToBottom();
    }
  }, [channelMessages, selectedChannel, activeTab, scrollToBottom]);

  useEffect(() => {
    if (activeTab === 'nodes' && selectedDMNode) {
      scrollToBottom();
    }
  }, [messages, selectedDMNode, activeTab, scrollToBottom]);

  // Regular data updates (every 5 seconds)
  useEffect(() => {
    const updateInterval = setInterval(() => {
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
        console.log('🔄 Performing scheduled node database refresh...');
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

  const requestFullNodeDatabase = async () => {
    try {
      console.log('📡 Requesting full node database refresh...');
      const response = await fetch(`${baseUrl}/api/nodes/refresh`, {
        method: 'POST'
      });

      if (response.ok) {
        console.log('✅ Node database refresh initiated');
        // Immediately update local data after refresh
        setTimeout(() => updateDataFromBackend(), 2000);
      } else {
        console.warn('⚠️ Node database refresh request failed');
      }
    } catch (error) {
      console.error('❌ Error requesting node database refresh:', error);
    }
  };

  const checkConnectionStatus = async (providedBaseUrl?: string) => {
    // Use the provided baseUrl or fall back to the state value
    const urlBase = providedBaseUrl !== undefined ? providedBaseUrl : baseUrl;
    try {
      const response = await fetch(`${urlBase}/api/connection`);
      if (response.ok) {
        const status = await response.json();
        if (status.connected) {
          if (connectionStatus !== 'connected') {
            console.log('🔗 Connection established, initializing...');
            setConnectionStatus('configuring');
            setError(null);

            // Improved initialization sequence
            // Backend already requested full configuration on startup,
            // so we just need to fetch the data that's already available
            try {
              await fetchChannels(urlBase); // Fetch channels first with the correct baseUrl
              await updateDataFromBackend(); // Then get current data
              setConnectionStatus('connected');
              console.log('✅ Initialization complete');
            } catch (initError) {
              console.error('❌ Initialization failed:', initError);
              setConnectionStatus('connected'); // Still mark as connected even if init partially fails
            }
          }
        } else {
          setConnectionStatus('disconnected');
          setError(`Cannot connect to Meshtastic node at ${nodeAddress}. Please ensure the node is reachable and has HTTP API enabled.`);
        }
      } else {
        setConnectionStatus('disconnected');
        setError('Failed to get connection status from server');
      }
    } catch (err) {
      setConnectionStatus('disconnected');
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      setError(`Server connection error: ${errorMessage}`);
    }
  };

  const fetchTraceroutes = async () => {
    try {
      const response = await fetch(`${baseUrl}/api/traceroutes/recent`);
      if (response.ok) {
        const data = await response.json();
        setTraceroutes(data);
      }
    } catch (error) {
      console.error('Error fetching traceroutes:', error);
    }
  };

  const fetchNodesWithTelemetry = async () => {
    try {
      const response = await fetch(`${baseUrl}/api/telemetry/available/nodes`);
      if (response.ok) {
        const data = await response.json();
        setNodesWithTelemetry(new Set(data.nodes));
        setNodesWithWeatherTelemetry(new Set(data.weather || []));
      }
    } catch (error) {
      console.error('Error fetching telemetry availability:', error);
    }
  };

  const fetchSystemStatus = async () => {
    try {
      const response = await fetch(`${baseUrl}/api/system/status`);
      if (response.ok) {
        const data = await response.json();
        setSystemStatus(data);
        setShowStatusModal(true);
      }
    } catch (error) {
      console.error('Error fetching system status:', error);
    }
  };

  const fetchChannels = async (providedBaseUrl?: string) => {
    // Use the provided baseUrl or fall back to the state value
    const urlBase = providedBaseUrl !== undefined ? providedBaseUrl : baseUrl;
    try {
      const channelsResponse = await fetch(`${urlBase}/api/channels`);
      if (channelsResponse.ok) {
        const channelsData = await channelsResponse.json();

        // Only update selected channel if this is the first time we're loading channels
        // and no channel is currently selected, or if the current selected channel no longer exists
        const currentSelectedChannel = selectedChannelRef.current;
        console.log('🔍 Channel update check:', {
          channelsLength: channelsData.length,
          hasSelectedInitialChannel: hasSelectedInitialChannelRef.current,
          selectedChannelState: selectedChannel,
          selectedChannelRef: currentSelectedChannel,
          firstChannelId: channelsData[0]?.id
        });

        if (channelsData.length > 0) {
          if (!hasSelectedInitialChannelRef.current && currentSelectedChannel === -1) {
            // First time loading channels - select the first one
            console.log('🎯 Setting initial channel to:', channelsData[0].id);
            setSelectedChannel(channelsData[0].id);
            selectedChannelRef.current = channelsData[0].id; // Update ref immediately
            console.log('📝 Called setSelectedChannel (initial) with:', channelsData[0].id);
            hasSelectedInitialChannelRef.current = true;
          } else {
            // Check if the currently selected channel still exists
            const currentChannelExists = channelsData.some((ch: Channel) => ch.id === currentSelectedChannel);
            console.log('🔍 Channel exists check:', { selectedChannel: currentSelectedChannel, currentChannelExists });
            if (!currentChannelExists && channelsData.length > 0) {
              // Current channel no longer exists, fallback to first channel
              console.log('⚠️ Current channel no longer exists, falling back to:', channelsData[0].id);
              setSelectedChannel(channelsData[0].id);
              selectedChannelRef.current = channelsData[0].id; // Update ref immediately
              console.log('📝 Called setSelectedChannel (fallback) with:', channelsData[0].id);
            } else {
              console.log('✅ Keeping current channel selection:', currentSelectedChannel);
            }
          }
        }

        setChannels(channelsData);
      }
    } catch (error) {
      console.error('Error fetching channels:', error);
    }
  };

  const updateDataFromBackend = async () => {
    try {
      // Fetch nodes
      const nodesResponse = await fetch(`${baseUrl}/api/nodes`);
      if (nodesResponse.ok) {
        const nodesData = await nodesResponse.json();
        setNodes(nodesData);
      }

      // Fetch messages
      const messagesResponse = await fetch(`${baseUrl}/api/messages?limit=100`);
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

        console.log('📊 Updating unread counts:', {
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
      const configResponse = await fetch(`${baseUrl}/api/config`);
      if (configResponse.ok) {
        const configData = await configResponse.json();
        setDeviceInfo(configData);
      }

      // Fetch device configuration
      const deviceConfigResponse = await fetch(`${baseUrl}/api/device-config`);
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
      console.error('Failed to update data from backend:', error);
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

  const getTracerouteHopCount = (nodeId: string): number => {
    const traceroute = getRecentTraceroute(nodeId);
    if (!traceroute || traceroute.hopCount === undefined) return 999;
    return traceroute.hopCount;
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

      await fetch(`${baseUrl}/api/traceroute`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ destination: nodeNum })
      });

      console.log(`🗺️ Traceroute request sent to ${nodeId}`);

      // Clear loading state after 30 seconds
      setTimeout(() => {
        setTracerouteLoading(null);
      }, 30000);
    } catch (error) {
      console.error('Failed to send traceroute:', error);
      setTracerouteLoading(null);
    }
  };

  const handleSendDirectMessage = async (destinationNodeId: string) => {
    if (!newMessage.trim() || connectionStatus !== 'connected') {
      return;
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
      portnum: 1 // Text message
    };

    // Add message to local state immediately for instant feedback
    setMessages(prev => [...prev, sentMessage]);

    try {
      const response = await fetch(`${baseUrl}/api/messages/send`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          text: newMessage,
          channel: 0, // Backend may expect channel 0 for DMs
          destination: destinationNodeId
        })
      });

      if (response.ok) {
        console.log('Direct message sent successfully');
        setNewMessage('');
        // The message will be updated when we receive the acknowledgment from backend
      } else {
        console.error('Failed to send direct message');
        // Remove the message from local state if sending failed
        setMessages(prev => prev.filter(msg => msg.id !== tempId));
        setError('Failed to send direct message');
      }
    } catch (error) {
      console.error('Error sending direct message:', error);
      // Remove the message from local state if sending failed
      setMessages(prev => prev.filter(msg => msg.id !== tempId));
      setError(`Failed to send direct message: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  };

  const handleSendMessage = async (channel: number = 0) => {
    if (!newMessage.trim() || connectionStatus !== 'connected') {
      return;
    }

    // Use channel ID directly - no mapping needed
    const messageChannel = channel;

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
      acknowledged: false
    };

    // Add message to local state immediately
    setMessages(prev => [...prev, sentMessage]);
    setChannelMessages(prev => ({
      ...prev,
      [messageChannel]: [...(prev[messageChannel] || []), sentMessage]
    }));

    // Add to pending acknowledgments
    setPendingMessages(prev => new Map(prev).set(tempId, sentMessage));

    // Clear the input
    const messageText = newMessage;
    setNewMessage('');

    try {
      const response = await fetch(`${baseUrl}/api/messages/send`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          text: messageText,
          channel: messageChannel
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
        case 'location':
          aVal = a.position ? `${a.position.latitude},${a.position.longitude}` : '';
          bVal = b.position ? `${b.position.latitude},${b.position.longitude}` : '';
          break;
        case 'hops':
          // For nodes without hop data, use fallback values that push them to bottom
          // Ascending: use 999 (high value = bottom), Descending: use -1 (low value = bottom)
          const noHopFallback = direction === 'asc' ? 999 : -1;
          aVal = a.user?.id ? getTracerouteHopCount(a.user.id) : noHopFallback;
          bVal = b.user?.id ? getTracerouteHopCount(b.user.id) : noHopFallback;
          // Also treat 999 from getTracerouteHopCount as no data
          if (aVal === 999) aVal = noHopFallback;
          if (bVal === 999) bVal = noHopFallback;
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
    return sortNodes(textFiltered, sortField, sortDirection);
  }, [nodes, maxNodeAgeHours, nodeFilter, sortField, sortDirection]);

  // Function to center map on a specific node
  const centerMapOnNode = useCallback((node: DeviceInfo) => {
    if (node.position && node.position.latitude != null && node.position.longitude != null) {
      setMapCenterTarget([node.position.latitude, node.position.longitude]);
    }
  }, []);

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

  // Helper function to check if a message is a single emoji
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
        {/* Left Sidebar - Node List */}
        <div className="nodes-sidebar">
          <div className="sidebar-header">
            <h3>Nodes ({processedNodes.length})</h3>
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
                  <option value="lastHeard">Sort: Updated</option>
                  <option value="snr">Sort: Signal</option>
                  <option value="battery">Sort: Charge</option>
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
          </div>

          <div className="nodes-list">
            {connectionStatus === 'connected' ? (
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
                        {node.user?.longName || `Node ${node.nodeNum}`}
                        {node.user?.role !== undefined && node.user?.role !== null && getRoleName(node.user.role) && (
                          <span className="node-role" title="Node Role"> {getRoleName(node.user.role)}</span>
                        )}
                      </div>
                      <div className="node-actions">
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
                          new Date(node.lastHeard * 1000).toLocaleString([], {
                            month: 'short',
                            day: 'numeric',
                            hour: '2-digit',
                            minute: '2-digit'
                          })
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
                      {node.user?.id && (() => {
                        const hopCount = getTracerouteHopCount(node.user.id);
                        return hopCount < 999;
                      })() && (
                        <div className="node-hops" title="Traceroute Hops">
                          {getTracerouteHopCount(node.user.id)}
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
        </div>

        {/* Right Side - Map */}
        <div className="map-container">
          {connectionStatus === 'connected' ? (
            <>
              <div className="map-controls">
                <label className="map-control-item">
                  <input
                    type="checkbox"
                    checked={showPaths}
                    onChange={(e) => setShowPaths(e.target.checked)}
                  />
                  <span>Show Paths</span>
                </label>
                <label className="map-control-item">
                  <input
                    type="checkbox"
                    checked={showRoute}
                    onChange={(e) => setShowRoute(e.target.checked)}
                  />
                  <span>Show Route</span>
                </label>
                <label className="map-control-item">
                  <input
                    type="checkbox"
                    checked={showMotion}
                    onChange={(e) => setShowMotion(e.target.checked)}
                  />
                  <span>Show Motion</span>
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
                {nodesWithPosition.map(node => {
                  const roleNum = typeof node.user?.role === 'string'
                    ? parseInt(node.user.role, 10)
                    : (typeof node.user?.role === 'number' ? node.user.role : 0);
                  const isRouter = roleNum === 2;
                  const isSelected = selectedNodeId === node.user?.id;
                  const markerIcon = isRouter
                    ? (isSelected ? selectedRouterIcon : routerIcon)
                    : (isSelected ? selectedIcon : defaultIcon);

                  return (
                <Marker
                  key={node.nodeNum}
                  position={[node.position!.latitude, node.position!.longitude]}
                  eventHandlers={{
                    click: () => {
                      setSelectedNodeId(node.user?.id || null);
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
                    <div className="route-popup">
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
                        <div className="route-usage">Last Seen: {new Date(node.lastHeard * 1000).toLocaleString()}</div>
                      )}

                      {node.user?.id && (
                        <button
                          className="popup-dm-btn"
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

                {/* Draw traceroute paths */}
                {showPaths && (() => {
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
                      console.error('Error parsing traceroute:', error);
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
                })()}

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
                    console.error('Error rendering traceroute:', error);
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
                            {new Date(positionHistory[0].timestamp).toLocaleString()} - {new Date(positionHistory[positionHistory.length - 1].timestamp).toLocaleString()}
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
      {connectionStatus === 'connected' ? (
        availableChannels.length > 0 ? (
          <>
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
                    console.log('👆 User clicked channel:', channelId, 'Previous selected:', selectedChannel);
                    setSelectedChannel(channelId);
                    selectedChannelRef.current = channelId; // Update ref immediately
                    setUnreadCounts(prev => {
                      const updated = { ...prev, [channelId]: 0 };
                      console.log('📝 Setting unread counts:', updated);
                      return updated;
                    });
                  }}
                >
                  <div className="channel-button-header">
                    <span className="channel-name">{displayName}</span>
                    <span className="channel-id">#{channelId}</span>
                    {unreadCounts[channelId] > 0 && (
                      <span className="unread-badge">{unreadCounts[channelId]}</span>
                    )}
                  </div>
                  <div className="channel-button-status">
                    <span className={`arrow-icon uplink ${channelConfig?.uplinkEnabled ? 'enabled' : 'disabled'}`} title="Uplink">
                      ↑
                    </span>
                    <span className={`arrow-icon downlink ${channelConfig?.downlinkEnabled ? 'enabled' : 'disabled'}`} title="Downlink">
                      ↓
                    </span>
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
                      console.log(`🔍 Channel display debug: selectedChannel=${selectedChannel}, messageChannel=${messageChannel}, messagesFound=${messagesForChannel.length}`);

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
                        const isPending = pendingMessages.has(msg.id);
                        const repliedMessage = msg.replyId ? findMessageById(msg.replyId, messageChannel) : null;
                        const isReaction = msg.emoji === 1;

                        // Hide reactions (tapbacks) from main message list
                        // They will be shown inline under the original message if it exists
                        if (isReaction) {
                          return null;
                        }

                        const reactions = messagesForChannel.filter(m =>
                          m.emoji === 1 && m.replyId &&
                          findMessageById(m.replyId, messageChannel)?.id === msg.id
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
                              {repliedMessage && !isReaction && (
                                <div className="replied-message">
                                  <div className="reply-arrow">↳</div>
                                  <div className="reply-content">
                                    <div className="reply-from">{getNodeShortName(repliedMessage.from)}</div>
                                    <div className="reply-text">{repliedMessage.text || "Empty Message"}</div>
                                  </div>
                                </div>
                              )}
                              <div className={`message-bubble ${isMine ? 'mine' : 'theirs'}`}>
                                <div className="message-text">
                                  {msg.text}
                                </div>
                                {reactions.length > 0 && (
                                  <div className="message-reactions">
                                    {reactions.map(reaction => (
                                      <span key={reaction.id} className="reaction" title={`From ${getNodeShortName(reaction.from)}`}>
                                        {reaction.text}
                                      </span>
                                    ))}
                                  </div>
                                )}
                                <div className="message-meta">
                                  <span className="message-time">
                                    {msg.timestamp.toLocaleTimeString([], {
                                      hour: '2-digit',
                                      minute: '2-digit'
                                    })}
                                  </span>
                                </div>
                              </div>
                            </div>
                            {isMine && (
                              <div className="message-status">
                                {isPending ? (
                                  <span className="status-pending" title="Sending...">⏳</span>
                                ) : (
                                  <span className="status-delivered" title="Delivered">✓</span>
                                )}
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
    </div>
    );
  };

  const renderMessagesTab = () => {
    const nodesWithMessages = processedNodes.map(node => {
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

    const sortedNodesWithMessages = [...nodesWithMessages].sort((a, b) => {
      if (a.unreadCount !== b.unreadCount) {
        return b.unreadCount - a.unreadCount;
      }
      if (a.lastMessageTime !== b.lastMessageTime) {
        return b.lastMessageTime - a.lastMessageTime;
      }
      return (b.lastHeard || 0) - (a.lastHeard || 0);
    });

    return (
      <div className="nodes-split-view">
        {/* Left Sidebar - Node List with Messages */}
        <div className="nodes-sidebar">
          <div className="sidebar-header">
            <h3>Messages ({processedNodes.length})</h3>
            <div className="node-controls">
              <input
                type="text"
                placeholder="Filter nodes..."
                value={nodeFilter}
                onChange={(e) => setNodeFilter(e.target.value)}
                className="filter-input-small"
              />
            </div>
          </div>

          <div className="nodes-list">
            {connectionStatus === 'connected' ? (
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
                          </div>

                          <div className="node-time">
                            {node.lastMessageTime ?
                              new Date(node.lastMessageTime).toLocaleString([], {
                                month: 'short',
                                day: 'numeric',
                                hour: '2-digit',
                                minute: '2-digit'
                              })
                              : 'Never'
                            }
                          </div>
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
                            Last seen: {new Date(selectedNode.lastHeard * 1000).toLocaleString([], {
                              month: 'short',
                              day: 'numeric',
                              hour: '2-digit',
                              minute: '2-digit'
                            })}
                          </div>
                        );
                      }
                      return null;
                    })()}
                  </h3>
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
                {getDMMessages(selectedDMNode).length > 0 ? (
                  getDMMessages(selectedDMNode).map(msg => {
                    const isTraceroute = msg.portnum === 70;
                    return (
                      <div key={msg.id} className={`message-item ${isTraceroute ? 'traceroute' : msg.from === selectedDMNode ? 'received' : 'sent'}`}>
                        <div className="message-header">
                          <span className="message-from">{getNodeName(msg.from)}</span>
                          <span className="message-time">{msg.timestamp.toLocaleTimeString()}</span>
                          {isTraceroute && <span className="traceroute-badge">TRACEROUTE</span>}
                        </div>
                        <div className="message-text" style={isTraceroute ? {whiteSpace: 'pre-line', fontFamily: 'monospace'} : {}}>{msg.text}</div>
                      </div>
                    );
                  })
                ) : (
                  <p className="no-messages">No direct messages with this node yet</p>
                )}
              </div>

              {/* Send DM form */}
              {connectionStatus === 'connected' && (
                <div className="send-message-form">
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

  const handleMaxNodeAgeChange = (value: number) => {
    setMaxNodeAgeHours(value);
    localStorage.setItem('maxNodeAgeHours', value.toString());
  };

  const handleTracerouteIntervalChange = async (value: number) => {
    setTracerouteIntervalMinutes(value);
    localStorage.setItem('tracerouteIntervalMinutes', value.toString());

    try {
      await fetch(`${baseUrl}/api/settings/traceroute-interval`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ intervalMinutes: value })
      });
    } catch (error) {
      console.error('Error updating traceroute interval:', error);
    }
  };

  const handleTemperatureUnitChange = (unit: TemperatureUnit) => {
    setTemperatureUnit(unit);
    localStorage.setItem('temperatureUnit', unit);
  };

  const handleDistanceUnitChange = (unit: 'km' | 'mi') => {
    setDistanceUnit(unit);
    localStorage.setItem('distanceUnit', unit);
  };

  const handleTelemetryVisualizationChange = (hours: number) => {
    setTelemetryVisualizationHours(hours);
    localStorage.setItem('telemetryVisualizationHours', hours.toString());
  };

  // Purge handlers moved to SettingsTab component

  // Removed renderSettingsTab - using SettingsTab component instead

  return (
    <div className="app">
      <header className="app-header">
        <div className="header-left">
          <div className="header-title">
            <img src={`${baseUrl}/logo.png`} alt="MeshMonitor Logo" className="header-logo" />
            <h1>MeshMonitor</h1>
          </div>
          <div className="node-info">
            <span className="node-address">{nodeAddress}</span>
          </div>
        </div>
        <div className="connection-status" onClick={fetchSystemStatus} style={{ cursor: 'pointer' }} title="Click for system status">
          <span className={`status-indicator ${connectionStatus}`}></span>
          <span>{connectionStatus === 'configuring' ? 'initializing' : connectionStatus}</span>
        </div>
      </header>

      <nav className="tab-nav">
        <button
          className={`tab-btn ${activeTab === 'nodes' ? 'active' : ''}`}
          onClick={() => setActiveTab('nodes')}
        >
          Nodes
        </button>
        <button
          className={`tab-btn ${activeTab === 'channels' ? 'active' : ''}`}
          onClick={() => setActiveTab('channels')}
        >
          Channels
          {Object.entries(unreadCounts).some(([channel, count]) => parseInt(channel) !== -1 && count > 0) && (
            <span className="tab-notification-dot"></span>
          )}
        </button>
        <button
          className={`tab-btn ${activeTab === 'messages' ? 'active' : ''}`}
          onClick={() => {
            setActiveTab('messages');
            // Clear unread count for direct messages (channel -1)
            setUnreadCounts(prev => ({ ...prev, [-1]: 0 }));
            // Set selected channel to -1 so new DMs don't create unread notifications
            setSelectedChannel(-1);
            selectedChannelRef.current = -1;
          }}
        >
          Messages
          {unreadCounts[-1] > 0 && (
            <span className="tab-notification-dot"></span>
          )}
        </button>
        <button
          className={`tab-btn ${activeTab === 'dashboard' ? 'active' : ''}`}
          onClick={() => setActiveTab('dashboard')}
        >
          Dashboard
        </button>
        <button
          className={`tab-btn ${activeTab === 'info' ? 'active' : ''}`}
          onClick={() => setActiveTab('info')}
        >
          Info
        </button>
        <button
          className={`tab-btn ${activeTab === 'settings' ? 'active' : ''}`}
          onClick={() => setActiveTab('settings')}
        >
          Settings
        </button>
      </nav>

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
            tracerouteIntervalMinutes={tracerouteIntervalMinutes}
            temperatureUnit={temperatureUnit}
            distanceUnit={distanceUnit}
            telemetryVisualizationHours={telemetryVisualizationHours}
            baseUrl={baseUrl}
            onMaxNodeAgeChange={handleMaxNodeAgeChange}
            onTracerouteIntervalChange={handleTracerouteIntervalChange}
            onTemperatureUnitChange={handleTemperatureUnitChange}
            onDistanceUnitChange={handleDistanceUnitChange}
            onTelemetryVisualizationChange={handleTelemetryVisualizationChange}
          />
        )}
      </main>

      {/* Node Popup */}
      {nodePopup && (() => {
        const node = nodes.find(n => n.user?.id === nodePopup.nodeId);
        if (!node) return null;

        return (
          <div
            className="node-popup"
            style={{
              position: 'fixed',
              left: nodePopup.position.x,
              top: nodePopup.position.y - 10,
              transform: 'translateX(-50%) translateY(-100%)',
              zIndex: 1000
            }}
          >
            <div className="popup-header">
              <strong>{node.user?.longName || `Node ${node.nodeNum}`}</strong>
              {node.user?.shortName && (
                <span className="popup-short">({node.user.shortName})</span>
              )}
            </div>

            <div className="popup-details">
              {node.user?.id && (
                <div>ID: {node.user.id}</div>
              )}

              {node.user?.role && (
                <div>Role: {node.user.role}</div>
              )}

              {node.snr != null && (
                <div>SNR: {node.snr.toFixed(1)} dB</div>
              )}

              {node.deviceMetrics?.batteryLevel !== undefined && node.deviceMetrics.batteryLevel !== null && (
                <div>
                  {node.deviceMetrics.batteryLevel === 101 ? 'Power: Plugged In' : `Battery: ${node.deviceMetrics.batteryLevel}%`}
                </div>
              )}

              {node.lastHeard && (
                <div>Last Seen: {new Date(node.lastHeard * 1000).toLocaleString()}</div>
              )}

              {node.position && (
                <div>
                  Position: {node.position.latitude?.toFixed(4) || 'N/A'}, {node.position.longitude?.toFixed(4) || 'N/A'}
                  {node.position.altitude && ` (${node.position.altitude}m)`}
                </div>
              )}
            </div>

            {node.user?.id && (
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

export default App