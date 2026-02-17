import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import apiService from '../services/api';
import { useToast } from './ToastContainer';
import { MODEM_PRESET_OPTIONS, REGION_OPTIONS } from './configuration/constants';
import type { Channel } from '../types/device';
import { ImportConfigModal } from './configuration/ImportConfigModal';
import { ExportConfigModal } from './configuration/ExportConfigModal';
import SectionNav from './SectionNav';
import { encodePositionFlags, decodePositionFlags } from '../utils/positionFlags';
import { DeviceConfigurationSection } from './admin-commands/DeviceConfigurationSection';
import { ModuleConfigurationSection } from './admin-commands/ModuleConfigurationSection';
import { useAdminCommandsState } from './admin-commands/useAdminCommandsState';
import { buildNodeOptions, filterNodes, sortNodeOptionsForRemoteAdmin, type NodeOption } from './admin-commands/nodeOptionsUtils';
import { createEmptyChannelSlot, createChannelFromResponse, isRetryableChannelError, countLoadedChannels } from './admin-commands/channelLoadingUtils';

interface AdminCommandsTabProps {
  nodes: any[];
  currentNodeId: string;
  channels?: Channel[];
  onChannelsUpdated?: () => void;
}


const AdminCommandsTab: React.FC<AdminCommandsTabProps> = ({ nodes, currentNodeId, channels: _channels = [], onChannelsUpdated: _onChannelsUpdated }) => {
  const { t } = useTranslation();
  const { showToast } = useToast();

  // Use consolidated state hook for config-related state
  const {
    state: configState,
    setLoRaConfig,
    setPositionConfig,
    setPositionFlags,
    setMQTTConfig,
    setSecurityConfig,
    setAdminKey,
    addAdminKey,
    removeAdminKey,
    setBluetoothConfig,
    setNetworkConfig,
    setNeighborInfoConfig,
    setOwnerConfig,
    setDeviceConfig,
    setTelemetryConfig,
    setStatusMessageConfig,
    setTrafficManagementConfig,
  } = useAdminCommandsState();

  // UI and non-config state (keep as useState for now)
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
  const [isRoleDropdownOpen, setIsRoleDropdownOpen] = useState(false);

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

  // Loading state for all configs
  const [isLoadingAllConfigs, setIsLoadingAllConfigs] = useState(false);
  const [loadingProgress, setLoadingProgress] = useState<{ current: number; total: number; configType: string } | null>(null);

  // Node management state (favorites/ignored)
  const [nodeManagementNodeNum, setNodeManagementNodeNum] = useState<number | null>(null);
  const [showNodeManagementSearch, setShowNodeManagementSearch] = useState(false);
  const [nodeManagementSearchQuery, setNodeManagementSearchQuery] = useState('');
  const [isLoadingChannels, setIsLoadingChannels] = useState(false);

  // Per-section loading status: 'idle' | 'loading' | 'success' | 'error'
  const [sectionLoadStatus, setSectionLoadStatus] = useState<Record<string, 'idle' | 'loading' | 'success' | 'error'>>({
    device: 'idle',
    lora: 'idle',
    position: 'idle',
    mqtt: 'idle',
    security: 'idle',
    bluetooth: 'idle',
    network: 'idle',
    neighborinfo: 'idle',
    telemetry: 'idle',
    statusmessage: 'idle',
    trafficmanagement: 'idle',
    owner: 'idle',
    channels: 'idle'
  });
  // Track remote node favorite/ignored status separately (key: nodeNum, value: {isFavorite, isIgnored})
  const [remoteNodeStatus, setRemoteNodeStatus] = useState<Map<number, { isFavorite: boolean; isIgnored: boolean }>>(new Map());

  // Session passkey status for remote nodes
  const [passkeyStatus, setPasskeyStatus] = useState<{
    hasPasskey: boolean;
    remainingSeconds: number | null;
  } | null>(null);

  // Device metadata state for Retrieve Device Metadata feature
  const [isLoadingDeviceMetadata, setIsLoadingDeviceMetadata] = useState(false);
  const [deviceMetadata, setDeviceMetadata] = useState<{
    firmwareVersion: string;
    deviceStateVersion: number;
    canShutdown: boolean;
    hasWifi: boolean;
    hasBluetooth: boolean;
    hasEthernet: boolean;
    role: number;
    positionFlags: number;
    hwModel: number;
    hasRemoteHardware: boolean;
  } | null>(null);

  // Reboot and Set Time command states
  const [isLoadingReboot, setIsLoadingReboot] = useState(false);
  const [isLoadingSetTime, setIsLoadingSetTime] = useState(false);

  // Collapsible sections state - persist to localStorage
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>(() => {
    const stored = localStorage.getItem('adminCommandsExpandedSections');
    if (stored) {
      try {
        return JSON.parse(stored);
      } catch {
        return {};
      }
    }
    // Default: expand main sections, collapse sub-sections
    return {
      'radio-config': false,
      'device-config': false,
      'module-config': false,
      // Sub-sections
      'admin-set-owner': false,
      'admin-device-config': false,
      'admin-position-config': false,
      'admin-bluetooth-config': false,
      'admin-security-config': false,
      'admin-mqtt-config': false,
      'admin-neighborinfo-config': false,
      'admin-channel-config': false,
      'admin-import-export': false,
      'admin-node-management': false,
      'admin-reboot-purge': false,
    };
  });

  // Persist expanded sections to localStorage
  useEffect(() => {
    localStorage.setItem('adminCommandsExpandedSections', JSON.stringify(expandedSections));
  }, [expandedSections]);

  // Use ref to access current expanded sections without recreating the component
  const expandedSectionsRef = useRef(expandedSections);
  expandedSectionsRef.current = expandedSections;

  const toggleSection = useCallback((sectionId: string) => {
    setExpandedSections(prev => ({ ...prev, [sectionId]: !prev[sectionId] }));
  }, []);

  // Stable CollapsibleSection wrapper - uses refs to avoid recreating on state changes
  const CollapsibleSection = useMemo(() => {
    const Component: React.FC<{
      id: string;
      title: string;
      children: React.ReactNode;
      defaultExpanded?: boolean;
      headerActions?: React.ReactNode;
      className?: string;
      nested?: boolean;
    }> = ({ id, title, children, defaultExpanded, headerActions, className = '', nested = false }) => {
      // Read from ref to get current value without causing re-creation
      const isExpanded = expandedSectionsRef.current[id] ?? defaultExpanded ?? false;

      return (
        <div id={id} className={`settings-section ${className}`} style={{
          marginLeft: nested ? '1.5rem' : '0',
          marginTop: nested ? '0.5rem' : '0'
        }}>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: '0.75rem 1rem',
              background: 'var(--ctp-surface0)',
              border: '1px solid var(--ctp-surface2)',
              borderRadius: '8px',
              cursor: 'pointer',
              marginBottom: isExpanded ? '1rem' : '0.5rem',
              transition: 'all 0.2s ease',
            }}
            onClick={() => toggleSection(id)}
            onMouseEnter={(e) => e.currentTarget.style.background = 'var(--ctp-surface1)'}
            onMouseLeave={(e) => e.currentTarget.style.background = 'var(--ctp-surface0)'}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flex: 1 }}>
              <span style={{
                fontSize: '0.875rem',
                transition: 'transform 0.2s ease',
                transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
                display: 'inline-block'
              }}>
                ▶
              </span>
              <h3 style={{ margin: 0, borderBottom: 'none', paddingBottom: 0, flex: 1 }}>{title}</h3>
            </div>
            {headerActions && (
              <div onClick={(e) => e.stopPropagation()} style={{ display: 'flex', gap: '0.5rem' }}>
                {headerActions}
              </div>
            )}
          </div>
          {isExpanded && (
            <div style={{
              padding: '0 0.5rem',
              overflow: 'visible'
            }}>
              {children}
            </div>
          )}
        </div>
      );
    };
    return Component;
  }, [toggleSection]);

  // Memoize node options building with sorting (admin-capable nodes first)
  const nodeOptionsMemo = useMemo(() => {
    const options = buildNodeOptions(nodes, currentNodeId, t);
    return sortNodeOptionsForRemoteAdmin(options);
  }, [nodes, currentNodeId, t]);

  useEffect(() => {
    setNodeOptions(nodeOptionsMemo);
    
    // Set default to local node (only if not already set)
    if (nodeOptionsMemo.length > 0 && selectedNodeNum === null) {
      setSelectedNodeNum(nodeOptionsMemo[0].nodeNum);
    }
  }, [nodeOptionsMemo, selectedNodeNum]);

  // Filter nodes based on search query
  const filteredNodes = useMemo(() => {
    return filterNodes(nodeOptions, searchQuery);
  }, [nodeOptions, searchQuery]);

  // Filter nodes for node management section
  const filteredNodesForManagement = useMemo(() => {
    return filterNodes(nodeOptions, nodeManagementSearchQuery);
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
    // Clear passkey status when switching nodes
    setPasskeyStatus(null);
  }, [selectedNodeNum]);

  // Fetch and update passkey status for remote nodes
  const fetchPasskeyStatus = useCallback(async () => {
    if (selectedNodeNum === null) return;

    const selectedNode = nodeOptions.find(n => n.nodeNum === selectedNodeNum);
    if (selectedNode?.isLocal) {
      setPasskeyStatus(null);
      return;
    }

    try {
      const response = await apiService.post<{
        success: boolean;
        isLocalNode: boolean;
        hasPasskey: boolean;
        remainingSeconds: number | null;
      }>('/api/admin/session-passkey-status', { nodeNum: selectedNodeNum });

      if (response.isLocalNode) {
        setPasskeyStatus(null);
      } else {
        setPasskeyStatus({
          hasPasskey: response.hasPasskey,
          remainingSeconds: response.remainingSeconds
        });
      }
    } catch {
      // Silently fail - passkey status is informational
    }
  }, [selectedNodeNum, nodeOptions]);

  // Poll passkey status when a remote node is selected
  useEffect(() => {
    const selectedNode = nodeOptions.find(n => n.nodeNum === selectedNodeNum);
    if (!selectedNode || selectedNode.isLocal) {
      return;
    }

    // Initial fetch
    fetchPasskeyStatus();

    // Set up interval to update countdown
    const interval = setInterval(() => {
      setPasskeyStatus(prev => {
        if (!prev || prev.remainingSeconds === null) return prev;
        const newRemaining = prev.remainingSeconds - 1;
        if (newRemaining <= 0) {
          return { hasPasskey: false, remainingSeconds: null };
        }
        return { ...prev, remainingSeconds: newRemaining };
      });
    }, 1000);

    return () => clearInterval(interval);
  }, [selectedNodeNum, nodeOptions, fetchPasskeyStatus]);

  const handleNodeSelect = useCallback((nodeNum: number) => {
    setSelectedNodeNum(nodeNum);
    const selected = nodeOptions.find(n => n.nodeNum === nodeNum);
    if (selected) {
      setSearchQuery(selected.longName);
    }
    setShowSearch(false);

    // Always clear remote node channels when switching nodes
    // They will be populated when Load is clicked
    setRemoteNodeChannels([]);

    // Reset section load statuses when switching nodes
    setSectionLoadStatus({
      device: 'idle',
      lora: 'idle',
      position: 'idle',
      mqtt: 'idle',
      security: 'idle',
      bluetooth: 'idle',
      neighborinfo: 'idle',
      owner: 'idle',
      channels: 'idle'
    });
  }, [nodeOptions]);

  const handleLoadAllConfigs = async () => {
    if (selectedNodeNum === null) {
      showToast(t('admin_commands.please_select_node'), 'error');
      return;
    }

    setIsLoadingAllConfigs(true);
    setLoadingProgress(null);
    // Reset all section statuses to loading
    setSectionLoadStatus({
      device: 'loading',
      lora: 'loading',
      position: 'loading',
      mqtt: 'loading',
      security: 'loading',
      bluetooth: 'loading',
      network: 'loading',
      neighborinfo: 'loading',
      telemetry: 'loading',
      statusmessage: 'loading',
      trafficmanagement: 'loading',
      owner: 'loading',
      channels: 'loading'
    });
    const errors: string[] = [];
    const loaded: string[] = [];
    const totalConfigs = 13; // device, lora, position, mqtt, security, bluetooth, network, neighborinfo, telemetry, statusmessage, trafficmanagement, owner, channels

    try {
      // Load all config types sequentially to avoid conflicts and timeouts
      const loadConfig = async (configType: string, step: number, loadFn: (result: any) => void) => {
        setLoadingProgress({ current: step, total: totalConfigs, configType });
        setSectionLoadStatus(prev => ({ ...prev, [configType]: 'loading' }));
        try {
          const result = await apiService.post<{ config: any }>('/api/admin/load-config', {
            nodeNum: selectedNodeNum,
            configType
          });
          if (result?.config) {
            loadFn(result);
            loaded.push(configType);
            setSectionLoadStatus(prev => ({ ...prev, [configType]: 'success' }));
          } else {
            setSectionLoadStatus(prev => ({ ...prev, [configType]: 'error' }));
          }
        } catch (_err) {
          errors.push(configType);
          setSectionLoadStatus(prev => ({ ...prev, [configType]: 'error' }));
        }
      };

      const loadOwner = async (step: number) => {
        setLoadingProgress({ current: step, total: totalConfigs, configType: 'owner' });
        setSectionLoadStatus(prev => ({ ...prev, owner: 'loading' }));
        try {
          const result = await apiService.post<{ owner: any }>('/api/admin/load-owner', {
            nodeNum: selectedNodeNum
          });
          if (result?.owner) {
            const owner = result.owner;
            setOwnerConfig({
              longName: owner.longName,
              shortName: owner.shortName,
              isUnmessagable: owner.isUnmessagable
            });
            loaded.push('owner');
            setSectionLoadStatus(prev => ({ ...prev, owner: 'success' }));
          } else {
            setSectionLoadStatus(prev => ({ ...prev, owner: 'error' }));
          }
        } catch (_err) {
          errors.push('owner');
          setSectionLoadStatus(prev => ({ ...prev, owner: 'error' }));
        }
      };

      // Load configs sequentially with small delays between requests
      await loadConfig('device', 1, (result) => {
        const config = result.config;
        setDeviceConfig({
          role: config.role,
          nodeInfoBroadcastSecs: config.nodeInfoBroadcastSecs
        });
      });
      await new Promise(resolve => setTimeout(resolve, 200)); // Small delay between requests

      await loadConfig('lora', 2, (result) => {
        const config = result.config;
        setLoRaConfig({
          usePreset: config.usePreset,
          modemPreset: config.modemPreset,
          bandwidth: config.bandwidth,
          spreadFactor: config.spreadFactor,
          codingRate: config.codingRate,
          frequencyOffset: config.frequencyOffset,
          overrideFrequency: config.overrideFrequency,
          region: config.region,
          hopLimit: config.hopLimit,
          txPower: config.txPower,
          channelNum: config.channelNum,
          sx126xRxBoostedGain: config.sx126xRxBoostedGain,
          ignoreMqtt: config.ignoreMqtt,
          configOkToMqtt: config.configOkToMqtt,
          txEnabled: config.txEnabled ?? true,  // Default to true if undefined
          overrideDutyCycle: config.overrideDutyCycle ?? false,
          paFanDisabled: config.paFanDisabled ?? false
        });
      });
      await new Promise(resolve => setTimeout(resolve, 200));

      await loadConfig('position', 3, (result) => {
        const config = result.config;
        const positionConfig: any = {
          positionBroadcastSecs: config.positionBroadcastSecs,
          positionSmartEnabled: config.positionBroadcastSmartEnabled ?? config.positionSmartEnabled,
          fixedPosition: config.fixedPosition,
          fixedLatitude: config.fixedLatitude,
          fixedLongitude: config.fixedLongitude,
          fixedAltitude: config.fixedAltitude,
          gpsUpdateInterval: config.gpsUpdateInterval,
          rxGpio: config.rxGpio,
          txGpio: config.txGpio,
          broadcastSmartMinimumDistance: config.broadcastSmartMinimumDistance,
          broadcastSmartMinimumIntervalSecs: config.broadcastSmartMinimumIntervalSecs,
          gpsEnGpio: config.gpsEnGpio,
          gpsMode: config.gpsMode
        };
        if (config.positionFlags !== undefined) {
          positionConfig.positionFlags = decodePositionFlags(config.positionFlags);
        }
        setPositionConfig(positionConfig);
      });
      await new Promise(resolve => setTimeout(resolve, 200));

      await loadConfig('mqtt', 4, (result) => {
        const config = result.config;
        setMQTTConfig({
          enabled: config.enabled,
          address: config.address,
          username: config.username,
          password: config.password,
          encryptionEnabled: config.encryptionEnabled,
          jsonEnabled: config.jsonEnabled,
          root: config.root
        });
      });
      await new Promise(resolve => setTimeout(resolve, 200));

      await loadConfig('security', 5, (result) => {
        const config = result.config;
        if (config.adminKeys !== undefined) {
          const keys = config.adminKeys.length === 0 ? [''] : (config.adminKeys.length < 3 ? [...config.adminKeys, ''] : config.adminKeys.slice(0, 3));
          setSecurityConfig({ adminKeys: keys });
        }
        const securityUpdates: any = {};
        if (config.isManaged !== undefined) securityUpdates.isManaged = config.isManaged;
        if (config.serialEnabled !== undefined) securityUpdates.serialEnabled = config.serialEnabled;
        if (config.debugLogApiEnabled !== undefined) securityUpdates.debugLogApiEnabled = config.debugLogApiEnabled;
        if (config.adminChannelEnabled !== undefined) securityUpdates.adminChannelEnabled = config.adminChannelEnabled;
        if (Object.keys(securityUpdates).length > 0) {
          setSecurityConfig(securityUpdates);
        }
      });
      await new Promise(resolve => setTimeout(resolve, 200));

      await loadConfig('bluetooth', 6, (result) => {
        const config = result.config;
        setBluetoothConfig({
          enabled: config.enabled,
          mode: config.mode,
          fixedPin: config.fixedPin
        });
      });
      await new Promise(resolve => setTimeout(resolve, 200));

      await loadConfig('network', 7, (result) => {
        const config = result.config;
        const ipv4 = config.ipv4Config || {};
        setNetworkConfig({
          wifiEnabled: config.wifiEnabled || false,
          wifiSsid: config.wifiSsid || '',
          wifiPsk: config.wifiPsk || '',
          ntpServer: config.ntpServer || '',
          addressMode: config.addressMode || 0,
          ipv4Address: ipv4.ip || '',
          ipv4Gateway: ipv4.gateway || '',
          ipv4Subnet: ipv4.subnet || '',
          ipv4Dns: ipv4.dns || ''
        });
      });
      await new Promise(resolve => setTimeout(resolve, 200));

      await loadConfig('neighborinfo', 8, (result) => {
        const config = result.config;
        setNeighborInfoConfig({
          enabled: config.enabled,
          updateInterval: config.updateInterval,
          transmitOverLora: config.transmitOverLora
        });
      });
      await new Promise(resolve => setTimeout(resolve, 200));

      await loadConfig('telemetry', 9, (result) => {
        const config = result.config;
        setTelemetryConfig({
          deviceUpdateInterval: config.deviceUpdateInterval ?? 900,
          deviceTelemetryEnabled: config.deviceTelemetryEnabled ?? false,
          environmentUpdateInterval: config.environmentUpdateInterval ?? 900,
          environmentMeasurementEnabled: config.environmentMeasurementEnabled ?? false,
          environmentScreenEnabled: config.environmentScreenEnabled ?? false,
          environmentDisplayFahrenheit: config.environmentDisplayFahrenheit ?? false,
          airQualityEnabled: config.airQualityEnabled ?? false,
          airQualityInterval: config.airQualityInterval ?? 900,
          powerMeasurementEnabled: config.powerMeasurementEnabled ?? false,
          powerUpdateInterval: config.powerUpdateInterval ?? 900,
          powerScreenEnabled: config.powerScreenEnabled ?? false,
          healthMeasurementEnabled: config.healthMeasurementEnabled ?? false,
          healthUpdateInterval: config.healthUpdateInterval ?? 900,
          healthScreenEnabled: config.healthScreenEnabled ?? false
        });
      });
      await new Promise(resolve => setTimeout(resolve, 200));

      await loadConfig('statusmessage', 10, (result) => {
        const config = result.config;
        setStatusMessageConfig({
          nodeStatus: config.nodeStatus ?? ''
        });
      });
      await new Promise(resolve => setTimeout(resolve, 200));

      await loadConfig('trafficmanagement', 11, (result) => {
        const config = result.config;
        setTrafficManagementConfig({
          enabled: config.enabled ?? false,
          positionDedupEnabled: config.positionDedupEnabled ?? false,
          positionDedupTimeSecs: config.positionDedupTimeSecs ?? 0,
          positionDedupDistanceMeters: config.positionDedupDistanceMeters ?? 0,
          nodeinfoDirectResponseEnabled: config.nodeinfoDirectResponseEnabled ?? false,
          nodeinfoDirectResponseMyNodeOnly: config.nodeinfoDirectResponseMyNodeOnly ?? false,
          rateLimitEnabled: config.rateLimitEnabled ?? false,
          rateLimitMaxPerNode: config.rateLimitMaxPerNode ?? 0,
          rateLimitWindowSecs: config.rateLimitWindowSecs ?? 0,
          unknownPacketDropEnabled: config.unknownPacketDropEnabled ?? false,
          unknownPacketGracePeriodSecs: config.unknownPacketGracePeriodSecs ?? 0,
          hopExhaustionEnabled: config.hopExhaustionEnabled ?? false,
          hopExhaustionMinHops: config.hopExhaustionMinHops ?? 0,
          hopExhaustionMaxHops: config.hopExhaustionMaxHops ?? 0
        });
      });
      await new Promise(resolve => setTimeout(resolve, 200));

      // Load owner info
      await loadOwner(12);
      await new Promise(resolve => setTimeout(resolve, 200));

      // Load channels (extracted logic to avoid duplicate loading state and toasts)
      setLoadingProgress({ current: 13, total: totalConfigs, configType: 'channels' });
      try {
        const localNodeNum = nodes.find(n => (n.user?.id || n.nodeId) === currentNodeId)?.nodeNum;
        const isLocalNode = selectedNodeNum === localNodeNum || selectedNodeNum === 0;
        
        if (isLocalNode) {
          // For local node, load channels from database
          const loadedChannels: Channel[] = [];
          const now = Date.now();
          
          for (let index = 0; index < 8; index++) {
            try {
              const channel = await apiService.post<{ channel?: any }>('/api/admin/get-channel', {
                nodeNum: selectedNodeNum,
                channelIndex: index
              });
              
              if (channel?.channel) {
                const ch = channel.channel;
                loadedChannels.push(createChannelFromResponse(ch, index, now));
              } else {
                loadedChannels.push(createEmptyChannelSlot(index, now));
              }
            } catch (_error) {
              loadedChannels.push(createEmptyChannelSlot(index, now));
            }
          }
          
          setRemoteNodeChannels(loadedChannels);
          loaded.push('channels');
          setSectionLoadStatus(prev => ({ ...prev, channels: 'success' }));
        } else {
          // For remote node, request all 8 channels in parallel
          const loadedChannels: Channel[] = [];
          const now = Date.now();
          
          // First, ensure we have a session passkey
          try {
            const passkeyResponse = await apiService.post<{
              success: boolean;
              hasPasskey: boolean;
              remainingSeconds: number | null;
            }>('/api/admin/ensure-session-passkey', {
              nodeNum: selectedNodeNum
            });
            // Update passkey status display
            if (passkeyResponse.hasPasskey) {
              setPasskeyStatus({
                hasPasskey: true,
                remainingSeconds: passkeyResponse.remainingSeconds
              });
            }
          } catch (error: any) {
            throw new Error(t('admin_commands.failed_session_passkey', { error: error.message }));
          }

          // Send all requests in parallel
          const channelRequests = Array.from({ length: 8 }, (_, index) => 
            apiService.post<{ channel?: any }>('/api/admin/get-channel', {
              nodeNum: selectedNodeNum,
              channelIndex: index
            }).then(result => ({ index, result, error: null }))
              .catch(error => ({ index, result: null, error }))
          );
          
          let results = await Promise.allSettled(channelRequests);
          const failedChannels: number[] = [];
          const maxRetries = 2;
          let retryCount = 0;
          
          const processResults = (results: PromiseSettledResult<any>[], useResultIndex: boolean = false): void => {
            results.forEach((settled, arrayIndex) => {
              let index: number;
              if (useResultIndex && settled.status === 'fulfilled') {
                index = settled.value.index;
              } else {
                index = arrayIndex;
              }
              
              if (settled.status === 'fulfilled') {
                const { result, error } = settled.value;
                
                if (error) {
                  const isRetryableError = error.message?.includes('404') || 
                                         error.message?.includes('not received') ||
                                         error.message?.includes('timeout');
                  if (isRetryableError && retryCount < maxRetries) {
                    failedChannels.push(index);
                  }
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
                } else if (result?.channel) {
                  const ch = result.channel;
                  // Create channel from response using helper function
                  const channelData = createChannelFromResponse(ch, index, now);
                  
                  const existingIndex = loadedChannels.findIndex(ch => ch.id === index);
                  if (existingIndex !== -1) {
                    loadedChannels[existingIndex] = channelData;
                  } else {
                    loadedChannels.push(channelData);
                  }
                } else {
                  if (retryCount < maxRetries) {
                    failedChannels.push(index);
                  }
                  const existingIndex = loadedChannels.findIndex(ch => ch.id === index);
                  if (existingIndex === -1) {
                    loadedChannels.push(createEmptyChannelSlot(index, now));
                  }
                }
              } else {
                if (!useResultIndex) {
                  if (retryCount < maxRetries) {
                    failedChannels.push(index);
                  }
                  const existingIndex = loadedChannels.findIndex(ch => ch.id === index);
                  if (existingIndex === -1) {
                    loadedChannels.push(createEmptyChannelSlot(index, now));
                  }
                }
              }
            });
          };
          
          processResults(results, false);
          
          // Retry failed channels
          while (failedChannels.length > 0 && retryCount < maxRetries) {
            retryCount++;
            const channelsToRetry = [...new Set(failedChannels)];
            failedChannels.length = 0;
            
            if (channelsToRetry.length > 0) {
              await new Promise(resolve => setTimeout(resolve, 1000 * retryCount));
              
              const retryRequests = channelsToRetry.map(index => 
                apiService.post<{ channel?: any }>('/api/admin/get-channel', {
                  nodeNum: selectedNodeNum,
                  channelIndex: index
                }).then(result => ({ index, result, error: null }))
                  .catch(error => ({ index, result: null, error }))
              );
              
              const retryResults = await Promise.allSettled(retryRequests);
              processResults(retryResults, true);
            }
          }
          
          setRemoteNodeChannels(loadedChannels);
          loaded.push('channels');
          setSectionLoadStatus(prev => ({ ...prev, channels: 'success' }));
        }
      } catch (_err) {
        errors.push('channels');
        setSectionLoadStatus(prev => ({ ...prev, channels: 'error' }));
      }

      // Show summary toast
      if (loaded.length > 0 && errors.length === 0) {
        showToast(t('admin_commands.all_configs_loaded', { count: loaded.length }), 'success');
      } else if (loaded.length > 0 && errors.length > 0) {
        showToast(t('admin_commands.configs_partially_loaded', { loaded: loaded.length, errors: errors.length }), 'warning');
      } else {
        showToast(t('admin_commands.failed_load_all_configs'), 'error');
      }
    } catch (error: any) {
      showToast(error.message || t('admin_commands.failed_load_all_configs'), 'error');
    } finally {
      setIsLoadingAllConfigs(false);
      setLoadingProgress(null);
    }
  };

  // Handle request device metadata
  const handleRequestDeviceMetadata = async () => {
    if (selectedNodeNum === null) {
      showToast(t('admin_commands.please_select_node'), 'error');
      return;
    }

    setIsLoadingDeviceMetadata(true);
    setDeviceMetadata(null);

    try {
      const result = await apiService.post<{ deviceMetadata: any }>('/api/admin/get-device-metadata', {
        nodeNum: selectedNodeNum
      });
      if (result?.deviceMetadata) {
        setDeviceMetadata(result.deviceMetadata);
        showToast(t('admin_commands.device_metadata_loaded'), 'success');
      } else {
        showToast(t('admin_commands.failed_device_metadata'), 'error');
      }
    } catch (error: any) {
      showToast(error.message || t('admin_commands.failed_device_metadata'), 'error');
    } finally {
      setIsLoadingDeviceMetadata(false);
    }
  };

  const handleSendReboot = async () => {
    if (selectedNodeNum === null) {
      showToast(t('admin_commands.please_select_node'), 'error');
      return;
    }

    // Confirm before sending reboot
    if (!window.confirm(t('admin_commands.confirm_reboot', 'Are you sure you want to reboot this node?'))) {
      return;
    }

    setIsLoadingReboot(true);

    try {
      await apiService.post('/api/admin/reboot', {
        nodeNum: selectedNodeNum,
        seconds: 5
      });
      showToast(t('admin_commands.reboot_sent', 'Reboot command sent successfully'), 'success');
    } catch (error: any) {
      showToast(error.message || t('admin_commands.failed_reboot', 'Failed to send reboot command'), 'error');
    } finally {
      setIsLoadingReboot(false);
    }
  };

  const handleSetTime = async () => {
    if (selectedNodeNum === null) {
      showToast(t('admin_commands.please_select_node'), 'error');
      return;
    }

    setIsLoadingSetTime(true);

    try {
      await apiService.post('/api/admin/set-time', {
        nodeNum: selectedNodeNum
      });
      showToast(t('admin_commands.set_time_sent', 'Time sync command sent successfully'), 'success');
    } catch (error: any) {
      showToast(error.message || t('admin_commands.failed_set_time', 'Failed to send set-time command'), 'error');
    } finally {
      setIsLoadingSetTime(false);
    }
  };

  // Individual section load handlers
  const handleLoadSingleConfig = async (configType: string) => {
    if (selectedNodeNum === null) {
      showToast(t('admin_commands.please_select_node'), 'error');
      return;
    }

    setSectionLoadStatus(prev => ({ ...prev, [configType]: 'loading' }));

    // Determine if this is a remote node (need for session passkey pre-request)
    const localNodeNum = nodes.find(n => (n.user?.id || n.nodeId) === currentNodeId)?.nodeNum;
    const isRemoteNode = selectedNodeNum !== localNodeNum && selectedNodeNum !== 0;

    // Retry configuration - matches channel loading pattern
    const maxRetries = 2;
    const isRetryableError = (error: any): boolean => {
      const msg = error?.message || '';
      return msg.includes('404') || msg.includes('timeout') || msg.includes('not received') || msg.includes('not reachable');
    };

    try {
      // For remote nodes, ensure session passkey is available before making any admin request
      // This prevents timeout failures on slow mesh networks
      // Note: This is done once before retries since the passkey persists
      if (isRemoteNode) {
        try {
          const passkeyResponse = await apiService.post<{
            success: boolean;
            hasPasskey: boolean;
            remainingSeconds: number | null;
          }>('/api/admin/ensure-session-passkey', {
            nodeNum: selectedNodeNum
          });
          // Update passkey status display
          if (passkeyResponse.hasPasskey) {
            setPasskeyStatus({
              hasPasskey: true,
              remainingSeconds: passkeyResponse.remainingSeconds
            });
          }
        } catch (error: any) {
          throw new Error(t('admin_commands.failed_session_passkey', { error: error.message }));
        }
      }

      if (configType === 'owner') {
        // Owner config with retry logic
        let lastError: any = null;
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
          try {
            if (attempt > 0) {
              await new Promise(resolve => setTimeout(resolve, 1000 * attempt)); // Exponential backoff
            }
            const result = await apiService.post<{ owner: any }>('/api/admin/load-owner', {
              nodeNum: selectedNodeNum
            });
            if (result?.owner) {
              setOwnerConfig({
                longName: result.owner.longName,
                shortName: result.owner.shortName,
                isUnmessagable: result.owner.isUnmessagable
              });
              setSectionLoadStatus(prev => ({ ...prev, owner: 'success' }));
              showToast(t('admin_commands.config_loaded_success', { configType: t('admin_commands.owner_config_short', 'Owner') }), 'success');
              return;
            }
            // No data in result - treat as retryable
            lastError = new Error('No owner data received');
            if (!isRetryableError(lastError) || attempt >= maxRetries) break;
          } catch (error: any) {
            lastError = error;
            if (!isRetryableError(error) || attempt >= maxRetries) break;
          }
        }
        setSectionLoadStatus(prev => ({ ...prev, owner: 'error' }));
        showToast(lastError?.message || t('admin_commands.config_load_failed', { configType: t('admin_commands.owner_config_short', 'Owner') }), 'error');
        return;
      }

      if (configType === 'channels') {
        await handleLoadChannels();
        return;
      }

      // Generic config types with retry logic
      let lastError: any = null;
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          if (attempt > 0) {
            await new Promise(resolve => setTimeout(resolve, 1000 * attempt)); // Exponential backoff
          }

          const result = await apiService.post<{ config: any }>('/api/admin/load-config', {
            nodeNum: selectedNodeNum,
            configType
          });

          if (result?.config) {
            const config = result.config;
            switch (configType) {
              case 'device':
                setDeviceConfig({
                  role: config.role,
                  nodeInfoBroadcastSecs: config.nodeInfoBroadcastSecs
                });
                break;
              case 'lora':
                setLoRaConfig({
                  usePreset: config.usePreset,
                  modemPreset: config.modemPreset,
                  bandwidth: config.bandwidth,
                  spreadFactor: config.spreadFactor,
                  codingRate: config.codingRate,
                  frequencyOffset: config.frequencyOffset,
                  overrideFrequency: config.overrideFrequency,
                  region: config.region,
                  hopLimit: config.hopLimit,
                  txPower: config.txPower,
                  channelNum: config.channelNum,
                  sx126xRxBoostedGain: config.sx126xRxBoostedGain,
                  ignoreMqtt: config.ignoreMqtt,
                  configOkToMqtt: config.configOkToMqtt,
                  txEnabled: config.txEnabled ?? true,  // Default to true if undefined
                  overrideDutyCycle: config.overrideDutyCycle ?? false,
                  paFanDisabled: config.paFanDisabled ?? false
                });
                break;
              case 'position':
                setPositionConfig({
                  positionBroadcastSecs: config.positionBroadcastSecs,
                  positionSmartEnabled: config.positionBroadcastSmartEnabled ?? config.positionSmartEnabled,
                  fixedPosition: config.fixedPosition,
                  fixedLatitude: config.fixedLatitude,
                  fixedLongitude: config.fixedLongitude,
                  fixedAltitude: config.fixedAltitude,
                  gpsUpdateInterval: config.gpsUpdateInterval,
                  rxGpio: config.rxGpio,
                  txGpio: config.txGpio,
                  broadcastSmartMinimumDistance: config.broadcastSmartMinimumDistance,
                  broadcastSmartMinimumIntervalSecs: config.broadcastSmartMinimumIntervalSecs,
                  gpsEnGpio: config.gpsEnGpio,
                  gpsMode: config.gpsMode
                });
                if (config.positionFlags !== undefined) {
                  setPositionFlags(decodePositionFlags(config.positionFlags));
                }
                break;
              case 'mqtt':
                setMQTTConfig({
                  enabled: config.enabled,
                  address: config.address,
                  username: config.username,
                  password: config.password,
                  encryptionEnabled: config.encryptionEnabled,
                  jsonEnabled: config.jsonEnabled,
                  root: config.root
                });
                break;
              case 'security':
                if (config.adminKeys !== undefined) {
                  const keys = config.adminKeys.length === 0 ? [''] : (config.adminKeys.length < 3 ? [...config.adminKeys, ''] : config.adminKeys.slice(0, 3));
                  setSecurityConfig({ adminKeys: keys });
                }
                const securityUpdates: Record<string, unknown> = {};
                if (config.isManaged !== undefined) securityUpdates.isManaged = config.isManaged;
                if (config.serialEnabled !== undefined) securityUpdates.serialEnabled = config.serialEnabled;
                if (config.debugLogApiEnabled !== undefined) securityUpdates.debugLogApiEnabled = config.debugLogApiEnabled;
                if (config.adminChannelEnabled !== undefined) securityUpdates.adminChannelEnabled = config.adminChannelEnabled;
                if (Object.keys(securityUpdates).length > 0) {
                  setSecurityConfig(securityUpdates);
                }
                break;
              case 'bluetooth':
                setBluetoothConfig({
                  enabled: config.enabled,
                  mode: config.mode,
                  fixedPin: config.fixedPin
                });
                break;
              case 'network':
                // Handle ipv4Config which may be nested
                const ipv4 = config.ipv4Config || {};
                setNetworkConfig({
                  wifiEnabled: config.wifiEnabled || false,
                  wifiSsid: config.wifiSsid || '',
                  wifiPsk: config.wifiPsk || '',
                  ntpServer: config.ntpServer || '',
                  addressMode: config.addressMode || 0,
                  ipv4Address: ipv4.ip || '',
                  ipv4Gateway: ipv4.gateway || '',
                  ipv4Subnet: ipv4.subnet || '',
                  ipv4Dns: ipv4.dns || ''
                });
                break;
              case 'neighborinfo':
                setNeighborInfoConfig({
                  enabled: config.enabled,
                  updateInterval: config.updateInterval,
                  transmitOverLora: config.transmitOverLora
                });
                break;
              case 'telemetry':
                setTelemetryConfig({
                  deviceUpdateInterval: config.deviceUpdateInterval ?? 900,
                  deviceTelemetryEnabled: config.deviceTelemetryEnabled ?? false,
                  environmentUpdateInterval: config.environmentUpdateInterval ?? 900,
                  environmentMeasurementEnabled: config.environmentMeasurementEnabled ?? false,
                  environmentScreenEnabled: config.environmentScreenEnabled ?? false,
                  environmentDisplayFahrenheit: config.environmentDisplayFahrenheit ?? false,
                  airQualityEnabled: config.airQualityEnabled ?? false,
                  airQualityInterval: config.airQualityInterval ?? 900,
                  powerMeasurementEnabled: config.powerMeasurementEnabled ?? false,
                  powerUpdateInterval: config.powerUpdateInterval ?? 900,
                  powerScreenEnabled: config.powerScreenEnabled ?? false,
                  healthMeasurementEnabled: config.healthMeasurementEnabled ?? false,
                  healthUpdateInterval: config.healthUpdateInterval ?? 900,
                  healthScreenEnabled: config.healthScreenEnabled ?? false
                });
                break;
            }
            setSectionLoadStatus(prev => ({ ...prev, [configType]: 'success' }));
            showToast(t('admin_commands.config_loaded_success', { configType: t(`admin_commands.${configType}_config_short`, configType) }), 'success');
            return; // Success - exit
          }

          // No config data - treat as retryable error
          lastError = new Error(`No ${configType} config data received`);
          if (!isRetryableError(lastError) || attempt >= maxRetries) break;
        } catch (error: any) {
          lastError = error;
          if (!isRetryableError(error) || attempt >= maxRetries) break;
        }
      }

      // All retries exhausted or non-retryable error
      setSectionLoadStatus(prev => ({ ...prev, [configType]: 'error' }));
      showToast(lastError?.message || t('admin_commands.config_load_failed', { configType: t(`admin_commands.${configType}_config_short`, configType) }), 'error');
    } catch (error: any) {
      // Session passkey failure or other non-retryable error
      setSectionLoadStatus(prev => ({ ...prev, [configType]: 'error' }));
      showToast(error.message || t('admin_commands.config_load_failed', { configType }), 'error');
    }
  };

  // Legacy handlers - redirect to handleLoadAllConfigs

  const handleLoadChannels = async () => {
    if (selectedNodeNum === null) {
      const error = new Error(t('admin_commands.please_select_node'));
      showToast(error.message, 'error');
      throw error;
    }

    setIsLoadingChannels(true);
    setSectionLoadStatus(prev => ({ ...prev, channels: 'loading' }));
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
              loadedChannels.push(createChannelFromResponse(ch, index, now));
            } else {
              // Add empty channel slot
              loadedChannels.push(createEmptyChannelSlot(index, now));
            }
          } catch (error) {
            // Add empty channel slot on error
            loadedChannels.push(createEmptyChannelSlot(index, now));
          }
        }
        
        setRemoteNodeChannels(loadedChannels);
        const loadedCount = countLoadedChannels(loadedChannels);
        showToast(t('admin_commands.channels_loaded_local', { count: loadedCount }), 'success');
        setSectionLoadStatus(prev => ({ ...prev, channels: 'success' }));
      } else {
        // For remote node, request all 8 channels in parallel (like Meshtastic app does)
        // This is much faster than sequential requests
        const loadedChannels: Channel[] = [];
        const now = Date.now();
        
        // First, ensure we have a session passkey (prevents conflicts from parallel requests)
        try {
          const passkeyResponse = await apiService.post<{
            success: boolean;
            hasPasskey: boolean;
            remainingSeconds: number | null;
          }>('/api/admin/ensure-session-passkey', {
            nodeNum: selectedNodeNum
          });
          // Update passkey status display
          if (passkeyResponse.hasPasskey) {
            setPasskeyStatus({
              hasPasskey: true,
              remainingSeconds: passkeyResponse.remainingSeconds
            });
          }
        } catch (error: any) {
          const err = new Error(t('admin_commands.failed_session_passkey', { error: error.message }));
          showToast(err.message, 'error');
          setIsLoadingChannels(false);
          throw err; // Re-throw so Promise.all() can catch it
        }

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
                if (isRetryableChannelError(error) && retryCount < maxRetries) {
                  failedChannels.push(index);
                }
                // 404 errors are expected for channels that don't exist or timed out
                // Don't log as warning, just add empty channel slot
                const errorMsg = error?.message || '';
                if (errorMsg.includes('404') || errorMsg.includes('not received')) {
                  // Silent - channel not available is expected
                } else {
                  console.warn(`Failed to load channel ${index}:`, error);
                }
                // Add empty channel slot on error (will be overwritten if retry succeeds)
                const existingIndex = loadedChannels.findIndex(ch => ch.id === index);
                if (existingIndex === -1) {
                  loadedChannels.push(createEmptyChannelSlot(index, now));
                }
              } else if (result?.channel) {
                const ch = result.channel;
                // Create channel from response using helper function
                const channelData = createChannelFromResponse(ch, index, now);
                
                // Update or add channel
                const existingIndex = loadedChannels.findIndex(ch => ch.id === index);
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
                  loadedChannels.push(createEmptyChannelSlot(index, now));
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
                  loadedChannels.push(createEmptyChannelSlot(index, now));
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
        const loadedCount = countLoadedChannels(loadedChannels);
        showToast(t('admin_commands.channels_loaded_remote', { count: loadedCount }), 'success');
        setSectionLoadStatus(prev => ({ ...prev, channels: 'success' }));
      }
    } catch (error: any) {
      showToast(error.message || t('admin_commands.failed_load_channels'), 'error');
      setSectionLoadStatus(prev => ({ ...prev, channels: 'error' }));
      throw error; // Re-throw so Promise.all() can catch it
    } finally {
      setIsLoadingChannels(false);
    }
  };

  // Determine if we're managing a remote node (not the local node)
  // Calculate this once per render to avoid recalculating in handlers
  const localNodeNum = nodeOptions.find(n => n.isLocal)?.nodeNum;
  const isManagingRemoteNode = selectedNodeNum !== null && selectedNodeNum !== localNodeNum && selectedNodeNum !== 0;

  const executeCommand = useCallback(async (command: string, params: any = {}) => {
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
  }, [selectedNodeNum, showToast, t]);

  const handleReboot = useCallback(async () => {
    if (!confirm(t('admin_commands.reboot_confirmation', { seconds: rebootSeconds }))) {
      return;
    }
    try {
      await executeCommand('reboot', { seconds: rebootSeconds });
    } catch (error) {
      // Error already handled by executeCommand (toast shown)
      console.error('Reboot command failed:', error);
    }
  }, [rebootSeconds, executeCommand, t]);


  const handleSetOwner = useCallback(async () => {
    if (!configState.owner.longName.trim() || !configState.owner.shortName.trim()) {
      showToast(t('admin_commands.long_short_name_required'), 'error');
      return;
    }
    try {
      await executeCommand('setOwner', {
        longName: configState.owner.longName.trim(),
        shortName: configState.owner.shortName.trim(),
        isUnmessagable: configState.owner.isUnmessagable
      });
    } catch (error) {
      // Error already handled by executeCommand (toast shown)
      console.error('Set owner command failed:', error);
    }
  }, [configState.owner, executeCommand, showToast, t]);

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
      await executeCommand('setFavoriteNode', { favoriteNodeNum: nodeManagementNodeNum });
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
      await executeCommand('removeFavoriteNode', { favoriteNodeNum: nodeManagementNodeNum });
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
      await executeCommand('setIgnoredNode', { targetNodeNum: nodeManagementNodeNum });
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
      await executeCommand('removeIgnoredNode', { targetNodeNum: nodeManagementNodeNum });
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

  const handleSetDeviceConfig = useCallback(async () => {
    const validNodeInfoBroadcastSecs = Math.max(3600, configState.device.nodeInfoBroadcastSecs);
    try {
      await executeCommand('setDeviceConfig', {
        config: {
          role: configState.device.role,
          nodeInfoBroadcastSecs: validNodeInfoBroadcastSecs
        }
      });
    } catch (error) {
      // Error already handled by executeCommand (toast shown)
      console.error('Set device config command failed:', error);
    }
  }, [configState.device, executeCommand]);

  const handleSetLoRaConfig = useCallback(async () => {
    const validHopLimit = Math.min(7, Math.max(1, configState.lora.hopLimit));
    const config: any = {
      usePreset: configState.lora.usePreset,
      hopLimit: validHopLimit,
      txPower: configState.lora.txPower,
      channelNum: configState.lora.channelNum,
      sx126xRxBoostedGain: configState.lora.sx126xRxBoostedGain,
      ignoreMqtt: configState.lora.ignoreMqtt,
      configOkToMqtt: configState.lora.configOkToMqtt,
      txEnabled: configState.lora.txEnabled,
      overrideDutyCycle: configState.lora.overrideDutyCycle,
      paFanDisabled: configState.lora.paFanDisabled
    };

    if (configState.lora.usePreset) {
      config.modemPreset = configState.lora.modemPreset;
    } else {
      config.bandwidth = configState.lora.bandwidth;
      config.spreadFactor = configState.lora.spreadFactor;
      config.codingRate = configState.lora.codingRate;
      config.frequencyOffset = configState.lora.frequencyOffset;
      config.overrideFrequency = configState.lora.overrideFrequency;
    }

    config.region = configState.lora.region;

    try {
      await executeCommand('setLoRaConfig', { config });
    } catch (error) {
      // Error already handled by executeCommand (toast shown)
      console.error('Set LoRa config command failed:', error);
    }
  }, [configState.lora, executeCommand]);

  const handleSetPositionConfig = useCallback(async () => {
    // Calculate position flags from checkboxes using utility function
    const flags = encodePositionFlags(configState.position.positionFlags);

    const config: any = {
      positionBroadcastSecs: Math.max(32, configState.position.positionBroadcastSecs),
      positionBroadcastSmartEnabled: configState.position.positionSmartEnabled,
      fixedPosition: configState.position.fixedPosition,
      gpsUpdateInterval: configState.position.gpsUpdateInterval,
      positionFlags: flags,
      broadcastSmartMinimumDistance: configState.position.broadcastSmartMinimumDistance,
      broadcastSmartMinimumIntervalSecs: configState.position.broadcastSmartMinimumIntervalSecs,
      gpsMode: configState.position.gpsMode
    };

    if (configState.position.fixedPosition) {
      // Backend expects latitude/longitude/altitude (not fixedLatitude/fixedLongitude)
      // It will send setFixedPosition admin message before setting the config
      config.latitude = configState.position.fixedLatitude;
      config.longitude = configState.position.fixedLongitude;
      config.altitude = configState.position.fixedAltitude;
    }

    // Only include GPIO pins if they're set (not undefined)
    if (configState.position.rxGpio !== undefined) config.rxGpio = configState.position.rxGpio;
    if (configState.position.txGpio !== undefined) config.txGpio = configState.position.txGpio;
    if (configState.position.gpsEnGpio !== undefined) config.gpsEnGpio = configState.position.gpsEnGpio;

    try {
      await executeCommand('setPositionConfig', { config });
    } catch (error) {
      // Error already handled by executeCommand (toast shown)
      console.error('Set position config command failed:', error);
    }
  }, [configState.position, executeCommand]);

  const handleSetMQTTConfig = async () => {
    const config: any = {
      enabled: configState.mqtt.enabled,
      address: configState.mqtt.address,
      username: configState.mqtt.username,
      password: configState.mqtt.password,
      encryptionEnabled: configState.mqtt.encryptionEnabled,
      jsonEnabled: configState.mqtt.jsonEnabled,
      root: configState.mqtt.root
    };

    try {
      await executeCommand('setMQTTConfig', { config });
    } catch (error) {
      // Error already handled by executeCommand (toast shown)
      console.error('Set MQTT config command failed:', error);
    }
  };

  const handleSetSecurityConfig = useCallback(async () => {
    // Filter out empty admin keys
    const validAdminKeys = configState.security.adminKeys.filter(key => key && key.trim().length > 0);
    
    const config: any = {
      adminKeys: validAdminKeys,
      isManaged: configState.security.isManaged,
      serialEnabled: configState.security.serialEnabled,
      debugLogApiEnabled: configState.security.debugLogApiEnabled,
      adminChannelEnabled: configState.security.adminChannelEnabled
    };

    try {
      await executeCommand('setSecurityConfig', { config });
    } catch (error) {
      // Error already handled by executeCommand (toast shown)
      console.error('Set security config command failed:', error);
    }
  }, [configState.security, executeCommand]);

  const handleSetBluetoothConfig = useCallback(async () => {
    const config: any = {
      enabled: configState.bluetooth.enabled,
      mode: configState.bluetooth.mode,
      fixedPin: configState.bluetooth.mode === 1 ? configState.bluetooth.fixedPin : undefined
    };

    try {
      await executeCommand('setBluetoothConfig', { config });
    } catch (error) {
      // Error already handled by executeCommand (toast shown)
      console.error('Set Bluetooth config command failed:', error);
    }
  }, [configState.bluetooth, executeCommand]);

  const handleSetNetworkConfig = useCallback(async () => {
    const config: any = {
      wifiEnabled: configState.network.wifiEnabled,
      wifiSsid: configState.network.wifiSsid,
      wifiPsk: configState.network.wifiPsk,
      ntpServer: configState.network.ntpServer,
      addressMode: configState.network.addressMode
    };

    // Only include ipv4Config if using static addressing (addressMode === 1)
    if (configState.network.addressMode === 1) {
      config.ipv4Config = {
        ip: configState.network.ipv4Address,
        gateway: configState.network.ipv4Gateway,
        subnet: configState.network.ipv4Subnet,
        dns: configState.network.ipv4Dns
      };
    }

    try {
      await executeCommand('setNetworkConfig', { config });
    } catch (error) {
      // Error already handled by executeCommand (toast shown)
      console.error('Set Network config command failed:', error);
    }
  }, [configState.network, executeCommand]);

  // Wrapper functions for DeviceConfigurationSection
  const handleOwnerConfigChange = useCallback((field: string, value: any) => {
    setOwnerConfig({ [field]: value });
  }, [setOwnerConfig]);

  const handleDeviceConfigChange = useCallback((field: string, value: any) => {
    setDeviceConfig({ [field]: value });
  }, [setDeviceConfig]);

  const handlePositionConfigChange = useCallback((field: string, value: any) => {
    setPositionConfig({ [field]: value });
  }, [setPositionConfig]);

  const handlePositionFlagChange = useCallback((flag: string, value: boolean) => {
    setPositionFlags({ [flag]: value });
  }, [setPositionFlags]);

  const handleBluetoothConfigChange = useCallback((field: string, value: any) => {
    setBluetoothConfig({ [field]: value });
  }, [setBluetoothConfig]);

  const handleNetworkConfigChange = useCallback((field: string, value: any) => {
    setNetworkConfig({ [field]: value });
  }, [setNetworkConfig]);

  // Wrapper functions for ModuleConfigurationSection
  const handleMQTTConfigChange = useCallback((field: string, value: any) => {
    setMQTTConfig({ [field]: value });
  }, [setMQTTConfig]);

  const handleNeighborInfoConfigChange = useCallback((field: string, value: any) => {
    setNeighborInfoConfig({ [field]: value });
  }, [setNeighborInfoConfig]);

  const handleSetNeighborInfoConfig = useCallback(async () => {
    const config: any = {
      enabled: configState.neighborInfo.enabled,
      updateInterval: configState.neighborInfo.updateInterval,
      transmitOverLora: configState.neighborInfo.transmitOverLora
    };

    try {
      await executeCommand('setNeighborInfoConfig', { config });
    } catch (error) {
      // Error already handled by executeCommand (toast shown)
      console.error('Set NeighborInfo config command failed:', error);
    }
  }, [configState.neighborInfo, executeCommand]);

  const handleTelemetryConfigChange = useCallback((field: string, value: any) => {
    setTelemetryConfig({ [field]: value });
  }, [setTelemetryConfig]);

  const handleSetTelemetryConfig = useCallback(async () => {
    const config: any = {
      deviceUpdateInterval: configState.telemetry.deviceUpdateInterval,
      deviceTelemetryEnabled: configState.telemetry.deviceTelemetryEnabled,
      environmentUpdateInterval: configState.telemetry.environmentUpdateInterval,
      environmentMeasurementEnabled: configState.telemetry.environmentMeasurementEnabled,
      environmentScreenEnabled: configState.telemetry.environmentScreenEnabled,
      environmentDisplayFahrenheit: configState.telemetry.environmentDisplayFahrenheit,
      airQualityEnabled: configState.telemetry.airQualityEnabled,
      airQualityInterval: configState.telemetry.airQualityInterval,
      powerMeasurementEnabled: configState.telemetry.powerMeasurementEnabled,
      powerUpdateInterval: configState.telemetry.powerUpdateInterval,
      powerScreenEnabled: configState.telemetry.powerScreenEnabled,
      healthMeasurementEnabled: configState.telemetry.healthMeasurementEnabled,
      healthUpdateInterval: configState.telemetry.healthUpdateInterval,
      healthScreenEnabled: configState.telemetry.healthScreenEnabled
    };

    try {
      await executeCommand('setTelemetryConfig', { config });
    } catch (error) {
      // Error already handled by executeCommand (toast shown)
      console.error('Set Telemetry config command failed:', error);
    }
  }, [configState.telemetry, executeCommand]);

  const handleStatusMessageConfigChange = useCallback((field: string, value: any) => {
    setStatusMessageConfig({ [field]: value });
  }, [setStatusMessageConfig]);

  const handleSetStatusMessageConfig = useCallback(async () => {
    const config: any = {
      nodeStatus: configState.statusMessage.nodeStatus
    };

    try {
      await executeCommand('setStatusMessageConfig', { config });
    } catch (error) {
      console.error('Set StatusMessage config command failed:', error);
    }
  }, [configState.statusMessage, executeCommand]);

  const handleTrafficManagementConfigChange = useCallback((field: string, value: any) => {
    setTrafficManagementConfig({ [field]: value });
  }, [setTrafficManagementConfig]);

  const handleSetTrafficManagementConfig = useCallback(async () => {
    const config: any = {
      enabled: configState.trafficManagement.enabled,
      positionDedupEnabled: configState.trafficManagement.positionDedupEnabled,
      positionDedupTimeSecs: configState.trafficManagement.positionDedupTimeSecs,
      positionDedupDistanceMeters: configState.trafficManagement.positionDedupDistanceMeters,
      nodeinfoDirectResponseEnabled: configState.trafficManagement.nodeinfoDirectResponseEnabled,
      nodeinfoDirectResponseMyNodeOnly: configState.trafficManagement.nodeinfoDirectResponseMyNodeOnly,
      rateLimitEnabled: configState.trafficManagement.rateLimitEnabled,
      rateLimitMaxPerNode: configState.trafficManagement.rateLimitMaxPerNode,
      rateLimitWindowSecs: configState.trafficManagement.rateLimitWindowSecs,
      unknownPacketDropEnabled: configState.trafficManagement.unknownPacketDropEnabled,
      unknownPacketGracePeriodSecs: configState.trafficManagement.unknownPacketGracePeriodSecs,
      hopExhaustionEnabled: configState.trafficManagement.hopExhaustionEnabled,
      hopExhaustionMinHops: configState.trafficManagement.hopExhaustionMinHops,
      hopExhaustionMaxHops: configState.trafficManagement.hopExhaustionMaxHops
    };

    try {
      await executeCommand('setTrafficManagementConfig', { config });
    } catch (error) {
      console.error('Set TrafficManagement config command failed:', error);
    }
  }, [configState.trafficManagement, executeCommand]);

  const handleAdminKeyChange = (index: number, value: string) => {
    setAdminKey(index, value);
    // Add a new empty field if the last field is being filled, but only if we have fewer than 3 keys (max 3)
    if (index === configState.security.adminKeys.length - 1 && value.trim().length > 0 && configState.security.adminKeys.length < 3) {
      addAdminKey();
    }
  };

  const handleRemoveAdminKey = (index: number) => {
    removeAdminKey(index);
    // Ensure at least one field remains
    if (configState.security.adminKeys.length === 1) {
      setAdminKey(0, '');
    }
  };

  const handleRoleChange = (newRole: number) => {
    if (newRole === 2) {
      const confirmed = window.confirm(t('admin_commands.router_mode_confirmation'));
      if (!confirmed) {
        setIsRoleDropdownOpen(false);
        return;
      }
    }
    setDeviceConfig({ role: newRole });
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

  // Helper to render section load button with status indicator (for header)
  const renderSectionLoadButton = (configType: string) => {
    const status = sectionLoadStatus[configType];
    const isLoading = status === 'loading';
    const isDisabled = isLoading || selectedNodeNum === null || isLoadingAllConfigs;

    return (
      <div
        style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}
        onClick={(e) => e.stopPropagation()} // Prevent header toggle when clicking button
      >
        {isLoading && (
          <span
            style={{
              width: '1rem',
              height: '1rem',
              border: '2px solid var(--ctp-surface2)',
              borderTopColor: 'var(--ctp-blue)',
              borderRadius: '50%',
              animation: 'spin 1s linear infinite',
              display: 'inline-block'
            }}
            title={t('common.loading')}
          />
        )}
        {status === 'success' && (
          <span style={{ color: 'var(--ctp-green)', fontSize: '1rem', fontWeight: 'bold' }} title={t('admin_commands.section_loaded')}>✓</span>
        )}
        {status === 'error' && (
          <span style={{ color: 'var(--ctp-red)', fontSize: '1rem', fontWeight: 'bold' }} title={t('admin_commands.section_load_failed')}>✗</span>
        )}
        <button
          onClick={() => handleLoadSingleConfig(configType)}
          disabled={isDisabled}
          className="save-button"
          style={{
            padding: '0.25rem 0.75rem',
            fontSize: '0.8rem',
            opacity: isDisabled ? 0.5 : 1,
            cursor: isDisabled ? 'not-allowed' : 'pointer'
          }}
        >
          {t('admin_commands.load_button', 'Load')}
        </button>
      </div>
    );
  };

  return (
    <div className="tab-content">
      <SectionNav items={[
        { id: 'admin-target-node', label: t('admin_commands.target_node', 'Target Node') },
        { id: 'radio-config', label: t('admin_commands.radio_configuration', 'Radio Configuration') },
        { id: 'device-config', label: t('admin_commands.device_configuration', 'Device Configuration') },
        { id: 'module-config', label: t('admin_commands.module_configuration', 'Module Configuration') },
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
                zIndex: 9999,
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
              ) : passkeyStatus?.hasPasskey && passkeyStatus.remainingSeconds !== null ? (
                <span style={{ color: 'var(--ctp-green)' }}>
                  {t('admin_commands.remote_node_passkey_acquired', { seconds: passkeyStatus.remainingSeconds })}
                </span>
              ) : (
                <span>{t('admin_commands.remote_node_passkey')}</span>
              )}
            </div>
          )}
        </div>
        {selectedNode && (
          <div style={{ marginTop: '1rem' }}>
            <button
              onClick={handleLoadAllConfigs}
              disabled={isLoadingAllConfigs || selectedNodeNum === null}
              className="save-button"
              style={{
                width: '100%',
                maxWidth: '600px',
                opacity: (isLoadingAllConfigs || selectedNodeNum === null) ? 0.5 : 1,
                cursor: (isLoadingAllConfigs || selectedNodeNum === null) ? 'not-allowed' : 'pointer'
              }}
            >
              {isLoadingAllConfigs && loadingProgress ? (
                <span>
                  {t('admin_commands.loading_config_progress', {
                    current: loadingProgress.current,
                    total: loadingProgress.total,
                    configType: t(`admin_commands.${loadingProgress.configType}_config_short`, loadingProgress.configType)
                  })}
                </span>
              ) : isLoadingAllConfigs ? (
                t('common.loading')
              ) : (
                t('admin_commands.load_all_configs', 'Load All Config')
              )}
            </button>
            <button
              onClick={handleRequestDeviceMetadata}
              disabled={isLoadingDeviceMetadata || selectedNodeNum === null}
              className="save-button"
              style={{
                width: '100%',
                maxWidth: '600px',
                marginTop: '0.5rem',
                opacity: (isLoadingDeviceMetadata || selectedNodeNum === null) ? 0.5 : 1,
                cursor: (isLoadingDeviceMetadata || selectedNodeNum === null) ? 'not-allowed' : 'pointer'
              }}
            >
              {isLoadingDeviceMetadata ? t('common.loading') : t('admin_commands.retrieve_device_metadata', 'Retrieve Device Metadata')}
            </button>
            <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem', maxWidth: '600px', width: '100%' }}>
              <button
                onClick={handleSendReboot}
                disabled={isLoadingReboot || selectedNodeNum === null}
                className="save-button"
                style={{
                  flex: 1,
                  opacity: (isLoadingReboot || selectedNodeNum === null) ? 0.5 : 1,
                  cursor: (isLoadingReboot || selectedNodeNum === null) ? 'not-allowed' : 'pointer',
                  backgroundColor: 'var(--ctp-red)'
                }}
              >
                {isLoadingReboot ? t('common.loading') : t('admin_commands.send_reboot', 'Send Reboot')}
              </button>
              <button
                onClick={handleSetTime}
                disabled={isLoadingSetTime || selectedNodeNum === null}
                className="save-button"
                style={{
                  flex: 1,
                  opacity: (isLoadingSetTime || selectedNodeNum === null) ? 0.5 : 1,
                  cursor: (isLoadingSetTime || selectedNodeNum === null) ? 'not-allowed' : 'pointer'
                }}
              >
                {isLoadingSetTime ? t('common.loading') : t('admin_commands.set_time', 'Set Time')}
              </button>
            </div>
            {deviceMetadata && (
              <div
                className="device-metadata-display"
                style={{
                  marginTop: '0.75rem',
                  padding: '1rem',
                  backgroundColor: 'var(--surface0)',
                  borderRadius: '8px',
                  border: '1px solid var(--overlay0)',
                  maxWidth: '600px'
                }}
              >
                <h4 style={{ margin: '0 0 0.75rem 0', color: 'var(--text)' }}>
                  {t('admin_commands.device_metadata_title', 'Device Metadata')}
                </h4>
                <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '0.5rem 1rem', fontSize: '0.9rem' }}>
                  <span style={{ color: 'var(--subtext0)', fontWeight: 500 }}>{t('admin_commands.firmware_version', 'Firmware Version')}:</span>
                  <span style={{ color: 'var(--text)' }}>{deviceMetadata.firmwareVersion}</span>

                  <span style={{ color: 'var(--subtext0)', fontWeight: 500 }}>{t('admin_commands.hardware_model', 'Hardware Model')}:</span>
                  <span style={{ color: 'var(--text)' }}>{deviceMetadata.hwModel}</span>

                  <span style={{ color: 'var(--subtext0)', fontWeight: 500 }}>{t('admin_commands.device_role', 'Device Role')}:</span>
                  <span style={{ color: 'var(--text)' }}>{deviceMetadata.role}</span>

                  <span style={{ color: 'var(--subtext0)', fontWeight: 500 }}>{t('admin_commands.device_state_version', 'State Version')}:</span>
                  <span style={{ color: 'var(--text)' }}>{deviceMetadata.deviceStateVersion}</span>

                  <span style={{ color: 'var(--subtext0)', fontWeight: 500 }}>{t('admin_commands.capabilities', 'Capabilities')}:</span>
                  <span style={{ color: 'var(--text)' }}>
                    {[
                      deviceMetadata.hasWifi && 'WiFi',
                      deviceMetadata.hasBluetooth && 'Bluetooth',
                      deviceMetadata.hasEthernet && 'Ethernet',
                      deviceMetadata.canShutdown && 'Shutdown',
                      deviceMetadata.hasRemoteHardware && 'Remote HW'
                    ].filter(Boolean).join(', ') || t('common.none', 'None')}
                  </span>

                  <span style={{ color: 'var(--subtext0)', fontWeight: 500 }}>{t('admin_commands.position_flags', 'Position Flags')}:</span>
                  <span style={{ color: 'var(--text)' }}>{deviceMetadata.positionFlags}</span>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {selectedNode?.isLocal && (
        <div style={{
          padding: '0.75rem 1rem',
          marginBottom: '1rem',
          backgroundColor: 'var(--ctp-surface0)',
          border: '1px solid var(--ctp-blue)',
          borderRadius: '8px',
          color: 'var(--ctp-subtext1)',
          fontSize: '0.9rem',
          lineHeight: '1.4'
        }}>
          {t('admin_commands.local_node_config_hint', 'All local device configuration, including many features not available in Remote Admin, is available on the')}{' '}
          <a
            href="#configuration"
            style={{ color: 'var(--ctp-blue)', textDecoration: 'underline', cursor: 'pointer' }}
          >
            {t('admin_commands.device_configuration_page_link', 'Device Configuration')}
          </a>{' '}
          {t('admin_commands.local_node_config_hint_suffix', 'page.')}
        </div>
      )}

      {/* Radio Configuration Section */}
      <CollapsibleSection
        id="radio-config"
        title={t('admin_commands.radio_configuration', 'Radio Configuration')}
      >
        {/* LoRa Config Section */}
        <CollapsibleSection
          id="admin-lora-config"
          title={t('admin_commands.lora_configuration')}
          nested={true}
          headerActions={renderSectionLoadButton('lora')}
        >
        <div className="setting-item">
          <label style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
            <input
              type="checkbox"
              checked={configState.lora.usePreset}
              onChange={(e) => setLoRaConfig({ usePreset: e.target.checked })}
              disabled={isExecuting}
              style={{ width: 'auto', margin: 0, flexShrink: 0 }}
            />
            <div style={{ flex: 1 }}>
              <div>{t('admin_commands.use_modem_preset')}</div>
              <span className="setting-description">{t('admin_commands.use_modem_preset_description')}</span>
            </div>
          </label>
        </div>
        {configState.lora.usePreset ? (
          <div className="setting-item">
            <label>{t('admin_commands.modem_preset')}</label>
            <select
              value={configState.lora.modemPreset}
              onChange={(e) => setLoRaConfig({ modemPreset: Number(e.target.value) })}
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
                value={configState.lora.bandwidth}
                onChange={(e) => setLoRaConfig({ bandwidth: Number(e.target.value) })}
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
                value={configState.lora.spreadFactor}
                onChange={(e) => setLoRaConfig({ spreadFactor: Number(e.target.value) })}
                disabled={isExecuting}
                className="setting-input"
                style={{ width: '200px' }}
              />
            </div>
            <div className="setting-item">
              <label>Coding Rate</label>
              <input
                type="number"
                value={configState.lora.codingRate}
                onChange={(e) => setLoRaConfig({ codingRate: Number(e.target.value) })}
                disabled={isExecuting}
                className="setting-input"
                style={{ width: '200px' }}
              />
            </div>
            <div className="setting-item">
              <label>Frequency Offset</label>
              <input
                type="number"
                value={configState.lora.frequencyOffset}
                onChange={(e) => setLoRaConfig({ frequencyOffset: Number(e.target.value) })}
                disabled={isExecuting}
                className="setting-input"
                style={{ width: '200px' }}
              />
            </div>
            <div className="setting-item">
              <label>Override Frequency (Hz)</label>
              <input
                type="number"
                value={configState.lora.overrideFrequency}
                onChange={(e) => setLoRaConfig({ overrideFrequency: Number(e.target.value) })}
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
            value={configState.lora.region}
            onChange={(e) => setLoRaConfig({ region: Number(e.target.value) })}
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
            value={configState.lora.hopLimit}
            onChange={(e) => setLoRaConfig({ hopLimit: Number(e.target.value) })}
            disabled={isExecuting}
            className="setting-input"
            style={{ width: '200px' }}
          />
        </div>
        <div className="setting-item">
          <label>TX Power</label>
          <input
            type="number"
            value={configState.lora.txPower}
            onChange={(e) => setLoRaConfig({ txPower: Number(e.target.value) })}
            disabled={isExecuting}
            className="setting-input"
            style={{ width: '200px' }}
          />
        </div>
        <div className="setting-item">
          <label>Channel Number</label>
          <input
            type="number"
            value={configState.lora.channelNum}
            onChange={(e) => setLoRaConfig({ channelNum: Number(e.target.value) })}
            disabled={isExecuting}
            className="setting-input"
            style={{ width: '200px' }}
          />
        </div>
        <div className="setting-item">
          <label style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
            <input
              type="checkbox"
              checked={configState.lora.sx126xRxBoostedGain}
              onChange={(e) => setLoRaConfig({ sx126xRxBoostedGain: e.target.checked })}
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
              checked={configState.lora.ignoreMqtt}
              onChange={(e) => setLoRaConfig({ ignoreMqtt: e.target.checked })}
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
              checked={configState.lora.configOkToMqtt}
              onChange={(e) => setLoRaConfig({ configOkToMqtt: e.target.checked })}
              disabled={isExecuting}
              style={{ width: 'auto', margin: 0, flexShrink: 0 }}
            />
            <div style={{ flex: 1 }}>
              <div>{t('admin_commands.config_ok_to_mqtt')}</div>
              <span className="setting-description">{t('admin_commands.config_ok_to_mqtt_description')}</span>
            </div>
          </label>
        </div>
        <div className="setting-item">
          <label style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
            <input
              type="checkbox"
              checked={configState.lora.txEnabled}
              onChange={(e) => setLoRaConfig({ txEnabled: e.target.checked })}
              disabled={isExecuting}
              style={{ width: 'auto', margin: 0, flexShrink: 0 }}
            />
            <div style={{ flex: 1 }}>
              <div>{t('admin_commands.tx_enabled')}</div>
              <span className="setting-description">{t('admin_commands.tx_enabled_description')}</span>
            </div>
          </label>
        </div>
        <div className="setting-item">
          <label style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
            <input
              type="checkbox"
              checked={configState.lora.overrideDutyCycle}
              onChange={(e) => setLoRaConfig({ overrideDutyCycle: e.target.checked })}
              disabled={isExecuting}
              style={{ width: 'auto', margin: 0, flexShrink: 0 }}
            />
            <div style={{ flex: 1 }}>
              <div>{t('admin_commands.override_duty_cycle')}</div>
              <span className="setting-description">{t('admin_commands.override_duty_cycle_description')}</span>
            </div>
          </label>
        </div>
        <div className="setting-item">
          <label style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
            <input
              type="checkbox"
              checked={configState.lora.paFanDisabled}
              onChange={(e) => setLoRaConfig({ paFanDisabled: e.target.checked })}
              disabled={isExecuting}
              style={{ width: 'auto', margin: 0, flexShrink: 0 }}
            />
            <div style={{ flex: 1 }}>
              <div>{t('admin_commands.pa_fan_disabled')}</div>
              <span className="setting-description">{t('admin_commands.pa_fan_disabled_description')}</span>
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
      </CollapsibleSection>

        {/* Security Config Section */}
        <CollapsibleSection
          id="admin-security-config"
          title={t('admin_commands.security_configuration')}
          nested={true}
          headerActions={renderSectionLoadButton('security')}
        >
        <p className="setting-description" style={{ marginBottom: '1rem' }}>
          {t('admin_commands.security_config_description')}
        </p>
        <div className="setting-item">
          <label>
            {t('admin_commands.admin_keys')}
            <span className="setting-description">
              {t('admin_commands.admin_keys_description')}
            </span>
          </label>
          {configState.security.adminKeys.map((key, index) => (
            <div key={index} style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.5rem', alignItems: 'center' }}>
              <input
                type="text"
                value={key}
                onChange={(e) => handleAdminKeyChange(index, e.target.value)}
                disabled={isExecuting}
                placeholder={t('admin_commands.admin_key_placeholder')}
                className="setting-input"
                style={{ flex: 1 }}
              />
              {configState.security.adminKeys.length > 1 && (
                <button
                  onClick={() => handleRemoveAdminKey(index)}
                  disabled={isExecuting}
                  style={{
                    padding: '0.5rem 1rem',
                    backgroundColor: 'var(--ctp-red)',
                    color: 'var(--ctp-base)',
                    border: 'none',
                    borderRadius: '4px',
                    cursor: isExecuting ? 'not-allowed' : 'pointer',
                    fontSize: '0.875rem'
                  }}
                >
                  {t('common.remove')}
                </button>
              )}
            </div>
          ))}
        </div>
        <div className="setting-item">
          <label style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', width: '100%' }}>
            <input
              type="checkbox"
              checked={configState.security.isManaged}
              onChange={(e) => setSecurityConfig({ isManaged: e.target.checked })}
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
              checked={configState.security.serialEnabled}
              onChange={(e) => setSecurityConfig({ serialEnabled: e.target.checked })}
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
              checked={configState.security.debugLogApiEnabled}
              onChange={(e) => setSecurityConfig({ debugLogApiEnabled: e.target.checked })}
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
              checked={configState.security.adminChannelEnabled}
              onChange={(e) => setSecurityConfig({ adminChannelEnabled: e.target.checked })}
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
          disabled={true}
          title={t('admin_commands.security_save_disabled')}
          style={{
            opacity: 0.5,
            cursor: 'not-allowed'
          }}
        >
          {t('admin_commands.save_security_config')}
        </button>
      </CollapsibleSection>

        {/* Channel Config Section */}
        <CollapsibleSection
          id="admin-channel-config"
          title={t('admin_commands.channel_configuration')}
          nested={true}
          headerActions={renderSectionLoadButton('channels')}
        >
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
      </CollapsibleSection>
      </CollapsibleSection>

      {/* Device Configuration Section */}
      <DeviceConfigurationSection
        CollapsibleSection={CollapsibleSection}
        ownerLongName={configState.owner.longName}
        ownerShortName={configState.owner.shortName}
        ownerIsUnmessagable={configState.owner.isUnmessagable}
        onOwnerConfigChange={handleOwnerConfigChange}
        onSaveOwnerConfig={handleSetOwner}
        deviceRole={configState.device.role}
        nodeInfoBroadcastSecs={configState.device.nodeInfoBroadcastSecs}
        isRoleDropdownOpen={isRoleDropdownOpen}
        onDeviceConfigChange={handleDeviceConfigChange}
        onRoleDropdownToggle={() => setIsRoleDropdownOpen(!isRoleDropdownOpen)}
        onRoleChange={handleRoleChange}
        onSaveDeviceConfig={handleSetDeviceConfig}
        positionBroadcastSecs={configState.position.positionBroadcastSecs}
        positionSmartEnabled={configState.position.positionSmartEnabled}
        fixedPosition={configState.position.fixedPosition}
        fixedLatitude={configState.position.fixedLatitude}
        fixedLongitude={configState.position.fixedLongitude}
        fixedAltitude={configState.position.fixedAltitude}
        gpsUpdateInterval={configState.position.gpsUpdateInterval}
        rxGpio={configState.position.rxGpio}
        txGpio={configState.position.txGpio}
        gpsEnGpio={configState.position.gpsEnGpio}
        broadcastSmartMinimumDistance={configState.position.broadcastSmartMinimumDistance}
        broadcastSmartMinimumIntervalSecs={configState.position.broadcastSmartMinimumIntervalSecs}
        gpsMode={configState.position.gpsMode}
        positionFlagAltitude={configState.position.positionFlags.altitude}
        positionFlagAltitudeMsl={configState.position.positionFlags.altitudeMsl}
        positionFlagGeoidalSeparation={configState.position.positionFlags.geoidalSeparation}
        positionFlagDop={configState.position.positionFlags.dop}
        positionFlagHvdop={configState.position.positionFlags.hvdop}
        positionFlagSatinview={configState.position.positionFlags.satinview}
        positionFlagSeqNo={configState.position.positionFlags.seqNo}
        positionFlagTimestamp={configState.position.positionFlags.timestamp}
        positionFlagHeading={configState.position.positionFlags.heading}
        positionFlagSpeed={configState.position.positionFlags.speed}
        onPositionConfigChange={handlePositionConfigChange}
        onPositionFlagChange={handlePositionFlagChange}
        onSavePositionConfig={handleSetPositionConfig}
        bluetoothEnabled={configState.bluetooth.enabled}
        bluetoothMode={configState.bluetooth.mode}
        bluetoothFixedPin={configState.bluetooth.fixedPin}
        onBluetoothConfigChange={handleBluetoothConfigChange}
        onSaveBluetoothConfig={handleSetBluetoothConfig}
        networkWifiEnabled={configState.network.wifiEnabled}
        networkWifiSsid={configState.network.wifiSsid}
        networkWifiPsk={configState.network.wifiPsk}
        networkNtpServer={configState.network.ntpServer}
        networkAddressMode={configState.network.addressMode}
        networkIpv4Address={configState.network.ipv4Address}
        networkIpv4Gateway={configState.network.ipv4Gateway}
        networkIpv4Subnet={configState.network.ipv4Subnet}
        networkIpv4Dns={configState.network.ipv4Dns}
        onNetworkConfigChange={handleNetworkConfigChange}
        onSaveNetworkConfig={handleSetNetworkConfig}
        isExecuting={isExecuting}
        selectedNodeNum={selectedNodeNum}
        ownerHeaderActions={renderSectionLoadButton('owner')}
        deviceHeaderActions={renderSectionLoadButton('device')}
        positionHeaderActions={renderSectionLoadButton('position')}
        bluetoothHeaderActions={renderSectionLoadButton('bluetooth')}
        networkHeaderActions={renderSectionLoadButton('network')}
      />

      {/* Module Configuration Section */}
      <ModuleConfigurationSection
        CollapsibleSection={CollapsibleSection}
        mqttEnabled={configState.mqtt.enabled}
        mqttAddress={configState.mqtt.address}
        mqttUsername={configState.mqtt.username}
        mqttPassword={configState.mqtt.password}
        mqttEncryptionEnabled={configState.mqtt.encryptionEnabled}
        mqttJsonEnabled={configState.mqtt.jsonEnabled}
        mqttRoot={configState.mqtt.root}
        onMQTTConfigChange={handleMQTTConfigChange}
        onSaveMQTTConfig={handleSetMQTTConfig}
        neighborInfoEnabled={configState.neighborInfo.enabled}
        neighborInfoUpdateInterval={configState.neighborInfo.updateInterval}
        neighborInfoTransmitOverLora={configState.neighborInfo.transmitOverLora}
        onNeighborInfoConfigChange={handleNeighborInfoConfigChange}
        onSaveNeighborInfoConfig={handleSetNeighborInfoConfig}
        telemetryDeviceUpdateInterval={configState.telemetry.deviceUpdateInterval}
        telemetryDeviceTelemetryEnabled={configState.telemetry.deviceTelemetryEnabled}
        telemetryEnvironmentUpdateInterval={configState.telemetry.environmentUpdateInterval}
        telemetryEnvironmentMeasurementEnabled={configState.telemetry.environmentMeasurementEnabled}
        telemetryEnvironmentScreenEnabled={configState.telemetry.environmentScreenEnabled}
        telemetryEnvironmentDisplayFahrenheit={configState.telemetry.environmentDisplayFahrenheit}
        telemetryAirQualityEnabled={configState.telemetry.airQualityEnabled}
        telemetryAirQualityInterval={configState.telemetry.airQualityInterval}
        telemetryPowerMeasurementEnabled={configState.telemetry.powerMeasurementEnabled}
        telemetryPowerUpdateInterval={configState.telemetry.powerUpdateInterval}
        telemetryPowerScreenEnabled={configState.telemetry.powerScreenEnabled}
        telemetryHealthMeasurementEnabled={configState.telemetry.healthMeasurementEnabled}
        telemetryHealthUpdateInterval={configState.telemetry.healthUpdateInterval}
        telemetryHealthScreenEnabled={configState.telemetry.healthScreenEnabled}
        onTelemetryConfigChange={handleTelemetryConfigChange}
        onSaveTelemetryConfig={handleSetTelemetryConfig}
        statusMessageNodeStatus={configState.statusMessage.nodeStatus}
        onStatusMessageConfigChange={handleStatusMessageConfigChange}
        onSaveStatusMessageConfig={handleSetStatusMessageConfig}
        statusMessageIsDisabled={sectionLoadStatus.statusmessage === 'error'}
        trafficManagementEnabled={configState.trafficManagement.enabled}
        trafficManagementPositionDedupEnabled={configState.trafficManagement.positionDedupEnabled}
        trafficManagementPositionDedupTimeSecs={configState.trafficManagement.positionDedupTimeSecs}
        trafficManagementPositionDedupDistanceMeters={configState.trafficManagement.positionDedupDistanceMeters}
        trafficManagementNodeinfoDirectResponseEnabled={configState.trafficManagement.nodeinfoDirectResponseEnabled}
        trafficManagementNodeinfoDirectResponseMyNodeOnly={configState.trafficManagement.nodeinfoDirectResponseMyNodeOnly}
        trafficManagementRateLimitEnabled={configState.trafficManagement.rateLimitEnabled}
        trafficManagementRateLimitMaxPerNode={configState.trafficManagement.rateLimitMaxPerNode}
        trafficManagementRateLimitWindowSecs={configState.trafficManagement.rateLimitWindowSecs}
        trafficManagementUnknownPacketDropEnabled={configState.trafficManagement.unknownPacketDropEnabled}
        trafficManagementUnknownPacketGracePeriodSecs={configState.trafficManagement.unknownPacketGracePeriodSecs}
        trafficManagementHopExhaustionEnabled={configState.trafficManagement.hopExhaustionEnabled}
        trafficManagementHopExhaustionMinHops={configState.trafficManagement.hopExhaustionMinHops}
        trafficManagementHopExhaustionMaxHops={configState.trafficManagement.hopExhaustionMaxHops}
        onTrafficManagementConfigChange={handleTrafficManagementConfigChange}
        onSaveTrafficManagementConfig={handleSetTrafficManagementConfig}
        trafficManagementIsDisabled={sectionLoadStatus.trafficmanagement === 'error'}
        isExecuting={isExecuting}
        selectedNodeNum={selectedNodeNum}
        mqttHeaderActions={renderSectionLoadButton('mqtt')}
        neighborInfoHeaderActions={renderSectionLoadButton('neighborinfo')}
        telemetryHeaderActions={renderSectionLoadButton('telemetry')}
        statusMessageHeaderActions={renderSectionLoadButton('statusmessage')}
        trafficManagementHeaderActions={renderSectionLoadButton('trafficmanagement')}
      />

      {/* Import/Export Configuration Section */}
      <CollapsibleSection
        id="admin-import-export"
        title={t('admin_commands.config_import_export')}
      >
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
            onClick={() => {
              if (selectedNodeNum === null) {
                showToast(t('admin_commands.please_select_node'), 'error');
                return;
              }

              // Open the export modal - it will use already loaded channels
              // If no channels are loaded, the modal will show helpful instructions
              setShowConfigExportModal(true);
            }}
            disabled={selectedNodeNum === null || isExecuting}
            style={{
              backgroundColor: 'var(--ctp-green)',
              color: '#fff',
              padding: '0.75rem 1.5rem',
              border: 'none',
              borderRadius: '4px',
              cursor: (selectedNodeNum === null || isExecuting) ? 'not-allowed' : 'pointer',
              fontSize: '1rem',
              fontWeight: 'bold',
              opacity: (selectedNodeNum === null || isExecuting) ? 0.5 : 1
            }}
            title={t('admin_commands.export_config_tooltip')}
          >
            {`📤 ${t('admin_commands.export_configuration')}`}
          </button>
        </div>
      </CollapsibleSection>

      {/* Node Favorites & Ignored Section */}
      <CollapsibleSection
        id="admin-node-management"
        title={t('admin_commands.node_favorites_ignored')}
      >
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
          <div ref={nodeManagementSearchRef} style={{ position: 'relative', width: '100%', maxWidth: '600px', zIndex: 100 }}>
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
                zIndex: 9999,
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
              const isDisabled = isExecuting || nodeManagementNodeNum === null;

              return (
                <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                  <button
                    onClick={handleSetFavoriteNode}
                    disabled={isDisabled}
                    style={{
                      flex: 1,
                      padding: '0.75rem 1rem',
                      backgroundColor: 'var(--ctp-yellow)',
                      color: 'var(--ctp-base)',
                      border: 'none',
                      borderRadius: '4px',
                      cursor: isDisabled ? 'not-allowed' : 'pointer',
                      fontSize: '0.9rem',
                      fontWeight: '500',
                      opacity: isDisabled ? 0.6 : 1
                    }}
                  >
                    {t('admin_commands.set_as_favorite')}
                  </button>
                  <button
                    onClick={handleRemoveFavoriteNode}
                    disabled={isDisabled}
                    style={{
                      flex: 1,
                      padding: '0.75rem 1rem',
                      backgroundColor: 'var(--ctp-surface2)',
                      color: 'var(--ctp-text)',
                      border: 'none',
                      borderRadius: '4px',
                      cursor: isDisabled ? 'not-allowed' : 'pointer',
                      fontSize: '0.9rem',
                      fontWeight: '500',
                      opacity: isDisabled ? 0.6 : 1
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
              const isDisabled = isExecuting || nodeManagementNodeNum === null;

              return (
                <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                  <button
                    onClick={handleSetIgnoredNode}
                    disabled={isDisabled}
                    style={{
                      flex: 1,
                      padding: '0.75rem 1rem',
                      backgroundColor: 'var(--ctp-red)',
                      color: 'var(--ctp-base)',
                      border: 'none',
                      borderRadius: '4px',
                      cursor: isDisabled ? 'not-allowed' : 'pointer',
                      fontSize: '0.9rem',
                      fontWeight: '500',
                      opacity: isDisabled ? 0.6 : 1
                    }}
                  >
                    {t('admin_commands.set_as_ignored')}
                  </button>
                  <button
                    onClick={handleRemoveIgnoredNode}
                    disabled={isDisabled}
                    style={{
                      flex: 1,
                      padding: '0.75rem 1rem',
                      backgroundColor: 'var(--ctp-surface2)',
                      color: 'var(--ctp-text)',
                      border: 'none',
                      borderRadius: '4px',
                      cursor: isDisabled ? 'not-allowed' : 'pointer',
                      fontSize: '0.9rem',
                      fontWeight: '500',
                      opacity: isDisabled ? 0.6 : 1
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
      </CollapsibleSection>

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

      {/* Reboot and Purge Command Section - Moved to bottom, matching Device page style */}
      <CollapsibleSection
        id="admin-reboot-purge"
        title={`⚠️ ${t('admin_commands.warning')}`}
        className="danger-zone"
      >
        <h2 style={{ color: '#ff4444', marginTop: 0, marginBottom: '1rem' }}>⚠️ {t('admin_commands.warning')}</h2>
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
      </CollapsibleSection>

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
              usePreset: configState.lora.usePreset,
              modemPreset: configState.lora.modemPreset,
              region: configState.lora.region,
              hopLimit: configState.lora.hopLimit
            }
          }}
          nodeNum={selectedNodeNum !== null ? selectedNodeNum : undefined}
          onLoadChannels={async () => {
            if (selectedNodeNum === null) {
              throw new Error(t('admin_commands.please_select_node'));
            }

            // Skip loading if channels were already successfully loaded
            // This respects manual loading - user can load configs, retry failed ones,
            // and then export without auto-reloading (fixes #1115)
            if (sectionLoadStatus.channels === 'success') {
              return;
            }
            
            const localNodeNum = nodeOptions.find(n => n.isLocal)?.nodeNum;
            const isLocalNode = selectedNodeNum === localNodeNum || selectedNodeNum === 0;
            
            if (isLocalNode) {
              // For local nodes, fetch from API
              const allChannels = await apiService.getAllChannels();
              setRemoteNodeChannels(allChannels);
            } else {
              // For remote nodes, only load channels (not all configs)
              await handleLoadChannels();
            }
          }}
          isLoadingChannels={isLoadingChannels || isLoadingAllConfigs}
        />
      )}
    </div>
  );
};

// Memoize to prevent re-renders from parent's statusTick timer
export default React.memo(AdminCommandsTab);
