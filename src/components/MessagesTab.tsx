/**
 * MessagesTab - Direct Messages conversation view
 *
 * Extracted from App.tsx to improve maintainability.
 * Handles the Messages/DM tab with node list and conversation view.
 */

import React, { useRef, useCallback, useState, useMemo, useEffect } from 'react';
import { useResizable } from '../hooks/useResizable';
import { useTranslation, Trans } from 'react-i18next';
import { DeviceInfo } from '../types/device';
import { MeshMessage } from '../types/message';
import { ResourceType } from '../types/permission';
import { TimeFormat, DateFormat } from '../contexts/SettingsContext';
import {
  formatDateTime,
  formatRelativeTime,
  formatMessageTime,
  getMessageDateSeparator,
  shouldShowDateSeparator,
} from '../utils/datetime';
import { formatTracerouteRoute } from '../utils/traceroute';
import { getUtf8ByteLength, formatByteCount, isEmoji } from '../utils/text';
import { calculateDistance, formatDistance, getDistanceToNode } from '../utils/distance';
import { renderMessageWithLinks } from '../utils/linkRenderer';
import { isNodeComplete, isInfrastructureNode, hasValidPosition, parseNodeId } from '../utils/nodeHelpers';
import { getEffectiveHops } from '../utils/nodeHops';
import { useMapContext } from '../contexts/MapContext';
import { useSettings } from '../contexts/SettingsContext';
import HopCountDisplay from './HopCountDisplay';
import LinkPreview from './LinkPreview';
import NodeDetailsBlock from './NodeDetailsBlock';
import TelemetryGraphs from './TelemetryGraphs';
import SmartHopsGraphs from './SmartHopsGraphs';
import LinkQualityGraph from './LinkQualityGraph';
import PacketStatsChart, { ChartDataEntry, DISTRIBUTION_COLORS } from './PacketStatsChart';
import { getPacketDistributionStats } from '../services/packetApi';
import { PacketDistributionStats } from '../types/packet';
import { NodeFilterPopup } from './NodeFilterPopup';
import { MessageStatusIndicator } from './MessageStatusIndicator';
import RelayNodeModal from './RelayNodeModal';
import TelemetryRequestModal, { TelemetryType } from './TelemetryRequestModal';
import { useToast } from './ToastContainer';
import apiService from '../services/api';
import { useCsrfFetch } from '../hooks/useCsrfFetch';

// Types for node with message metadata
interface NodeWithMessages extends DeviceInfo {
  messageCount: number;
  unreadCount: number;
  lastMessageTime: number;
  lastMessageText: string;
}

// Traceroute data structure
interface TracerouteData {
  timestamp: number;
  route: string;
  routeBack: string;
  snrTowards: string;
  snrBack: string;
  fromNodeNum: number;
  toNodeNum: number;
}

// Memoized distance display component to avoid recalculating on every render
const DistanceDisplay = React.memo<{
  homeNode: DeviceInfo | undefined;
  targetNode: DeviceInfo;
  distanceUnit: 'km' | 'mi';
  t: (key: string) => string;
}>(({ homeNode, targetNode, distanceUnit, t }) => {
  const distance = React.useMemo(
    () => getDistanceToNode(homeNode, targetNode, distanceUnit),
    [homeNode?.position?.latitude, homeNode?.position?.longitude,
     targetNode.position?.latitude, targetNode.position?.longitude, distanceUnit]
  );

  if (!distance) return null;

  return (
    <span
      className="node-distance"
      title={t('nodes.distance')}
      style={{
        fontSize: '0.75rem',
        color: 'var(--ctp-subtext0)',
        marginLeft: '0.5rem',
      }}
    >
      📏 {distance}
    </span>
  );
});

export interface MessagesTabProps {
  // Data
  processedNodes: DeviceInfo[];
  nodes: DeviceInfo[];
  messages: MeshMessage[];
  currentNodeId: string;

  // Telemetry Sets
  nodesWithTelemetry: Set<string>;
  nodesWithWeatherTelemetry: Set<string>;
  nodesWithPKC: Set<string>;

  // Connection state
  connectionStatus: string;

  // Selected state
  selectedDMNode: string | null;
  setSelectedDMNode: (nodeId: string) => void;

  // Message input
  newMessage: string;
  setNewMessage: (message: string) => void;
  replyingTo: MeshMessage | null;
  setReplyingTo: (message: MeshMessage | null) => void;

  // Unread tracking
  unreadCountsData: {
    directMessages?: Record<string, number>;
  } | null;
  markMessagesAsRead: (
    messageIds?: string[],
    channelId?: number,
    dmNodeId?: string,
    markAllDMs?: boolean
  ) => Promise<void>;

  // UI state
  nodeFilter: string; // Deprecated - use messagesNodeFilter instead
  setNodeFilter: (filter: string) => void;
  messagesNodeFilter: string;
  setMessagesNodeFilter: (filter: string) => void;
  dmFilter: 'all' | 'unread' | 'recent' | 'hops' | 'favorites' | 'withPosition' | 'noInfra';
  setDmFilter: (filter: 'all' | 'unread' | 'recent' | 'hops' | 'favorites' | 'withPosition' | 'noInfra') => void;
  securityFilter: 'all' | 'flaggedOnly' | 'hideFlagged';
  channelFilter: number | 'all';
  showIncompleteNodes: boolean;
  showNodeFilterPopup: boolean;
  setShowNodeFilterPopup: (show: boolean) => void;
  isMessagesNodeListCollapsed: boolean;
  setIsMessagesNodeListCollapsed: (collapsed: boolean) => void;

  // Loading states
  tracerouteLoading: string | null;
  positionLoading: string | null;
  nodeInfoLoading: string | null;
  neighborInfoLoading: string | null;
  telemetryRequestLoading: string | null;

  // Settings
  timeFormat: TimeFormat;
  dateFormat: DateFormat;
  temperatureUnit: 'F' | 'C';
  telemetryVisualizationHours: number;
  distanceUnit: 'mi' | 'km';
  baseUrl: string;

  // Permission check
  hasPermission: (resource: ResourceType, action: 'read' | 'write') => boolean;

  // Handlers
  handleSendDirectMessage: (destinationNodeId: string) => Promise<void>;
  handleResendMessage: (message: MeshMessage) => Promise<void>;
  handleTraceroute: (nodeId: string) => Promise<void>;
  handleExchangePosition: (nodeId: string) => Promise<void>;
  handleExchangeNodeInfo: (nodeId: string) => Promise<void>;
  handleRequestNeighborInfo: (nodeId: string) => Promise<void>;
  handleRequestTelemetry: (nodeId: string, telemetryType: 'device' | 'environment' | 'airQuality' | 'power') => Promise<void>;
  handleDeleteMessage: (message: MeshMessage) => Promise<void>;
  handleSenderClick: (nodeId: string, event: React.MouseEvent) => void;
  handleSendTapback: (emoji: string, message: MeshMessage) => void;
  getRecentTraceroute: (nodeId: string) => TracerouteData | null;
  toggleIgnored: (node: DeviceInfo, event: React.MouseEvent) => Promise<void>;
  toggleFavorite: (node: DeviceInfo, event: React.MouseEvent) => Promise<void>;

  // Modal controls
  setShowTracerouteHistoryModal: (show: boolean) => void;
  setShowPurgeDataModal: (show: boolean) => void;
  setShowPositionOverrideModal: (show: boolean) => void;
  setEmojiPickerMessage: (message: MeshMessage | null) => void;

  // Helper function
  shouldShowData: () => boolean;

  // Navigation
  handleShowOnMap: (nodeId: string) => void;

  // Refs from parent for scroll handling
  dmMessagesContainerRef: React.RefObject<HTMLDivElement | null>;
}

const MessagesTab: React.FC<MessagesTabProps> = ({
  processedNodes,
  nodes,
  messages,
  currentNodeId,
  nodesWithTelemetry,
  nodesWithWeatherTelemetry,
  nodesWithPKC,
  connectionStatus,
  selectedDMNode,
  setSelectedDMNode,
  newMessage,
  setNewMessage,
  replyingTo,
  setReplyingTo,
  unreadCountsData,
  markMessagesAsRead,
  nodeFilter: _nodeFilter, // Deprecated - kept for backward compatibility
  messagesNodeFilter,
  setMessagesNodeFilter,
  setNodeFilter: _setNodeFilter, // Deprecated - kept for backward compatibility
  dmFilter,
  setDmFilter,
  securityFilter,
  channelFilter,
  showIncompleteNodes,
  showNodeFilterPopup,
  setShowNodeFilterPopup,
  isMessagesNodeListCollapsed,
  setIsMessagesNodeListCollapsed,
  tracerouteLoading,
  positionLoading,
  nodeInfoLoading,
  neighborInfoLoading,
  telemetryRequestLoading,
  timeFormat,
  dateFormat,
  temperatureUnit,
  telemetryVisualizationHours,
  distanceUnit,
  baseUrl,
  hasPermission,
  handleSendDirectMessage,
  handleResendMessage,
  handleTraceroute,
  handleExchangePosition,
  handleExchangeNodeInfo,
  handleRequestNeighborInfo,
  handleRequestTelemetry,
  handleDeleteMessage,
  handleSenderClick,
  handleSendTapback,
  getRecentTraceroute,
  toggleIgnored,
  toggleFavorite,
  setShowTracerouteHistoryModal,
  setShowPurgeDataModal,
  setShowPositionOverrideModal,
  setEmojiPickerMessage,
  shouldShowData,
  handleShowOnMap,
  dmMessagesContainerRef,
}) => {
  const { t } = useTranslation();

  // Get settings and context for effective hops calculation
  const { nodeHopsCalculation } = useSettings();
  const { traceroutes, neighborInfo, setNeighborInfo } = useMapContext();
  const currentNodeNum = currentNodeId ? parseNodeId(currentNodeId) : null;

  // Local state for actions menu
  const [showActionsMenu, setShowActionsMenu] = useState(false);

  // Relay node modal state
  const [relayModalOpen, setRelayModalOpen] = useState(false);
  const [selectedRelayNode, setSelectedRelayNode] = useState<number | null>(null);
  const [selectedRxTime, setSelectedRxTime] = useState<Date | undefined>(undefined);
  const [selectedMessageRssi, setSelectedMessageRssi] = useState<number | undefined>(undefined);
  const [directNeighborStats, setDirectNeighborStats] = useState<Record<number, { avgRssi: number; packetCount: number; lastHeard: number }>>({});

  // Telemetry request modal state
  const [showTelemetryRequestModal, setShowTelemetryRequestModal] = useState(false);

  // Sticky nodes - pinned to top of list regardless of sorting (stored in localStorage)
  const [stickyNodes, setStickyNodes] = useState<Set<number>>(() => {
    try {
      const stored = localStorage.getItem('meshmonitor-sticky-dm-nodes');
      if (stored) {
        const parsed = JSON.parse(stored);
        return new Set(Array.isArray(parsed) ? parsed : []);
      }
    } catch {
      // Ignore parse errors
    }
    return new Set();
  });

  // Toggle sticky status for a node
  const toggleStickyNode = useCallback((nodeNum: number, e: React.MouseEvent) => {
    e.stopPropagation(); // Don't select the node when toggling sticky
    setStickyNodes(prev => {
      const newSet = new Set(prev);
      if (newSet.has(nodeNum)) {
        newSet.delete(nodeNum);
      } else {
        newSet.add(nodeNum);
      }
      // Persist to localStorage
      localStorage.setItem('meshmonitor-sticky-dm-nodes', JSON.stringify([...newSet]));
      return newSet;
    });
  }, []);

  // Admin scan state
  const [adminScanLoading, setAdminScanLoading] = useState<string | null>(null);
  const { showToast } = useToast();
  const csrfFetch = useCsrfFetch();

  // Purge neighbors state
  const [purgingNeighbors, setPurgingNeighbors] = useState(false);

  // Resizable send section (only on desktop)
  const {
    size: sendSectionHeight,
    isResizing: isSendSectionResizing,
    handleMouseDown: handleSendSectionResizeStart,
  } = useResizable({
    id: 'dm-send-section-height',
    defaultHeight: 280,
    minHeight: 120,
    maxHeight: 600,
    direction: 'vertical',
  });

  // Detect if we're on mobile/tablet
  const isMobileLayout = useMemo(() => {
    if (typeof window === 'undefined') return false;
    return window.innerWidth < 768;
  }, []);

  // Map nodes to the format expected by RelayNodeModal
  const mappedNodes = nodes.map(node => {
    const stats = directNeighborStats[node.nodeNum];
    return {
      nodeNum: node.nodeNum,
      nodeId: node.user?.id || `!${node.nodeNum.toString(16).padStart(8, '0')}`,
      longName: node.user?.longName || `Node ${node.nodeNum}`,
      shortName: node.user?.shortName || node.nodeNum.toString(16).substring(0, 4),
      hopsAway: node.hopsAway,
      role: typeof node.user?.role === 'string' ? parseInt(node.user.role, 10) : node.user?.role,
      avgDirectRssi: stats?.avgRssi,
      heardDirectly: stats !== undefined,
    };
  });

  // Refs
  const dmMessageInputRef = useRef<HTMLInputElement>(null);

  // Helper functions
  const getNodeName = useCallback(
    (nodeId: string): string => {
      const node = nodes.find(n => n.user?.id === nodeId);
      return node?.user?.longName || node?.user?.shortName || nodeId;
    },
    [nodes]
  );

  const getNodeShortName = useCallback(
    (nodeId: string): string => {
      const node = nodes.find(n => n.user?.id === nodeId);
      return (node?.user?.shortName && node.user.shortName.trim()) || nodeId.substring(1, 5);
    },
    [nodes]
  );

  const isMyMessage = useCallback(
    (msg: MeshMessage): boolean => {
      return msg.from === currentNodeId || msg.isLocalMessage === true;
    },
    [currentNodeId]
  );

  const getDMMessages = useCallback(
    (nodeId: string): MeshMessage[] => {
      return messages.filter(
        msg =>
          (msg.from === nodeId || msg.to === nodeId) &&
          msg.to !== '!ffffffff' &&
          msg.channel === -1 &&
          msg.portnum === 1
      );
    },
    [messages]
  );

  // Handle relay node click - opens modal to show potential relay nodes
  const handleRelayClick = useCallback(
    async (msg: MeshMessage) => {
      if (msg.relayNode !== undefined && msg.relayNode !== null) {
        setSelectedRelayNode(msg.relayNode);
        setSelectedRxTime(msg.timestamp);
        setSelectedMessageRssi(msg.rxRssi ?? undefined);

        // Fetch direct neighbor stats
        try {
          const stats = await apiService.getDirectNeighborStats(24);
          setDirectNeighborStats(stats);
        } catch (error) {
          console.error('Failed to fetch direct neighbor stats:', error);
        }

        setRelayModalOpen(true);
      }
    },
    []
  );

  // Handle scan for remote admin
  const handleScanForAdmin = useCallback(
    async (nodeId: string) => {
      const node = nodes.find(n => n.user?.id === nodeId);
      if (!node) return;

      setAdminScanLoading(nodeId);
      try {
        const response = await csrfFetch(`${baseUrl}/api/nodes/${node.nodeNum}/scan-remote-admin`, {
          method: 'POST',
        });

        if (!response.ok) {
          if (response.status === 403) {
            showToast(t('messages.scan_admin_permission_denied'), 'error');
            return;
          }
          throw new Error(`Server returned ${response.status}`);
        }

        const result = await response.json();
        if (result.hasRemoteAdmin) {
          const firmware = result.metadata?.firmwareVersion || t('common.unknown');
          showToast(t('messages.scan_admin_success', { firmware }), 'success');
        } else {
          showToast(t('messages.scan_admin_no_access'), 'warning');
        }
      } catch (error) {
        console.error('Failed to scan for admin:', error);
        showToast(t('messages.scan_admin_failed'), 'error');
      } finally {
        setAdminScanLoading(null);
      }
    },
    [nodes, baseUrl, csrfFetch, showToast, t]
  );

  // Packet type distribution for selected node (last 24h)
  const selectedNodeNum = useMemo(() => {
    if (!selectedDMNode) return undefined;
    const node = nodes.find(n => n.user?.id === selectedDMNode);
    return node?.nodeNum;
  }, [selectedDMNode, nodes]);

  const [nodePacketDistribution, setNodePacketDistribution] = useState<PacketDistributionStats | null>(null);

  const fetchNodePacketDistribution = useCallback(async () => {
    if (selectedNodeNum === undefined) {
      setNodePacketDistribution(null);
      return;
    }
    try {
      const since = Math.floor(Date.now() / 1000) - 86400; // Last 24 hours
      const distribution = await getPacketDistributionStats(since, selectedNodeNum);
      setNodePacketDistribution(distribution);
    } catch (error) {
      console.error('Failed to fetch node packet distribution:', error);
    }
  }, [selectedNodeNum]);

  useEffect(() => {
    fetchNodePacketDistribution();
    const interval = setInterval(fetchNodePacketDistribution, 60000);
    return () => clearInterval(interval);
  }, [fetchNodePacketDistribution]);

  const nodePacketTypeData: ChartDataEntry[] = useMemo(() => {
    if (!nodePacketDistribution?.byType) return [];
    return nodePacketDistribution.byType.map((p, i) => ({
      name: p.portnum_name.replace(/_APP$/, '').replace(/_/g, ' '),
      value: p.count,
      color: DISTRIBUTION_COLORS[i % DISTRIBUTION_COLORS.length],
    }));
  }, [nodePacketDistribution]);

  // Permission check
  if (!hasPermission('messages', 'read')) {
    return (
      <div className="no-permission-message">
        <p><Trans i18nKey="messages.permission_denied" components={{ strong: <strong /> }} /></p>
      </div>
    );
  }

  // Find the home node for distance calculations
  const homeNode = nodes.find(n => n.user?.id === currentNodeId);

  // Process nodes with message metadata
  const nodesWithMessages: NodeWithMessages[] = processedNodes
    .filter(node => node.user?.id !== currentNodeId)
    .map(node => {
      const nodeId = node.user?.id;
      if (!nodeId) {
        return {
          ...node,
          messageCount: 0,
          unreadCount: 0,
          lastMessageTime: 0,
          lastMessageText: '',
        };
      }

      const dmMessages = getDMMessages(nodeId);
      const unreadCount = unreadCountsData?.directMessages?.[nodeId] || 0;

      const lastMessage =
        dmMessages.length > 0
          ? dmMessages.reduce((latest, msg) => (msg.timestamp.getTime() > latest.timestamp.getTime() ? msg : latest))
          : null;

      const lastMessageText = lastMessage
        ? (lastMessage.text || '').substring(0, 50) + (lastMessage.text && lastMessage.text.length > 50 ? '...' : '')
        : '';

      return {
        ...node,
        messageCount: dmMessages.length,
        unreadCount,
        lastMessageTime: dmMessages.length > 0 ? Math.max(...dmMessages.map(m => m.timestamp.getTime())) : 0,
        lastMessageText,
      };
    });

  // Sort by hops (ascending, 0 first, unknown last)
  const sortByHops = (a: NodeWithMessages, b: NodeWithMessages): number => {
    const aHops = getEffectiveHops(a, nodeHopsCalculation, traceroutes, currentNodeNum);
    const bHops = getEffectiveHops(b, nodeHopsCalculation, traceroutes, currentNodeNum);
    return aHops - bHops;
  };

  // Default sort: favorites first, then by last message time
  const sortDefault = (a: NodeWithMessages, b: NodeWithMessages): number => {
    if (a.isFavorite && !b.isFavorite) return -1;
    if (!a.isFavorite && b.isFavorite) return 1;
    return b.lastMessageTime - a.lastMessageTime;
  };

  // Sort and filter nodes based on dmFilter
  const sortedNodesWithMessages = [...nodesWithMessages]
    .filter(node => {
      // Sticky nodes always pass through filters
      if (stickyNodes.has(node.nodeNum)) return true;

      // Apply filter conditions
      switch (dmFilter) {
        case 'unread':
          return node.unreadCount > 0;
        case 'recent': {
          const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
          return node.lastMessageTime > oneDayAgo;
        }
        case 'favorites':
          return node.isFavorite === true;
        case 'withPosition':
          return hasValidPosition(node);
        case 'noInfra':
          return !isInfrastructureNode(node);
        case 'hops':
        case 'all':
        default:
          return true;
      }
    })
    .sort((a, b) => {
      // Sticky nodes always come first
      const aSticky = stickyNodes.has(a.nodeNum);
      const bSticky = stickyNodes.has(b.nodeNum);
      if (aSticky && !bSticky) return -1;
      if (!aSticky && bSticky) return 1;

      // For hops-based filters, sort by hops ascending
      if (['hops', 'favorites', 'withPosition', 'noInfra'].includes(dmFilter)) {
        return sortByHops(a, b);
      }
      // Default sort: favorites first, then by last message time
      return sortDefault(a, b);
    });

  // Filter for display
  const filteredNodes = sortedNodesWithMessages.filter(node => {
    // Sticky nodes always pass through filters
    if (stickyNodes.has(node.nodeNum)) return true;

    if (securityFilter === 'flaggedOnly') {
      if (!node.keyIsLowEntropy && !node.duplicateKeyDetected && !node.keySecurityIssueDetails) return false;
    } else if (securityFilter === 'hideFlagged') {
      if (node.keyIsLowEntropy || node.duplicateKeyDetected || node.keySecurityIssueDetails) return false;
    }
    if (!showIncompleteNodes && !isNodeComplete(node)) {
      return false;
    }
    if (channelFilter !== 'all') {
      const nodeChannel = node.channel ?? 0;
      if (nodeChannel !== channelFilter) return false;
    }
    if (!messagesNodeFilter) return true;
    const searchTerm = messagesNodeFilter.toLowerCase();
    return (
      node.user?.longName?.toLowerCase().includes(searchTerm) ||
      node.user?.shortName?.toLowerCase().includes(searchTerm) ||
      node.user?.id?.toLowerCase().includes(searchTerm)
    );
  });

  // Get DM messages for selected node
  const selectedDMMessages = selectedDMNode
    ? getDMMessages(selectedDMNode).sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())
    : [];

  const selectedNode = selectedDMNode ? nodes.find(n => n.user?.id === selectedDMNode) : null;

  return (
    <div className="nodes-split-view messages-split-view">
      {/* Left Sidebar - Node List */}
      <div className={`nodes-sidebar messages-sidebar ${isMessagesNodeListCollapsed ? 'collapsed' : ''}`}>
        <div className="sidebar-header">
          <button
            className="collapse-nodes-btn"
            onClick={() => setIsMessagesNodeListCollapsed(!isMessagesNodeListCollapsed)}
            title={isMessagesNodeListCollapsed ? t('nodes.expand_node_list') : t('nodes.collapse_node_list')}
          >
            {isMessagesNodeListCollapsed ? '▶' : '◀'}
          </button>
          {!isMessagesNodeListCollapsed && (
            <div className="sidebar-header-content">
              <h3>{t('messages.nodes_header')}</h3>
              <button
                className="mark-all-read-btn"
                onClick={() => markMessagesAsRead(undefined, undefined, undefined, true)}
                title={t('messages.mark_all_read_title')}
              >
                {t('messages.mark_all_read_button')}
              </button>
            </div>
          )}
          {!isMessagesNodeListCollapsed && (
            <div className="node-controls">
              <div className="filter-input-wrapper">
                <input
                  type="text"
                  placeholder={t('messages.filter_placeholder')}
                  value={messagesNodeFilter}
                  onChange={e => setMessagesNodeFilter(e.target.value)}
                  className="filter-input-small"
                />
                {messagesNodeFilter && (
                  <button
                    className="filter-clear-btn"
                    onClick={() => setMessagesNodeFilter('')}
                    title={t('common.clear_filter')}
                    type="button"
                  >
                    ✕
                  </button>
                )}
              </div>
              <div className="sort-controls">
                <select
                  value={dmFilter}
                  onChange={e => setDmFilter(e.target.value as 'all' | 'unread' | 'recent' | 'hops' | 'favorites' | 'withPosition' | 'noInfra')}
                  className="sort-dropdown"
                  title={t('messages.filter_conversations_title')}
                >
                  <option value="all">{t('messages.all_conversations')}</option>
                  <option value="unread">{t('messages.unread_only')}</option>
                  <option value="recent">{t('messages.recent_24h')}</option>
                  <option value="hops">{t('messages.by_hops')}</option>
                  <option value="favorites">{t('messages.favorites_only')}</option>
                  <option value="withPosition">{t('messages.with_position')}</option>
                  <option value="noInfra">{t('messages.exclude_infrastructure')}</option>
                </select>
              </div>
            </div>
          )}
        </div>

        <NodeFilterPopup isOpen={showNodeFilterPopup} onClose={() => setShowNodeFilterPopup(false)} />

        {!isMessagesNodeListCollapsed && (
          <div className="nodes-list">
            {shouldShowData() ? (
              processedNodes.length > 0 ? (
                <>
                  {filteredNodes.map(node => (
                    <div
                      key={node.nodeNum}
                      className={`node-item ${selectedDMNode === node.user?.id ? 'selected' : ''}`}
                      onClick={() => {
                        setSelectedDMNode(node.user?.id || '');
                        setReplyingTo(null);
                      }}
                    >
                      <div className="node-header">
                        <div className="node-name">
                          {node.isFavorite && <span className="favorite-indicator">⭐</span>}
                          <div className="node-name-text">
                            <div className="node-longname">{node.user?.longName || t('messages.node_fallback', { nodeNum: node.nodeNum })}</div>
                          </div>
                        </div>
                        <div className="node-actions">
                          {node.position && node.position.latitude != null && node.position.longitude != null && (
                            <span className="node-indicator-icon" title={t('nodes.location')}>📍</span>
                          )}
                          {node.viaMqtt && (
                            <span className="node-indicator-icon" title={t('nodes.via_mqtt')}>🌐</span>
                          )}
                          {node.user?.id && nodesWithTelemetry.has(node.user.id) && (
                            <span className="node-indicator-icon" title={t('nodes.has_telemetry')}>📊</span>
                          )}
                          {node.user?.id && nodesWithWeatherTelemetry.has(node.user.id) && (
                            <span className="node-indicator-icon" title={t('nodes.has_weather')}>☀️</span>
                          )}
                          {node.user?.id && nodesWithPKC.has(node.user.id) && (
                            <span className="node-indicator-icon" title={t('nodes.has_pkc')}>🔐</span>
                          )}
                          {(node.keyIsLowEntropy || node.duplicateKeyDetected || node.keySecurityIssueDetails) && (
                            <span
                              className="security-warning-icon"
                              title={node.keySecurityIssueDetails || t('messages.key_security_issue')}
                              style={{
                                fontSize: '16px',
                                color: '#f44336',
                                marginLeft: '4px',
                                cursor: 'help',
                              }}
                            >
                              {node.keyMismatchDetected ? '🔓' : '⚠️'}
                            </span>
                          )}
                          <div
                            className={`node-short ${stickyNodes.has(node.nodeNum) ? 'sticky' : ''}`}
                            onClick={(e) => toggleStickyNode(node.nodeNum, e)}
                            title={stickyNodes.has(node.nodeNum) ? t('messages.unpin_node') : t('messages.pin_node')}
                            style={{ cursor: 'pointer' }}
                          >
                            {stickyNodes.has(node.nodeNum) && <span className="pin-indicator">📌</span>}
                            {node.user?.shortName || '-'}
                          </div>
                        </div>
                      </div>

                      <div className="node-details" style={{ width: '100%' }}>
                        <div
                          style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                            gap: '0.5rem',
                            width: '100%',
                          }}
                        >
                          <div
                            className="last-message-preview"
                            style={{
                              fontSize: '0.85rem',
                              color: 'var(--ctp-subtext0)',
                              fontStyle: 'italic',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                              flex: '1',
                              minWidth: 0,
                            }}
                          >
                            {node.lastMessageText || t('messages.no_messages_preview')}
                          </div>

                          <div
                            style={{
                              display: 'flex',
                              gap: '0.5rem',
                              alignItems: 'center',
                              flexShrink: 0,
                              fontSize: '0.85rem',
                            }}
                          >
                            <span className="stat" title={t('messages.total_messages_title')}>
                              💬 {node.messageCount}
                            </span>
                            {node.lastMessageTime > 0 && (
                              <span
                                className="stat"
                                title={formatDateTime(new Date(node.lastMessageTime), timeFormat, dateFormat)}
                                style={
                                  node.unreadCount > 0
                                    ? {
                                        border: '2px solid var(--ctp-red)',
                                        borderRadius: '12px',
                                        padding: '2px 6px',
                                        backgroundColor: 'var(--ctp-surface0)',
                                      }
                                    : undefined
                                }
                              >
                                🕒 {formatRelativeTime(node.lastMessageTime)}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>

                      <div className="node-stats">
                        {node.hopsAway === 0 && node.snr != null && (
                          <span className="stat" title={t('nodes.snr')}>
                            📶 {node.snr.toFixed(1)}dB
                          </span>
                        )}
                        {node.hopsAway === 0 && node.rssi != null && (
                          <span className="stat" title={t('nodes.rssi')}>
                            📡 {node.rssi}dBm
                          </span>
                        )}
                        {(node.hopsAway != null || node.lastMessageHops != null) && (() => {
                          const effectiveHops = getEffectiveHops(node, nodeHopsCalculation, traceroutes, currentNodeNum);
                          return effectiveHops < 999 ? (
                            <span className="stat" title={t('nodes.hops_away')}>
                              🔗 {effectiveHops} {t('nodes.hop', { count: effectiveHops })}
                            </span>
                          ) : null;
                        })()}
                        <DistanceDisplay
                          homeNode={homeNode}
                          targetNode={node}
                          distanceUnit={distanceUnit}
                          t={t}
                        />
                      </div>

                    </div>
                  ))}
                </>
              ) : (
                <div className="no-data">{t('messages.no_nodes')}</div>
              )
            ) : (
              <div className="no-data">{t('messages.connect_to_view')}</div>
            )}
          </div>
        )}
      </div>

      {/* Right Panel - Conversation View */}
      <div className="nodes-main-content">
        {/* Mobile Node Dropdown */}
        <div className="node-dropdown-mobile">
          <select
            className="node-dropdown-select"
            value={selectedDMNode || ''}
            onChange={e => {
              setSelectedDMNode(e.target.value);
              setReplyingTo(null);
            }}
          >
            <option value="">{t('messages.select_conversation')}</option>
            {sortedNodesWithMessages
              .filter(node => {
                if (!showIncompleteNodes && !isNodeComplete(node)) return false;
                if (!messagesNodeFilter) return true;
                const searchTerm = messagesNodeFilter.toLowerCase();
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
                const battery =
                  node.deviceMetrics?.batteryLevel !== undefined && node.deviceMetrics.batteryLevel !== null
                    ? node.deviceMetrics.batteryLevel === 101
                      ? ' 🔌'
                      : ` ${node.deviceMetrics.batteryLevel}%`
                    : '';
                const unread = node.unreadCount > 0 ? ` (${node.unreadCount})` : '';

                return (
                  <option key={node.user?.id || node.nodeNum} value={node.user?.id || ''}>
                    {node.isFavorite ? '⭐ ' : ''}
                    {displayName} ({shortName}){snr}
                    {battery}
                    {unread}
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
                  {t('messages.conversation_with', { name: getNodeName(selectedDMNode) })}
                  {selectedNode?.lastHeard && (
                    <div style={{ fontSize: '0.75em', fontWeight: 'normal', color: '#888', marginTop: '4px' }}>
                      {t('messages.last_seen', { time: formatDateTime(new Date(selectedNode.lastHeard * 1000), timeFormat, dateFormat) })}
                    </div>
                  )}
                </h3>
                {/* Actions Dropdown Menu */}
                <div className="node-actions-container">
                  <button
                    onClick={() => setShowActionsMenu(!showActionsMenu)}
                    className="btn btn-secondary actions-menu-btn"
                    title={t('messages.actions_menu_title')}
                    style={{ padding: '0.5rem 1rem', fontSize: '0.9rem', whiteSpace: 'nowrap' }}
                  >
                    {t('messages.actions_menu')} ▼
                  </button>

                  {showActionsMenu && (
                    <>
                      <div className="actions-menu-overlay" onClick={() => setShowActionsMenu(false)} />
                      <div className="actions-menu-dropdown">
                        {/* Traceroute Actions */}
                        {hasPermission('traceroute', 'write') && (
                          <>
                            <button
                              className="actions-menu-item"
                              onClick={() => {
                                handleTraceroute(selectedDMNode);
                                setShowActionsMenu(false);
                              }}
                              disabled={connectionStatus !== 'connected' || tracerouteLoading === selectedDMNode}
                            >
                              🗺️ {t('messages.traceroute_button')}
                              {tracerouteLoading === selectedDMNode && <span className="spinner"></span>}
                            </button>
                            <button
                              className="actions-menu-item"
                              onClick={() => {
                                setShowTracerouteHistoryModal(true);
                                setShowActionsMenu(false);
                              }}
                            >
                              📜 {t('messages.history_button')}
                            </button>
                          </>
                        )}

                        {/* Exchange Actions */}
                        {hasPermission('messages', 'write') && (
                          <>
                            <button
                              className="actions-menu-item"
                              onClick={() => {
                                handleExchangePosition(selectedDMNode);
                                setShowActionsMenu(false);
                              }}
                              disabled={connectionStatus !== 'connected' || positionLoading === selectedDMNode}
                            >
                              📍 {t('messages.exchange_position')}
                              {positionLoading === selectedDMNode && <span className="spinner"></span>}
                            </button>
                            <button
                              className="actions-menu-item"
                              onClick={() => {
                                handleExchangeNodeInfo(selectedDMNode);
                                setShowActionsMenu(false);
                              }}
                              disabled={connectionStatus !== 'connected' || nodeInfoLoading === selectedDMNode}
                            >
                              🔑 {t('messages.exchange_user_info')}
                              {nodeInfoLoading === selectedDMNode && <span className="spinner"></span>}
                            </button>
                            <button
                              className="actions-menu-item"
                              onClick={() => {
                                setShowTelemetryRequestModal(true);
                                setShowActionsMenu(false);
                              }}
                              disabled={connectionStatus !== 'connected' || telemetryRequestLoading === selectedDMNode}
                            >
                              📊 {t('messages.request_telemetry')}
                              {telemetryRequestLoading === selectedDMNode && <span className="spinner"></span>}
                            </button>
                          </>
                        )}

                        {/* Admin Scan */}
                        {hasPermission('settings', 'write') && (
                          <button
                            className="actions-menu-item"
                            onClick={() => {
                              handleScanForAdmin(selectedDMNode);
                              setShowActionsMenu(false);
                            }}
                            disabled={connectionStatus !== 'connected' || adminScanLoading === selectedDMNode}
                          >
                            🔍 {t('messages.scan_for_admin')}
                            {adminScanLoading === selectedDMNode && <span className="spinner"></span>}
                          </button>
                        )}

                        {/* Node Management */}
                        {hasPermission('messages', 'write') && selectedNode && (
                          <>
                            <div className="actions-menu-divider" />
                            <button
                              className="actions-menu-item"
                              onClick={(e) => {
                                toggleFavorite(selectedNode, e);
                                setShowActionsMenu(false);
                              }}
                            >
                              {selectedNode.isFavorite ? `⭐ ${t('nodes.remove_favorite')}` : `☆ ${t('nodes.add_favorite')}`}
                            </button>
                            <button
                              className="actions-menu-item"
                              onClick={(e) => {
                                toggleIgnored(selectedNode, e);
                                setShowActionsMenu(false);
                              }}
                            >
                              {selectedNode.isIgnored ? `👁️ ${t('messages.unignore_node')}` : `🚫 ${t('messages.ignore_node')}`}
                            </button>
                          </>
                        )}

                        {/* Map & Position */}
                        {(selectedNode?.position?.latitude != null || hasPermission('nodes', 'write')) && (
                          <div className="actions-menu-divider" />
                        )}
                        {selectedNode?.position?.latitude != null && selectedNode?.position?.longitude != null && (
                          <button
                            className="actions-menu-item"
                            onClick={() => {
                              handleShowOnMap(selectedDMNode);
                              setShowActionsMenu(false);
                            }}
                          >
                            🗺️ {t('messages.show_on_map')}
                          </button>
                        )}
                        {hasPermission('nodes', 'write') && (
                          <button
                            className="actions-menu-item"
                            onClick={() => {
                              setShowPositionOverrideModal(true);
                              setShowActionsMenu(false);
                            }}
                          >
                            📍 {t('messages.override_position')}
                          </button>
                        )}

                        {/* Danger Zone */}
                        {hasPermission('messages', 'write') && (
                          <>
                            <div className="actions-menu-divider" />
                            <button
                              className="actions-menu-item actions-menu-item-danger"
                              onClick={() => {
                                setShowPurgeDataModal(true);
                                setShowActionsMenu(false);
                              }}
                            >
                              🗑️ {t('messages.purge_data')}
                            </button>
                          </>
                        )}
                      </div>
                    </>
                  )}
                </div>
              </div>
            </div>

            {/* Security Warning Bar */}
            {selectedNode && (selectedNode.keyIsLowEntropy || selectedNode.duplicateKeyDetected || selectedNode.keySecurityIssueDetails) && (
              <div
                style={{
                  backgroundColor: '#f44336',
                  color: 'white',
                  padding: '12px',
                  marginBottom: '10px',
                  borderRadius: '4px',
                  fontWeight: 'bold',
                  textAlign: 'center',
                }}
              >
                {selectedNode.keyMismatchDetected ? '🔓' : '⚠️'} {selectedNode.keyMismatchDetected ? t('messages.key_mismatch') : t('messages.security_risk')}
              </div>
            )}

            {/* Messages Container */}
            <div className="messages-container" ref={dmMessagesContainerRef}>
              {selectedDMMessages.length > 0 ? (
                selectedDMMessages.map((msg, index) => {
                  const isTraceroute = msg.portnum === 70;
                  const isMine = isMyMessage(msg);
                  const isReaction = msg.emoji === 1 || (msg.replyId != null && isEmoji(msg.text));

                  if (isReaction) return null;

                  const reactions = selectedDMMessages.filter(
                    m => (m.emoji === 1 || isEmoji(m.text)) && m.replyId && m.replyId.toString() === msg.id.split('_')[1]
                  );

                  const repliedMessage = msg.replyId
                    ? selectedDMMessages.find(m => m.id.split('_')[1] === msg.replyId?.toString())
                    : null;

                  const currentDate = new Date(msg.timestamp);
                  const prevMsg = index > 0 ? selectedDMMessages[index - 1] : null;
                  const prevDate = prevMsg ? new Date(prevMsg.timestamp) : null;
                  const showSeparator = shouldShowDateSeparator(prevDate, currentDate);

                  if (isTraceroute) {
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
                              <HopCountDisplay
                                hopStart={msg.hopStart}
                                hopLimit={msg.hopLimit}
                                rxSnr={msg.rxSnr}
                                rxRssi={msg.rxRssi}
                                relayNode={msg.relayNode}
                                viaMqtt={msg.viaMqtt}
                                onClick={() => handleRelayClick(msg)}
                              />
                            </span>
                            <span className="traceroute-badge">{t('messages.traceroute_badge')}</span>
                          </div>
                          <div className="message-text" style={{ whiteSpace: 'pre-line', fontFamily: 'monospace' }}>
                            {renderMessageWithLinks(msg.text)}
                          </div>
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
                      <div 
                        className={`message-bubble-container ${isMine ? 'mine' : 'theirs'}`}
                        data-message-id={msg.id}
                      >
                        {!isMine && (
                          <div
                            className={`sender-dot clickable ${isEmoji(getNodeShortName(msg.from)) ? 'is-emoji' : ''}`}
                            title={`Click for ${getNodeName(msg.from)} details`}
                            onClick={e => handleSenderClick(msg.from, e)}
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
                                    <div className="reply-text">{repliedMessage.text || t('messages.empty_message')}</div>
                                  </>
                                ) : (
                                  <div className="reply-text" style={{ fontStyle: 'italic', opacity: 0.6 }}>
                                    {t('messages.message_unavailable')}
                                  </div>
                                )}
                              </div>
                            </div>
                          )}
                          {hasPermission('messages', 'write') && (
                            <div className="message-actions">
                              {isMine ? (
                                <button
                                  className="resend-button"
                                  onClick={() => handleResendMessage(msg)}
                                  title={t('messages.resend_button_title')}
                                >
                                  ↻
                                </button>
                              ) : (
                                <button
                                  className="reply-button"
                                  onClick={() => {
                                    setReplyingTo(msg);
                                    dmMessageInputRef.current?.focus();
                                  }}
                                  title={t('messages.reply_button_title')}
                                >
                                  ↩
                                </button>
                              )}
                              <button
                                className="emoji-picker-button"
                                onClick={() => setEmojiPickerMessage(msg)}
                                title={t('messages.emoji_button_title')}
                              >
                                😄
                              </button>
                              <button
                                className="delete-button"
                                onClick={() => handleDeleteMessage(msg)}
                                title={t('messages.delete_button_title')}
                              >
                                🗑️
                              </button>
                            </div>
                          )}
                          <div className={`message-bubble ${isMine ? 'mine' : 'theirs'}`}>
                            <div className="message-text-row">
                              <div className="message-text" style={{ whiteSpace: 'pre-line' }}>
                                {renderMessageWithLinks(msg.text)}
                              </div>
                              <div className="message-meta">
                                <span className="message-time">
                                  {formatMessageTime(currentDate, timeFormat, dateFormat)}
                                  <HopCountDisplay
                                    hopStart={msg.hopStart}
                                    hopLimit={msg.hopLimit}
                                    rxSnr={msg.rxSnr}
                                    rxRssi={msg.rxRssi}
                                    relayNode={msg.relayNode}
                                    viaMqtt={msg.viaMqtt}
                                    onClick={() => handleRelayClick(msg)}
                                  />
                                </span>
                              </div>
                            </div>
                            <LinkPreview text={msg.text} />
                            {reactions.length > 0 && (
                              <div className="message-reactions">
                                {reactions.map(reaction => (
                                  <span
                                    key={reaction.id}
                                    className="reaction"
                                    title={t('messages.reaction_tooltip', { name: getNodeShortName(reaction.from) })}
                                    onClick={() => handleSendTapback(reaction.text, msg)}
                                  >
                                    {reaction.text}
                                  </span>
                                ))}
                              </div>
                            )}
                          </div>
                        </div>
                        {isMine && <div className="message-status"><MessageStatusIndicator message={msg} /></div>}
                      </div>
                    </React.Fragment>
                  );
                })
              ) : (
                <p className="no-messages">{t('messages.no_dm_yet')}</p>
              )}
            </div>

            {/* Resize Handle - Desktop only */}
            {!isMobileLayout && (
              <div
                className={`dm-resize-handle ${isSendSectionResizing ? 'resizing' : ''}`}
                onMouseDown={handleSendSectionResizeStart}
                title={t('messages.resize_handle_title')}
                role="separator"
                aria-orientation="horizontal"
                aria-label={t('messages.resize_handle_title')}
              />
            )}

            {/* Send Section Container - wraps send form and info below */}
            <div
              className={`dm-send-section ${isSendSectionResizing ? 'resizing' : ''}`}
              style={!isMobileLayout ? { height: `${sendSectionHeight}px` } : undefined}
            >
              {/* Send DM form */}
              {connectionStatus === 'connected' && (
                <div className="send-message-form">
                {replyingTo && (
                  <div className="reply-indicator">
                    <div className="reply-indicator-content">
                      <div className="reply-indicator-label">{t('messages.replying_to', { name: getNodeName(replyingTo.from) })}</div>
                      <div className="reply-indicator-text">{replyingTo.text}</div>
                    </div>
                    <button className="reply-indicator-close" onClick={() => setReplyingTo(null)} title={t('messages.cancel_reply_title')}>
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
                        onChange={e => setNewMessage(e.target.value)}
                        placeholder={t('messages.dm_placeholder', { name: getNodeName(selectedDMNode) })}
                        className="message-input"
                        onKeyPress={e => {
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

            {/* Traceroute Display */}
              {hasPermission('traceroute', 'write') &&
                (() => {
                  const recentTrace = getRecentTraceroute(selectedDMNode);
                  if (recentTrace) {
                    const age = Math.floor((Date.now() - recentTrace.timestamp) / (1000 * 60));
                    const ageStr = age < 60 ? `${age}m ago` : `${Math.floor(age / 60)}h ago`;

                    // Check if traceroute failed (both directions have no valid data)
                    const forwardFailed = !recentTrace.route || recentTrace.route === 'null';
                    const returnFailed = !recentTrace.routeBack || recentTrace.routeBack === 'null';
                    const noData = forwardFailed && returnFailed;
                    const isPending = noData && age < 1; // Less than 1 minute old
                    const isFailed = noData && !isPending;

                    return (
                      <div className="traceroute-info" style={{ marginTop: '1rem' }}>
                        <div className="traceroute-route">
                          <strong>{t('messages.traceroute_forward')}</strong>{' '}
                          {formatTracerouteRoute(
                            recentTrace.route,
                            recentTrace.snrTowards,
                            recentTrace.fromNodeNum,
                            recentTrace.toNodeNum,
                            nodes,
                            distanceUnit
                          )}
                        </div>
                        <div className="traceroute-route">
                          <strong>{t('messages.traceroute_return')}</strong>{' '}
                          {formatTracerouteRoute(
                            recentTrace.routeBack,
                            recentTrace.snrBack,
                            recentTrace.toNodeNum,
                            recentTrace.fromNodeNum,
                            nodes,
                            distanceUnit
                          )}
                        </div>
                        <div className="traceroute-age">
                          {t('messages.last_traced', { time: ageStr })}
                          {isPending && (
                            <span className="traceroute-pending-badge" style={{
                              marginLeft: '0.5rem',
                              color: 'var(--ctp-yellow)',
                              fontWeight: 'bold'
                            }}>
                              ({t('messages.traceroute_pending', 'Pending')})
                            </span>
                          )}
                          {isFailed && (
                            <span className="traceroute-failed-badge" style={{
                              marginLeft: '0.5rem',
                              color: 'var(--ctp-red)',
                              fontWeight: 'bold'
                            }}>
                              ({t('messages.traceroute_failed')})
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  }
                  return null;
                })()}

            {/* Neighbor Info Display */}
            {(() => {
              if (!selectedDMNode || !neighborInfo) return null;
              const nodeNumStr = selectedDMNode.replace('!', '');
              const nodeNum = parseInt(nodeNumStr, 16);
              const nodeNeighbors = neighborInfo.filter(ni => ni.nodeNum === nodeNum);
              if (nodeNeighbors.length === 0) return null;

              // Get most recent timestamp
              const mostRecent = Math.max(...nodeNeighbors.map(n => n.timestamp));
              const age = Math.floor((Date.now() - mostRecent) / (1000 * 60));
              const ageStr = age < 60 ? `${age}m ago` : `${Math.floor(age / 60)}h ago`;

              const handlePurgeNeighbors = async () => {
                if (!selectedDMNode || purgingNeighbors) return;

                // Confirm before purging
                const confirmed = window.confirm(t('messages.confirm_purge_neighbors', 'Are you sure you want to delete all neighbor info for this node?'));
                if (!confirmed) return;

                setPurgingNeighbors(true);
                try {
                  await apiService.purgeNeighborInfo(selectedDMNode);
                  // Immediately update UI by filtering out purged neighbors
                  setNeighborInfo(neighborInfo.filter(n => n.nodeNum !== nodeNum));
                  showToast(t('messages.neighbor_info_purged', 'Neighbor info purged successfully'), 'success');
                } catch (error) {
                  console.error('Failed to purge neighbor info:', error);
                  showToast(t('messages.neighbor_info_purge_failed', 'Failed to purge neighbor info'), 'error');
                } finally {
                  setPurgingNeighbors(false);
                }
              };

              return (
                <div className="neighbor-info-section" style={{ marginTop: '1rem' }}>
                  <div className="neighbor-info-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <strong>{t('messages.neighbor_info_title', 'Neighbor Info')}</strong>
                      <span className="neighbor-info-age" style={{ marginLeft: '0.5rem', fontSize: '0.85em', color: 'var(--ctp-subtext0)' }}>
                        ({ageStr})
                      </span>
                    </div>
                    <button
                      onClick={handlePurgeNeighbors}
                      className="purge-neighbors-btn"
                      disabled={purgingNeighbors}
                      style={{
                        padding: '0.25rem 0.5rem',
                        fontSize: '0.8em',
                        backgroundColor: 'var(--ctp-surface0)',
                        color: 'var(--ctp-text)',
                        border: '1px solid var(--ctp-surface1)',
                        borderRadius: '4px',
                        cursor: purgingNeighbors ? 'not-allowed' : 'pointer',
                        opacity: purgingNeighbors ? 0.6 : 1,
                      }}
                      title={t('messages.purge_neighbors_tooltip', 'Delete neighbor info for this node')}
                    >
                      {purgingNeighbors ? <span className="spinner"></span> : t('messages.purge_neighbors', 'Purge')}
                    </button>
                  </div>
                  <div className="neighbor-info-list" style={{ marginTop: '0.5rem' }}>
                    {nodeNeighbors.map((neighbor, idx) => {
                      // Calculate distance if both positions available
                      let distanceStr = '';
                      if (neighbor.nodeLatitude != null && neighbor.nodeLongitude != null &&
                          neighbor.neighborLatitude != null && neighbor.neighborLongitude != null) {
                        const distKm = calculateDistance(
                          neighbor.nodeLatitude, neighbor.nodeLongitude,
                          neighbor.neighborLatitude, neighbor.neighborLongitude
                        );
                        distanceStr = formatDistance(distKm, distanceUnit);
                      }

                      return (
                        <div key={idx} className="neighbor-info-item" style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          padding: '0.25rem 0',
                          borderBottom: idx < nodeNeighbors.length - 1 ? '1px solid var(--ctp-surface0)' : 'none'
                        }}>
                          <span>{neighbor.neighborName || neighbor.neighborNodeId || `!${neighbor.neighborNodeNum.toString(16)}`}</span>
                          <span style={{ color: 'var(--ctp-subtext0)' }}>
                            {neighbor.snr != null && `SNR: ${neighbor.snr.toFixed(1)} dB`}
                            {distanceStr && ` | ${distanceStr}`}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })()}

            {/* Quick Action Buttons */}
            <div className="dm-action-buttons" style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: '0.5rem',
              marginTop: '1rem',
              marginBottom: '1rem'
            }}>
              {/* Show on Map */}
              {selectedNode?.position?.latitude != null && selectedNode?.position?.longitude != null && (
                <button
                  onClick={() => handleShowOnMap(selectedDMNode)}
                  style={{
                    flex: '1 1 auto',
                    minWidth: '120px',
                    padding: '0.5rem 1rem',
                    backgroundColor: 'var(--ctp-blue)',
                    color: 'var(--ctp-base)',
                    border: 'none',
                    borderRadius: '4px',
                    cursor: 'pointer',
                    fontSize: '0.9rem'
                  }}
                >
                  🗺️ {t('messages.show_on_map')}
                </button>
              )}

              {/* Traceroute */}
              {hasPermission('traceroute', 'write') && (
                <button
                  onClick={() => handleTraceroute(selectedDMNode)}
                  disabled={connectionStatus !== 'connected' || tracerouteLoading === selectedDMNode}
                  style={{
                    flex: '1 1 auto',
                    minWidth: '120px',
                    padding: '0.5rem 1rem',
                    backgroundColor: 'var(--ctp-blue)',
                    color: 'var(--ctp-base)',
                    border: 'none',
                    borderRadius: '4px',
                    cursor: connectionStatus !== 'connected' || tracerouteLoading === selectedDMNode ? 'not-allowed' : 'pointer',
                    opacity: connectionStatus !== 'connected' || tracerouteLoading === selectedDMNode ? 0.5 : 1,
                    fontSize: '0.9rem'
                  }}
                >
                  {tracerouteLoading === selectedDMNode ? <span className="spinner"></span> : '📡'} {t('messages.traceroute_button')}
                </button>
              )}

              {/* Exchange Node Info */}
              {hasPermission('messages', 'write') && (
                <button
                  onClick={() => handleExchangeNodeInfo(selectedDMNode)}
                  disabled={connectionStatus !== 'connected' || nodeInfoLoading === selectedDMNode}
                  style={{
                    flex: '1 1 auto',
                    minWidth: '120px',
                    padding: '0.5rem 1rem',
                    backgroundColor: 'var(--ctp-blue)',
                    color: 'var(--ctp-base)',
                    border: 'none',
                    borderRadius: '4px',
                    cursor: connectionStatus !== 'connected' || nodeInfoLoading === selectedDMNode ? 'not-allowed' : 'pointer',
                    opacity: connectionStatus !== 'connected' || nodeInfoLoading === selectedDMNode ? 0.5 : 1,
                    fontSize: '0.9rem'
                  }}
                >
                  {nodeInfoLoading === selectedDMNode ? <span className="spinner"></span> : '🔑'} {t('messages.exchange_user_info')}
                </button>
              )}

              {/* Exchange Position */}
              {hasPermission('messages', 'write') && (
                <button
                  onClick={() => handleExchangePosition(selectedDMNode)}
                  disabled={connectionStatus !== 'connected' || positionLoading === selectedDMNode}
                  style={{
                    flex: '1 1 auto',
                    minWidth: '120px',
                    padding: '0.5rem 1rem',
                    backgroundColor: 'var(--ctp-blue)',
                    color: 'var(--ctp-base)',
                    border: 'none',
                    borderRadius: '4px',
                    cursor: connectionStatus !== 'connected' || positionLoading === selectedDMNode ? 'not-allowed' : 'pointer',
                    opacity: connectionStatus !== 'connected' || positionLoading === selectedDMNode ? 0.5 : 1,
                    fontSize: '0.9rem'
                  }}
                >
                  {positionLoading === selectedDMNode ? <span className="spinner"></span> : '📍'} {t('messages.exchange_position')}
                </button>
              )}

              {/* Request Neighbor Info */}
              {hasPermission('traceroute', 'write') && (
                <button
                  onClick={() => handleRequestNeighborInfo(selectedDMNode)}
                  disabled={connectionStatus !== 'connected' || neighborInfoLoading === selectedDMNode}
                  style={{
                    flex: '1 1 auto',
                    minWidth: '120px',
                    padding: '0.5rem 1rem',
                    backgroundColor: 'var(--ctp-blue)',
                    color: 'var(--ctp-base)',
                    border: 'none',
                    borderRadius: '4px',
                    cursor: connectionStatus !== 'connected' || neighborInfoLoading === selectedDMNode ? 'not-allowed' : 'pointer',
                    opacity: connectionStatus !== 'connected' || neighborInfoLoading === selectedDMNode ? 0.5 : 1,
                    fontSize: '0.9rem'
                  }}
                >
                  {neighborInfoLoading === selectedDMNode ? <span className="spinner"></span> : '🏠'} {t('messages.request_neighbor_info')}
                </button>
              )}
            </div>

            {selectedNode && <NodeDetailsBlock node={selectedNode} timeFormat={timeFormat} dateFormat={dateFormat} />}

            {/* Security Details Section */}
            {selectedNode &&
              (selectedNode.keyIsLowEntropy || selectedNode.duplicateKeyDetected || selectedNode.keySecurityIssueDetails) && (
                <div className="node-details-block" style={{ marginTop: '1rem' }}>
                  <h3 className="node-details-title" style={{ color: '#f44336' }}>
                    ⚠️ {t('messages.security_issue_title')}
                  </h3>
                  <div className="node-details-grid">
                    <div className="node-detail-card" style={{ gridColumn: '1 / -1', borderLeft: '4px solid #f44336' }}>
                      <div className="node-detail-label">{t('messages.issue_details')}</div>
                      <div className="node-detail-value" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                        {selectedNode.keyIsLowEntropy && t('messages.low_entropy_warning')}
                        {selectedNode.duplicateKeyDetected &&
                          (() => {
                            const match = selectedNode.keySecurityIssueDetails?.match(/nodes?: ([\d, ]+)/);
                            const sharedNodeNums = match ? match[1].split(',').map(s => parseInt(s.trim(), 10)) : [];
                            if (sharedNodeNums.length === 0) return null;

                            return (
                              <>
                                {t('messages.shared_key_with')}
                                {sharedNodeNums.map((nodeNum, idx) => {
                                  const sharedNode = nodes.find(n => n.nodeNum === nodeNum);
                                  const displayName = sharedNode?.user?.longName || t('messages.node_fallback', { nodeNum });
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
                                          font: 'inherit',
                                        }}
                                        title={t('messages.switch_to_title', { name: displayName })}
                                      >
                                        {displayName} ({shortName})
                                      </button>
                                    </span>
                                  );
                                })}
                              </>
                            );
                          })()}
                        {selectedNode.keyMismatchDetected && (
                          <div style={{ marginTop: selectedNode.keyIsLowEntropy || selectedNode.duplicateKeyDetected ? '8px' : 0 }}>
                            {selectedNode.keySecurityIssueDetails}
                          </div>
                        )}
                        {/* Fallback: show raw details if no specific flag is set but details exist */}
                        {!selectedNode.keyIsLowEntropy && !selectedNode.duplicateKeyDetected && !selectedNode.keyMismatchDetected && selectedNode.keySecurityIssueDetails && (
                          <div>{selectedNode.keySecurityIssueDetails}</div>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              )}

              <TelemetryGraphs
                nodeId={selectedDMNode}
                temperatureUnit={temperatureUnit}
                telemetryHours={telemetryVisualizationHours}
                baseUrl={baseUrl}
              />
              <SmartHopsGraphs
                nodeId={selectedDMNode}
                telemetryHours={telemetryVisualizationHours}
                baseUrl={baseUrl}
              />
              <LinkQualityGraph
                nodeId={selectedDMNode}
                telemetryHours={telemetryVisualizationHours}
                baseUrl={baseUrl}
              />
              {nodePacketDistribution?.enabled && nodePacketTypeData.length > 0 && (
                <PacketStatsChart
                  title={t('messages.packet_type_distribution')}
                  data={nodePacketTypeData}
                  total={nodePacketDistribution.total}
                  chartId="node-packet-type"
                />
              )}
            </div>
            {/* End of dm-send-section */}
          </div>
        ) : (
          <div className="no-selection">
            <p>{t('messages.select_from_list')}</p>
          </div>
        )}
      </div>

      {/* Relay node modal */}
      {relayModalOpen && selectedRelayNode !== null && (
        <RelayNodeModal
          isOpen={relayModalOpen}
          onClose={() => {
            setRelayModalOpen(false);
            setSelectedRelayNode(null);
          }}
          relayNode={selectedRelayNode}
          rxTime={selectedRxTime}
          nodes={mappedNodes}
          messageRssi={selectedMessageRssi}
          onNodeClick={(nodeId) => {
            setRelayModalOpen(false);
            setSelectedRelayNode(null);
            handleSenderClick(nodeId, { stopPropagation: () => {} } as React.MouseEvent);
          }}
        />
      )}

      {/* Telemetry request modal */}
      {showTelemetryRequestModal && selectedDMNode && (
        <TelemetryRequestModal
          isOpen={showTelemetryRequestModal}
          onClose={() => setShowTelemetryRequestModal(false)}
          onRequest={(telemetryType: TelemetryType) => {
            handleRequestTelemetry(selectedDMNode, telemetryType);
            setShowTelemetryRequestModal(false);
          }}
          loading={telemetryRequestLoading === selectedDMNode}
          nodeName={selectedNode?.user?.longName || selectedNode?.user?.shortName || selectedDMNode}
        />
      )}
    </div>
  );
};

export default MessagesTab;
