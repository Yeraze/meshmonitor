import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import apiService from '../services/api';
import { useToast } from './ToastContainer';
import { ROLE_OPTIONS, MODEM_PRESET_OPTIONS, REGION_OPTIONS } from './configuration/constants';
import type { Channel } from '../types/device';
import { ImportConfigModal } from './configuration/ImportConfigModal';
import { ExportConfigModal } from './configuration/ExportConfigModal';
import SectionNav from './SectionNav';

interface AdminCommandsTabProps {
  nodes: any[];
  currentNodeId: string;
  channels?: Channel[];
  onChannelsUpdated?: () => void;
}

interface NodeOption {
  nodeNum: number;
  nodeId: string;
  longName: string;
  shortName: string;
  isLocal: boolean;
  isFavorite?: boolean;
  isIgnored?: boolean;
}

const AdminCommandsTab: React.FC<AdminCommandsTabProps> = ({ nodes, currentNodeId, channels: _channels = [], onChannelsUpdated: _onChannelsUpdated }) => {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const [selectedNodeNum, setSelectedNodeNum] = useState<number | null>(null);
  const [isExecuting, setIsExecuting] = useState(false);
  const [nodeOptions, setNodeOptions] = useState<NodeOption[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [showSearch, setShowSearch] = useState(false);
  const searchRef = useRef<HTMLDivElement>(null);
  const nodeManagementSearchRef = useRef<HTMLDivElement>(null);
  // Store channels for remote nodes
  const [remoteNodeChannels, setRemoteNodeChannels] = useState<Channel[]>([]);

  // Command-specific state
  const [rebootSeconds, setRebootSeconds] = useState(5);
  const [ownerLongName, setOwnerLongName] = useState('');
  const [ownerShortName, setOwnerShortName] = useState('');
  const [ownerIsUnmessagable, setOwnerIsUnmessagable] = useState(false);

  // Device Config state
  const [deviceRole, setDeviceRole] = useState<number>(0);
  const [nodeInfoBroadcastSecs, setNodeInfoBroadcastSecs] = useState(3600);
  const [isRoleDropdownOpen, setIsRoleDropdownOpen] = useState(false);

  // LoRa Config state
  const [usePreset, setUsePreset] = useState(true);
  const [modemPreset, setModemPreset] = useState<number>(0);
  const [bandwidth, setBandwidth] = useState<number>(250);
  const [spreadFactor, setSpreadFactor] = useState<number>(11);
  const [codingRate, setCodingRate] = useState<number>(8);
  const [frequencyOffset, setFrequencyOffset] = useState<number>(0);
  const [overrideFrequency, setOverrideFrequency] = useState<number>(0);
  const [region, setRegion] = useState<number>(0);
  const [hopLimit, setHopLimit] = useState<number>(3);
  const [txPower, setTxPower] = useState<number>(0);
  const [channelNum, setChannelNum] = useState<number>(0);
  const [sx126xRxBoostedGain, setSx126xRxBoostedGain] = useState<boolean>(false);
  const [ignoreMqtt, setIgnoreMqtt] = useState<boolean>(false);
  const [configOkToMqtt, setConfigOkToMqtt] = useState<boolean>(false);

  // Position Config state
  const [positionBroadcastSecs, setPositionBroadcastSecs] = useState(900);
  const [positionSmartEnabled, setPositionSmartEnabled] = useState(true);
  const [fixedPosition, setFixedPosition] = useState(false);
  const [fixedLatitude, setFixedLatitude] = useState<number>(0);
  const [fixedLongitude, setFixedLongitude] = useState<number>(0);
  const [fixedAltitude, setFixedAltitude] = useState<number>(0);

  // MQTT Config state
  const [mqttEnabled, setMqttEnabled] = useState(false);
  const [mqttAddress, setMqttAddress] = useState('');
  const [mqttUsername, setMqttUsername] = useState('');
  const [mqttPassword, setMqttPassword] = useState('');
  const [mqttEncryptionEnabled, setMqttEncryptionEnabled] = useState(true);
  const [mqttJsonEnabled, setMqttJsonEnabled] = useState(false);
  const [mqttRoot, setMqttRoot] = useState('');

  // Security Config state
  const [adminKeys, setAdminKeys] = useState<string[]>(['']);
  const [isManaged, setIsManaged] = useState<boolean>(false);
  const [serialEnabled, setSerialEnabled] = useState<boolean>(false);
  const [debugLogApiEnabled, setDebugLogApiEnabled] = useState<boolean>(false);
  const [adminChannelEnabled, setAdminChannelEnabled] = useState<boolean>(false);

  // Channel Config state - for editing a specific channel
  const [editingChannelSlot, setEditingChannelSlot] = useState<number | null>(null);
  const [channelName, setChannelName] = useState('');
  const [channelPsk, setChannelPsk] = useState('');
  const [channelRole, setChannelRole] = useState<number>(1);
  const [channelUplinkEnabled, setChannelUplinkEnabled] = useState(true);
  const [channelDownlinkEnabled, setChannelDownlinkEnabled] = useState(true);
  const [channelPositionPrecision, setChannelPositionPrecision] = useState<number>(32);
  const [showChannelEditModal, setShowChannelEditModal] = useState(false);

  // Import/Export state
  const [showImportModal, setShowImportModal] = useState(false);
  const [showConfigImportModal, setShowConfigImportModal] = useState(false);
  const [showConfigExportModal, setShowConfigExportModal] = useState(false);
  const [importSlotId, setImportSlotId] = useState<number | null>(null);
  const [importFileContent, setImportFileContent] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Loading states for each section
  const [isLoadingOwner, setIsLoadingOwner] = useState(false);
  const [isLoadingDeviceConfig, setIsLoadingDeviceConfig] = useState(false);
  const [isLoadingLoRaConfig, setIsLoadingLoRaConfig] = useState(false);
  const [isLoadingPositionConfig, setIsLoadingPositionConfig] = useState(false);
  const [isLoadingMQTTConfig, setIsLoadingMQTTConfig] = useState(false);
  const [isLoadingSecurityConfig, setIsLoadingSecurityConfig] = useState(false);

  // Node management state (favorites/ignored)
  const [nodeManagementNodeNum, setNodeManagementNodeNum] = useState<number | null>(null);
  const [showNodeManagementSearch, setShowNodeManagementSearch] = useState(false);
  const [nodeManagementSearchQuery, setNodeManagementSearchQuery] = useState('');
  const [isLoadingChannels, setIsLoadingChannels] = useState(false);
  const [channelLoadProgress, setChannelLoadProgress] = useState<string>('');
  // Track remote node favorite/ignored status separately (key: nodeNum, value: {isFavorite, isIgnored})
  const [remoteNodeStatus, setRemoteNodeStatus] = useState<Map<number, { isFavorite: boolean; isIgnored: boolean }>>(new Map());

  useEffect(() => {
    // Build node options list
    const options: NodeOption[] = [];
    
    if (!nodes || nodes.length === 0) {
      setNodeOptions([]);
      return;
    }

    // Add local node first
    const localNode = nodes.find(n => (n.user?.id || n.nodeId) === currentNodeId);
    if (localNode && localNode.nodeNum !== undefined) {
      const localNodeId = localNode.user?.id || localNode.nodeId || `!${localNode.nodeNum.toString(16).padStart(8, '0')}`;
      options.push({
        nodeNum: localNode.nodeNum,
        nodeId: localNodeId,
        longName: localNode.user?.longName || localNode.longName || t('admin_commands.local_node_fallback'),
        shortName: localNode.user?.shortName || localNode.shortName || t('admin_commands.local_node_short'),
        isLocal: true,
        isFavorite: localNode.isFavorite ?? false,
        isIgnored: localNode.isIgnored ?? false
      });
    }

    // Add other nodes - include all nodes with nodeNum, even if nodeId is missing
    nodes
      .filter(n => {
        // Exclude local node
        const nodeId = n.user?.id || n.nodeId;
        if (nodeId === currentNodeId) return false;
        // Include if it has a nodeNum (required for admin commands)
        return n.nodeNum !== undefined && n.nodeNum !== null;
      })
      .forEach(node => {
        const nodeId = node.user?.id || node.nodeId || `!${node.nodeNum.toString(16).padStart(8, '0')}`;
        const longName = node.user?.longName || node.longName;
        const shortName = node.user?.shortName || node.shortName;
        options.push({
          nodeNum: node.nodeNum,
          nodeId: nodeId,
          longName: longName || `Node ${nodeId}`,
          shortName: shortName || (nodeId.startsWith('!') ? nodeId.substring(1, 5) : nodeId.substring(0, 4)),
          isLocal: false,
          isFavorite: node.isFavorite ?? false,
          isIgnored: node.isIgnored ?? false
        });
      });

    setNodeOptions(options);
    
    // Set default to local node (only if not already set)
    if (options.length > 0 && selectedNodeNum === null) {
      setSelectedNodeNum(options[0].nodeNum);
    }
  }, [nodes, currentNodeId]);

  // Filter nodes based on search query
  const filteredNodes = useMemo(() => {
    if (!searchQuery.trim()) {
      return nodeOptions;
    }
    const lowerSearch = searchQuery.toLowerCase().trim();
    return nodeOptions.filter(node => {
      const longName = node.longName.toLowerCase();
      const shortName = node.shortName.toLowerCase();
      const nodeId = node.nodeId.toLowerCase();
      const nodeNumHex = node.nodeNum.toString(16).padStart(8, '0');
      return longName.includes(lowerSearch) ||
             shortName.includes(lowerSearch) ||
             nodeId.includes(lowerSearch) ||
             nodeNumHex.includes(lowerSearch) ||
             node.nodeNum.toString().includes(lowerSearch);
    });
  }, [nodeOptions, searchQuery]);

  // Filter nodes for node management section
  const filteredNodesForManagement = useMemo(() => {
    if (!nodeManagementSearchQuery.trim()) {
      return nodeOptions;
    }
    const lowerSearch = nodeManagementSearchQuery.toLowerCase().trim();
    return nodeOptions.filter(node => {
      const longName = node.longName.toLowerCase();
      const shortName = node.shortName.toLowerCase();
      const nodeId = node.nodeId.toLowerCase();
      const nodeNumHex = node.nodeNum.toString(16).padStart(8, '0');
      return longName.includes(lowerSearch) ||
             shortName.includes(lowerSearch) ||
             nodeId.includes(lowerSearch) ||
             nodeNumHex.includes(lowerSearch) ||
             node.nodeNum.toString().includes(lowerSearch);
    });
  }, [nodeOptions, nodeManagementSearchQuery]);

  // Close search dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (searchRef.current && !searchRef.current.contains(event.target as Node)) {
        setShowSearch(false);
      }
      if (nodeManagementSearchRef.current && !nodeManagementSearchRef.current.contains(event.target as Node)) {
        setShowNodeManagementSearch(false);
      }
    };

    if (showSearch || showNodeManagementSearch) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [showSearch, showNodeManagementSearch]);

  // Clear remote node status when switching target nodes (since status is per-remote-device)
  useEffect(() => {
    setRemoteNodeStatus(new Map());
    // Also clear node management selection when switching target nodes
    setNodeManagementNodeNum(null);
  }, [selectedNodeNum]);

  const handleNodeSelect = (nodeNum: number) => {
    setSelectedNodeNum(nodeNum);
    const selected = nodeOptions.find(n => n.nodeNum === nodeNum);
    if (selected) {
      setSearchQuery(selected.longName);
    }
    setShowSearch(false);
    
    // Always clear remote node channels when switching nodes
    // They will be populated when Load is clicked
    setRemoteNodeChannels([]);
  };

  const handleLoadDeviceConfig = async () => {
    if (selectedNodeNum === null) {
      showToast(t('admin_commands.please_select_node'), 'error');
      return;
    }

    setIsLoadingDeviceConfig(true);
    try {
      const result = await apiService.post<{ config: any }>('/api/admin/load-config', {
        nodeNum: selectedNodeNum,
        configType: 'device'
      });
      
      if (result?.config) {
        const config = result.config;
        if (config.role !== undefined) setDeviceRole(config.role);
        if (config.nodeInfoBroadcastSecs !== undefined) setNodeInfoBroadcastSecs(config.nodeInfoBroadcastSecs);
        showToast(t('admin_commands.device_config_loaded'), 'success');
      }
    } catch (error: any) {
      showToast(error.message || t('admin_commands.failed_load_device_config'), 'error');
    } finally {
      setIsLoadingDeviceConfig(false);
    }
  };

  const handleLoadLoRaConfig = async () => {
    if (selectedNodeNum === null) {
      const error = new Error(t('admin_commands.please_select_node'));
      showToast(error.message, 'error');
      throw error;
    }

    setIsLoadingLoRaConfig(true);
    try {
      const result = await apiService.post<{ config: any }>('/api/admin/load-config', {
        nodeNum: selectedNodeNum,
        configType: 'lora'
      });
      
      if (result?.config) {
        const config = result.config;
        if (config.usePreset !== undefined) setUsePreset(config.usePreset);
        if (config.modemPreset !== undefined) setModemPreset(config.modemPreset);
        if (config.bandwidth !== undefined) setBandwidth(config.bandwidth);
        if (config.spreadFactor !== undefined) setSpreadFactor(config.spreadFactor);
        if (config.codingRate !== undefined) setCodingRate(config.codingRate);
        if (config.frequencyOffset !== undefined) setFrequencyOffset(config.frequencyOffset);
        if (config.overrideFrequency !== undefined) setOverrideFrequency(config.overrideFrequency);
        if (config.region !== undefined) setRegion(config.region);
        if (config.hopLimit !== undefined) setHopLimit(config.hopLimit);
        if (config.txPower !== undefined) setTxPower(config.txPower);
        if (config.channelNum !== undefined) setChannelNum(config.channelNum);
        if (config.sx126xRxBoostedGain !== undefined) setSx126xRxBoostedGain(config.sx126xRxBoostedGain);
        if (config.ignoreMqtt !== undefined) setIgnoreMqtt(config.ignoreMqtt);
        if (config.configOkToMqtt !== undefined) setConfigOkToMqtt(config.configOkToMqtt);
        showToast(t('admin_commands.lora_config_loaded'), 'success');
      } else {
        throw new Error(t('admin_commands.no_config_data'));
      }
    } catch (error: any) {
      showToast(error.message || t('admin_commands.failed_load_lora_config'), 'error');
      throw error; // Re-throw so Promise.all() can catch it
    } finally {
      setIsLoadingLoRaConfig(false);
    }
  };

  const handleLoadPositionConfig = async () => {
    if (selectedNodeNum === null) {
      showToast(t('admin_commands.please_select_node'), 'error');
      return;
    }

    setIsLoadingPositionConfig(true);
    try {
      const result = await apiService.post<{ config: any }>('/api/admin/load-config', {
        nodeNum: selectedNodeNum,
        configType: 'position'
      });
      
      if (result?.config) {
        const config = result.config;
        if (config.positionBroadcastSecs !== undefined) setPositionBroadcastSecs(config.positionBroadcastSecs);
        if (config.positionBroadcastSmartEnabled !== undefined) {
          setPositionSmartEnabled(config.positionBroadcastSmartEnabled);
        } else if (config.positionSmartEnabled !== undefined) {
          setPositionSmartEnabled(config.positionSmartEnabled);
        }
        if (config.fixedPosition !== undefined) setFixedPosition(config.fixedPosition);
        if (config.fixedLatitude !== undefined) setFixedLatitude(config.fixedLatitude);
        if (config.fixedLongitude !== undefined) setFixedLongitude(config.fixedLongitude);
        if (config.fixedAltitude !== undefined) setFixedAltitude(config.fixedAltitude);
        showToast(t('admin_commands.position_config_loaded'), 'success');
      }
    } catch (error: any) {
      showToast(error.message || t('admin_commands.failed_load_position_config'), 'error');
    } finally {
      setIsLoadingPositionConfig(false);
    }
  };

  const handleLoadMQTTConfig = async () => {
    if (selectedNodeNum === null) {
      showToast(t('admin_commands.please_select_node'), 'error');
      return;
    }

    setIsLoadingMQTTConfig(true);
    try {
      const result = await apiService.post<{ config: any }>('/api/admin/load-config', {
        nodeNum: selectedNodeNum,
        configType: 'mqtt'
      });
      
      if (result?.config) {
        const config = result.config;
        if (config.enabled !== undefined) setMqttEnabled(config.enabled);
        if (config.address !== undefined) setMqttAddress(config.address || '');
        if (config.username !== undefined) setMqttUsername(config.username || '');
        if (config.password !== undefined) setMqttPassword(config.password || '');
        if (config.encryptionEnabled !== undefined) setMqttEncryptionEnabled(config.encryptionEnabled);
        if (config.jsonEnabled !== undefined) setMqttJsonEnabled(config.jsonEnabled);
        if (config.root !== undefined) setMqttRoot(config.root || '');
        showToast(t('admin_commands.mqtt_config_loaded'), 'success');
      }
    } catch (error: any) {
      showToast(error.message || t('admin_commands.failed_load_mqtt_config'), 'error');
    } finally {
      setIsLoadingMQTTConfig(false);
    }
  };

  const handleLoadChannels = async () => {
    if (selectedNodeNum === null) {
      const error = new Error(t('admin_commands.please_select_node'));
      showToast(error.message, 'error');
      throw error;
    }

    setIsLoadingChannels(true);
    try {
      const localNodeNum = nodes.find(n => (n.user?.id || n.nodeId) === currentNodeId)?.nodeNum;
      const isLocalNode = selectedNodeNum === localNodeNum || selectedNodeNum === 0;
      
      if (isLocalNode) {
        // For local node, load channels from database and populate remoteNodeChannels
        // This ensures consistent behavior - channels start empty and are populated by Load button
        const loadedChannels: Channel[] = [];
        const now = Date.now();
        
        // Load all 8 channels from database
        for (let index = 0; index < 8; index++) {
          try {
            const channel = await apiService.post<{ channel?: any }>('/api/admin/get-channel', {
              nodeNum: selectedNodeNum,
              channelIndex: index
            });
            
            if (channel?.channel) {
              const ch = channel.channel;
              loadedChannels.push({
                id: index,
                name: ch.name || '',
                psk: ch.psk || '',
                role: ch.role !== undefined ? ch.role : (index === 0 ? 1 : 0),
                uplinkEnabled: ch.uplinkEnabled !== undefined ? ch.uplinkEnabled : false,
                downlinkEnabled: ch.downlinkEnabled !== undefined ? ch.downlinkEnabled : false,
                positionPrecision: ch.positionPrecision !== undefined ? ch.positionPrecision : 32,
                createdAt: now,
                updatedAt: now
              });
            } else {
              // Add empty channel slot
              loadedChannels.push({
                id: index,
                name: '',
                psk: '',
                role: index === 0 ? 1 : 0,
                uplinkEnabled: false,
                downlinkEnabled: false,
                positionPrecision: 32,
                createdAt: now,
                updatedAt: now
              });
            }
          } catch (error) {
            // Add empty channel slot on error
            loadedChannels.push({
              id: index,
              name: '',
              psk: '',
              role: index === 0 ? 1 : 0,
              uplinkEnabled: false,
              downlinkEnabled: false,
              positionPrecision: 32,
              createdAt: now,
              updatedAt: now
            });
          }
        }
        
        setRemoteNodeChannels(loadedChannels);
        const loadedCount = loadedChannels.filter(ch => {
          const hasName = ch.name && ch.name.trim().length > 0;
          const hasPsk = ch.psk && ch.psk.trim().length > 0;
          const isPrimary = ch.role === 1;
          return hasName || hasPsk || isPrimary;
        }).length;
        showToast(t('admin_commands.channels_loaded_local', { count: loadedCount }), 'success');
      } else {
        // For remote node, request all 8 channels in parallel (like Meshtastic app does)
        // This is much faster than sequential requests
        const loadedChannels: Channel[] = [];
        const now = Date.now();
        
        setChannelLoadProgress('Requesting session passkey...');
        
        // First, ensure we have a session passkey (prevents conflicts from parallel requests)
        try {
          await apiService.post('/api/admin/ensure-session-passkey', {
            nodeNum: selectedNodeNum
          });
        } catch (error: any) {
          const err = new Error(t('admin_commands.failed_session_passkey', { error: error.message }));
          showToast(err.message, 'error');
          setIsLoadingChannels(false);
          throw err; // Re-throw so Promise.all() can catch it
        }
        
        setChannelLoadProgress('Requesting all channels...');
        
        // Send all requests in parallel (now they can all use the same session passkey)
        const channelRequests = Array.from({ length: 8 }, (_, index) => 
          apiService.post<{ channel?: any }>('/api/admin/get-channel', {
            nodeNum: selectedNodeNum,
            channelIndex: index
          }).then(result => ({ index, result, error: null }))
            .catch(error => ({ index, result: null, error }))
        );
        
        // Wait for all requests to complete (or timeout)
        let results = await Promise.allSettled(channelRequests);
        
        // Track which channels failed and need retry
        const failedChannels: number[] = [];
        const maxRetries = 2; // Retry up to 2 times
        let retryCount = 0;
        
        // Function to process results and identify failures
        const processResults = (results: PromiseSettledResult<any>[], useResultIndex: boolean = false): void => {
          results.forEach((settled, arrayIndex) => {
            // For retry results, use the index from the result object, not the array index
            // For initial results, use array index (which matches channel index 0-7)
            let index: number;
            if (useResultIndex && settled.status === 'fulfilled') {
              index = settled.value.index; // Use the index from the result object
            } else {
              index = arrayIndex; // Use array index to maintain order
            }
            
            if (settled.status === 'fulfilled') {
              const { result, error } = settled.value;
              
              if (error) {
                // Track failed channels for retry (only 404/timeout errors, not other errors)
                const isRetryableError = error.message?.includes('404') || 
                                       error.message?.includes('not received') ||
                                       error.message?.includes('timeout');
                if (isRetryableError && retryCount < maxRetries) {
                  failedChannels.push(index);
                }
                // 404 errors are expected for channels that don't exist or timed out
                // Don't log as warning, just add empty channel slot
                if (error.message?.includes('404') || error.message?.includes('not received')) {
                  console.debug(`Channel ${index} not available on remote node (timeout or not configured)`);
                } else {
                  console.warn(`Failed to load channel ${index}:`, error);
                }
                // Add empty channel slot on error (will be overwritten if retry succeeds)
                const existingIndex = loadedChannels.findIndex(ch => ch.id === index);
                if (existingIndex === -1) {
                  loadedChannels.push({
                    id: index,
                    name: '',
                    psk: '',
                    role: index === 0 ? 1 : 0, // Default to disabled (0) except channel 0
                    uplinkEnabled: false,
                    downlinkEnabled: false,
                    positionPrecision: 32,
                    createdAt: now,
                    updatedAt: now
                  });
                }
              } else if (result?.channel) {
                const ch = result.channel;
                // Convert role to number if it's a string enum
                let role = ch.role;
                if (typeof role === 'string') {
                  const roleMap: { [key: string]: number } = {
                    'DISABLED': 0,
                    'PRIMARY': 1,
                    'SECONDARY': 2
                  };
                  role = roleMap[role] !== undefined ? roleMap[role] : (index === 0 ? 1 : 0);
                } else if (role === undefined || role === null) {
                  role = index === 0 ? 1 : 0; // Default: PRIMARY for channel 0, DISABLED for others
                }
                
                // If role is DISABLED (0) but channel has data, infer the correct role
                // This is a safeguard in case backend inference didn't run
                const hasData = (ch.name && ch.name.trim().length > 0) || (ch.psk && ch.psk.length > 0);
                if (role === 0 && hasData) {
                  console.log(`Channel ${index} has data but role is DISABLED, inferring role from index`);
                  role = index === 0 ? 1 : 2; // PRIMARY for channel 0, SECONDARY for others
                }
                // Log what we received for debugging (only for channels with data to reduce noise)
                if (ch.name || ch.psk) {
                  console.log(`Channel ${index} loaded:`, {
                    name: ch.name,
                    hasPsk: !!ch.psk,
                    role: role,
                    roleType: typeof ch.role,
                    originalRole: ch.role,
                    uplinkEnabled: ch.uplinkEnabled,
                    downlinkEnabled: ch.downlinkEnabled
                  });
                }
                
                // A channel with role 0 (DISABLED) is still a valid response - it just means the channel is disabled
                // We got a valid channel response, so don't retry this channel
                // Update or add channel
                const existingIndex = loadedChannels.findIndex(ch => ch.id === index);
                const channelData = {
                  id: index,
                  name: ch.name || '',
                  psk: ch.psk || '',
                  role: role,
                  uplinkEnabled: ch.uplinkEnabled !== undefined ? ch.uplinkEnabled : false,
                  downlinkEnabled: ch.downlinkEnabled !== undefined ? ch.downlinkEnabled : false,
                  positionPrecision: ch.positionPrecision !== undefined ? ch.positionPrecision : 32,
                  createdAt: now,
                  updatedAt: now
                };
                
                if (existingIndex !== -1) {
                  loadedChannels[existingIndex] = channelData;
                } else {
                  loadedChannels.push(channelData);
                }
                
                // Don't retry if we got a valid channel response, even if it's disabled (role 0)
                // Role 0 is a valid state - it just means the channel is disabled
              } else {
                // No channel data in result - this is a failure, mark for retry
                if (retryCount < maxRetries) {
                  failedChannels.push(index);
                }
                // Add empty channel slot if no data received
                const existingIndex = loadedChannels.findIndex(ch => ch.id === index);
                if (existingIndex === -1) {
                  loadedChannels.push({
                    id: index,
                    name: '',
                    psk: '',
                    role: index === 0 ? 1 : 0, // Default to disabled (0) except channel 0
                    uplinkEnabled: false,
                    downlinkEnabled: false,
                    positionPrecision: 32,
                    createdAt: now,
                    updatedAt: now
                  });
                }
              }
            } else {
              // Promise rejected - this is a failure, mark for retry
              // For retry results, we can't get the index from a rejected promise
              // Skip it - it will be retried again if needed
              if (!useResultIndex) {
                // Only track failures for initial requests (where arrayIndex = channel index)
                if (retryCount < maxRetries) {
                  failedChannels.push(index);
                }
                console.warn(`Channel ${index} request was rejected:`, settled.reason);
                const existingIndex = loadedChannels.findIndex(ch => ch.id === index);
                if (existingIndex === -1) {
                  loadedChannels.push({
                    id: index,
                    name: '',
                    psk: '',
                    role: index === 0 ? 1 : 0,
                    uplinkEnabled: false,
                    downlinkEnabled: false,
                    positionPrecision: 32,
                    createdAt: now,
                    updatedAt: now
                  });
                }
              } else {
                // For retry rejections, log but don't add empty slot (we don't know the index)
                console.warn(`Retry request was rejected (index unknown):`, settled.reason);
              }
            }
          });
        };
        
        // Process initial results (use array index since initial requests are in order 0-7)
        processResults(results, false);
        
        // Retry failed channels (only those that actually failed - 404/timeout/rejected)
        while (failedChannels.length > 0 && retryCount < maxRetries) {
          retryCount++;
          const channelsToRetry = [...new Set(failedChannels)]; // Remove duplicates
          failedChannels.length = 0; // Clear for this retry round
          
          if (channelsToRetry.length > 0) {
            setChannelLoadProgress(`Retrying ${channelsToRetry.length} failed channel(s) (attempt ${retryCount}/${maxRetries})...`);
            
            // Wait a bit before retrying (exponential backoff)
            await new Promise(resolve => setTimeout(resolve, 1000 * retryCount));
            
            // Retry only the failed channels
            const retryRequests = channelsToRetry.map(index => 
              apiService.post<{ channel?: any }>('/api/admin/get-channel', {
                nodeNum: selectedNodeNum,
                channelIndex: index
              }).then(result => ({ index, result, error: null }))
                .catch(error => ({ index, result: null, error }))
            );
            
            const retryResults = await Promise.allSettled(retryRequests);
            // For retry results, use the index from the result object (not array index)
            processResults(retryResults, true);
          }
        }
        
        setRemoteNodeChannels(loadedChannels);
        // Count channels that have actual data (name, PSK, or are primary channel)
        const loadedCount = loadedChannels.filter(ch => {
          const hasName = ch.name && ch.name.trim().length > 0;
          const hasPsk = ch.psk && ch.psk.trim().length > 0;
          const isPrimary = ch.role === 1;
          return hasName || hasPsk || isPrimary;
        }).length;
        setChannelLoadProgress('');
        showToast(t('admin_commands.channels_loaded_remote', { count: loadedCount }), 'success');
      }
    } catch (error: any) {
      setChannelLoadProgress('');
      showToast(error.message || t('admin_commands.failed_load_channels'), 'error');
      throw error; // Re-throw so Promise.all() can catch it
    } finally {
      setIsLoadingChannels(false);
    }
  };

  // Determine if we're managing a remote node (not the local node)
  // Calculate this once per render to avoid recalculating in handlers
  const localNodeNum = nodeOptions.find(n => n.isLocal)?.nodeNum;
  const isManagingRemoteNode = selectedNodeNum !== null && selectedNodeNum !== localNodeNum && selectedNodeNum !== 0;

  const executeCommand = async (command: string, params: any = {}) => {
    if (selectedNodeNum === null) {
      showToast(t('admin_commands.please_select_node'), 'error');
      throw new Error(t('admin_commands.no_node_selected'));
    }

    setIsExecuting(true);
    try {
      const result = await apiService.post<{ success: boolean; message: string }>('/api/admin/commands', {
        command,
        nodeNum: selectedNodeNum,
        ...params
      });
      showToast(result.message || t('admin_commands.command_executed', { command }), 'success');
      return result;
    } catch (error: any) {
      showToast(error.message || t('admin_commands.failed_execute_command'), 'error');
      console.error('Admin command error:', error);
      throw error;
    } finally {
      setIsExecuting(false);
    }
  };

  const handleReboot = async () => {
    if (!confirm(t('admin_commands.reboot_confirmation', { seconds: rebootSeconds }))) {
      return;
    }
    try {
      await executeCommand('reboot', { seconds: rebootSeconds });
    } catch (error) {
      // Error already handled by executeCommand (toast shown)
      console.error('Reboot command failed:', error);
    }
  };

  const handleLoadOwner = async () => {
    if (selectedNodeNum === null) {
      showToast(t('admin_commands.please_select_node'), 'error');
      return;
    }

    setIsLoadingOwner(true);
    try {
      const result = await apiService.post<{ owner?: any }>('/api/admin/load-owner', {
        nodeNum: selectedNodeNum
      });
      
      if (result?.owner) {
        setOwnerLongName(result.owner.longName || '');
        setOwnerShortName(result.owner.shortName || '');
        setOwnerIsUnmessagable(result.owner.isUnmessagable || false);
        showToast(t('admin_commands.owner_info_loaded'), 'success');
      } else {
        showToast(t('admin_commands.no_owner_info'), 'warning');
      }
    } catch (error: any) {
      showToast(error.message || t('admin_commands.failed_load_owner_info'), 'error');
    } finally {
      setIsLoadingOwner(false);
    }
  };

  const handleSetOwner = async () => {
    if (!ownerLongName.trim() || !ownerShortName.trim()) {
      showToast(t('admin_commands.long_short_name_required'), 'error');
      return;
    }
    try {
      await executeCommand('setOwner', {
        longName: ownerLongName.trim(),
        shortName: ownerShortName.trim(),
        isUnmessagable: ownerIsUnmessagable
      });
    } catch (error) {
      // Error already handled by executeCommand (toast shown)
      console.error('Set owner command failed:', error);
    }
  };

  const handlePurgeNodeDb = async () => {
    if (!confirm(t('admin_commands.purge_confirmation'))) {
      return;
    }
    try {
      await executeCommand('purgeNodeDb', { seconds: 0 });
    } catch (error) {
      // Error already handled by executeCommand (toast shown)
      console.error('Purge node DB command failed:', error);
    }
  };

  const handleSetFavoriteNode = async () => {
    if (nodeManagementNodeNum === null) {
      showToast(t('admin_commands.please_select_node_to_favorite'), 'error');
      return;
    }
    try {
      await executeCommand('setFavoriteNode', { nodeNum: nodeManagementNodeNum });
      showToast(t('admin_commands.node_set_favorite', { nodeNum: nodeManagementNodeNum }), 'success');
      // Optimistically update state - use remote status if managing remote node, otherwise local
      if (isManagingRemoteNode) {
        setRemoteNodeStatus(prev => {
          const newMap = new Map(prev);
          const current = newMap.get(nodeManagementNodeNum) || { isFavorite: false, isIgnored: false };
          newMap.set(nodeManagementNodeNum, { ...current, isFavorite: true });
          return newMap;
        });
      } else {
        setNodeOptions(prev => prev.map(node => 
          node.nodeNum === nodeManagementNodeNum 
            ? { ...node, isFavorite: true }
            : node
        ));
      }
    } catch (error) {
      // Error already handled by executeCommand (toast shown)
      console.error('Set favorite node command failed:', error);
    }
  };

  const handleRemoveFavoriteNode = async () => {
    if (nodeManagementNodeNum === null) {
      showToast(t('admin_commands.please_select_node_to_unfavorite'), 'error');
      return;
    }
    try {
      await executeCommand('removeFavoriteNode', { nodeNum: nodeManagementNodeNum });
      showToast(t('admin_commands.node_removed_favorite', { nodeNum: nodeManagementNodeNum }), 'success');
      // Optimistically update state - use remote status if managing remote node, otherwise local
      if (isManagingRemoteNode) {
        setRemoteNodeStatus(prev => {
          const newMap = new Map(prev);
          const current = newMap.get(nodeManagementNodeNum) || { isFavorite: false, isIgnored: false };
          newMap.set(nodeManagementNodeNum, { ...current, isFavorite: false });
          return newMap;
        });
      } else {
        setNodeOptions(prev => prev.map(node => 
          node.nodeNum === nodeManagementNodeNum 
            ? { ...node, isFavorite: false }
            : node
        ));
      }
    } catch (error) {
      // Error already handled by executeCommand (toast shown)
      console.error('Remove favorite node command failed:', error);
    }
  };

  const handleSetIgnoredNode = async () => {
    if (nodeManagementNodeNum === null) {
      showToast(t('admin_commands.please_select_node_to_ignore'), 'error');
      return;
    }
    try {
      await executeCommand('setIgnoredNode', { nodeNum: nodeManagementNodeNum });
      showToast(t('admin_commands.node_set_ignored', { nodeNum: nodeManagementNodeNum }), 'success');
      // Optimistically update state - use remote status if managing remote node, otherwise local
      if (isManagingRemoteNode) {
        setRemoteNodeStatus(prev => {
          const newMap = new Map(prev);
          const current = newMap.get(nodeManagementNodeNum) || { isFavorite: false, isIgnored: false };
          newMap.set(nodeManagementNodeNum, { ...current, isIgnored: true });
          return newMap;
        });
      } else {
        setNodeOptions(prev => prev.map(node => 
          node.nodeNum === nodeManagementNodeNum 
            ? { ...node, isIgnored: true }
            : node
        ));
      }
    } catch (error) {
      // Error already handled by executeCommand (toast shown)
      console.error('Set ignored node command failed:', error);
    }
  };

  const handleRemoveIgnoredNode = async () => {
    if (nodeManagementNodeNum === null) {
      showToast(t('admin_commands.please_select_node_to_unignore'), 'error');
      return;
    }
    try {
      await executeCommand('removeIgnoredNode', { nodeNum: nodeManagementNodeNum });
      showToast(t('admin_commands.node_removed_ignored', { nodeNum: nodeManagementNodeNum }), 'success');
      // Optimistically update state - use remote status if managing remote node, otherwise local
      if (isManagingRemoteNode) {
        setRemoteNodeStatus(prev => {
          const newMap = new Map(prev);
          const current = newMap.get(nodeManagementNodeNum) || { isFavorite: false, isIgnored: false };
          newMap.set(nodeManagementNodeNum, { ...current, isIgnored: false });
          return newMap;
        });
      } else {
        setNodeOptions(prev => prev.map(node => 
          node.nodeNum === nodeManagementNodeNum 
            ? { ...node, isIgnored: false }
            : node
        ));
      }
    } catch (error) {
      // Error already handled by executeCommand (toast shown)
      console.error('Remove ignored node command failed:', error);
    }
  };

  const handleSetDeviceConfig = async () => {
    const validNodeInfoBroadcastSecs = Math.max(3600, nodeInfoBroadcastSecs);
    try {
      await executeCommand('setDeviceConfig', {
        config: {
          role: deviceRole,
          nodeInfoBroadcastSecs: validNodeInfoBroadcastSecs
        }
      });
    } catch (error) {
      // Error already handled by executeCommand (toast shown)
      console.error('Set device config command failed:', error);
    }
  };

  const handleSetLoRaConfig = async () => {
    const validHopLimit = Math.min(7, Math.max(1, hopLimit));
    const config: any = {
      usePreset,
      hopLimit: validHopLimit,
      txPower,
      channelNum,
      sx126xRxBoostedGain,
      ignoreMqtt,
      configOkToMqtt
    };

    if (usePreset) {
      config.modemPreset = modemPreset;
    } else {
      config.bandwidth = bandwidth;
      config.spreadFactor = spreadFactor;
      config.codingRate = codingRate;
      config.frequencyOffset = frequencyOffset;
      config.overrideFrequency = overrideFrequency;
    }

    config.region = region;

    try {
      await executeCommand('setLoRaConfig', { config });
    } catch (error) {
      // Error already handled by executeCommand (toast shown)
      console.error('Set LoRa config command failed:', error);
    }
  };

  const handleSetPositionConfig = async () => {
    const config: any = {
      positionBroadcastSecs: Math.max(32, positionBroadcastSecs),
      positionSmartEnabled,
      fixedPosition
    };

    if (fixedPosition) {
      config.fixedLatitude = fixedLatitude;
      config.fixedLongitude = fixedLongitude;
      config.fixedAltitude = fixedAltitude;
    }

    try {
      await executeCommand('setPositionConfig', { config });
    } catch (error) {
      // Error already handled by executeCommand (toast shown)
      console.error('Set position config command failed:', error);
    }
  };

  const handleSetMQTTConfig = async () => {
    const config: any = {
      enabled: mqttEnabled,
      address: mqttAddress,
      username: mqttUsername,
      password: mqttPassword,
      encryptionEnabled: mqttEncryptionEnabled,
      jsonEnabled: mqttJsonEnabled,
      root: mqttRoot
    };

    try {
      await executeCommand('setMQTTConfig', { config });
    } catch (error) {
      // Error already handled by executeCommand (toast shown)
      console.error('Set MQTT config command failed:', error);
    }
  };

  const handleLoadSecurityConfig = async () => {
    if (selectedNodeNum === null) {
      showToast(t('admin_commands.please_select_node'), 'error');
      return;
    }

    setIsLoadingSecurityConfig(true);
    try {
      const result = await apiService.post<{ config: any }>('/api/admin/load-config', {
        nodeNum: selectedNodeNum,
        configType: 'security'
      });
      
      if (result?.config) {
        const config = result.config;
        if (config.adminKeys !== undefined) {
          // Set admin keys, but only add empty field if we have fewer than 3 keys (max 3)
          if (config.adminKeys.length === 0) {
            setAdminKeys(['']);
          } else if (config.adminKeys.length < 3) {
            setAdminKeys([...config.adminKeys, '']);
          } else {
            setAdminKeys(config.adminKeys.slice(0, 3)); // Ensure max 3 keys
          }
        }
        if (config.isManaged !== undefined) setIsManaged(config.isManaged);
        if (config.serialEnabled !== undefined) setSerialEnabled(config.serialEnabled);
        if (config.debugLogApiEnabled !== undefined) setDebugLogApiEnabled(config.debugLogApiEnabled);
        if (config.adminChannelEnabled !== undefined) setAdminChannelEnabled(config.adminChannelEnabled);
        showToast(t('admin_commands.security_config_loaded'), 'success');
      }
    } catch (error: any) {
      showToast(error.message || t('admin_commands.failed_load_security_config'), 'error');
    } finally {
      setIsLoadingSecurityConfig(false);
    }
  };

  const handleSetSecurityConfig = async () => {
    // Filter out empty admin keys
    const validAdminKeys = adminKeys.filter(key => key && key.trim().length > 0);
    
    const config: any = {
      adminKeys: validAdminKeys,
      isManaged,
      serialEnabled,
      debugLogApiEnabled,
      adminChannelEnabled
    };

    try {
      await executeCommand('setSecurityConfig', { config });
    } catch (error) {
      // Error already handled by executeCommand (toast shown)
      console.error('Set security config command failed:', error);
    }
  };

  const handleAdminKeyChange = (index: number, value: string) => {
    const newKeys = [...adminKeys];
    newKeys[index] = value;
    // Add a new empty field if the last field is being filled, but only if we have fewer than 3 keys (max 3)
    if (index === adminKeys.length - 1 && value.trim().length > 0 && adminKeys.length < 3) {
      newKeys.push('');
    }
    // Ensure we never exceed 3 keys
    setAdminKeys(newKeys.slice(0, 3));
  };

  const handleRemoveAdminKey = (index: number) => {
    const newKeys = adminKeys.filter((_, i) => i !== index);
    // Ensure at least one field remains
    if (newKeys.length === 0) {
      newKeys.push('');
    }
    setAdminKeys(newKeys);
  };

  const handleRoleChange = (newRole: number) => {
    if (newRole === 2) {
      const confirmed = window.confirm(t('admin_commands.router_mode_confirmation'));
      if (!confirmed) {
        setIsRoleDropdownOpen(false);
        return;
      }
    }
    setDeviceRole(newRole);
    setIsRoleDropdownOpen(false);
  };


  const handleEditChannel = (slotId: number) => {
    // Use the same channel source logic as the display
    const localNodeNum = nodes.find(n => (n.user?.id || n.nodeId) === currentNodeId)?.nodeNum;
    const isLocalNode = selectedNodeNum === localNodeNum || selectedNodeNum === 0;
    
    let channelsToUse: Channel[];
    if (isLocalNode) {
      // For local node, use remoteNodeChannels if loaded, otherwise empty
      channelsToUse = remoteNodeChannels.length > 0 ? remoteNodeChannels : [];
    } else {
      // For remote nodes, use remoteNodeChannels
      channelsToUse = remoteNodeChannels;
    }
    
    const existingChannel = channelsToUse.find(ch => ch.id === slotId);
    setEditingChannelSlot(slotId);
    setChannelName(existingChannel?.name ?? '');
    setChannelPsk(existingChannel?.psk ?? '');
    setChannelRole((existingChannel?.role !== undefined && existingChannel?.role !== null) ? existingChannel.role : (slotId === 0 ? 1 : 0));
    setChannelUplinkEnabled(existingChannel?.uplinkEnabled !== undefined ? existingChannel.uplinkEnabled : false);
    setChannelDownlinkEnabled(existingChannel?.downlinkEnabled !== undefined ? existingChannel.downlinkEnabled : false);
    setChannelPositionPrecision((existingChannel?.positionPrecision !== undefined && existingChannel?.positionPrecision !== null) ? existingChannel.positionPrecision : 32);
    setShowChannelEditModal(true);
  };

  const handleLoadSingleChannel = async (channelIndex: number, retryCount: number = 0) => {
    if (selectedNodeNum === null) {
      return;
    }

    const maxRetries = 3;
    const retryDelay = 1500; // 1.5 seconds between retries

    try {
      const channel = await apiService.post<{ channel?: any }>('/api/admin/get-channel', {
        nodeNum: selectedNodeNum,
        channelIndex: channelIndex
      });
      
      const now = Date.now();
      let channelData: Channel;
      
      if (channel?.channel) {
        const ch = channel.channel;
        // Convert role to number if it's a string enum
        let role = ch.role;
        if (typeof role === 'string') {
          const roleMap: { [key: string]: number } = {
            'DISABLED': 0,
            'PRIMARY': 1,
            'SECONDARY': 2
          };
          role = roleMap[role] !== undefined ? roleMap[role] : (channelIndex === 0 ? 1 : 0);
        } else if (role === undefined || role === null) {
          role = channelIndex === 0 ? 1 : 0;
        }
        
        // If role is DISABLED (0) but channel has data, infer the correct role
        const hasData = (ch.name && ch.name.trim().length > 0) || (ch.psk && ch.psk.length > 0);
        if (role === 0 && hasData) {
          role = channelIndex === 0 ? 1 : 2;
        }
        
        channelData = {
          id: channelIndex,
          name: ch.name || '',
          psk: ch.psk || '',
          role: role,
          uplinkEnabled: ch.uplinkEnabled !== undefined ? ch.uplinkEnabled : false,
          downlinkEnabled: ch.downlinkEnabled !== undefined ? ch.downlinkEnabled : false,
          positionPrecision: ch.positionPrecision !== undefined ? ch.positionPrecision : 32,
          createdAt: now,
          updatedAt: now
        };
      } else {
        // Empty channel slot
        channelData = {
          id: channelIndex,
          name: '',
          psk: '',
          role: channelIndex === 0 ? 1 : 0,
          uplinkEnabled: false,
          downlinkEnabled: false,
          positionPrecision: 32,
          createdAt: now,
          updatedAt: now
        };
      }
      
      // Update remoteNodeChannels with just this channel
      setRemoteNodeChannels(prev => {
        const updated = [...prev];
        const existingIndex = updated.findIndex(ch => ch.id === channelIndex);
        if (existingIndex !== -1) {
          updated[existingIndex] = channelData;
        } else {
          updated.push(channelData);
          // Sort by ID to maintain order
          updated.sort((a, b) => a.id - b.id);
        }
        return updated;
      });
    } catch (error: any) {
      // If it's a 404 or timeout error and we haven't exceeded retries, try again
      const isRetryableError = error.message?.includes('404') || 
                               error.message?.includes('not received') ||
                               error.message?.includes('timeout');
      
      if (isRetryableError && retryCount < maxRetries) {
        // Wait before retrying
        await new Promise(resolve => setTimeout(resolve, retryDelay));
        // Retry
        return handleLoadSingleChannel(channelIndex, retryCount + 1);
      }
      
      // Log but don't show toast - the save was successful, this is just a refresh
      // Only log if we've exhausted retries
      if (retryCount >= maxRetries) {
        console.warn(`Failed to refresh channel ${channelIndex} after ${maxRetries} retries:`, error);
      }
    }
  };

  const handleSaveChannel = async () => {
    if (editingChannelSlot === null) return;
    
    if (channelName.length > 11) {
      showToast(t('admin_commands.channel_name_max_length'), 'error');
      return;
    }
    
    const savedChannelIndex = editingChannelSlot;
    
    // When disabling a channel (role 0), clear name and PSK
    const isDisabling = channelRole === 0;
    const finalName = isDisabling ? '' : channelName;
    const finalPsk = isDisabling ? undefined : (channelPsk || undefined);
    
    try {
      await executeCommand('setChannel', {
        channelIndex: savedChannelIndex,
        config: {
          name: finalName,
          psk: finalPsk,
          role: channelRole,
          uplinkEnabled: channelUplinkEnabled,
          downlinkEnabled: channelDownlinkEnabled,
          positionPrecision: channelPositionPrecision
        }
      });
      
      // Close modal first
      setShowChannelEditModal(false);
      setEditingChannelSlot(null);
      
      // Refresh only the saved channel after successful save
      // Wait a moment for the remote node to process the change (especially for remote nodes)
      await new Promise(resolve => setTimeout(resolve, 1500));
      await handleLoadSingleChannel(savedChannelIndex);
    } catch (error) {
      // Error is already handled by executeCommand, just don't refresh
      console.error('Failed to save channel:', error);
    }
  };

  const handleExportChannel = async (channelId: number) => {
    if (selectedNodeNum === null) {
      showToast(t('admin_commands.please_select_node_export'), 'error');
      return;
    }

    try {
      const localNodeNum = nodes.find(n => (n.user?.id || n.nodeId) === currentNodeId)?.nodeNum;
      const isLocalNode = selectedNodeNum === localNodeNum || selectedNodeNum === 0;

      if (isLocalNode) {
        // For local node, use the standard export endpoint
        await apiService.exportChannel(channelId);
        showToast(t('admin_commands.channel_exported_successfully', { channelId }), 'success');
      } else {
        // For remote node, get channel data and export it manually
        const channel = await apiService.post<{ channel?: any }>('/api/admin/get-channel', {
          nodeNum: selectedNodeNum,
          channelIndex: channelId
        });

        if (!channel?.channel) {
          showToast(`Channel ${channelId} not found`, 'error');
          return;
        }

        const ch = channel.channel;
        // Normalize boolean values to ensure consistent export format
        const normalizeBoolean = (value: any, defaultValue: boolean = true): boolean => {
          if (value === undefined || value === null) {
            return defaultValue;
          }
          if (typeof value === 'boolean') return value;
          if (typeof value === 'number') return value !== 0;
          if (typeof value === 'string') return value.toLowerCase() === 'true' || value === '1';
          return !!value;
        };
        
        const exportData = {
          version: '1.0',
          exportedAt: new Date().toISOString(),
          channel: {
            id: channelId,
            name: ch.name || '',
            psk: ch.psk || '',
            role: ch.role,
            uplinkEnabled: normalizeBoolean(ch.uplinkEnabled, true),
            downlinkEnabled: normalizeBoolean(ch.downlinkEnabled, true),
            positionPrecision: ch.positionPrecision,
          },
        };

        // Download the file
        const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        const channelName = ch.name || 'unnamed';
        const filename = `meshmonitor-channel-${channelName.replace(/[^a-z0-9]/gi, '_').toLowerCase()}-${Date.now()}.json`;
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        document.body.removeChild(a);
        showToast(t('admin_commands.channel_exported_successfully', { channelId }), 'success');
      }
    } catch (error: any) {
      showToast(error.message || 'Failed to export channel', 'error');
      console.error('Error exporting channel:', error);
    }
  };

  const handleImportClick = (slotId: number) => {
    setImportSlotId(slotId);
    setImportFileContent('');
    setShowImportModal(true);
  };

  const handleFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      const content = e.target?.result as string;
      setImportFileContent(content);
    };
    reader.readAsText(file);
  };

  const handleImportChannel = async () => {
    if (!importFileContent || importSlotId === null || selectedNodeNum === null) {
      showToast(t('admin_commands.please_select_file_and_slot'), 'error');
      return;
    }

    setIsExecuting(true);
    try {
      // Parse the imported JSON
      const importData = JSON.parse(importFileContent);

      if (!importData.channel) {
        throw new Error(t('admin_commands.invalid_import_format'));
      }

      const channelData = importData.channel;

      // Validate required fields
      if (channelData.name && channelData.name.length > 11) {
        showToast(t('admin_commands.channel_name_max_length'), 'error');
        return;
      }

      // Normalize boolean values - handle both boolean (true/false) and numeric (1/0) formats
      const normalizeBoolean = (value: any, defaultValue: boolean = true): boolean => {
        if (value === undefined || value === null) {
          return defaultValue;
        }
        // Handle boolean values
        if (typeof value === 'boolean') {
          return value;
        }
        // Handle numeric values (0/1)
        if (typeof value === 'number') {
          return value !== 0;
        }
        // Handle string values ("true"/"false", "1"/"0")
        if (typeof value === 'string') {
          return value.toLowerCase() === 'true' || value === '1';
        }
        // Default to truthy check
        return !!value;
      };

      const localNodeNum = nodes.find(n => (n.user?.id || n.nodeId) === currentNodeId)?.nodeNum;
      const isLocalNode = selectedNodeNum === localNodeNum || selectedNodeNum === 0;

      if (isLocalNode) {
        // For local node, use the standard import endpoint
        // Normalize the channel data before sending
        const normalizedChannelData = {
          ...channelData,
          uplinkEnabled: normalizeBoolean(channelData.uplinkEnabled, true),
          downlinkEnabled: normalizeBoolean(channelData.downlinkEnabled, true)
        };
        await apiService.importChannel(importSlotId, normalizedChannelData);
        showToast(t('admin_commands.channel_imported_successfully', { importSlotId }), 'success');
        // Refresh channels
        if (_onChannelsUpdated) {
          _onChannelsUpdated();
        }
      } else {
        // For remote node, use admin command to set channel
        await executeCommand('setChannel', {
          channelIndex: importSlotId,
          config: {
            name: channelData.name || '',
            psk: channelData.psk || undefined,
            role: channelData.role !== undefined ? channelData.role : (importSlotId === 0 ? 1 : 0),
            uplinkEnabled: normalizeBoolean(channelData.uplinkEnabled, true),
            downlinkEnabled: normalizeBoolean(channelData.downlinkEnabled, true),
            positionPrecision: channelData.positionPrecision !== undefined ? channelData.positionPrecision : 32
          }
        });
        showToast(t('admin_commands.channel_imported_successfully', { importSlotId }), 'success');
        // Refresh the imported channel
        await new Promise(resolve => setTimeout(resolve, 1500));
        await handleLoadSingleChannel(importSlotId);
      }

      setShowImportModal(false);
      setImportFileContent('');
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    } catch (error: any) {
      showToast(error.message || 'Failed to import channel', 'error');
      console.error('Error importing channel:', error);
    } finally {
      setIsExecuting(false);
    }
  };

  const selectedNode = nodeOptions.find(n => n.nodeNum === selectedNodeNum);

  // Show loading state if nodes haven't loaded yet
  // if (!nodes || nodes.length === 0) {
  //   return (
  //     <div style={{ padding: '2rem', maxWidth: '1200px', margin: '0 auto' }}>
  //       <h2 style={{ marginBottom: '1.5rem', color: 'var(--ctp-text)' }}>{t('admin_commands.title')}</h2>
  //       <p style={{ color: 'var(--ctp-subtext0)' }}>{t('admin_commands.loading_nodes')}</p>
  //     </div>
  //   );
  // }

  return (
    <div className="tab-content">
      <SectionNav items={[
        { id: 'admin-target-node', label: t('admin_commands.target_node', 'Target Node') },
        { id: 'admin-set-owner', label: t('admin_commands.set_owner', 'Set Owner') },
        { id: 'admin-device-config', label: t('admin_commands.device_configuration', 'Device Config') },
        { id: 'admin-lora-config', label: t('admin_commands.lora_configuration', 'LoRa Config') },
        { id: 'admin-position-config', label: t('admin_commands.position_configuration', 'Position') },
        { id: 'admin-mqtt-config', label: t('admin_commands.mqtt_configuration', 'MQTT') },
        { id: 'admin-security-config', label: t('admin_commands.security_configuration', 'Security') },
        { id: 'admin-channel-config', label: t('admin_commands.channel_configuration', 'Channels') },
        { id: 'admin-import-export', label: t('admin_commands.config_import_export', 'Import/Export') },
        { id: 'admin-node-management', label: t('admin_commands.node_favorites_ignored', 'Node Management') },
      ]} />

      {/* Node Selection Section */}
      <div id="admin-target-node" className="settings-section">
        <h3>{t('admin_commands.target_node')}</h3>
        <div className="setting-item">
          <label>
            {t('admin_commands.select_node_description')}
            <span className="setting-description">
              {t('admin_commands.select_node_help')}
            </span>
          </label>
          <div ref={searchRef} style={{ position: 'relative', width: '100%', maxWidth: '600px' }}>
            <input
              type="text"
              className="setting-input"
              placeholder={selectedNode ? selectedNode.longName : t('admin_commands.search_node_placeholder')}
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                setShowSearch(true);
              }}
              onFocus={() => setShowSearch(true)}
              disabled={isExecuting || nodeOptions.length === 0}
              style={{ width: '100%' }}
            />
            {showSearch && filteredNodes.length > 0 && (
              <div style={{
                position: 'absolute',
                top: '100%',
                left: 0,
                right: 0,
                marginTop: '4px',
                background: 'var(--ctp-base)',
                border: '2px solid var(--ctp-surface2)',
                borderRadius: '8px',
                maxHeight: '300px',
                overflowY: 'auto',
                zIndex: 1000,
                boxShadow: '0 4px 12px rgba(0, 0, 0, 0.3)'
              }}>
                {filteredNodes.map(node => (
                  <div
                    key={node.nodeNum}
                    onClick={() => handleNodeSelect(node.nodeNum)}
                    style={{
                      padding: '0.75rem 1rem',
                      cursor: 'pointer',
                      borderBottom: '1px solid var(--ctp-surface1)',
                      transition: 'background 0.1s',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center'
                    }}
                    onMouseEnter={(e) => e.currentTarget.style.background = 'var(--ctp-surface0)'}
                    onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                  >
                    <div>
                      <div style={{ fontWeight: '500', color: 'var(--ctp-text)' }}>
                        {node.longName} {node.isLocal && <span style={{ color: 'var(--ctp-blue)' }}>({t('admin_commands.local_node_indicator')})</span>}
                      </div>
                      <div style={{ fontSize: '0.85rem', color: 'var(--ctp-subtext0)', marginTop: '0.25rem' }}>
                        {node.shortName && node.shortName !== node.longName && `${node.shortName} • `}
                        {node.nodeId}
                      </div>
                    </div>
                    {selectedNodeNum === node.nodeNum && (
                      <span style={{ color: 'var(--ctp-blue)', fontSize: '1.2rem' }}>✓</span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
          {selectedNode && (
            <div style={{ marginTop: '0.75rem', fontSize: '0.875rem', color: 'var(--ctp-subtext0)' }}>
              {selectedNode.isLocal ? (
                <span>{t('admin_commands.local_node_no_passkey')}</span>
              ) : (
                <span>{t('admin_commands.remote_node_passkey')}</span>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="settings-content">
      {/* Set Owner Command Section */}
      <div id="admin-set-owner" className="settings-section">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem', paddingBottom: '0.75rem', borderBottom: '2px solid var(--ctp-surface2)' }}>
          <h3 style={{ margin: 0, borderBottom: 'none', paddingBottom: 0 }}>{t('admin_commands.set_owner')}</h3>
          <button
            onClick={handleLoadOwner}
            disabled={isLoadingOwner || selectedNodeNum === null}
            className="save-button"
            style={{
              opacity: (isLoadingOwner || selectedNodeNum === null) ? 0.5 : 1,
              cursor: (isLoadingOwner || selectedNodeNum === null) ? 'not-allowed' : 'pointer'
            }}
          >
            {isLoadingOwner ? t('common.loading') : t('common.load')}
          </button>
        </div>
        <div className="setting-item">
          <label>
            {t('admin_commands.long_name')}
            <span className="setting-description">
              {t('admin_commands.long_name_description')}
            </span>
          </label>
          <input
            type="text"
            value={ownerLongName}
            onChange={(e) => setOwnerLongName(e.target.value)}
            disabled={isExecuting}
            placeholder={t('admin_commands.long_name_placeholder')}
            className="setting-input"
          />
        </div>
        <div className="setting-item">
          <label>
            {t('admin_commands.short_name')}
            <span className="setting-description">
              {t('admin_commands.short_name_description')}
            </span>
          </label>
          <input
            type="text"
            value={ownerShortName}
            onChange={(e) => setOwnerShortName(e.target.value)}
            disabled={isExecuting}
            placeholder={t('admin_commands.short_name_placeholder')}
            maxLength={4}
            className="setting-input"
          />
        </div>
        <div className="setting-item">
          <label style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
            <input
              type="checkbox"
              checked={ownerIsUnmessagable}
              onChange={(e) => setOwnerIsUnmessagable(e.target.checked)}
              disabled={isExecuting}
              style={{ width: 'auto', margin: 0, flexShrink: 0 }}
            />
            <div style={{ flex: 1 }}>
              <div>{t('admin_commands.mark_unmessagable')}</div>
              <span className="setting-description">{t('admin_commands.mark_unmessagable_description')}</span>
            </div>
          </label>
        </div>
        <button
          className="save-button"
          onClick={handleSetOwner}
          disabled={isExecuting || !ownerLongName.trim() || !ownerShortName.trim() || selectedNodeNum === null}
          style={{
            opacity: (isExecuting || !ownerLongName.trim() || !ownerShortName.trim() || selectedNodeNum === null) ? 0.5 : 1,
            cursor: (isExecuting || !ownerLongName.trim() || !ownerShortName.trim() || selectedNodeNum === null) ? 'not-allowed' : 'pointer'
          }}
        >
          {isExecuting ? t('common.saving') : t('admin_commands.set_owner_button')}
        </button>
      </div>

      {/* Device Config Section */}
      <div id="admin-device-config" className="settings-section">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem', paddingBottom: '0.75rem', borderBottom: '2px solid var(--ctp-surface2)' }}>
          <h3 style={{ margin: 0, borderBottom: 'none', paddingBottom: 0 }}>{t('admin_commands.device_configuration')}</h3>
          <button
            onClick={handleLoadDeviceConfig}
            disabled={isLoadingDeviceConfig || selectedNodeNum === null}
            className="save-button"
            style={{
              opacity: (isLoadingDeviceConfig || selectedNodeNum === null) ? 0.5 : 1,
              cursor: (isLoadingDeviceConfig || selectedNodeNum === null) ? 'not-allowed' : 'pointer'
            }}
          >
            {isLoadingDeviceConfig ? t('common.loading') : t('common.load')}
          </button>
        </div>
        <div className="setting-item">
          <label>
            {t('admin_commands.device_role')}
            <span className="setting-description">
              {t('admin_commands.device_role_description')}
            </span>
          </label>
          <div style={{ position: 'relative' }}>
            <div
              onClick={() => setIsRoleDropdownOpen(!isRoleDropdownOpen)}
              className="setting-input config-custom-dropdown"
              style={{
                cursor: 'pointer',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                padding: '0.75rem',
                minHeight: '80px',
                width: '100%',
                maxWidth: '800px'
              }}
            >
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 'bold', fontSize: '1.1em', color: 'var(--ctp-text)', marginBottom: '0.5rem' }}>
                  {ROLE_OPTIONS.find(opt => opt.value === deviceRole)?.name || 'CLIENT'}
                </div>
                <div style={{ fontSize: '0.9em', color: 'var(--ctp-subtext0)', marginBottom: '0.25rem', lineHeight: '1.4' }}>
                  {ROLE_OPTIONS.find(opt => opt.value === deviceRole)?.shortDesc || ''}
                </div>
                <div style={{ fontSize: '0.85em', color: 'var(--ctp-subtext1)', fontStyle: 'italic', lineHeight: '1.4' }}>
                  {ROLE_OPTIONS.find(opt => opt.value === deviceRole)?.description || ''}
                </div>
              </div>
              <span style={{ fontSize: '1.2em', marginLeft: '1rem', flexShrink: 0 }}>{isRoleDropdownOpen ? '▲' : '▼'}</span>
            </div>
            {isRoleDropdownOpen && (
              <div
                className="config-custom-dropdown-menu"
                style={{
                  position: 'absolute',
                  top: '100%',
                  left: 0,
                  width: '100%',
                  maxWidth: '800px',
                  background: 'var(--ctp-base)',
                  border: '2px solid var(--ctp-surface2)',
                  borderRadius: '8px',
                  maxHeight: '500px',
                  overflowY: 'auto',
                  zIndex: 1000,
                  boxShadow: '0 4px 12px rgba(0, 0, 0, 0.3)'
                }}
              >
                {ROLE_OPTIONS.map(option => (
                  <div
                    key={option.value}
                    onClick={() => handleRoleChange(option.value)}
                    style={{
                      padding: '0.75rem 1rem',
                      cursor: 'pointer',
                      borderBottom: '1px solid var(--ctp-surface1)',
                      background: option.value === deviceRole ? 'var(--ctp-surface0)' : 'transparent',
                      transition: 'background 0.2s'
                    }}
                    onMouseEnter={(e) => {
                      if (option.value !== deviceRole) {
                        e.currentTarget.style.background = 'var(--ctp-surface0)';
                      }
                    }}
                    onMouseLeave={(e) => {
                      if (option.value !== deviceRole) {
                        e.currentTarget.style.background = 'transparent';
                      }
                    }}
                  >
                    <div style={{ fontWeight: 'bold', fontSize: '1em', color: 'var(--ctp-text)', marginBottom: '0.4rem' }}>
                      {option.name}
                    </div>
                    <div style={{ fontSize: '0.9em', color: 'var(--ctp-subtext0)', marginBottom: '0.3rem', lineHeight: '1.4' }}>
                      {option.shortDesc}
                    </div>
                    <div style={{ fontSize: '0.85em', color: 'var(--ctp-subtext1)', fontStyle: 'italic', lineHeight: '1.4' }}>
                      {option.description}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
        <div className="setting-item">
          <label>
            {t('admin_commands.node_info_broadcast')}
            <span className="setting-description">
              {t('admin_commands.node_info_broadcast_description')}
            </span>
          </label>
          <input
            type="number"
            min="3600"
            max="4294967295"
            value={nodeInfoBroadcastSecs}
            onChange={(e) => setNodeInfoBroadcastSecs(parseInt(e.target.value))}
            disabled={isExecuting}
            className="setting-input"
            style={{ width: '200px' }}
          />
        </div>
        <button
          className="save-button"
          onClick={handleSetDeviceConfig}
          disabled={isExecuting || selectedNodeNum === null}
          style={{
            opacity: (isExecuting || selectedNodeNum === null) ? 0.5 : 1,
            cursor: (isExecuting || selectedNodeNum === null) ? 'not-allowed' : 'pointer'
          }}
        >
          {isExecuting ? t('common.saving') : t('admin_commands.save_device_config')}
        </button>
      </div>

      {/* LoRa Config Section */}
      <div id="admin-lora-config" className="settings-section">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem', paddingBottom: '0.75rem', borderBottom: '2px solid var(--ctp-surface2)' }}>
          <h3 style={{ margin: 0, borderBottom: 'none', paddingBottom: 0 }}>{t('admin_commands.lora_configuration')}</h3>
          <button
            onClick={handleLoadLoRaConfig}
            disabled={isLoadingLoRaConfig || selectedNodeNum === null}
            className="save-button"
            style={{
              opacity: (isLoadingLoRaConfig || selectedNodeNum === null) ? 0.5 : 1,
              cursor: (isLoadingLoRaConfig || selectedNodeNum === null) ? 'not-allowed' : 'pointer'
            }}
          >
            {isLoadingLoRaConfig ? t('common.loading') : t('common.load')}
          </button>
        </div>
        <div className="setting-item">
          <label style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
            <input
              type="checkbox"
              checked={usePreset}
              onChange={(e) => setUsePreset(e.target.checked)}
              disabled={isExecuting}
              style={{ width: 'auto', margin: 0, flexShrink: 0 }}
            />
            <div style={{ flex: 1 }}>
              <div>{t('admin_commands.use_modem_preset')}</div>
              <span className="setting-description">{t('admin_commands.use_modem_preset_description')}</span>
            </div>
          </label>
        </div>
        {usePreset ? (
          <div className="setting-item">
            <label>{t('admin_commands.modem_preset')}</label>
            <select
              value={modemPreset}
              onChange={(e) => setModemPreset(Number(e.target.value))}
              disabled={isExecuting}
              className="setting-input"
              style={{ width: '300px' }}
            >
              {MODEM_PRESET_OPTIONS.map(preset => (
                <option key={preset.value} value={preset.value}>
                  {preset.name} - {preset.description} ({preset.params})
                </option>
              ))}
            </select>
          </div>
        ) : (
          <>
            <div className="setting-item">
              <label>{t('admin_commands.bandwidth')}</label>
              <input
                type="number"
                value={bandwidth}
                onChange={(e) => setBandwidth(Number(e.target.value))}
                disabled={isExecuting}
                className="setting-input"
                style={{ width: '200px' }}
              />
            </div>
            <div className="setting-item">
              <label>{t('admin_commands.spread_factor')}</label>
              <input
                type="number"
                min="7"
                max="12"
                value={spreadFactor}
                onChange={(e) => setSpreadFactor(Number(e.target.value))}
                disabled={isExecuting}
                className="setting-input"
                style={{ width: '200px' }}
              />
            </div>
            <div className="setting-item">
              <label>Coding Rate</label>
              <input
                type="number"
                value={codingRate}
                onChange={(e) => setCodingRate(Number(e.target.value))}
                disabled={isExecuting}
                className="setting-input"
                style={{ width: '200px' }}
              />
            </div>
            <div className="setting-item">
              <label>Frequency Offset</label>
              <input
                type="number"
                value={frequencyOffset}
                onChange={(e) => setFrequencyOffset(Number(e.target.value))}
                disabled={isExecuting}
                className="setting-input"
                style={{ width: '200px' }}
              />
            </div>
            <div className="setting-item">
              <label>Override Frequency (Hz)</label>
              <input
                type="number"
                value={overrideFrequency}
                onChange={(e) => setOverrideFrequency(Number(e.target.value))}
                disabled={isExecuting}
                className="setting-input"
                style={{ width: '200px' }}
              />
            </div>
          </>
        )}
        <div className="setting-item">
          <label>Region</label>
          <select
            value={region}
            onChange={(e) => setRegion(Number(e.target.value))}
            disabled={isExecuting}
            className="setting-input"
            style={{ width: '300px' }}
          >
            {REGION_OPTIONS.map(reg => (
              <option key={reg.value} value={reg.value}>
                {reg.label}
              </option>
            ))}
          </select>
        </div>
        <div className="setting-item">
          <label>Hop Limit (1-7)</label>
          <input
            type="number"
            min="1"
            max="7"
            value={hopLimit}
            onChange={(e) => setHopLimit(Number(e.target.value))}
            disabled={isExecuting}
            className="setting-input"
            style={{ width: '200px' }}
          />
        </div>
        <div className="setting-item">
          <label>TX Power</label>
          <input
            type="number"
            value={txPower}
            onChange={(e) => setTxPower(Number(e.target.value))}
            disabled={isExecuting}
            className="setting-input"
            style={{ width: '200px' }}
          />
        </div>
        <div className="setting-item">
          <label>Channel Number</label>
          <input
            type="number"
            value={channelNum}
            onChange={(e) => setChannelNum(Number(e.target.value))}
            disabled={isExecuting}
            className="setting-input"
            style={{ width: '200px' }}
          />
        </div>
        <div className="setting-item">
          <label style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
            <input
              type="checkbox"
              checked={sx126xRxBoostedGain}
              onChange={(e) => setSx126xRxBoostedGain(e.target.checked)}
              disabled={isExecuting}
              style={{ width: 'auto', margin: 0, flexShrink: 0 }}
            />
            <div style={{ flex: 1 }}>
              <div>SX126x RX Boosted Gain</div>
              <span className="setting-description">Enable boosted RX gain for SX126x radios</span>
            </div>
          </label>
        </div>
        <div className="setting-item">
          <label style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
            <input
              type="checkbox"
              checked={ignoreMqtt}
              onChange={(e) => setIgnoreMqtt(e.target.checked)}
              disabled={isExecuting}
              style={{ width: 'auto', margin: 0, flexShrink: 0 }}
            />
            <div style={{ flex: 1 }}>
              <div>{t('admin_commands.ignore_mqtt')}</div>
              <span className="setting-description">{t('admin_commands.ignore_mqtt_description')}</span>
            </div>
          </label>
        </div>
        <div className="setting-item">
          <label style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
            <input
              type="checkbox"
              checked={configOkToMqtt}
              onChange={(e) => setConfigOkToMqtt(e.target.checked)}
              disabled={isExecuting}
              style={{ width: 'auto', margin: 0, flexShrink: 0 }}
            />
            <div style={{ flex: 1 }}>
              <div>{t('admin_commands.config_ok_to_mqtt')}</div>
              <span className="setting-description">{t('admin_commands.config_ok_to_mqtt_description')}</span>
            </div>
          </label>
        </div>
        <button
          className="save-button"
          onClick={handleSetLoRaConfig}
          disabled={isExecuting || selectedNodeNum === null}
          style={{
            opacity: (isExecuting || selectedNodeNum === null) ? 0.5 : 1,
            cursor: (isExecuting || selectedNodeNum === null) ? 'not-allowed' : 'pointer'
          }}
        >
          {isExecuting ? t('common.saving') : t('admin_commands.save_lora_config')}
        </button>
      </div>

      {/* Position Config Section */}
      <div id="admin-position-config" className="settings-section">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem', paddingBottom: '0.75rem', borderBottom: '2px solid var(--ctp-surface2)' }}>
          <h3 style={{ margin: 0, borderBottom: 'none', paddingBottom: 0 }}>{t('admin_commands.position_configuration')}</h3>
          <button
            onClick={handleLoadPositionConfig}
            disabled={isLoadingPositionConfig || selectedNodeNum === null}
            className="save-button"
            style={{
              opacity: (isLoadingPositionConfig || selectedNodeNum === null) ? 0.5 : 1,
              cursor: (isLoadingPositionConfig || selectedNodeNum === null) ? 'not-allowed' : 'pointer'
            }}
          >
            {isLoadingPositionConfig ? t('common.loading') : t('common.load')}
          </button>
        </div>
        <div className="setting-item">
          <label>
            {t('admin_commands.position_broadcast_interval')}
            <span className="setting-description">{t('admin_commands.position_broadcast_interval_description')}</span>
          </label>
          <input
            type="number"
            min="32"
            max="4294967295"
            value={positionBroadcastSecs}
            onChange={(e) => setPositionBroadcastSecs(parseInt(e.target.value))}
            disabled={isExecuting}
            className="setting-input"
            style={{ width: '200px' }}
          />
        </div>
        <div className="setting-item">
          <label style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
            <input
              type="checkbox"
              checked={positionSmartEnabled}
              onChange={(e) => setPositionSmartEnabled(e.target.checked)}
              disabled={isExecuting}
              style={{ width: 'auto', margin: 0, flexShrink: 0 }}
            />
            <div style={{ flex: 1 }}>
              <div>{t('admin_commands.smart_position_broadcast')}</div>
              <span className="setting-description">{t('admin_commands.smart_position_broadcast_description')}</span>
            </div>
          </label>
        </div>
        <div className="setting-item">
          <label style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
            <input
              type="checkbox"
              checked={fixedPosition}
              onChange={(e) => setFixedPosition(e.target.checked)}
              disabled={isExecuting}
              style={{ width: 'auto', margin: 0, flexShrink: 0 }}
            />
            <div style={{ flex: 1 }}>
              <div>{t('admin_commands.fixed_position')}</div>
              <span className="setting-description">{t('admin_commands.fixed_position_description')}</span>
            </div>
          </label>
        </div>
        {fixedPosition && (
          <>
            <div className="setting-item">
              <label>
                Latitude
                <span className="setting-description">Fixed latitude coordinate (-90 to 90)</span>
              </label>
              <input
                type="number"
                step="0.000001"
                min="-90"
                max="90"
                value={fixedLatitude}
                onChange={(e) => setFixedLatitude(parseFloat(e.target.value))}
                disabled={isExecuting}
                className="setting-input"
                style={{ width: '200px' }}
              />
            </div>
            <div className="setting-item">
              <label>
                Longitude
                <span className="setting-description">Fixed longitude coordinate (-180 to 180)</span>
              </label>
              <input
                type="number"
                step="0.000001"
                min="-180"
                max="180"
                value={fixedLongitude}
                onChange={(e) => setFixedLongitude(parseFloat(e.target.value))}
                disabled={isExecuting}
                className="setting-input"
                style={{ width: '200px' }}
              />
            </div>
            <div className="setting-item">
              <label>
                Altitude (meters)
                <span className="setting-description">Fixed altitude above sea level</span>
              </label>
              <input
                type="number"
                step="1"
                value={fixedAltitude}
                onChange={(e) => setFixedAltitude(parseInt(e.target.value))}
                disabled={isExecuting}
                className="setting-input"
                style={{ width: '200px' }}
              />
            </div>
          </>
        )}
        <button
          className="save-button"
          onClick={handleSetPositionConfig}
          disabled={isExecuting || selectedNodeNum === null}
          style={{
            opacity: (isExecuting || selectedNodeNum === null) ? 0.5 : 1,
            cursor: (isExecuting || selectedNodeNum === null) ? 'not-allowed' : 'pointer'
          }}
        >
          {isExecuting ? t('common.saving') : t('admin_commands.save_position_config')}
        </button>
      </div>

      {/* MQTT Config Section */}
      <div id="admin-mqtt-config" className="settings-section">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem', paddingBottom: '0.75rem', borderBottom: '2px solid var(--ctp-surface2)' }}>
          <h3 style={{ margin: 0, borderBottom: 'none', paddingBottom: 0 }}>{t('admin_commands.mqtt_configuration')}</h3>
          <button
            onClick={handleLoadMQTTConfig}
            disabled={isLoadingMQTTConfig || selectedNodeNum === null}
            className="save-button"
            style={{
              opacity: (isLoadingMQTTConfig || selectedNodeNum === null) ? 0.5 : 1,
              cursor: (isLoadingMQTTConfig || selectedNodeNum === null) ? 'not-allowed' : 'pointer'
            }}
          >
            {isLoadingMQTTConfig ? t('common.loading') : t('common.load')}
          </button>
        </div>
        <div className="setting-item">
          <label style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
            <input
              type="checkbox"
              checked={mqttEnabled}
              onChange={(e) => setMqttEnabled(e.target.checked)}
              disabled={isExecuting}
              style={{ width: 'auto', margin: 0, flexShrink: 0 }}
            />
            <div style={{ flex: 1 }}>
              <div>{t('admin_commands.enable_mqtt')}</div>
              <span className="setting-description">{t('admin_commands.enable_mqtt_description')}</span>
            </div>
          </label>
        </div>
        {mqttEnabled && (
          <>
            <div className="setting-item">
              <label>
                {t('admin_commands.server_address')}
                <span className="setting-description">{t('admin_commands.server_address_description')}</span>
              </label>
              <input
                type="text"
                value={mqttAddress}
                onChange={(e) => setMqttAddress(e.target.value)}
                disabled={isExecuting}
                placeholder="mqtt.meshtastic.org"
                className="setting-input"
                style={{ width: '100%', maxWidth: '600px' }}
              />
            </div>
            <div className="setting-item">
              <label>
                Username
                <span className="setting-description">MQTT broker username</span>
              </label>
              <input
                type="text"
                value={mqttUsername}
                onChange={(e) => setMqttUsername(e.target.value)}
                disabled={isExecuting}
                className="setting-input"
                style={{ width: '100%', maxWidth: '600px' }}
              />
            </div>
            <div className="setting-item">
              <label>
                Password
                <span className="setting-description">MQTT broker password</span>
              </label>
              <input
                type="password"
                value={mqttPassword}
                onChange={(e) => setMqttPassword(e.target.value)}
                disabled={isExecuting}
                className="setting-input"
                style={{ width: '100%', maxWidth: '600px' }}
              />
            </div>
            <div className="setting-item">
              <label>
                Root Topic
                <span className="setting-description">MQTT root topic prefix (e.g., msh/US)</span>
              </label>
              <input
                type="text"
                value={mqttRoot}
                onChange={(e) => setMqttRoot(e.target.value)}
                disabled={isExecuting}
                placeholder="msh/US"
                className="setting-input"
                style={{ width: '100%', maxWidth: '600px' }}
              />
            </div>
            <div className="setting-item">
              <label style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
                <input
                  type="checkbox"
                  checked={mqttEncryptionEnabled}
                  onChange={(e) => setMqttEncryptionEnabled(e.target.checked)}
                  disabled={isExecuting}
                  style={{ width: 'auto', margin: 0, flexShrink: 0 }}
                />
                <div style={{ flex: 1 }}>
                  <div>Encryption Enabled</div>
                  <span className="setting-description">Use TLS encryption for MQTT connection</span>
                </div>
              </label>
            </div>
            <div className="setting-item">
              <label style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
                <input
                  type="checkbox"
                  checked={mqttJsonEnabled}
                  onChange={(e) => setMqttJsonEnabled(e.target.checked)}
                  disabled={isExecuting}
                  style={{ width: 'auto', margin: 0, flexShrink: 0 }}
                />
                <div style={{ flex: 1 }}>
                  <div>{t('admin_commands.json_enabled')}</div>
                  <span className="setting-description">{t('admin_commands.json_enabled_description')}</span>
                </div>
              </label>
            </div>
          </>
        )}
        <button
          className="save-button"
          onClick={handleSetMQTTConfig}
          disabled={isExecuting || selectedNodeNum === null}
          style={{
            opacity: (isExecuting || selectedNodeNum === null) ? 0.5 : 1,
            cursor: (isExecuting || selectedNodeNum === null) ? 'not-allowed' : 'pointer'
          }}
        >
          {isExecuting ? t('common.saving') : t('admin_commands.save_mqtt_config')}
        </button>
      </div>

      {/* Security Config Section */}
      <div id="admin-security-config" className="settings-section">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem', paddingBottom: '0.75rem', borderBottom: '2px solid var(--ctp-surface2)' }}>
          <h3 style={{ margin: 0, borderBottom: 'none', paddingBottom: 0 }}>{t('admin_commands.security_configuration')}</h3>
          <button
            onClick={handleLoadSecurityConfig}
            disabled={isLoadingSecurityConfig || selectedNodeNum === null}
            className="save-button"
            style={{
              opacity: (isLoadingSecurityConfig || selectedNodeNum === null) ? 0.5 : 1,
              cursor: (isLoadingSecurityConfig || selectedNodeNum === null) ? 'not-allowed' : 'pointer'
            }}
          >
            {isLoadingSecurityConfig ? t('common.loading') : t('common.load')}
          </button>
        </div>
        
        <div className="setting-item">
          <label>
            {t('admin_commands.admin_keys')}
            <span className="setting-description">
              {t('admin_commands.admin_keys_description')}
            </span>
          </label>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            {adminKeys.map((key, index) => (
              <div key={index} style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                <input
                  type="text"
                  value={key}
                  onChange={(e) => handleAdminKeyChange(index, e.target.value)}
                  disabled={isExecuting}
                  placeholder={t('admin_commands.admin_key_placeholder') || 'base64:... or hex string'}
                  className="setting-input"
                  style={{ flex: 1, fontFamily: 'monospace', fontSize: '0.875rem' }}
                />
                {adminKeys.length > 1 && (
                  <button
                    onClick={() => handleRemoveAdminKey(index)}
                    disabled={isExecuting}
                    style={{
                      padding: '0.5rem 1rem',
                      background: 'var(--ctp-red)',
                      color: 'var(--ctp-base)',
                      border: 'none',
                      borderRadius: '4px',
                      cursor: isExecuting ? 'not-allowed' : 'pointer',
                      opacity: isExecuting ? 0.5 : 1
                    }}
                  >
                    {t('common.remove') || 'Remove'}
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>

        <div className="setting-item">
          <label style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
            <input
              type="checkbox"
              checked={isManaged}
              onChange={(e) => setIsManaged(e.target.checked)}
              disabled={isExecuting}
              style={{ width: 'auto', margin: 0, flexShrink: 0 }}
            />
            <div style={{ flex: 1 }}>
              <div>{t('admin_commands.is_managed')}</div>
              <span className="setting-description">{t('admin_commands.is_managed_description')}</span>
            </div>
          </label>
        </div>

        <div className="setting-item">
          <label style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
            <input
              type="checkbox"
              checked={serialEnabled}
              onChange={(e) => setSerialEnabled(e.target.checked)}
              disabled={isExecuting}
              style={{ width: 'auto', margin: 0, flexShrink: 0 }}
            />
            <div style={{ flex: 1 }}>
              <div>{t('admin_commands.serial_enabled')}</div>
              <span className="setting-description">{t('admin_commands.serial_enabled_description')}</span>
            </div>
          </label>
        </div>

        <div className="setting-item">
          <label style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
            <input
              type="checkbox"
              checked={debugLogApiEnabled}
              onChange={(e) => setDebugLogApiEnabled(e.target.checked)}
              disabled={isExecuting}
              style={{ width: 'auto', margin: 0, flexShrink: 0 }}
            />
            <div style={{ flex: 1 }}>
              <div>{t('admin_commands.debug_log_api_enabled')}</div>
              <span className="setting-description">{t('admin_commands.debug_log_api_enabled_description')}</span>
            </div>
          </label>
        </div>

        <div className="setting-item">
          <label style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
            <input
              type="checkbox"
              checked={adminChannelEnabled}
              onChange={(e) => setAdminChannelEnabled(e.target.checked)}
              disabled={isExecuting}
              style={{ width: 'auto', margin: 0, flexShrink: 0 }}
            />
            <div style={{ flex: 1 }}>
              <div>{t('admin_commands.admin_channel_enabled')}</div>
              <span className="setting-description">{t('admin_commands.admin_channel_enabled_description')}</span>
            </div>
          </label>
        </div>

        <button
          className="save-button"
          onClick={handleSetSecurityConfig}
          disabled={isExecuting || selectedNodeNum === null}
          style={{
            opacity: (isExecuting || selectedNodeNum === null) ? 0.5 : 1,
            cursor: (isExecuting || selectedNodeNum === null) ? 'not-allowed' : 'pointer'
          }}
        >
          {isExecuting ? t('common.saving') : t('admin_commands.save_security_config')}
        </button>
      </div>

      {/* Channel Config Section */}
      <div id="admin-channel-config" className="settings-section">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem', paddingBottom: '0.75rem', borderBottom: '2px solid var(--ctp-surface2)' }}>
          <h3 style={{ margin: 0, borderBottom: 'none', paddingBottom: 0 }}>{t('admin_commands.channel_configuration')}</h3>
          <button
            onClick={handleLoadChannels}
            disabled={isLoadingChannels || selectedNodeNum === null}
            className="save-button"
            style={{
              opacity: (isLoadingChannels || selectedNodeNum === null) ? 0.5 : 1,
              cursor: (isLoadingChannels || selectedNodeNum === null) ? 'not-allowed' : 'pointer'
            }}
          >
            {isLoadingChannels ? (channelLoadProgress || t('admin_commands.loading_channels')) : t('common.load')}
          </button>
        </div>
        <p className="setting-description" style={{ marginBottom: '1rem' }}>
          {t('admin_commands.channel_config_description')}
        </p>

        <div style={{ display: 'grid', gap: '1rem' }}>
          {Array.from({ length: 8 }, (_, index) => {
            // Determine which channels to use
            const localNodeNum = nodes.find(n => (n.user?.id || n.nodeId) === currentNodeId)?.nodeNum;
            const isLocalNode = selectedNodeNum === localNodeNum || selectedNodeNum === 0;
            
            // Always start with empty channels - they will be populated when Load is clicked
            // For local nodes: use channels from props only if they've been explicitly loaded
            // For remote nodes: use remoteNodeChannels (starts empty, populated by Load button)
            let channelsToUse: Channel[];
            if (isLocalNode) {
              // For local node, also use remoteNodeChannels if loaded (to maintain consistency)
              // This ensures local node channels also start empty until Load is clicked
              channelsToUse = remoteNodeChannels.length > 0 ? remoteNodeChannels : [];
            } else {
              // For remote nodes, ALWAYS use remoteNodeChannels (starts empty, populated by Load button)
              channelsToUse = remoteNodeChannels;
            }
            
            const channel = channelsToUse.find(ch => ch.id === index);
            
            return (
              <div
                key={index}
                style={{
                  border: channel?.role === 1
                    ? '2px solid var(--ctp-blue)'
                    : '1px solid var(--ctp-surface1)',
                  borderRadius: '8px',
                  padding: '1rem',
                  backgroundColor: channel ? 'var(--ctp-surface0)' : 'var(--ctp-mantle)',
                  opacity: channel?.role === 0 ? 0.5 : 1,
                  boxShadow: channel?.role === 1 ? '0 0 10px rgba(137, 180, 250, 0.3)' : 'none'
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '0.75rem' }}>
                  <div>
                    <h4 style={{ margin: 0, color: 'var(--ctp-text)' }}>
                      {t('admin_commands.channel_slot', { index })}: {channel ? (
                        <>
                          {channel.name && channel.name.trim().length > 0 ? channel.name : <span style={{ color: 'var(--ctp-subtext0)', fontStyle: 'italic' }}>{t('admin_commands.unnamed')}</span>}
                          {channel.role === 1 && <span style={{ marginLeft: '0.5rem', color: 'var(--ctp-blue)', fontSize: '0.8rem' }}>★ {t('admin_commands.primary')}</span>}
                          {channel.role === 2 && <span style={{ marginLeft: '0.5rem', color: 'var(--ctp-green)', fontSize: '0.8rem' }}>● {t('admin_commands.secondary')}</span>}
                          {channel.role === 0 && <span style={{ marginLeft: '0.5rem', color: 'var(--ctp-overlay0)', fontSize: '0.8rem' }}>⊘ {t('admin_commands.disabled')}</span>}
                        </>
                      ) : <span style={{ color: 'var(--ctp-subtext0)', fontStyle: 'italic' }}>{t('admin_commands.empty')}</span>}
                    </h4>
                    {channel && (
                      <div style={{ marginTop: '0.5rem', fontSize: '0.9rem', color: 'var(--ctp-subtext1)' }}>
                        <div>{channel.psk && channel.psk !== 'AQ==' ? `🔒 ${t('admin_commands.encrypted')}` : `🔓 ${t('admin_commands.unencrypted')}`}</div>
                        <div>
                          {channel.uplinkEnabled ? `↑ ${t('admin_commands.uplink')} ` : ''}
                          {channel.downlinkEnabled ? `↓ ${t('admin_commands.downlink')}` : ''}
                          {!channel.uplinkEnabled && !channel.downlinkEnabled && t('admin_commands.no_bridge')}
                        </div>
                      </div>
                    )}
                  </div>
                  <div style={{ display: 'flex', gap: '0.5rem' }}>
                    <button
                      onClick={() => handleEditChannel(index)}
                      disabled={isExecuting || selectedNodeNum === null}
                      style={{
                        padding: '0.5rem 0.75rem',
                        fontSize: '0.9rem',
                        backgroundColor: 'var(--ctp-blue)',
                        color: 'var(--ctp-base)',
                        border: 'none',
                        borderRadius: '4px',
                        cursor: (isExecuting || selectedNodeNum === null) ? 'not-allowed' : 'pointer',
                        opacity: (isExecuting || selectedNodeNum === null) ? 0.5 : 1
                      }}
                    >
                      ✏️ {t('common.edit')}
                    </button>
                    {channel && (
                      <button
                        onClick={() => handleExportChannel(index)}
                        disabled={isExecuting || selectedNodeNum === null}
                        style={{
                          padding: '0.5rem 0.75rem',
                          fontSize: '0.9rem',
                          backgroundColor: 'var(--ctp-green)',
                          color: 'var(--ctp-base)',
                          border: 'none',
                          borderRadius: '4px',
                          cursor: (isExecuting || selectedNodeNum === null) ? 'not-allowed' : 'pointer',
                          opacity: (isExecuting || selectedNodeNum === null) ? 0.5 : 1
                        }}
                      >
                        📥 {t('common.export')}
                      </button>
                    )}
                    <button
                      onClick={() => handleImportClick(index)}
                      disabled={isExecuting || selectedNodeNum === null}
                      style={{
                        padding: '0.5rem 0.75rem',
                        fontSize: '0.9rem',
                        backgroundColor: 'var(--ctp-yellow)',
                        color: 'var(--ctp-base)',
                        border: 'none',
                        borderRadius: '4px',
                        cursor: (isExecuting || selectedNodeNum === null) ? 'not-allowed' : 'pointer',
                        opacity: (isExecuting || selectedNodeNum === null) ? 0.5 : 1
                      }}
                    >
                      📤 {t('common.import')}
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Import/Export Configuration Section */}
      <div id="admin-import-export" className="settings-section" style={{ marginTop: '2rem', marginBottom: '2rem' }}>
        <h3>{t('admin_commands.config_import_export')}</h3>
        <p style={{ color: 'var(--ctp-subtext0)', marginBottom: '1rem' }}>
          {t('admin_commands.config_import_export_description')}
        </p>
        <div style={{ display: 'flex', gap: '1rem', marginBottom: '1.5rem' }}>
          <button
            onClick={() => setShowConfigImportModal(true)}
            disabled={selectedNodeNum === null || isExecuting}
            style={{
              backgroundColor: 'var(--ctp-blue)',
              color: '#fff',
              padding: '0.75rem 1.5rem',
              border: 'none',
              borderRadius: '4px',
              cursor: (selectedNodeNum === null || isExecuting) ? 'not-allowed' : 'pointer',
              fontSize: '1rem',
              fontWeight: 'bold',
              opacity: (selectedNodeNum === null || isExecuting) ? 0.5 : 1
            }}
          >
            📥 {t('admin_commands.import_configuration')}
          </button>
          <button
            onClick={async () => {
              if (selectedNodeNum === null) {
                showToast(t('admin_commands.please_select_node'), 'error');
                return;
              }

              const localNodeNum = nodeOptions.find(n => n.isLocal)?.nodeNum;
              const isLocalNode = selectedNodeNum === localNodeNum || selectedNodeNum === 0;

              // For remote nodes, load channels and LoRa config before opening modal
              if (!isLocalNode) {
                try {
                  showToast(t('admin_commands.loading_remote_config'), 'info');
                  
                  // Load channels and LoRa config in parallel
                  await Promise.all([
                    handleLoadChannels(),
                    handleLoadLoRaConfig()
                  ]);
                  
                  showToast(t('admin_commands.config_loaded_success'), 'success');
                } catch (error: any) {
                  showToast(error.message || t('admin_commands.failed_load_config'), 'error');
                  return; // Don't open modal if loading failed
                }
              }

              // Open the export modal
              setShowConfigExportModal(true);
            }}
            disabled={selectedNodeNum === null || isExecuting || isLoadingChannels || isLoadingLoRaConfig}
            style={{
              backgroundColor: 'var(--ctp-green)',
              color: '#fff',
              padding: '0.75rem 1.5rem',
              border: 'none',
              borderRadius: '4px',
              cursor: (selectedNodeNum === null || isExecuting || isLoadingChannels || isLoadingLoRaConfig) ? 'not-allowed' : 'pointer',
              fontSize: '1rem',
              fontWeight: 'bold',
              opacity: (selectedNodeNum === null || isExecuting || isLoadingChannels || isLoadingLoRaConfig) ? 0.5 : 1
            }}
          >
            {(isLoadingChannels || isLoadingLoRaConfig) ? t('common.loading') : `📤 ${t('admin_commands.export_configuration')}`}
          </button>
        </div>
      </div>

      {/* Node Favorites & Ignored Section */}
      <div id="admin-node-management" className="settings-section" style={{ marginTop: '2rem' }}>
        <h3>{t('admin_commands.node_favorites_ignored')}</h3>
        <p style={{ color: 'var(--ctp-subtext0)', marginBottom: '1.5rem' }}>
          {t('admin_commands.node_favorites_ignored_description')}
        </p>
        
        <div className="setting-item">
          <label>
            {t('admin_commands.select_node_to_manage')}
            <span className="setting-description">
              {t('admin_commands.select_node_to_manage_description')}
            </span>
          </label>
          <div ref={nodeManagementSearchRef} style={{ position: 'relative', width: '100%', maxWidth: '600px' }}>
            <input
              type="text"
              className="setting-input"
              placeholder={nodeManagementNodeNum !== null 
                ? nodeOptions.find(n => n.nodeNum === nodeManagementNodeNum)?.longName || t('admin_commands.node_fallback', { nodeNum: nodeManagementNodeNum })
                : t('admin_commands.search_node_to_manage')}
              value={nodeManagementSearchQuery}
              onChange={(e) => {
                setNodeManagementSearchQuery(e.target.value);
                setShowNodeManagementSearch(true);
              }}
              onFocus={() => setShowNodeManagementSearch(true)}
              disabled={isExecuting || nodeOptions.length === 0}
              style={{ width: '100%' }}
            />
            {showNodeManagementSearch && filteredNodesForManagement.length > 0 && (
              <div style={{
                position: 'absolute',
                top: '100%',
                left: 0,
                right: 0,
                marginTop: '4px',
                background: 'var(--ctp-base)',
                border: '2px solid var(--ctp-surface2)',
                borderRadius: '8px',
                maxHeight: '300px',
                overflowY: 'auto',
                zIndex: 1000,
                boxShadow: '0 4px 12px rgba(0, 0, 0, 0.3)'
              }}>
                {filteredNodesForManagement.map(node => (
                  <div
                    key={node.nodeNum}
                    onClick={() => {
                      setNodeManagementNodeNum(node.nodeNum);
                      setShowNodeManagementSearch(false);
                      setNodeManagementSearchQuery(node.longName);
                    }}
                    style={{
                      padding: '0.75rem 1rem',
                      cursor: 'pointer',
                      borderBottom: '1px solid var(--ctp-surface1)',
                      transition: 'background 0.1s',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center'
                    }}
                    onMouseEnter={(e) => e.currentTarget.style.background = 'var(--ctp-surface0)'}
                    onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                  >
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: '500', color: 'var(--ctp-text)', display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                        <span>{node.longName}</span>
                        {node.isLocal && <span style={{ color: 'var(--ctp-blue)', fontSize: '0.85rem' }}>({t('admin_commands.local_node_indicator')})</span>}
                        {node.isFavorite && (
                          <span style={{ 
                            backgroundColor: 'var(--ctp-yellow)', 
                            color: 'var(--ctp-base)', 
                            padding: '0.125rem 0.5rem', 
                            borderRadius: '4px', 
                            fontSize: '0.75rem',
                            fontWeight: '600'
                          }}>
                            ⭐ {t('admin_commands.favorite')}
                          </span>
                        )}
                        {node.isIgnored && (
                          <span style={{ 
                            backgroundColor: 'var(--ctp-red)', 
                            color: 'var(--ctp-base)', 
                            padding: '0.125rem 0.5rem', 
                            borderRadius: '4px', 
                            fontSize: '0.75rem',
                            fontWeight: '600'
                          }}>
                            🚫 {t('admin_commands.ignored')}
                          </span>
                        )}
                      </div>
                      <div style={{ fontSize: '0.85rem', color: 'var(--ctp-subtext0)', marginTop: '0.25rem' }}>
                        {node.shortName && node.shortName !== node.longName && `${node.shortName} • `}
                        {node.nodeId}
                      </div>
                    </div>
                    {nodeManagementNodeNum === node.nodeNum && (
                      <span style={{ color: 'var(--ctp-blue)', fontSize: '1.2rem' }}>✓</span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
          {nodeManagementNodeNum !== null && (() => {
            const selectedNode = nodeOptions.find(n => n.nodeNum === nodeManagementNodeNum);
            // When managing a remote node, only use remote status (don't fall back to local status)
            // When managing local node, use local status from nodeOptions
            const remoteStatus = isManagingRemoteNode ? remoteNodeStatus.get(nodeManagementNodeNum) : null;
            const isFavorite = isManagingRemoteNode 
              ? (remoteStatus?.isFavorite ?? false)  // Remote: only use remote status, default to false
              : (selectedNode?.isFavorite ?? false);  // Local: use local status
            const isIgnored = isManagingRemoteNode 
              ? (remoteStatus?.isIgnored ?? false)    // Remote: only use remote status, default to false
              : (selectedNode?.isIgnored ?? false);   // Local: use local status
            return (
              <div style={{ marginTop: '0.75rem', fontSize: '0.875rem', color: 'var(--ctp-subtext0)' }}>
                {t('admin_commands.selected')}: {selectedNode?.longName || t('admin_commands.node_fallback', { nodeNum: nodeManagementNodeNum })}
                {(isFavorite || isIgnored) && (
                  <span style={{ marginLeft: '0.5rem' }}>
                    {isFavorite && <span style={{ color: 'var(--ctp-yellow)' }}>⭐ {t('admin_commands.favorite')}</span>}
                    {isIgnored && <span style={{ color: 'var(--ctp-red)', marginLeft: '0.5rem' }}>🚫 {t('admin_commands.ignored')}</span>}
                  </span>
                )}
              </div>
            );
          })()}
        </div>

        <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', marginTop: '1.5rem' }}>
          <div style={{ flex: 1, minWidth: '200px' }}>
            <h4 style={{ marginBottom: '0.75rem', color: 'var(--ctp-text)' }}>⭐ {t('admin_commands.favorites')}</h4>
            {(() => {
              const selectedNode = nodeManagementNodeNum !== null ? nodeOptions.find(n => n.nodeNum === nodeManagementNodeNum) : null;
              // When managing a remote node, only use remote status (don't fall back to local status)
              // When managing local node, use local status from nodeOptions
              const remoteStatus = isManagingRemoteNode && nodeManagementNodeNum !== null ? remoteNodeStatus.get(nodeManagementNodeNum) : null;
              const isCurrentlyFavorite = isManagingRemoteNode
                ? (remoteStatus?.isFavorite ?? false)  // Remote: only use remote status, default to false
                : (selectedNode?.isFavorite ?? false); // Local: use local status
              const isDisabled = isExecuting || nodeManagementNodeNum === null;
              
              return (
                <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                  <button
                    onClick={handleSetFavoriteNode}
                    disabled={isDisabled || isCurrentlyFavorite}
                    style={{
                      flex: 1,
                      padding: '0.75rem 1rem',
                      backgroundColor: isCurrentlyFavorite ? 'var(--ctp-surface1)' : 'var(--ctp-yellow)',
                      color: isCurrentlyFavorite ? 'var(--ctp-subtext0)' : 'var(--ctp-base)',
                      border: 'none',
                      borderRadius: '4px',
                      cursor: (isDisabled || isCurrentlyFavorite) ? 'not-allowed' : 'pointer',
                      fontSize: '0.9rem',
                      fontWeight: '500',
                      opacity: (isDisabled || isCurrentlyFavorite) ? 0.6 : 1
                    }}
                  >
                    {isCurrentlyFavorite ? t('admin_commands.already_favorite') : t('admin_commands.set_as_favorite')}
                  </button>
                  <button
                    onClick={handleRemoveFavoriteNode}
                    disabled={isDisabled || !isCurrentlyFavorite}
                    style={{
                      flex: 1,
                      padding: '0.75rem 1rem',
                      backgroundColor: !isCurrentlyFavorite ? 'var(--ctp-surface1)' : 'var(--ctp-surface2)',
                      color: 'var(--ctp-text)',
                      border: 'none',
                      borderRadius: '4px',
                      cursor: (isDisabled || !isCurrentlyFavorite) ? 'not-allowed' : 'pointer',
                      fontSize: '0.9rem',
                      fontWeight: '500',
                      opacity: (isDisabled || !isCurrentlyFavorite) ? 0.6 : 1
                    }}
                  >
                    {t('admin_commands.remove_favorite')}
                  </button>
                </div>
              );
            })()}
          </div>
          <div style={{ flex: 1, minWidth: '200px' }}>
            <h4 style={{ marginBottom: '0.75rem', color: 'var(--ctp-text)' }}>🚫 {t('admin_commands.ignored_nodes')}</h4>
            {(() => {
              const selectedNode = nodeManagementNodeNum !== null ? nodeOptions.find(n => n.nodeNum === nodeManagementNodeNum) : null;
              // When managing a remote node, only use remote status (don't fall back to local status)
              // When managing local node, use local status from nodeOptions
              const remoteStatus = isManagingRemoteNode && nodeManagementNodeNum !== null ? remoteNodeStatus.get(nodeManagementNodeNum) : null;
              const isCurrentlyIgnored = isManagingRemoteNode
                ? (remoteStatus?.isIgnored ?? false)   // Remote: only use remote status, default to false
                : (selectedNode?.isIgnored ?? false);   // Local: use local status
              const isDisabled = isExecuting || nodeManagementNodeNum === null;
              
              return (
                <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                  <button
                    onClick={handleSetIgnoredNode}
                    disabled={isDisabled || isCurrentlyIgnored}
                    style={{
                      flex: 1,
                      padding: '0.75rem 1rem',
                      backgroundColor: isCurrentlyIgnored ? 'var(--ctp-surface1)' : 'var(--ctp-red)',
                      color: isCurrentlyIgnored ? 'var(--ctp-subtext0)' : 'var(--ctp-base)',
                      border: 'none',
                      borderRadius: '4px',
                      cursor: (isDisabled || isCurrentlyIgnored) ? 'not-allowed' : 'pointer',
                      fontSize: '0.9rem',
                      fontWeight: '500',
                      opacity: (isDisabled || isCurrentlyIgnored) ? 0.6 : 1
                    }}
                  >
                    {isCurrentlyIgnored ? t('admin_commands.already_ignored') : t('admin_commands.set_as_ignored')}
                  </button>
                  <button
                    onClick={handleRemoveIgnoredNode}
                    disabled={isDisabled || !isCurrentlyIgnored}
                    style={{
                      flex: 1,
                      padding: '0.75rem 1rem',
                      backgroundColor: !isCurrentlyIgnored ? 'var(--ctp-surface1)' : 'var(--ctp-surface2)',
                      color: 'var(--ctp-text)',
                      border: 'none',
                      borderRadius: '4px',
                      cursor: (isDisabled || !isCurrentlyIgnored) ? 'not-allowed' : 'pointer',
                      fontSize: '0.9rem',
                      fontWeight: '500',
                      opacity: (isDisabled || !isCurrentlyIgnored) ? 0.6 : 1
                    }}
                  >
                    {t('admin_commands.remove_ignored')}
                  </button>
                </div>
              );
            })()}
          </div>
        </div>
        <p style={{ marginTop: '1rem', fontSize: '0.85rem', color: 'var(--ctp-subtext1)', fontStyle: 'italic' }}>
          {t('admin_commands.firmware_requirement_note')}
        </p>
      </div>

      {/* Channel Edit Modal */}
      {showChannelEditModal && editingChannelSlot !== null && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: 'rgba(0, 0, 0, 0.7)',
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            zIndex: 10000
          }}
          onClick={() => {
            setShowChannelEditModal(false);
            setEditingChannelSlot(null);
          }}
        >
          <div
            style={{
              background: 'var(--ctp-base)',
              padding: '2rem',
              borderRadius: '8px',
              maxWidth: '600px',
              width: '90%',
              maxHeight: '90vh',
              overflowY: 'auto',
              border: '2px solid var(--ctp-surface2)'
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 style={{ marginTop: 0, marginBottom: '1.5rem', color: 'var(--ctp-text)' }}>
              {t('admin_commands.edit_channel', { slot: editingChannelSlot })}
            </h3>
            
            <div className="setting-item">
              <label>
                {t('admin_commands.channel_name')}
                <span className="setting-description">{t('admin_commands.channel_name_description')}</span>
              </label>
              <input
                type="text"
                maxLength={11}
                value={channelName}
                onChange={(e) => setChannelName(e.target.value)}
                disabled={isExecuting}
                placeholder={t('admin_commands.channel_name_placeholder')}
                className="setting-input"
                style={{ width: '100%' }}
              />
            </div>

            <div className="setting-item">
              <label>
                {t('admin_commands.psk')}
                <span className="setting-description">{t('admin_commands.psk_description')}</span>
              </label>
              <input
                type="text"
                value={channelPsk}
                onChange={(e) => setChannelPsk(e.target.value)}
                disabled={isExecuting}
                placeholder={t('admin_commands.psk_placeholder')}
                className="setting-input"
                style={{ width: '100%' }}
              />
            </div>

            <div className="setting-item">
              <label>
                {t('admin_commands.channel_role')}
                <span className="setting-description">{t('admin_commands.channel_role_description')}</span>
              </label>
              <select
                value={channelRole}
                onChange={(e) => setChannelRole(Number(e.target.value))}
                disabled={isExecuting}
                className="setting-input"
                style={{ width: '100%' }}
              >
                <option value={1}>{t('admin_commands.primary')}</option>
                <option value={2}>{t('admin_commands.secondary')}</option>
                <option value={0}>{t('admin_commands.disabled')}</option>
              </select>
            </div>

            <div className="setting-item">
              <label style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
                <input
                  type="checkbox"
                  checked={channelUplinkEnabled}
                  onChange={(e) => setChannelUplinkEnabled(e.target.checked)}
                  disabled={isExecuting}
                  style={{ width: 'auto', margin: 0, flexShrink: 0 }}
                />
                <div style={{ flex: 1 }}>
                  <div>{t('admin_commands.uplink_enabled')}</div>
                  <span className="setting-description">{t('admin_commands.uplink_enabled_description')}</span>
                </div>
              </label>
            </div>

            <div className="setting-item">
              <label style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
                <input
                  type="checkbox"
                  checked={channelDownlinkEnabled}
                  onChange={(e) => setChannelDownlinkEnabled(e.target.checked)}
                  disabled={isExecuting}
                  style={{ width: 'auto', margin: 0, flexShrink: 0 }}
                />
                <div style={{ flex: 1 }}>
                  <div>{t('admin_commands.downlink_enabled')}</div>
                  <span className="setting-description">{t('admin_commands.downlink_enabled_description')}</span>
                </div>
              </label>
            </div>

            <div className="setting-item">
              <label>
                {t('admin_commands.position_precision')}
                <span className="setting-description">{t('admin_commands.position_precision_description')}</span>
              </label>
              <input
                type="number"
                min="0"
                max="32"
                value={channelPositionPrecision}
                onChange={(e) => setChannelPositionPrecision(Number(e.target.value))}
                disabled={isExecuting}
                className="setting-input"
                style={{ width: '100%' }}
              />
            </div>

            <div style={{ display: 'flex', gap: '1rem', marginTop: '1.5rem' }}>
              <button
                className="save-button"
                onClick={handleSaveChannel}
                disabled={isExecuting || selectedNodeNum === null}
                style={{
                  opacity: (isExecuting || selectedNodeNum === null) ? 0.5 : 1,
                  cursor: (isExecuting || selectedNodeNum === null) ? 'not-allowed' : 'pointer'
                }}
              >
                {isExecuting ? t('common.saving') : t('admin_commands.save_channel')}
              </button>
              <button
                onClick={() => {
                  setShowChannelEditModal(false);
                  setEditingChannelSlot(null);
                }}
                disabled={isExecuting}
                style={{
                  padding: '0.75rem 1.5rem',
                  backgroundColor: 'var(--ctp-surface0)',
                  color: 'var(--ctp-text)',
                  border: '1px solid var(--ctp-surface2)',
                  borderRadius: '4px',
                  cursor: isExecuting ? 'not-allowed' : 'pointer',
                  fontSize: '1rem',
                  fontWeight: 'bold'
                }}
              >
                {t('common.cancel')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Import Channel Modal */}
      {showImportModal && importSlotId !== null && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: 'rgba(0, 0, 0, 0.7)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 10000
          }}
          onClick={() => !isExecuting && setShowImportModal(false)}
        >
          <div
            style={{
              backgroundColor: 'var(--ctp-base)',
              borderRadius: '8px',
              padding: '1.5rem',
              maxWidth: '500px',
              width: '90%',
              maxHeight: '80vh',
              overflowY: 'auto'
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 style={{ marginTop: 0 }}>{t('admin_commands.import_channel', { slot: importSlotId })}</h3>

            <div className="setting-item">
              <label htmlFor="import-file">
                {t('admin_commands.select_json_file')}
                <span className="setting-description">{t('admin_commands.select_json_file_description')}</span>
              </label>
              <input
                ref={fileInputRef}
                id="import-file"
                type="file"
                accept=".json"
                onChange={handleFileSelect}
                style={{
                  width: '100%',
                  padding: '0.5rem',
                  marginTop: '0.5rem'
                }}
              />
            </div>

            {importFileContent && (
              <div style={{ marginTop: '1rem' }}>
                <label>{t('admin_commands.preview')}:</label>
                <pre
                  style={{
                    backgroundColor: 'var(--ctp-surface0)',
                    padding: '0.75rem',
                    borderRadius: '4px',
                    fontSize: '0.85rem',
                    maxHeight: '200px',
                    overflowY: 'auto'
                  }}
                >
                  {importFileContent}
                </pre>
              </div>
            )}

            <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1.5rem' }}>
              <button
                onClick={handleImportChannel}
                disabled={isExecuting || !importFileContent}
                style={{
                  flex: 1,
                  padding: '0.75rem',
                  backgroundColor: 'var(--ctp-green)',
                  color: 'var(--ctp-base)',
                  border: 'none',
                  borderRadius: '4px',
                  cursor: (isExecuting || !importFileContent) ? 'not-allowed' : 'pointer',
                  opacity: (isExecuting || !importFileContent) ? 0.6 : 1
                }}
              >
                {isExecuting ? t('admin_commands.importing') : t('admin_commands.import_channel_button')}
              </button>
              <button
                onClick={() => setShowImportModal(false)}
                disabled={isExecuting}
                style={{
                  flex: 1,
                  padding: '0.75rem',
                  backgroundColor: 'var(--ctp-surface1)',
                  color: 'var(--ctp-text)',
                  border: 'none',
                  borderRadius: '4px',
                  cursor: isExecuting ? 'not-allowed' : 'pointer'
                }}
              >
                {t('common.cancel')}
              </button>
            </div>
          </div>
        </div>
      )}

      </div>

      {/* Reboot and Purge Command Section - Moved to bottom, matching Device page style */}
      <div className="settings-section danger-zone" style={{ marginTop: '2rem', marginBottom: '2rem' }}>
        <h2 style={{ color: '#ff4444', marginTop: 0 }}>⚠️ {t('admin_commands.warning')}</h2>
        <p style={{ fontSize: '1.1rem', fontWeight: 'bold' }}>
          {t('admin_commands.warning_message')}
        </p>
        <p>
          {t('admin_commands.warning_description')}
        </p>
        <div style={{ marginTop: '1.5rem', display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', flexWrap: 'wrap' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--ctp-text)' }}>
              {t('admin_commands.reboot_delay_label')}:
              <input
                type="number"
                min="0"
                max="60"
                value={rebootSeconds}
                onChange={(e) => setRebootSeconds(Number(e.target.value))}
                disabled={isExecuting || selectedNodeNum === null}
                className="setting-input"
                style={{ width: '100px' }}
              />
            </label>
            <button
              onClick={handleReboot}
              disabled={isExecuting || selectedNodeNum === null}
              style={{
                backgroundColor: '#ff6b6b',
                color: '#fff',
                padding: '0.75rem 1.5rem',
                border: 'none',
                borderRadius: '4px',
                cursor: (isExecuting || selectedNodeNum === null) ? 'not-allowed' : 'pointer',
                fontSize: '1rem',
                fontWeight: 'bold',
                opacity: (isExecuting || selectedNodeNum === null) ? 0.6 : 1
              }}
            >
              🔄 {t('admin_commands.reboot_device')}
            </button>
          </div>
          <button
            onClick={handlePurgeNodeDb}
            disabled={isExecuting || selectedNodeNum === null}
            style={{
              backgroundColor: '#d32f2f',
              color: '#fff',
              padding: '0.75rem 1.5rem',
              border: 'none',
              borderRadius: '4px',
              cursor: (isExecuting || selectedNodeNum === null) ? 'not-allowed' : 'pointer',
              fontSize: '1rem',
              fontWeight: 'bold',
              opacity: (isExecuting || selectedNodeNum === null) ? 0.6 : 1
            }}
          >
            🗑️ {t('admin_commands.purge_node_database')}
          </button>
        </div>
      </div>

      {/* Import/Export Config Modals */}
      {showConfigImportModal && (
        <ImportConfigModal
          isOpen={showConfigImportModal}
          onClose={() => setShowConfigImportModal(false)}
          onImportSuccess={async () => {
            showToast(t('admin_commands.configuration_imported_success'), 'success');
            setShowConfigImportModal(false);
            // Refresh channels if local node
            const localNodeNum = nodeOptions.find(n => n.isLocal)?.nodeNum;
            if (selectedNodeNum === localNodeNum || selectedNodeNum === 0) {
              if (_onChannelsUpdated) {
                _onChannelsUpdated();
              }
            } else {
              // For remote nodes, reload channels
              await handleLoadChannels();
            }
          }}
          nodeNum={selectedNodeNum !== null ? selectedNodeNum : undefined}
        />
      )}

      {showConfigExportModal && (
        <ExportConfigModal
          isOpen={showConfigExportModal}
          onClose={() => setShowConfigExportModal(false)}
          channels={selectedNodeNum !== null ? (() => {
            const localNodeNum = nodeOptions.find(n => n.isLocal)?.nodeNum;
            const isLocalNode = selectedNodeNum === localNodeNum || selectedNodeNum === 0;
            if (isLocalNode) {
              // For local nodes, use remoteNodeChannels if loaded (to match what's displayed), otherwise use empty array
              // This ensures consistency between what's displayed and what gets exported
              // Both display and export should show empty until Load is clicked
              return remoteNodeChannels.length > 0 ? remoteNodeChannels : [];
            } else {
              // For remote nodes, use remoteNodeChannels directly (it's already a Channel[] array)
              return remoteNodeChannels || [];
            }
          })() : []}
          deviceConfig={{
            lora: {
              usePreset: usePreset,
              modemPreset: modemPreset,
              region: region,
              hopLimit: hopLimit
            }
          }}
          nodeNum={selectedNodeNum !== null ? selectedNodeNum : undefined}
        />
      )}
    </div>
  );
};

export default AdminCommandsTab;
