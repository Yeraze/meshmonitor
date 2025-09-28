import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { MapContainer, TileLayer, Marker, Popup, Polyline, useMap } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import './App.css'
import TelemetryGraphs from './components/TelemetryGraphs'
import { version } from '../package.json'
import { type TemperatureUnit } from './utils/temperature'

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

// Create reusable icons to prevent recreation issues
const defaultIcon = new L.Icon({
  iconUrl: 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjQiIGhlaWdodD0iMjQiIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPHBhdGggZD0iTTEyIDJDOS4yNCAyIDcgNC4yNCA3IDdDNyAxMy40NyAxMiAyMiAxMiAyMkMxMiAyMiAxNyAxMy40NyAxNyA3QzE3IDQuMjQgMTQuNzYgMiAxMiAyWk0xMiA5LjVDMTAuNjIgOS41IDkuNSA4LjM4IDkuNSA3UzkuNTEgNC41IDExIDQuNVMxNS41IDUuNjIgMTUuNSA3UzE0LjM4IDkuNSAxMiA5LjVaIiBmaWxsPSIjNjY5OGY1Ii8+Cjwvc3ZnPg==',
  iconSize: [24, 24],
  iconAnchor: [12, 24],
  popupAnchor: [0, -24]
});

const selectedIcon = new L.Icon({
  iconUrl: 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjQiIGhlaWdodD0iMjQiIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPHBhdGggZD0iTTEyIDJDOS4yNCAyIDcgNC4yNCA3IDdDNyAxMy40NyAxMiAyMiAxMiAyMkMxMiAyMiAxNyAxMy40NyAxNyA3QzE3IDQuMjQgMTQuNzYgMiAxMiAyWk0xMiA5LjVDMTAuNjIgOS41IDkuNSA4LjM4IDkuNSA3UzkuNTEgNC41IDExIDQuNVMxNS41IDUuNjIgMTUuNSA3UzE0LjM4IDkuNUgxMiA5LjVaIiBmaWxsPSIjZmY2NjY2Ii8+Cjwvc3ZnPg==',
  iconSize: [30, 30],
  iconAnchor: [15, 30],
  popupAnchor: [0, -30]
});

// Helper function to convert role number to readable string
const getRoleName = (role: number | string | undefined): string | null => {
  if (role === undefined || role === null) return null;
  const roleNum = typeof role === 'string' ? parseInt(role) : role;
  switch (roleNum) {
    case 0: return 'Client';
    case 1: return 'Client Mute';
    case 2: return 'Router';
    case 4: return 'Repeater';
    case 11: return 'Router Late';
    default: return `Role ${roleNum}`;
  }
};

interface DeviceInfo {
  nodeNum: number;
  user?: {
    id: string;
    longName: string;
    shortName: string;
    hwModel?: number;
    role?: string;
  };
  position?: {
    latitude: number;
    longitude: number;
    altitude?: number;
  };
  deviceMetrics?: {
    batteryLevel?: number;
    voltage?: number;
    channelUtilization?: number;
    airUtilTx?: number;
  };
  hopsAway?: number;
  lastHeard?: number;
  snr?: number;
  rssi?: number;
}

interface MeshMessage {
  id: string;
  from: string;
  to: string;
  fromNodeId: string;
  toNodeId: string;
  text: string;
  channel: number;
  portnum?: number;
  timestamp: Date;
  acknowledged?: boolean;
  isLocalMessage?: boolean;
  hopStart?: number;
  hopLimit?: number;
  replyId?: number;
  emoji?: number;
}

interface Channel {
  id: number;
  name: string;
  psk?: string;
  uplinkEnabled: boolean;
  downlinkEnabled: boolean;
  createdAt: number;
  updatedAt: number;
}

type TabType = 'nodes' | 'channels' | 'messages' | 'info' | 'settings';

type SortField = 'longName' | 'shortName' | 'id' | 'lastHeard' | 'snr' | 'battery' | 'hwModel' | 'location' | 'hops';
type SortDirection = 'asc' | 'desc';

// Map centering component that uses useMap hook
interface MapCenterControllerProps {
  centerTarget: [number, number] | null;
  onCenterComplete: () => void;
}

const MapCenterController: React.FC<MapCenterControllerProps> = ({ centerTarget, onCenterComplete }) => {
  const map = useMap();

  useEffect(() => {
    if (centerTarget) {
      map.setView(centerTarget, 15); // Zoom level 15 for close view
      onCenterComplete(); // Reset target after centering
    }
  }, [map, centerTarget, onCenterComplete]);

  return null;
};

function App() {
  const [activeTab, setActiveTab] = useState<TabType>('nodes')
  const [nodes, setNodes] = useState<DeviceInfo[]>([])
  const [channels, setChannels] = useState<Channel[]>([])
  const [connectionStatus, setConnectionStatus] = useState<'disconnected' | 'connecting' | 'connected' | 'configuring'>('disconnected')
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
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const [pendingMessages, setPendingMessages] = useState<Map<string, MeshMessage>>(new Map())
  const [unreadCounts, setUnreadCounts] = useState<{[key: number]: number}>({})
  const audioRef = useRef<HTMLAudioElement | null>(null)
  // const lastNotificationTime = useRef<number>(0) // Disabled for now
  const [tracerouteLoading, setTracerouteLoading] = useState<string | null>(null)
  const [showRoutes, setShowRoutes] = useState<boolean>(false)
  const [traceroutes, setTraceroutes] = useState<any[]>([])
  const [nodesWithTelemetry, setNodesWithTelemetry] = useState<Set<string>>(new Set())
  const [nodesWithWeatherTelemetry, setNodesWithWeatherTelemetry] = useState<Set<string>>(new Set())

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

  // Initialize notification sound
  useEffect(() => {
    const audio = new Audio('data:audio/wav;base64,UklGRnoGAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQoGAACBhYqFbF1fdJivrJBhNjVgodDbq2EcBj+a2/LDciUFLIHO8tiJNwgZaLvt559NEAxQp+PwtmMcBjiR1/LMeSwFJHfH8N2QQAoUXrTp66hVFApGn+DyvmwhBiqG0PLSfzcGG2O56+OdTgwOUpzq66NRDwg+ltbyvW0qBSl+z/DV');
    audioRef.current = audio;
    audioRef.current.volume = 0.3;
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
        const configResponse = await fetch('/api/config');
        if (configResponse.ok) {
          const config = await configResponse.json();
          setNodeAddress(config.meshtasticNodeIp);
        } else {
          setNodeAddress('192.168.1.100');
        }

        // Check connection status
        await checkConnectionStatus();
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

  // Fetch traceroutes when showRoutes is enabled or Messages/Nodes tab is active
  useEffect(() => {
    if ((showRoutes || activeTab === 'messages' || activeTab === 'nodes') && connectionStatus === 'connected') {
      fetchTraceroutes();
      const interval = setInterval(fetchTraceroutes, 10000); // Refresh every 10 seconds
      return () => clearInterval(interval);
    }
  }, [showRoutes, activeTab, connectionStatus]);

  // Auto-scroll to bottom when messages change or channel changes
  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [channelMessages, selectedChannel]);

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
      const response = await fetch('/api/nodes/refresh', {
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

  const checkConnectionStatus = async () => {
    try {
      const response = await fetch('/api/connection');
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
              await fetchChannels(); // Fetch channels first
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
      const response = await fetch('/api/traceroutes/recent');
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
      const response = await fetch('/api/telemetry/available/nodes');
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
      const response = await fetch('/api/system/status');
      if (response.ok) {
        const data = await response.json();
        setSystemStatus(data);
        setShowStatusModal(true);
      }
    } catch (error) {
      console.error('Error fetching system status:', error);
    }
  };

  const fetchChannels = async () => {
    try {
      const channelsResponse = await fetch('/api/channels');
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
      const nodesResponse = await fetch('/api/nodes');
      if (nodesResponse.ok) {
        const nodesData = await nodesResponse.json();
        setNodes(nodesData);
      }

      // Fetch messages
      const messagesResponse = await fetch('/api/messages?limit=100');
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
      const configResponse = await fetch('/api/config');
      if (configResponse.ok) {
        const configData = await configResponse.json();
        setDeviceInfo(configData);
      }

      // Fetch device configuration
      const deviceConfigResponse = await fetch('/api/device-config');
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

  const formatTracerouteRoute = (route: string, snr: string) => {
    try {
      const routeArray = JSON.parse(route || '[]');
      const snrArray = JSON.parse(snr || '[]');

      if (routeArray.length === 0) {
        return 'Direct connection';
      }

      return routeArray.map((nodeNum: number, idx: number) => {
        const node = nodes.find(n => n.nodeNum === nodeNum);
        const nodeName = node?.user?.longName || node?.user?.shortName || `!${nodeNum.toString(16)}`;
        const snrValue = snrArray[idx] !== undefined ? ` (${snrArray[idx]}dB)` : '';
        return nodeName + snrValue;
      }).join(' → ');
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

      await fetch('/api/traceroute', {
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

    try {
      const response = await fetch('/api/messages/send', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          text: newMessage,
          channel: 0,
          destination: destinationNodeId
        })
      });

      if (response.ok) {
        console.log('Direct message sent successfully');
        setNewMessage('');
      } else {
        console.error('Failed to send direct message');
      }
    } catch (error) {
      console.error('Error sending direct message:', error);
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
      const response = await fetch('/api/messages/send', {
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


  const getNodeName = (nodeId: string): string => {
    const node = nodes.find(n => n.user?.id === nodeId);
    return node?.user?.longName || node?.user?.shortName || nodeId;
  };

  const getNodeShortName = (nodeId: string): string => {
    const node = nodes.find(n => n.user?.id === nodeId);
    // Prefer the actual shortName field, fallback to truncated ID only if shortName is empty/null
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
          aVal = a.user?.id ? getTracerouteHopCount(a.user.id) : 999;
          bVal = b.user?.id ? getTracerouteHopCount(b.user.id) : 999;
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
  const isSingleEmoji = (text: string): boolean => {
    const emojiRegex = /^(\p{Emoji_Presentation}|\p{Extended_Pictographic})$/u;
    return emojiRegex.test(text.trim());
  };

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
                            {node.deviceMetrics.batteryLevel === 101 ? '🔌' : '🔋'} {node.deviceMetrics.batteryLevel === 101 ? 'Plugged In' : `${node.deviceMetrics.batteryLevel}%`}
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
                    checked={showRoutes}
                    onChange={(e) => setShowRoutes(e.target.checked)}
                  />
                  <span>Show Routes</span>
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
                {nodesWithPosition.map(node => (
                <Marker
                  key={node.nodeNum}
                  position={[node.position!.latitude, node.position!.longitude]}
                  eventHandlers={{
                    click: () => {
                      setSelectedNodeId(node.user?.id || null);
                    }
                  }}
                  icon={selectedNodeId === node.user?.id ? selectedIcon : defaultIcon}
                >
                  <Popup>
                    <div className="node-popup">
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

                        <div>
                          Position: {node.position!.latitude?.toFixed(4) || 'N/A'}, {node.position!.longitude?.toFixed(4) || 'N/A'}
                          {node.position!.altitude && ` (${node.position!.altitude}m)`}
                        </div>
                      </div>

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
              ))}

                {/* Draw traceroute paths */}
                {showRoutes && (() => {
                  // Calculate segment usage counts
                  const segmentUsage = new Map<string, number>();
                  const segmentsList: Array<{
                    key: string;
                    positions: [number, number][];
                    nodeNums: number[];
                  }> = [];

                  traceroutes.forEach((tr, idx) => {
                    try {
                      const route = JSON.parse(tr.route || '[]');
                      const nodeSequence: number[] = [tr.fromNodeNum, ...route, tr.toNodeNum];
                      const positions: Array<{nodeNum: number; pos: [number, number]}> = [];

                      // Build node sequence with positions
                      nodeSequence.forEach((nodeNum) => {
                        const node = nodes.find(n => n.nodeNum === nodeNum);
                        if (node?.position?.latitude && node?.position?.longitude) {
                          positions.push({
                            nodeNum,
                            pos: [node.position.latitude, node.position.longitude]
                          });
                        }
                      });

                      // Create segments and count usage
                      for (let i = 0; i < positions.length - 1; i++) {
                        const from = positions[i];
                        const to = positions[i + 1];
                        const segmentKey = [from.nodeNum, to.nodeNum].sort().join('-');

                        segmentUsage.set(segmentKey, (segmentUsage.get(segmentKey) || 0) + 1);

                        segmentsList.push({
                          key: `tr-${idx}-seg-${i}`,
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
                          </div>
                        </Popup>
                      </Polyline>
                    );
                  });
                })()}

                {/* Draw selected node's traceroute in red */}
                {selectedNodeId && (() => {
                  const selectedTrace = traceroutes.find(tr =>
                    tr.toNodeId === selectedNodeId || tr.fromNodeId === selectedNodeId
                  );

                  if (!selectedTrace) return null;

                  try {
                    const route = JSON.parse(selectedTrace.route || '[]');
                    const nodeSequence: number[] = [selectedTrace.fromNodeNum, ...route, selectedTrace.toNodeNum];

                    const positions: [number, number][] = [];

                    nodeSequence.forEach((nodeNum) => {
                      const node = processedNodes.find(n => n.nodeNum === nodeNum);
                      if (node?.position?.latitude && node?.position?.longitude) {
                        positions.push([node.position.latitude, node.position.longitude]);
                      }
                    });

                    if (positions.length < 2) {
                      return null;
                    }

                    const fromNode = nodes.find(n => n.nodeNum === selectedTrace.fromNodeNum);
                    const toNode = nodes.find(n => n.nodeNum === selectedTrace.toNodeNum);
                    const fromName = fromNode?.user?.longName || fromNode?.user?.shortName || selectedTrace.fromNodeId;
                    const toName = toNode?.user?.longName || toNode?.user?.shortName || selectedTrace.toNodeId;
                    const hops = route.length;

                    return (
                      <Polyline
                        key="selected-traceroute"
                        positions={positions}
                        color="#f38ba8"
                        weight={4}
                        opacity={0.9}
                        dashArray="10, 5"
                      >
                        <Popup>
                          <div className="route-popup">
                            <h4>Selected Traceroute</h4>
                            <div className="route-endpoints">
                              <strong>{fromName}</strong> → <strong>{toName}</strong>
                            </div>
                            <div className="route-usage">
                              <strong>{hops}</strong> hop{hops !== 1 ? 's' : ''}
                            </div>
                          </div>
                        </Popup>
                      </Polyline>
                    );
                  } catch (error) {
                    return null;
                  }
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
                  <div className="messages-container">
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
                        const isReaction = msg.replyId && isSingleEmoji(msg.text) && repliedMessage;

                        if (isReaction) {
                          return null;
                        }

                        const reactions = messagesForChannel.filter(m =>
                          m.replyId && isSingleEmoji(m.text) &&
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
                                  {msg.emoji ? String.fromCodePoint(msg.emoji) : msg.text}
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
                    <div ref={messagesEndRef} />
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
                          <strong>→ Forward:</strong> {formatTracerouteRoute(recentTrace.route, recentTrace.snrTowards)}
                        </div>
                        <div className="traceroute-route">
                          <strong>← Return:</strong> {formatTracerouteRoute(recentTrace.routeBack, recentTrace.snrBack)}
                        </div>
                        <div className="traceroute-age">Last traced {ageStr}</div>
                      </div>
                    );
                  }
                  return null;
                })()}
              </div>

              <div className="messages-container">
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

              <TelemetryGraphs nodeId={selectedDMNode} temperatureUnit={temperatureUnit} />
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

  const renderInfoTab = () => (
    <div className="tab-content">
      <h2>Device Information & Configuration</h2>
      <div className="device-info">
        <div className="info-section">
          <h3>Connection Status</h3>
          <p><strong>Node Address:</strong> {nodeAddress}</p>
          {deviceConfig?.basic?.nodeId && (
            <p><strong>Node ID:</strong> {deviceConfig.basic.nodeId}</p>
          )}
          {deviceConfig?.basic?.nodeName && (
            <p><strong>Node Name:</strong> {deviceConfig.basic.nodeName}</p>
          )}
          {deviceConfig?.basic && (
            <p><strong>Firmware Version:</strong> {deviceConfig.basic.firmwareVersion || 'Not available'}</p>
          )}
          <p><strong>Connection Status:</strong> <span className={`status-text ${connectionStatus}`}>{connectionStatus}</span></p>
          <p><strong>Uses TLS:</strong> {deviceInfo?.meshtasticUseTls ? 'Yes' : 'No'}</p>
        </div>

        {deviceConfig && (
          <>
            <div className="info-section">
              <h3>LoRa Radio Configuration</h3>
              <p><strong>Region:</strong> {deviceConfig.radio?.region || 'Unknown'}</p>
              <p><strong>Modem Preset:</strong> {deviceConfig.radio?.modemPreset || 'Unknown'}</p>
              <p><strong>Hop Limit:</strong> {deviceConfig.radio?.hopLimit || 'Unknown'}</p>
              <p><strong>TX Power:</strong> {deviceConfig.radio?.txPower ? `${deviceConfig.radio.txPower} dBm` : 'Unknown'}</p>
              <p><strong>Bandwidth:</strong> {deviceConfig.radio?.bandwidth ? `${deviceConfig.radio.bandwidth} kHz` : 'Unknown'}</p>
              <p><strong>Spread Factor:</strong> {deviceConfig.radio?.spreadFactor || 'Unknown'}</p>
              <p><strong>Coding Rate:</strong> {deviceConfig.radio?.codingRate || 'Unknown'}</p>
            </div>

            <div className="info-section">
              <h3>MQTT Configuration</h3>
              <p><strong>Enabled:</strong> {deviceConfig.mqtt?.enabled ? 'Yes' : 'No'}</p>
              <p><strong>Server:</strong> {deviceConfig.mqtt?.server || 'Not configured'}</p>
              <p><strong>Username:</strong> {deviceConfig.mqtt?.username || 'Not set'}</p>
              <p><strong>Encryption Enabled:</strong> {deviceConfig.mqtt?.encryption ? 'Yes' : 'No'}</p>
              <p><strong>JSON Format:</strong> {deviceConfig.mqtt?.json ? 'Enabled' : 'Disabled'}</p>
              <p><strong>TLS Enabled:</strong> {deviceConfig.mqtt?.tls ? 'Yes' : 'No'}</p>
              <p><strong>Root Topic:</strong> {deviceConfig.mqtt?.rootTopic || 'msh'}</p>
            </div>

          </>
        )}

        <div className="info-section">
          <h3>Application Information</h3>
          <p><strong>Version:</strong> {version}</p>
        </div>

        <div className="info-section">
          <h3>Network Statistics</h3>
          <p><strong>Total Nodes:</strong> {nodes.length}</p>
          <p><strong>Total Channels:</strong> {channels.length}</p>
          <p><strong>Total Messages:</strong> {messages.length}</p>
          <p><strong>Active Message Channels:</strong> {getAvailableChannels().length}</p>
        </div>

        <div className="info-section">
          <h3>Recent Activity</h3>
          <p><strong>Last Message:</strong> {messages.length > 0 ? messages[0].timestamp.toLocaleString() : 'None'}</p>
          <p><strong>Most Active Node:</strong> {
            nodes.length > 0 ?
            nodes.reduce((prev, current) =>
              (prev.lastHeard || 0) > (current.lastHeard || 0) ? prev : current
            ).user?.longName || 'Unknown' : 'None'
          }</p>
        </div>

        {!deviceConfig && (
          <div className="info-section">
            <p className="no-data">Device configuration not available. Ensure connection is established.</p>
          </div>
        )}
      </div>

      {currentNodeId && connectionStatus === 'connected' && (
        <div className="info-section-full-width">
          <h3>Local Node Telemetry</h3>
          <TelemetryGraphs nodeId={currentNodeId} temperatureUnit={temperatureUnit} />
        </div>
      )}
    </div>
  );

  const handleMaxNodeAgeChange = (value: number) => {
    setMaxNodeAgeHours(value);
    localStorage.setItem('maxNodeAgeHours', value.toString());
  };

  const handleTracerouteIntervalChange = async (value: number) => {
    setTracerouteIntervalMinutes(value);
    localStorage.setItem('tracerouteIntervalMinutes', value.toString());

    try {
      await fetch('/api/settings/traceroute-interval', {
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

  const handlePurgeNodes = async () => {
    const confirmed = window.confirm(
      'Are you sure you want to erase all nodes and traceroute history?\n\n' +
      'Impact:\n' +
      '• All node information will be deleted\n' +
      '• All traceroute history will be deleted\n' +
      '• A node refresh will be triggered to repopulate the list\n\n' +
      'This action cannot be undone!'
    );

    if (!confirmed) return;

    try {
      const response = await fetch('/api/purge/nodes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });

      if (response.ok) {
        alert('Node list and traceroutes have been purged. Refreshing...');
        window.location.reload();
      } else {
        alert('Failed to purge nodes. Please try again.');
      }
    } catch (error) {
      console.error('Error purging nodes:', error);
      alert('Error purging nodes. Please try again.');
    }
  };

  const handlePurgeTelemetry = async () => {
    const confirmed = window.confirm(
      'Are you sure you want to purge all telemetry data?\n\n' +
      'Impact:\n' +
      '• All historical telemetry records will be deleted\n' +
      '• Telemetry graphs will show no historical data\n' +
      '• Current node states (battery, voltage) will be preserved\n' +
      '• New telemetry will continue to be collected\n\n' +
      'This action cannot be undone!'
    );

    if (!confirmed) return;

    try {
      const response = await fetch('/api/purge/telemetry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });

      if (response.ok) {
        alert('Telemetry data has been purged.');
      } else {
        alert('Failed to purge telemetry. Please try again.');
      }
    } catch (error) {
      console.error('Error purging telemetry:', error);
      alert('Error purging telemetry. Please try again.');
    }
  };

  const handlePurgeMessages = async () => {
    const confirmed = window.confirm(
      'Are you sure you want to purge all messages?\n\n' +
      'Impact:\n' +
      '• All channel messages will be deleted\n' +
      '• All direct messages will be deleted\n' +
      '• Message history will be permanently lost\n' +
      '• New messages will continue to be received\n\n' +
      'This action cannot be undone!'
    );

    if (!confirmed) return;

    try {
      const response = await fetch('/api/purge/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });

      if (response.ok) {
        alert('Messages have been purged. Refreshing...');
        window.location.reload();
      } else {
        alert('Failed to purge messages. Please try again.');
      }
    } catch (error) {
      console.error('Error purging messages:', error);
      alert('Error purging messages. Please try again.');
    }
  };

  const renderSettingsTab = () => (
    <div className="tab-content">
      <div className="settings-header-card">
        <img src="/logo.png" alt="MeshMonitor Logo" className="settings-logo" />
        <div className="settings-title-section">
          <h1 className="settings-app-name">MeshMonitor</h1>
          <p className="settings-version">Version {version}</p>
        </div>
      </div>
      <div className="settings-content">
        <div className="settings-section">
          <h3>Node Display</h3>
          <div className="setting-item">
            <label htmlFor="maxNodeAge">
              Maximum Age of Active Nodes (hours)
              <span className="setting-description">Nodes older than this will not appear in the Node List</span>
            </label>
            <input
              id="maxNodeAge"
              type="number"
              min="1"
              max="168"
              value={maxNodeAgeHours}
              onChange={(e) => handleMaxNodeAgeChange(parseInt(e.target.value))}
              className="setting-input"
            />
          </div>
        </div>

        <div className="settings-section">
          <h3>Traceroute</h3>
          <div className="setting-item">
            <label htmlFor="tracerouteInterval">
              Automatic Traceroute Interval (minutes)
              <span className="setting-description">How often to automatically send traceroutes to nodes</span>
            </label>
            <input
              id="tracerouteInterval"
              type="number"
              min="1"
              max="60"
              value={tracerouteIntervalMinutes}
              onChange={(e) => handleTracerouteIntervalChange(parseInt(e.target.value))}
              className="setting-input"
            />
          </div>
        </div>

        <div className="settings-section">
          <h3>Display Preferences</h3>
          <div className="setting-item">
            <label htmlFor="temperatureUnit">
              Temperature Unit
              <span className="setting-description">Choose between Celsius and Fahrenheit for temperature display</span>
            </label>
            <select
              id="temperatureUnit"
              value={temperatureUnit}
              onChange={(e) => handleTemperatureUnitChange(e.target.value as TemperatureUnit)}
              className="setting-input"
            >
              <option value="C">Celsius (°C)</option>
              <option value="F">Fahrenheit (°F)</option>
            </select>
          </div>
        </div>

        <div className="settings-section danger-zone">
          <h3>⚠️ Danger Zone</h3>
          <p className="danger-zone-description">These actions cannot be undone. Use with caution.</p>

          <div className="danger-action">
            <div className="danger-action-info">
              <h4>Erase Node List</h4>
              <p>Removes all nodes and traceroute history from the database. A node refresh will be triggered to repopulate the list.</p>
            </div>
            <button
              className="danger-button"
              onClick={handlePurgeNodes}
            >
              Erase Nodes
            </button>
          </div>

          <div className="danger-action">
            <div className="danger-action-info">
              <h4>Purge Telemetry</h4>
              <p>Removes all historical telemetry data (battery, voltage, temperature, etc.). Current node states will be preserved.</p>
            </div>
            <button
              className="danger-button"
              onClick={handlePurgeTelemetry}
            >
              Purge Telemetry
            </button>
          </div>

          <div className="danger-action">
            <div className="danger-action-info">
              <h4>Purge Messages</h4>
              <p>Removes all messages from channels and direct message conversations. This action is permanent.</p>
            </div>
            <button
              className="danger-button"
              onClick={handlePurgeMessages}
            >
              Purge Messages
            </button>
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <div className="app">
      <header className="app-header">
        <div className="header-left">
          <div className="header-title">
            <img src="/logo.png" alt="MeshMonitor Logo" className="header-logo" />
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
              <button onClick={checkConnectionStatus} className="retry-btn">
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
        {activeTab === 'info' && renderInfoTab()}
        {activeTab === 'settings' && renderSettingsTab()}
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