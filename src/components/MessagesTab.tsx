/**
 * MessagesTab - Direct Messages conversation view
 *
 * Extracted from App.tsx to improve maintainability.
 * Handles the Messages/DM tab with node list and conversation view.
 */

import React, { useRef, useCallback, useState, useMemo, useEffect } from 'react';
import '../styles/messages.css';
import { useResizable } from '../hooks/useResizable';
import { useAutoResizeTextarea } from '../hooks/useAutoResizeTextarea';
import { useTranslation, Trans } from 'react-i18next';
import { DeviceInfo, Channel } from '../types/device';
import { MeshMessage } from '../types/message';
import { ResourceType } from '../types/permission';
import { TimeFormat, DateFormat, useNotificationMuteSettings } from '../contexts/SettingsContext';
import {
  formatDateTime,
  formatRelativeTime,
  formatMessageTime,
  getMessageDateSeparator,
  shouldShowDateSeparator,
} from '../utils/datetime';
import { buildTracerouteStripGraph, type TracerouteStripInput } from '../utils/tracerouteStrip';
import { buildStripNodeMeta } from '../utils/tracerouteStripMeta';
import { buildStatisticalStrip, type UnionStripGraph } from '../utils/tracerouteUnionLayout';
import { TracerouteStrip, type TracerouteStripNodeMeta } from './traceroute/TracerouteStrip';
import { TracerouteCopyLinks } from './traceroute/TracerouteCopyLinks';
import { TracerouteParticipationPicker } from './traceroute/TracerouteParticipationPicker';
import { useNodeTraceroutes } from '../hooks/useNodeTraceroutes';
import { useTraceroutePairHistory } from '../hooks/useTraceroutePairHistory';
import { getMessageSortTime } from '../utils/messageSort';
import KeyMismatchWarning from './security/KeyMismatchWarning';
import { getUtf8ByteLength, formatByteCount, isEmoji } from '../utils/text';
import { isDeviceDbWarningMitigatable } from '../utils/deviceDbWarning';
import { applyHomoglyphOptimization } from '../utils/homoglyph';
import { calculateDistance, formatDistance, getDistanceToNode } from '../utils/distance';
import { renderMessageWithLinks } from '../utils/linkRenderer';
import { getMessageContentMatchNodeIds } from '../utils/messageContentFilter';
import { isNodeComplete, isInfrastructureNode, hasValidPosition, parseNodeId, formatSenderLabel } from '../utils/nodeHelpers';
import { getEffectiveHops } from '../utils/nodeHops';
import { scrollInputIntoView } from '../utils/scrollInputIntoView';
import { useMapContext } from '../contexts/MapContext';
import { useSettings } from '../contexts/SettingsContext';
import { nodeColorStyle } from '../utils/nodeColor';
import { useDeviceNodes, useTelemetryNodes, setNodeFieldInCache } from '../hooks/useServerData';
import { useQueryClient } from '@tanstack/react-query';
import HopCountDisplay from './HopCountDisplay';
import LinkPreview from './LinkPreview';
import NodeDetailsBlock from './NodeDetailsBlock';
import TelemetryGraphs from './TelemetryGraphs';
import SmartHopsGraphs from './SmartHopsGraphs';
import LinkQualityGraph from './LinkQualityGraph';
import PacketStatsChart, { ChartDataEntry, DISTRIBUTION_COLORS } from './PacketStatsChart';
import { getPacketDistributionStats } from '../services/packetApi';
import { PacketDistributionStats } from '../types/packet';

import { MessageEmojiButton } from './MessageEmojiButton';
import { MessageStatusIndicator } from './MessageStatusIndicator';
import MessageDetailsModal from './diagnostics/MessageDetailsModal';
import type { MessageDirection } from '../utils/deliveryDiagnostics/types';
import TelemetryRequestModal, { TelemetryType } from './TelemetryRequestModal';
import { CopyNodeInfoModal } from './CopyNodeInfoModal';
import { useToast } from './ToastContainer';
import apiService, { type TracerouteParticipationEntry } from '../services/api';
import { useCsrfFetch } from '../hooks/useCsrfFetch';
import { useSource } from '../contexts/SourceContext';
import { computeMessagesReadOnlyState } from './messagesReadOnlyState';
import { UiIcon } from './icons';
import UnreadDivider from './messages/UnreadDivider';
import { resolveUnreadAnchorId, shouldSuppressDivider } from '../utils/unreadAnchor';
import { useUnreadDividerAnchors } from '../contexts/MessagingContext';

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

/**
 * The row the traceroute box actually renders (epic phase 2, WP2): either
 * the poll's `TracerouteData` (no `id`, non-null `route`/`routeBack`) or a
 * `TracerouteParticipationEntry` from the picker (has `id`, nullable
 * `route`/`routeBack`). Widens the local union rather than editing
 * `TracerouteData` itself. Structurally satisfies `TracerouteStripInput` —
 * no adapter needed to feed `buildTracerouteStripGraph`.
 */
type DisplayedTraceroute = TracerouteStripInput & { id?: number; timestamp: number };

/** What the traceroute box is showing: a specific stored row, the statistical
 *  aggregate, or nothing picked — in which case rule 1's newest-of-both applies.
 *  One discriminated value rather than two flags, so the two states cannot both
 *  be set (SR_PHASE2_SPEC.md D13). */
type TraceroutePick = { kind: 'entry'; id: number } | { kind: 'statistical' };

/** S2's build result: the union graph, its node metadata, and the tooltip
 *  denominator. `null` whenever no aggregate is available or worth showing
 *  (SR_PHASE2_SPEC.md D14 S2). */
type StatisticalTraceroute = {
  graph: UnionStripGraph;
  meta: Map<number, TracerouteStripNodeMeta>;
  totalRoutes: number;
} | null;

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
        color: 'var(--color-text-subtle)',
        marginLeft: '0.5rem',
      }}
    >
      <UiIcon name="ruler" size={14} /> {distance}
    </span>
  );
});

export interface MessagesTabProps {
  // Data
  processedNodes: DeviceInfo[];
  nodes: DeviceInfo[];
  messages: MeshMessage[];
  currentNodeId: string;

  // Connection state
  connectionStatus: string;

  /** TX disabled on this source (epic #4294 Phase 2) — disable send/request controls with a tooltip, keep reads working. */
  txDisabled?: boolean;
  /**
   * Pre-computed tooltip for disabled TX controls (#4547 Phase 2 WP5). App.tsx
   * picks the MeshCore receive-only wording or the Meshtastic LoRa-config
   * wording based on source type. Optional — falls back to
   * `(txDisabledTooltip ?? t('tx_disabled.control_tooltip'))` at each call site when omitted, so
   * existing callers/tests are unaffected.
   */
  txDisabledTooltip?: string;

  // Selected state
  selectedDMNode: string | null;
  /** Node whose compose box the node list asked us to focus (#4325), or null. */
  pendingComposeFocus?: string | null;
  /** Consume the focus request above. */
  clearComposeFocus?: () => void;
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
  channels: Channel[];
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
  hasPermission: (
    resource: ResourceType,
    action: 'read' | 'write',
    opts?: { sourceId?: string | null; anySource?: boolean }
  ) => boolean;

  // Handlers
  handleSendDirectMessage: (destinationNodeId: string) => Promise<void>;
  onSendBell?: (destination: string, text: string) => Promise<void>;
  handleResendMessage: (message: MeshMessage) => Promise<void>;
  handleTraceroute: (nodeId: string, channel?: number) => Promise<void>;
  handleExchangePosition: (nodeId: string, channel?: number) => Promise<void>;
  handleExchangeNodeInfo: (nodeId: string, channel?: number) => Promise<void>;
  handleRequestNeighborInfo: (nodeId: string) => Promise<void>;
  handleRequestTelemetry: (nodeId: string, telemetryType: 'device' | 'environment' | 'airQuality' | 'power') => Promise<void>;
  handleDeleteMessage: (message: MeshMessage) => Promise<void>;
  handleSenderClick: (nodeId: string, event: React.MouseEvent) => void;
  handleSendTapback: (emoji: string, message: MeshMessage) => void;
  getRecentTraceroute: (nodeId: string) => TracerouteData | null;
  toggleIgnored: (node: DeviceInfo, event: React.MouseEvent) => Promise<void>;
  toggleHideFromMap: (node: DeviceInfo, event: React.MouseEvent) => Promise<void>;
  toggleFavorite: (node: DeviceInfo, event: React.MouseEvent) => Promise<void>;
  toggleFavoriteLock: (node: DeviceInfo, event: React.MouseEvent) => Promise<void>;

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

  // Search focus
  focusMessageId?: string | null;
  onFocusMessageHandled?: () => void;

  /**
   * When true (MQTT Bridge dashboard), the DM message log and the send
   * composer are hidden. Only the per-node telemetry block is shown.
   */
  mqttReadOnly?: boolean;
}

const MessagesTab: React.FC<MessagesTabProps> = ({
  processedNodes,
  nodes,
  messages,
  currentNodeId,
  connectionStatus,
  txDisabled = false,
  txDisabledTooltip,
  selectedDMNode,
  setSelectedDMNode,
  pendingComposeFocus = null,
  clearComposeFocus,
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
  channels,
  channelFilter,
  showIncompleteNodes,
  showNodeFilterPopup: _showNodeFilterPopup,
  setShowNodeFilterPopup: _setShowNodeFilterPopup,
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
  onSendBell,
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
  toggleHideFromMap,
  toggleFavorite,
  toggleFavoriteLock,
  setShowTracerouteHistoryModal,
  setShowPurgeDataModal,
  setShowPositionOverrideModal,
  setEmojiPickerMessage,
  shouldShowData,
  handleShowOnMap,
  dmMessagesContainerRef,
  focusMessageId,
  onFocusMessageHandled,
  mqttReadOnly = false,
}) => {
  const { t } = useTranslation();
  const { isDMMuted, muteDM, unmuteDM } = useNotificationMuteSettings();

  // Get settings and context for effective hops calculation
  const { nodeHopsCalculation, nodeListStyle } = useSettings();
  const { traceroutes, neighborInfo, setNeighborInfo } = useMapContext();
  const deviceNodeNums = useDeviceNodes();
  const currentNodeNum = currentNodeId ? parseNodeId(currentNodeId) : null;

  // Telemetry availability Sets — sourced directly from the poll cache
  // (#3962 5.4 PR2), replacing the props previously threaded from App's
  // DataContext-backed state.
  const {
    nodesWithTelemetry,
    nodesWithWeather: nodesWithWeatherTelemetry,
    nodesWithPKC,
  } = useTelemetryNodes();

  // Local state for actions menu
  const [showActionsMenu, setShowActionsMenu] = useState(false);
  const [showPositionChannelDropdown, setShowPositionChannelDropdown] = useState(false);
  const [showTracerouteChannelDropdown, setShowTracerouteChannelDropdown] = useState(false);
  const [showNodeInfoChannelDropdown, setShowNodeInfoChannelDropdown] = useState(false);

  // Relay node modal state
  // Unified Message Details popup (#4816 follow-up): one modal for both the
  // sent delivery-status icon and the hop/⏱ badge (sent or received).
  const [detailsState, setDetailsState] = useState<{ message: MeshMessage; direction: MessageDirection } | null>(null);
  const [directNeighborStats, setDirectNeighborStats] = useState<Record<number, { avgRssi: number; packetCount: number; lastHeard: number }>>({});
  const [homoglyphEnabled, setHomoglyphEnabled] = useState(false);

  // Copy NodeInfo modal state
  const [showCopyNodeInfoModal, setShowCopyNodeInfoModal] = useState(false);

  // State for "Jump to Bottom" button
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);

  // "Message anyway" override (#4153) for the unmessageable-node DM banner.
  // `is_unmessagable` is only a NodeInfo self-report, not an enforced
  // protocol restriction, so it can be stale/wrong. Keyed per-nodeId (not a
  // single boolean) so overriding one conversation never unlocks another —
  // switching selectedDMNode naturally looks up a different key, so nothing
  // leaks between conversations. Cleared on reload (not persisted).
  const [unmessageableOverrides, setUnmessageableOverrides] = useState<Set<string>>(new Set());

  // Handle scroll to detect if user has scrolled up
  const handleScroll = useCallback(() => {
    const container = dmMessagesContainerRef.current;
    if (!container) return;
    const isNearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 100;
    setShowJumpToBottom(!isNearBottom);
  }, [dmMessagesContainerRef]);

  // Scroll to bottom function
  const scrollToBottom = useCallback(() => {
    const container = dmMessagesContainerRef.current;
    if (container) {
      container.scrollTo({
        top: container.scrollHeight,
        behavior: 'smooth'
      });
    }
  }, [dmMessagesContainerRef]);

  // Attach scroll listener
  useEffect(() => {
    const container = dmMessagesContainerRef.current;
    if (container) {
      container.addEventListener('scroll', handleScroll);
      return () => container.removeEventListener('scroll', handleScroll);
    }
  }, [handleScroll]);

  // Fetch homoglyph optimization setting
  useEffect(() => {
    const fetchHomoglyphSetting = async () => {
      try {
        const settings = await apiService.get<Record<string, string>>('/api/settings');
        setHomoglyphEnabled(settings.homoglyphEnabled === 'true');
      } catch {
        // Default to false if we can't fetch settings
      }
    };
    void fetchHomoglyphSetting();
  }, []);

  // Close position channel dropdown on click outside
  useEffect(() => {
    if (!showPositionChannelDropdown) return;
    const handleClickOutside = () => setShowPositionChannelDropdown(false);
    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, [showPositionChannelDropdown]);

  // Close traceroute channel dropdown on click outside
  useEffect(() => {
    if (!showTracerouteChannelDropdown) return;
    const handleClickOutside = () => setShowTracerouteChannelDropdown(false);
    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, [showTracerouteChannelDropdown]);

  // Close node info channel dropdown on click outside
  useEffect(() => {
    if (!showNodeInfoChannelDropdown) return;
    const handleClickOutside = () => setShowNodeInfoChannelDropdown(false);
    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, [showNodeInfoChannelDropdown]);

  // Scroll to and highlight a focused message from search
  useEffect(() => {
    if (!focusMessageId) return;
    const timer = setTimeout(() => {
      const el = document.querySelector(`[data-message-id="${CSS.escape(focusMessageId)}"]`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.classList.add('search-highlight');
        setTimeout(() => el.classList.remove('search-highlight'), 3000);
      }
      onFocusMessageHandled?.();
    }, 300);
    return () => clearTimeout(timer);
  }, [focusMessageId, onFocusMessageHandled]);

  // Memoize byte count to avoid redundant homoglyph optimization on each render
  const byteCountDisplay = useMemo(() => {
    const message = homoglyphEnabled ? applyHomoglyphOptimization(newMessage) : newMessage;
    return formatByteCount(getUtf8ByteLength(message));
  }, [newMessage, homoglyphEnabled]);

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
  const { sourceId } = useSource();
  // Oldest-unread timestamp for the open DM, pinned at entry (#4607) — drives
  // the red "New messages" divider below.
  const { dm: pinnedFirstUnreadDM } = useUnreadDividerAnchors();
  const queryClient = useQueryClient();

  // Purge neighbors state
  const [purgingNeighbors, setPurgingNeighbors] = useState(false);

  // Security warning clear state (#4302 — the warning bar had no way to
  // resolve a stale flag short of finding the Security tab's "Run Scan Now").
  // Tracked by nodeNum (not a bare boolean) so switching the selected DM node
  // mid-request can't attribute the wrong node's loading state to this one.
  const [clearingSecurityWarningNode, setClearingSecurityWarningNode] = useState<number | null>(null);
  const handleClearSecurityWarning = useCallback(async (nodeNum: number) => {
    setClearingSecurityWarningNode(nodeNum);
    try {
      await apiService.post(`/api/security/nodes/${nodeNum}/clear`, { sourceId });
      // Optimistically drop the flags in the poll cache so the warning bar
      // disappears immediately instead of lingering until the next poll (#4302).
      setNodeFieldInCache(queryClient, sourceId, nodeNum, {
        keyIsLowEntropy: false,
        duplicateKeyDetected: false,
        keyMismatchDetected: false,
        keySecurityIssueDetails: undefined,
      });
      showToast(t('messages.security_risk_cleared', 'Security warning cleared'), 'success');
    } catch {
      showToast(t('messages.security_risk_clear_failed', 'Failed to clear security warning'), 'error');
    } finally {
      setClearingSecurityWarningNode(null);
    }
  }, [sourceId, queryClient, showToast, t]);

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
      shortName: node.user?.shortName || node.nodeNum.toString(16).padStart(8, '0').slice(-4),
      hopsAway: node.hopsAway,
      role: typeof node.user?.role === 'string' ? parseInt(node.user.role, 10) : node.user?.role,
      avgDirectRssi: stats?.avgRssi,
      heardDirectly: stats !== undefined,
    };
  });

  // Refs
  const dmMessageInputRef = useRef<HTMLTextAreaElement>(null);

  useAutoResizeTextarea(dmMessageInputRef, newMessage);

  // Honor a "Send Direct Message" focus request from the node list (#4325).
  //
  // Two paths, because the request usually arrives BEFORE the compose textarea
  // exists: navigating in from the node list mounts this tab, and on that first
  // pass the conversation pane (and its textarea) has not rendered yet. An
  // effect alone therefore fires against a null ref and, if it consumed the
  // request, the box would never get focused — that was the original bug.
  //
  //  - `attachDmInput` (callback ref) fires the moment the textarea mounts and
  //    focuses it if a request is outstanding. This is the normal path.
  //  - The effect below covers the case where the textarea is ALREADY mounted
  //    when the request lands (same conversation re-requested), which the
  //    callback ref cannot see because it does not re-fire.
  //
  // A request is only consumed once actually honored, except for a stale one
  // aimed at a different node, which is dropped so it can't fire later.
  const composeFocusTargetRef = useRef<string | null>(null);
  composeFocusTargetRef.current =
    pendingComposeFocus && pendingComposeFocus === selectedDMNode ? pendingComposeFocus : null;
  const clearComposeFocusRef = useRef(clearComposeFocus);
  clearComposeFocusRef.current = clearComposeFocus;

  const attachDmInput = useCallback((el: HTMLTextAreaElement | null) => {
    dmMessageInputRef.current = el;
    if (el && composeFocusTargetRef.current) {
      el.focus();
      composeFocusTargetRef.current = null;
      clearComposeFocusRef.current?.();
    }
  }, []);

  useEffect(() => {
    if (!pendingComposeFocus || !clearComposeFocus) return;
    if (pendingComposeFocus !== selectedDMNode) {
      clearComposeFocus();
      return;
    }
    if (!dmMessageInputRef.current) return; // textarea not mounted yet — attachDmInput will take it
    dmMessageInputRef.current.focus();
    clearComposeFocus();
  }, [pendingComposeFocus, selectedDMNode, clearComposeFocus]);

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
      return (node?.user?.shortName && node.user.shortName.trim()) || nodeId.slice(-4);
    },
    [nodes]
  );

  // Per-message sender label: "Long Name (SHRT)" (issue #4193). Kept as a
  // separate helper rather than folded into getNodeName so the fallback
  // chain there is untouched; see formatSenderLabel in nodeHelpers.ts for
  // the pure formatting rules (no duplicate/empty parenthetical).
  const getSenderLabel = useCallback(
    (nodeId: string): string => {
      const node = nodes.find(n => n.user?.id === nodeId);
      return formatSenderLabel(node?.user?.longName, node?.user?.shortName, nodeId);
    },
    [nodes]
  );

  const isMyMessage = useCallback(
    (msg: MeshMessage): boolean => {
      // Spoof-suspected messages claim our node id but arrived over RF — never
      // treat them as our own outgoing (#2584).
      if (msg.spoofSuspected) return false;
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

  // Issue #3922: let the conversation filter match on message *content*, not
  // just the partner's name/id. Precompute the set of node IDs whose DM
  // history contains the current filter term so both node-list renderers can
  // do an O(1) membership check instead of rescanning messages per node.
  const messageContentMatchNodeIds = useMemo(
    () => getMessageContentMatchNodeIds(messages, messagesNodeFilter),
    [messages, messagesNodeFilter]
  );

  // Handle relay node click - opens modal to show potential relay nodes
  const handleRelayClick = useCallback(
    async (msg: MeshMessage) => {
      // Opens the unified Message Details popup (#4816 follow-up). Direction
      // decides which sections show: our own send → delivery diagnostics; a
      // received message → route/signal/packet + relay candidates.
      // Fetch direct neighbor stats (only relevant when a relay byte is present,
      // but harmless to fetch and keeps the relay-candidate list populated).
      if (msg.relayNode !== undefined && msg.relayNode !== null) {
        try {
          const stats = await apiService.getDirectNeighborStats(24);
          setDirectNeighborStats(stats);
        } catch (error) {
          console.error('Failed to fetch direct neighbor stats:', error);
        }
      }

      setDetailsState({ message: msg, direction: isMyMessage(msg) ? 'sent' : 'received' });
    },
    [isMyMessage]
  );

  // Handle scan for remote admin
  const handleScanForAdmin = useCallback(
    async (nodeId: string) => {
      const node = nodes.find(n => n.user?.id === nodeId);
      if (!node) return;

      setAdminScanLoading(nodeId);
      try {
        const scanQuery = sourceId ? `?sourceId=${encodeURIComponent(sourceId)}` : '';
        const response = await csrfFetch(`${baseUrl}/api/nodes/${node.nodeNum}/scan-remote-admin${scanQuery}`, {
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
    [nodes, baseUrl, csrfFetch, showToast, t, sourceId]
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
    void fetchNodePacketDistribution();
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

  // Traceroute visual strip (#4381 WP4): the traceroute box renders inside a
  // JSX IIFE below, which cannot host a hook, so the graph+meta build is
  // hoisted here to component scope. `recentTrace` itself is intentionally
  // NOT memoized (it wasn't before this change either — the old inline block
  // called `getRecentTraceroute(selectedDMNode)` fresh on every render); only
  // the pure graph/meta derivation is memoized off it.
  const recentTrace = selectedDMNode ? getRecentTraceroute(selectedDMNode) : null;

  // Traceroute participation picker (Traceroute Strip Interactivity epic,
  // phase 2, WP2) — lets the user choose, among the stored traceroutes this
  // node took part in (as an endpoint or an intermediate hop), which one the
  // strip displays instead of always the newest poll row. This is the only
  // way an MQTT source (no origin node, so no own `recentTrace`) can show
  // the strip at all.
  //
  // `pickerNodeNum` is parsed directly from the hex id — unlike
  // `selectedNodeNum` above, which requires the node to already be present
  // in `nodes` — so it still resolves for a node not yet in the live list.
  const pickerNodeNum = selectedDMNode ? parseNodeId(selectedDMNode) : null;
  const { data: participationEntries, refetch: refetchParticipation } =
    useNodeTraceroutes(pickerNodeNum, { enabled: !!selectedDMNode });
  const entries: TracerouteParticipationEntry[] = participationEntries ?? [];

  // Statistical Route epic phase 2, D13 — one discriminated pick rather than
  // two mutually-exclusive flags. `pickedTracerouteId`/`statisticalPicked`
  // are derived so rules 1, 2 and 3 below keep their pre-existing shape.
  // S5 asymmetry (intentional): a statistical pick is NOT cleared when
  // eligibility is lost — only a partner change (rule 2) or a new poll row
  // (rule 3) clears it — so if eligibility returns while still picked, the
  // statistical view resumes without any user action.
  const [pick, setPick] = useState<TraceroutePick | null>(null);
  const pickedTracerouteId = pick?.kind === 'entry' ? pick.id : null;
  const statisticalPicked = pick?.kind === 'statistical';

  // Rule 2 — the manual pick resets whenever the conversation partner changes.
  useEffect(() => { setPick(null); }, [selectedDMNode]);

  // Rule 3 — the poll sees a new/updated traceroute first; clear any manual
  // pick so the user looking at a node they just traced sees the result, and
  // pull the picker list forward so the new row becomes selectable.
  useEffect(() => {
    if (recentTrace?.timestamp == null) return;
    setPick(null);
    void refetchParticipation();
  }, [recentTrace?.timestamp, refetchParticipation]);

  // Rule 1 — which row the strip shows: an explicit pick wins; otherwise the
  // newest of (`recentTrace`, `entries[0]`) by timestamp. Not "entries[0]
  // always": between firing a traceroute and the next participation
  // refetch, the poll row (`recentTrace`) is the newer one, and it is what
  // carries the pending/failed badge. Comparing timestamps keeps the shipped
  // TCP behaviour byte-identical while letting the picker supply the row on
  // MQTT, where `recentTrace` is always null (no origin node). A picked id
  // that disappears from a refetched list falls back to `newestAvailable` by
  // construction.
  const pickedEntry: TracerouteParticipationEntry | null = pickedTracerouteId != null
    ? entries.find(e => e.id === pickedTracerouteId) ?? null
    : null;
  const newestAvailable: DisplayedTraceroute | null =
    !recentTrace ? entries[0] ?? null
    : !entries[0] ? recentTrace
    : entries[0].timestamp >= recentTrace.timestamp ? entries[0] : recentTrace;
  const displayedTrace: DisplayedTraceroute | null = pickedEntry ?? newestAvailable;

  const tracerouteStrip = useMemo(() => {
    if (!displayedTrace) return null;
    const stripGraph = buildTracerouteStripGraph(displayedTrace);
    const stripMeta = buildStripNodeMeta(stripGraph, nodes, {
      hopsCalculation: nodeHopsCalculation,
      traceroutes,
      currentNodeNum,
    });
    return { stripGraph, stripMeta };
  }, [displayedTrace, nodes, nodeHopsCalculation, traceroutes, currentNodeNum]);

  // S1 (SR_PHASE2_SPEC.md D14, amended) — gated on cheap VALIDITY signals
  // only: permission, both node numbers resolved, and a real (non-self)
  // pair. The original design also required >= 2 participation-list
  // ("endpoint") entries, on the theory that the picker's already-fetched
  // 7-day list is a cheap, sound proxy for "an aggregate is plausible" —
  // live validation on the dev rig disproved that: a real pair
  // (1129874776 <-> 2732916556) had 25 stored traceroutes with route data,
  // but every one was 35-83 days old, so the 7-day participation window
  // showed only 3 'hop' entries and the count-based gate stayed at 0
  // forever. The epic's binding decision is "all stored pair history, no
  // time filter" (SR_PHASE2_SPEC.md §0); a precondition keyed to a
  // *windowed* list directly contradicts that for exactly the kind of
  // long-lived pair the feature exists for. Cost of dropping it: one GET
  // per opened DM conversation (with both a local and peer node), which the
  // hook's staleTime (60s) / gcTime (5min) already bound.
  const { rows: pairHistory } = useTraceroutePairHistory(currentNodeNum, pickerNodeNum, {
    enabled:
      hasPermission('traceroute', 'read') &&
      currentNodeNum != null &&
      pickerNodeNum != null &&
      currentNodeNum !== pickerNodeNum,
  });

  // S2 — build the union once. `buildStatisticalStrip` also returns a
  // layout; the strip component recomputes it from the graph, exactly as it
  // does for a single-route graph, so the component stays a pure function of
  // (graph, meta). Do NOT pass layout options here: the component paints
  // glyphs at its own DEFAULT_GLYPH_SIZE, which matches
  // DEFAULT_LAYOUT_OPTIONS.glyphSize.
  const statistical = useMemo<StatisticalTraceroute>(() => {
    if (currentNodeNum == null || pickerNodeNum == null || !pairHistory?.length) return null;
    const { union, graph } = buildStatisticalStrip(pairHistory, currentNodeNum, pickerNodeNum);
    if (union.totalRoutes < 2 || graph.isEmpty) return null;
    const meta = buildStripNodeMeta(graph, nodes, {
      hopsCalculation: nodeHopsCalculation,
      traceroutes,
      currentNodeNum,
    });
    return { graph, meta, totalRoutes: union.totalRoutes };
  }, [pairHistory, currentNodeNum, pickerNodeNum, nodes, nodeHopsCalculation, traceroutes]);

  // S5 — derived, not stored: losing availability while picked falls back to
  // the rule-1 row with no effect and no cleanup.
  const showStatistical = statisticalPicked && statistical != null;

  /** Load a hop from the traceroute strip into the Node Details panel.
   *  No `setActiveTab`: the strip only ever renders on the Messages tab, so
   *  the destination is already on screen. Mirrors NodesTab's
   *  `handlePopupDMClick` (NodesTab.tsx:1152) minus the tab switch. */
  const handleStripNodeDetails = useCallback((nodeUserId: string) => {
    setSelectedDMNode(nodeUserId);
  }, [setSelectedDMNode]);

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
          ? dmMessages.reduce((latest, msg) => (getMessageSortTime(msg) > getMessageSortTime(latest) ? msg : latest))
          : null;

      const lastMessageText = lastMessage
        ? (lastMessage.text || '').substring(0, 50) + (lastMessage.text && lastMessage.text.length > 50 ? '...' : '')
        : '';

      return {
        ...node,
        messageCount: dmMessages.length,
        unreadCount,
        lastMessageTime: dmMessages.length > 0 ? Math.max(...dmMessages.map(getMessageSortTime)) : 0,
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
      node.user?.id?.toLowerCase().includes(searchTerm) ||
      // Issue #3922: also match conversations by message content.
      (node.user?.id ? messageContentMatchNodeIds.has(node.user.id) : false)
    );
  });

  // Get DM messages for selected node
  const selectedDMMessages = selectedDMNode
    ? getDMMessages(selectedDMNode).sort((a, b) => getMessageSortTime(a) - getMessageSortTime(b))
    : [];

  // Unread divider anchor (#4607). `pinnedFirstUnreadDM` is the oldest-unread
  // timestamp captured when this conversation was opened — read-marking clears
  // the unread set a tick later, so a live lookup would always come back empty.
  // Resolved against the same sorted list the rows render from.
  //
  // `hasMoreOlder: true` because the DM view renders a window and pages older
  // history in on scroll, so a top-of-window anchor is not the start of the
  // conversation.
  //
  // Computed inline rather than with useMemo: this point in the component is
  // BELOW the `messages:read` early return above, so a hook here would be
  // conditional and React would fault on the render where permission flips.
  const unreadAnchorId = (() => {
    const rows = selectedDMMessages.map(m => ({ id: m.id, sortTime: getMessageSortTime(m) }));
    const anchor = resolveUnreadAnchorId({
      messages: rows,
      watermarkMs: pinnedFirstUnreadDM,
      mode: 'firstUnread',
      ownMessageIds: new Set(selectedDMMessages.filter(isMyMessage).map(m => m.id)),
    });
    return shouldSuppressDivider({ anchorId: anchor, messages: rows, hasMoreOlder: true })
      ? null
      : anchor;
  })();

  const selectedNode = selectedDMNode ? nodes.find(n => n.user?.id === selectedDMNode) : null;

  // Two distinct read-only states (see computeMessagesReadOnlyState):
  //  - dmReadOnly      → hide the DM log + composer (MQTT mirror OR unmessageable
  //                      node, #3755).
  //  - actionsReadOnly → hide the mesh-action buttons (traceroute/telemetry/
  //                      nodeinfo/position/neighborinfo/admin scan). These are
  //                      channel-routed packets, not DMs, so an unmessageable
  //                      node still answers them — only the MQTT-bridge mirror
  //                      suppresses them (#3831).
  const { dmReadOnly, dmReadOnlyReason, actionsReadOnly } = computeMessagesReadOnlyState({
    mqttReadOnly,
    isUnmessagable: selectedNode?.isUnmessagable,
    // Only ever suppresses the unmessageable gate — never bypasses MQTT
    // (enforced inside computeMessagesReadOnlyState itself).
    overrideUnmessageable: selectedDMNode ? unmessageableOverrides.has(selectedDMNode) : false,
  });

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
            <UiIcon name={isMessagesNodeListCollapsed ? 'forward' : 'back'} size={18} />
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
                    aria-label={t('common.clear_filter')}
                    type="button"
                  >
                    <UiIcon name="close" size={16} />
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


        {!isMessagesNodeListCollapsed && (
          <div className="nodes-list">
            {shouldShowData() ? (
              processedNodes.length > 0 ? (
                <>
                  {filteredNodes.map(node => {
                    // #4880: color the node box per the active Node List Style.
                    // `nodeColorStyle` returns {} for monochrome, keeping the
                    // existing theme look.
                    const nc = nodeColorStyle(nodeListStyle, {
                      nodeNum: node.nodeNum,
                      hopsAway: node.hopsAway,
                      isFavorite: node.isFavorite,
                    });
                    return (
                    <div
                      key={node.nodeNum}
                      className={`node-item ${selectedDMNode === node.user?.id ? 'selected' : ''}`}
                      style={nc.background ? { background: nc.background, color: nc.text } : undefined}
                      onClick={() => {
                        const nodeId = node.user?.id || '';
                        setSelectedDMNode(nodeId);
                        setReplyingTo(null);
                        if (nodeId) void markMessagesAsRead(undefined, -1, nodeId);
                      }}
                    >
                      <div className="node-header">
                        <div className="node-name">
                          {node.isFavorite && <span className="favorite-indicator"><UiIcon name="favorite" size={15} /></span>}
                          <div className="node-name-text">
                            <div className="node-longname">{node.user?.longName || t('messages.node_fallback', { nodeNum: node.nodeNum })}</div>
                          </div>
                        </div>
                        <div className="node-actions">
                          {node.position && node.position.latitude != null && node.position.longitude != null && (
                            <span className="node-indicator-icon" title={t('nodes.location')}><UiIcon name="location" size={15} /></span>
                          )}
                          {node.viaMqtt && (
                            <span className="node-indicator-icon" title={t('nodes.via_mqtt')}><UiIcon name="network" size={15} /></span>
                          )}
                          {node.user?.id && nodesWithTelemetry.has(node.user.id) && (
                            <span className="node-indicator-icon" title={t('nodes.has_telemetry')}><UiIcon name="telemetry" size={15} /></span>
                          )}
                          {node.user?.id && nodesWithWeatherTelemetry.has(node.user.id) && (
                            <span className="node-indicator-icon" title={t('nodes.has_weather')}><UiIcon name="weather" size={15} /></span>
                          )}
                          {node.user?.id && nodesWithPKC.has(node.user.id) && (
                            <span className="node-indicator-icon" title={t('nodes.has_pkc')}><UiIcon name="encryptedKey" size={15} /></span>
                          )}
                          {node.user?.id && isDMMuted(node.user.id) && (
                            <span className="node-indicator-icon" title={t('notifications.muted', 'Notifications muted')}><UiIcon name="muted" size={15} /></span>
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
                              <UiIcon name={node.keyMismatchDetected ? 'unlock' : 'alert'} size={16} />
                            </span>
                          )}
                          <div
                            className={`node-short ${stickyNodes.has(node.nodeNum) ? 'sticky' : ''}`}
                            onClick={(e) => toggleStickyNode(node.nodeNum, e)}
                            title={stickyNodes.has(node.nodeNum) ? t('messages.unpin_node') : t('messages.pin_node')}
                            style={{ cursor: 'pointer' }}
                          >
                            {stickyNodes.has(node.nodeNum) && <span className="pin-indicator"><UiIcon name="pin" size={14} /></span>}
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
                              color: selectedDMNode === node.user?.id ? '#000000' : 'var(--color-text-subtle)',
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
                              <UiIcon name="messages" size={14} /> {node.messageCount}
                            </span>
                            {node.lastMessageTime > 0 && (
                              <span
                                className="stat"
                                title={formatDateTime(new Date(node.lastMessageTime), timeFormat, dateFormat)}
                                style={
                                  node.unreadCount > 0
                                    ? {
                                        border: '2px solid var(--color-error)',
                                        borderRadius: '12px',
                                        padding: '2px 6px',
                                        backgroundColor: 'var(--color-surface)',
                                      }
                                    : undefined
                                }
                              >
                                <UiIcon name="time" size={14} /> {formatRelativeTime(node.lastMessageTime)}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>

                      <div className="node-stats">
                        {node.hopsAway === 0 && node.snr != null && (
                          <span className="stat" title={t('nodes.snr')}>
                            <UiIcon name="wifi" size={14} /> {node.snr.toFixed(1)}dB
                          </span>
                        )}
                        {node.hopsAway === 0 && node.rssi != null && (
                          <span className="stat" title={t('nodes.rssi')}>
                            <UiIcon name="radioSignal" size={14} /> {node.rssi}dBm
                          </span>
                        )}
                        {(node.hopsAway != null || node.lastMessageHops != null) && (() => {
                          const effectiveHops = getEffectiveHops(node, nodeHopsCalculation, traceroutes, currentNodeNum);
                          return effectiveHops < 999 ? (
                            <span className="stat" title={t('nodes.hops_away')}>
                              <UiIcon name="link" size={14} /> {effectiveHops} {t('nodes.hop', { count: effectiveHops })}
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
                    );
                  })}
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
              const nodeId = e.target.value;
              setSelectedDMNode(nodeId);
              setReplyingTo(null);
              if (nodeId) void markMessagesAsRead(undefined, -1, nodeId);
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
                  node.user?.id?.toLowerCase().includes(searchTerm) ||
                  // Issue #3922: also match conversations by message content.
                  (node.user?.id ? messageContentMatchNodeIds.has(node.user.id) : false)
                );
              })
              .map(node => {
                const displayName = node.user?.longName || `Node ${node.nodeNum}`;
                const shortName = node.user?.shortName || '-';
                const snr = node.snr != null ? ` ${node.snr.toFixed(1)}dB` : '';
                const battery =
                  node.deviceMetrics?.batteryLevel !== undefined && node.deviceMetrics.batteryLevel !== null
                    ? node.deviceMetrics.batteryLevel === 101
                      ? ` ${t('node_popup.power_plugged', 'Plugged In')}`
                      : ` ${node.deviceMetrics.batteryLevel}%`
                    : '';
                const unread = node.unreadCount > 0 ? ` (${node.unreadCount})` : '';

                return (
                  <option key={node.user?.id || node.nodeNum} value={node.user?.id || ''}>
                    {node.isFavorite ? `[${t('meshcore.favorite.is_favorite', 'Favorite')}] ` : ''}
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
                    {t('messages.actions_menu')} <UiIcon name="chevronDown" size={15} />
                  </button>

                  {showActionsMenu && (
                    <>
                      <div className="actions-menu-overlay" onClick={() => setShowActionsMenu(false)} />
                      <div className="actions-menu-dropdown">
                        {/* Notification Mute Actions */}
                        {isDMMuted(selectedDMNode) ? (
                          <button
                            className="actions-menu-item"
                            onClick={async () => {
                              await unmuteDM(selectedDMNode);
                              setShowActionsMenu(false);
                            }}
                          >
                            <UiIcon name="unmute" /> {t('notifications.unmute', 'Unmute notifications')}
                          </button>
                        ) : (
                          <>
                            <button
                              className="actions-menu-item"
                              onClick={async () => {
                                await muteDM(selectedDMNode, null);
                                setShowActionsMenu(false);
                              }}
                            >
                              <UiIcon name="muted" /> {t('notifications.mute_indefinite', 'Mute notifications indefinitely')}
                            </button>
                            <button
                              className="actions-menu-item"
                              onClick={async () => {
                                await muteDM(selectedDMNode, Date.now() + 60 * 60 * 1000);
                                setShowActionsMenu(false);
                              }}
                            >
                              <UiIcon name="time" /> {t('notifications.mute_1h', 'Mute for 1 hour')}
                            </button>
                            <button
                              className="actions-menu-item"
                              onClick={async () => {
                                await muteDM(selectedDMNode, Date.now() + 7 * 24 * 60 * 60 * 1000);
                                setShowActionsMenu(false);
                              }}
                            >
                              <UiIcon name="calendar" /> {t('notifications.mute_1w', 'Mute for 1 week')}
                            </button>
                          </>
                        )}
                        <div className="actions-menu-divider" />
                        {/* Traceroute Actions — the active Traceroute and
                            request flows transmit to the mesh, so they're
                            suppressed in the MQTT-bridge mirror. The history
                            view is read-only and remains. */}
                        {hasPermission('traceroute', 'write') && (
                          <>
                            {!actionsReadOnly && (
                              <button
                                className="actions-menu-item"
                                onClick={() => {
                                  void handleTraceroute(selectedDMNode);
                                  setShowActionsMenu(false);
                                }}
                                disabled={connectionStatus !== 'connected' || tracerouteLoading === selectedDMNode || txDisabled}
                                title={txDisabled ? (txDisabledTooltip ?? t('tx_disabled.control_tooltip')) : undefined}
                              >
                                <UiIcon name="route" /> {t('messages.traceroute_button')}
                                {tracerouteLoading === selectedDMNode && <span className="spinner"></span>}
                              </button>
                            )}
                            <button
                              className="actions-menu-item"
                              onClick={() => {
                                setShowTracerouteHistoryModal(true);
                                setShowActionsMenu(false);
                              }}
                            >
                              <UiIcon name="list" /> {t('messages.history_button')}
                            </button>
                          </>
                        )}

                        {/* Exchange Actions — every entry below transmits a
                            packet to the mesh (position exchange, NodeInfo
                            request, telemetry request). Hidden entirely in
                            the MQTT-bridge mirror. Available for unmessageable
                            nodes because these use channel routing, not DMs. */}
                        {!actionsReadOnly && hasPermission('messages', 'write') && (
                          <>
                            <button
                              className="actions-menu-item"
                              onClick={() => {
                                void handleExchangePosition(selectedDMNode);
                                setShowActionsMenu(false);
                              }}
                              disabled={connectionStatus !== 'connected' || positionLoading === selectedDMNode || txDisabled}
                              title={txDisabled ? (txDisabledTooltip ?? t('tx_disabled.control_tooltip')) : undefined}
                            >
                              <UiIcon name="location" /> {t('messages.exchange_position')}
                              {positionLoading === selectedDMNode && <span className="spinner"></span>}
                            </button>
                            <button
                              className="actions-menu-item"
                              onClick={() => {
                                void handleExchangeNodeInfo(selectedDMNode);
                                setShowActionsMenu(false);
                              }}
                              disabled={connectionStatus !== 'connected' || nodeInfoLoading === selectedDMNode || txDisabled}
                              title={txDisabled ? (txDisabledTooltip ?? t('tx_disabled.control_tooltip')) : undefined}
                            >
                              <UiIcon name="key" /> {t('messages.exchange_node_info')}
                              {nodeInfoLoading === selectedDMNode && <span className="spinner"></span>}
                            </button>
                            <button
                              className="actions-menu-item"
                              onClick={() => {
                                setShowTelemetryRequestModal(true);
                                setShowActionsMenu(false);
                              }}
                              disabled={connectionStatus !== 'connected' || telemetryRequestLoading === selectedDMNode || txDisabled}
                              title={txDisabled ? (txDisabledTooltip ?? t('tx_disabled.control_tooltip')) : undefined}
                            >
                              <UiIcon name="telemetry" /> {t('messages.request_telemetry')}
                              {telemetryRequestLoading === selectedDMNode && <span className="spinner"></span>}
                            </button>
                          </>
                        )}

                        {/* Copy NodeInfo from Another Source — local DB
                            operation, no packet transmitted. */}
                        {/* #4244: not gated on isNodeComplete — another source may
                            have heard fresher NodeInfo, and "complete" can mean
                            nothing more than derived placeholder names. */}
                        {selectedNode && hasPermission('nodes', 'write') && (
                          <button
                            className="actions-menu-item"
                            onClick={() => {
                              setShowCopyNodeInfoModal(true);
                              setShowActionsMenu(false);
                            }}
                          >
                            <UiIcon name="copy" /> {t('nodes.copy_nodeinfo_title')}
                          </button>
                        )}

                        {/* Admin Scan — sends an admin probe packet to the
                            remote node. No-op in the MQTT-bridge mirror.
                            'settings' is sourcey (Phase 6 #4416). Verified
                            POST /nodes/:nodeNum/scan-remote-admin declares
                            requirePermission('settings','write') with no
                            sourceIdFrom — the sourceId query param it does
                            send only picks the scan target, it is not used
                            for the permission check — so this stays an
                            unscoped gate. */}
                        {!actionsReadOnly && hasPermission('settings', 'write', { anySource: true }) && (
                          <button
                            className="actions-menu-item"
                            onClick={() => {
                              void handleScanForAdmin(selectedDMNode);
                              setShowActionsMenu(false);
                            }}
                            disabled={connectionStatus !== 'connected' || adminScanLoading === selectedDMNode || txDisabled}
                            title={txDisabled ? (txDisabledTooltip ?? t('tx_disabled.control_tooltip')) : undefined}
                          >
                            <UiIcon name="search" /> {t('messages.scan_for_admin')}
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
                                void toggleFavorite(selectedNode, e);
                                setShowActionsMenu(false);
                              }}
                            >
                              <UiIcon name={selectedNode.isFavorite ? 'favorite' : 'favoriteOff'} /> {selectedNode.isFavorite ? t('nodes.remove_favorite') : t('nodes.add_favorite')}
                            </button>
                            <button
                              className="actions-menu-item"
                              onClick={(e) => {
                                void toggleFavoriteLock(selectedNode, e);
                                setShowActionsMenu(false);
                              }}
                            >
                              <UiIcon name={selectedNode.favoriteLocked ? 'unlock' : 'encrypted'} /> {selectedNode.favoriteLocked ? t('nodes.unlock_favorite', 'Remove Favorite Lock') : t('nodes.lock_favorite', 'Set Favorite Lock')}
                            </button>
                            <button
                              className="actions-menu-item"
                              onClick={(e) => {
                                void toggleIgnored(selectedNode, e);
                                setShowActionsMenu(false);
                              }}
                            >
                              <UiIcon name={selectedNode.isIgnored ? 'unencrypted' : 'blocked'} /> {selectedNode.isIgnored ? t('messages.unignore_node') : t('messages.ignore_node')}
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
                            {/* #4137: distinct icon/label from the hide/show toggle below
                                ("Show on Map" is the un-hide label) so this pure pan action
                                is never mistaken for the toggle. */}
                            <UiIcon name="target" /> {t('messages.center_on_map', 'Center on Map')}
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
                            <UiIcon name="location" /> {t('messages.override_position')}
                          </button>
                        )}
                        {hasPermission('nodes', 'write') && selectedNode && (
                          <button
                            className="actions-menu-item"
                            onClick={(e) => {
                              void toggleHideFromMap(selectedNode, e);
                              setShowActionsMenu(false);
                            }}
                          >
                            <UiIcon name={selectedNode.hideFromMap ? 'map' : 'visibilityOff'} /> {selectedNode.hideFromMap
                              ? t('messages.unhide_from_map', 'Show on Map')
                              : t('messages.hide_from_map', 'Hide from Map')}
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
                              <UiIcon name="delete" /> {t('messages.purge_data')}
                            </button>
                          </>
                        )}
                      </div>
                    </>
                  )}
                </div>
              </div>
            </div>

            {/* Public-key mismatch (#4738) — explained rather than asserted,
                with severity driven by whether the user has actually encrypted
                anything to the old key. Scoped to the mismatch case: low-entropy
                and duplicate-key are different problems needing different
                guidance, so they keep the original banner below. */}
            {selectedNode && selectedNode.keyMismatchDetected && (
              <div style={{ marginBottom: '10px' }}>
                <KeyMismatchWarning
                  sentDirectMessageCount={
                    // `isMyMessage`, not `to === node`: it is the canonical
                    // "did I send this" check AND it excludes spoof-suspected
                    // messages. A forged message claiming to be from us must
                    // not be counted as us having encrypted something to this
                    // node — that would inflate the severity of the very
                    // warning meant to detect impersonation (review, #4747).
                    selectedDMNode ? selectedDMMessages.filter(isMyMessage).length : 0
                  }
                  details={selectedNode.keySecurityIssueDetails}
                >
                  {hasPermission('security', 'write') && (
                    <button
                      onClick={() => void handleClearSecurityWarning(selectedNode.nodeNum)}
                      disabled={clearingSecurityWarningNode === selectedNode.nodeNum}
                      title={t('messages.security_risk_clear_title', 'Clear this security warning')}
                      style={{
                        background: 'transparent',
                        border: '1px solid currentColor',
                        color: 'inherit',
                        borderRadius: '4px',
                        padding: '2px 10px',
                        cursor: clearingSecurityWarningNode === selectedNode.nodeNum ? 'default' : 'pointer',
                      }}
                    >
                      {clearingSecurityWarningNode === selectedNode.nodeNum ? t('messages.security_risk_clearing', 'Clearing…') : t('messages.security_risk_clear', 'Clear')}
                    </button>
                  )}
                </KeyMismatchWarning>
              </div>
            )}

            {/* Security Warning Bar */}
            {selectedNode && !selectedNode.keyMismatchDetected && (selectedNode.keyIsLowEntropy || selectedNode.duplicateKeyDetected || selectedNode.keySecurityIssueDetails) && (
              <div
                style={{
                  backgroundColor: '#f44336',
                  color: 'white',
                  padding: '12px',
                  marginBottom: '10px',
                  borderRadius: '4px',
                  fontWeight: 'bold',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexWrap: 'wrap',
                  gap: '10px',
                }}
              >
                <span>
                  <UiIcon name="alert" /> {t('messages.security_risk')}
                </span>
                {hasPermission('security', 'write') && (
                  <button
                    onClick={() => void handleClearSecurityWarning(selectedNode.nodeNum)}
                    disabled={clearingSecurityWarningNode === selectedNode.nodeNum}
                    title={t('messages.security_risk_clear_title', 'Clear this security warning')}
                    style={{
                      background: 'rgba(255, 255, 255, 0.15)',
                      border: '1px solid rgba(255, 255, 255, 0.8)',
                      color: 'white',
                      borderRadius: '4px',
                      padding: '2px 10px',
                      fontWeight: 'normal',
                      cursor: clearingSecurityWarningNode === selectedNode.nodeNum ? 'default' : 'pointer',
                    }}
                  >
                    {clearingSecurityWarningNode === selectedNode.nodeNum ? t('messages.security_risk_clearing', 'Clearing…') : t('messages.security_risk_clear', 'Clear')}
                  </button>
                )}
              </div>
            )}

            {/*
              Not in device DB warning - node exists in MeshMonitor but not on the radio.
              When the key is known and there's no active mismatch, MeshMonitor will
              pre-populate the radio's NodeDB via add_contact before the PKI DM (PR #3227),
              so the DM still succeeds — a mitigatable warning shown in a softer yellow box.
              Otherwise the DM truly will fail, so keep the stronger orange warning.
              See isDeviceDbWarningMitigatable for the predicate (mirrors the backend gate).
            */}
            {selectedNodeNum !== undefined && deviceNodeNums.size > 0 && !deviceNodeNums.has(selectedNodeNum) && (
              <div
                style={{
                  backgroundColor: isDeviceDbWarningMitigatable(selectedNode)
                    ? 'var(--color-warning)'
                    : 'var(--color-caution)',
                  color: 'var(--color-bg)',
                  padding: '10px 12px',
                  marginBottom: '10px',
                  borderRadius: '4px',
                  textAlign: 'center',
                }}
              >
                {isDeviceDbWarningMitigatable(selectedNode)
                  ? t('messages.not_in_device_db_key_known', 'This node is not in the connected device\'s database. MeshMonitor will attempt to restore the saved key when you send a direct message.')
                  : t('messages.not_in_device_db', 'This node is not in your radio\'s database. Direct messages will fail until the node exchanges keys with your radio. Use "Exchange Node Info" to request key exchange.')}
              </div>
            )}

            {/*
              Unmessageable-node banner (#4139) - explains why the DM log/composer
              below is hidden, instead of the composer just silently disappearing.
              Only shown for the unmessageable reason — the MQTT-bridge mirror case
              already hides the action buttons too, which is self-explanatory from
              the source picker, so it doesn't get a banner here.

              #4153: `is_unmessagable` is only a NodeInfo self-report, not an
              enforced protocol restriction — it can be stale or wrong — so the
              banner offers a "Message anyway" override. The override is keyed
              per-nodeId (unmessageableOverrides), so it never leaks between
              conversations, and it is NEVER offered for the MQTT reason (a
              hard transport limitation, not a self-report — enforced inside
              computeMessagesReadOnlyState, not just in this banner).
            */}
            {dmReadOnlyReason === 'unmessageable' && (
              <div
                style={{
                  backgroundColor: 'var(--color-warning)',
                  color: 'var(--color-bg)',
                  padding: '10px 12px',
                  marginBottom: '10px',
                  borderRadius: '4px',
                  textAlign: 'center',
                }}
              >
                {t(
                  'messages.unmessageable_banner',
                  'This node reports itself as unmessageable (router/repeater/sensor) — it cannot receive direct messages.'
                )}
                {selectedDMNode && (
                  <>
                    {' '}
                    <button
                      onClick={() => {
                        const nodeId = selectedDMNode;
                        setUnmessageableOverrides(prev => {
                          const next = new Set(prev);
                          next.add(nodeId);
                          return next;
                        });
                      }}
                      style={{
                        background: 'none',
                        border: 'none',
                        padding: 0,
                        color: 'var(--color-accent)',
                        textDecoration: 'underline',
                        cursor: 'pointer',
                        fontWeight: 'bold',
                        fontSize: 'inherit',
                      }}
                      title={t(
                        'messages.unmessageable_override_title',
                        'This flag is self-reported and may be stale or wrong. Try messaging this node anyway.'
                      )}
                    >
                      {t('messages.unmessageable_override_button', 'Message anyway')}
                    </button>
                  </>
                )}
              </div>
            )}

            {/* Messages Container — hidden for unmessageable nodes and MQTT-bridge mirror */}
            <div
              className="messages-container"
              ref={dmMessagesContainerRef}
              style={{ position: 'relative', display: dmReadOnly ? 'none' : undefined }}
            >
              {showJumpToBottom && (
                <div
                  style={{
                    position: 'sticky',
                    top: '0.5rem',
                    zIndex: 10,
                    display: 'flex',
                    justifyContent: 'center',
                    marginBottom: '0.5rem',
                  }}
                >
                  <button
                    className="jump-to-bottom-btn"
                    onClick={scrollToBottom}
                    style={{
                      padding: '0.5rem 1rem',
                      backgroundColor: 'var(--color-accent)',
                      border: 'none',
                      borderRadius: '20px',
                      cursor: 'pointer',
                      fontSize: '0.85rem',
                      color: 'var(--color-bg)',
                      fontWeight: 'bold',
                      boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.5rem',
                    }}
                  >
                    <UiIcon name="sortDescending" size={16} /> {t('channels.jump_to_bottom', 'Jump to Bottom')}
                  </button>
                </div>
              )}
              {selectedDMMessages.length > 0 ? (
                selectedDMMessages.map((msg, index) => {
                  const isTraceroute = msg.portnum === 70;
                  const isMine = isMyMessage(msg);
                  const isReaction = msg.emoji === 1 || (msg.replyId != null && isEmoji(msg.text));

                  // #4880: color an incoming ("theirs") bubble + sender dot by
                  // the sender node under the active Node List Style. Own
                  // messages keep the standard "mine" styling. Returns {} for
                  // monochrome / unknown sender, leaving the theme look intact.
                  const senderNode = isMine ? undefined : nodes.find(n => n.user?.id === msg.from);
                  const senderColor = senderNode
                    ? nodeColorStyle(nodeListStyle, {
                        nodeNum: senderNode.nodeNum,
                        hopsAway: senderNode.hopsAway,
                        isFavorite: senderNode.isFavorite,
                      })
                    : {};

                  if (isReaction) return null;

                  const reactions = selectedDMMessages.filter(
                    m => (m.emoji === 1 || isEmoji(m.text)) && m.replyId && m.replyId.toString() === msg.id.split('_').pop()
                  );

                  const repliedMessage = msg.replyId
                    ? selectedDMMessages.find(m => m.id.split('_').pop() === msg.replyId?.toString())
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
                        {unreadAnchorId === msg.id && <UnreadDivider />}
                        <div className="message-item traceroute">
                          <div className="message-header">
                            <span className="message-from">{getSenderLabel(msg.from)}</span>
                            <span className="message-time">
                              {formatMessageTime(currentDate, timeFormat, dateFormat)}
                              <HopCountDisplay
                                hopStart={msg.hopStart}
                                hopLimit={msg.hopLimit}
                                rxSnr={msg.rxSnr}
                                rxRssi={msg.rxRssi}
                                relayNode={msg.relayNode}
                                viaMqtt={msg.viaMqtt}
                                viaStoreForward={msg.viaStoreForward}
                                xeddsaSigned={msg.xeddsaSigned}
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
                      {/* Red "New messages" line, directly above the oldest
                          message unseen at entry (#4607). */}
                      {unreadAnchorId === msg.id && <UnreadDivider />}
                      <div 
                        className={`message-bubble-container ${isMine ? 'mine' : 'theirs'}`}
                        data-message-id={msg.id}
                      >
                        {!isMine && (
                          <div
                            className={`sender-dot clickable ${isEmoji(getNodeShortName(msg.from)) ? 'is-emoji' : ''}`}
                            title={`Click for ${getNodeName(msg.from)} details`}
                            onClick={e => handleSenderClick(msg.from, e)}
                            style={senderColor.background ? { background: senderColor.background, color: senderColor.text } : undefined}
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
                                  disabled={txDisabled}
                                  title={txDisabled ? (txDisabledTooltip ?? t('tx_disabled.control_tooltip')) : t('messages.resend_button_title')}
                                  aria-label={t('messages.resend_button_title')}
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
                                  aria-label={t('messages.reply_button_title')}
                                >
                                  <UiIcon name="reply" size={15} />
                                </button>
                              )}
                              <button
                                className="emoji-picker-button"
                                onClick={() => setEmojiPickerMessage(msg)}
                                disabled={txDisabled}
                                title={txDisabled ? (txDisabledTooltip ?? t('tx_disabled.control_tooltip')) : t('messages.emoji_button_title')}
                                aria-label={t('messages.emoji_button_title')}
                              >
                                <UiIcon name="reaction" size={15} />
                              </button>
                              <button
                                className="delete-button"
                                onClick={() => handleDeleteMessage(msg)}
                                title={t('messages.delete_button_title')}
                                aria-label={t('messages.delete_button_title')}
                              >
                                <UiIcon name="delete" size={15} />
                              </button>
                            </div>
                          )}
                          <div
                            className={`message-bubble ${isMine ? 'mine' : 'theirs'}`}
                            style={senderColor.background ? { background: senderColor.background, color: senderColor.text } : undefined}
                          >
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
                                    viaStoreForward={msg.viaStoreForward}
                                    xeddsaSigned={msg.xeddsaSigned}
                                    onClick={() => handleRelayClick(msg)}
                                  />
                                </span>
                              </div>
                            </div>
                            <LinkPreview text={msg.text} />
                            {reactions.length > 0 && (
                              <div className="message-reactions">
                                {/* Reaction chips stay clickable even when txDisabled — see the
                                    matching comment in ChannelsTab.tsx (epic #4294 Phase 2, §3.2/§3.3):
                                    they double as the read affordance for "who reacted", and a
                                    re-tap while TX is off is caught by the handleSendTapback
                                    failure-branch toast in App.tsx rather than pre-emptively blocked. */}
                                {reactions.map(reaction => (
                                  <span
                                    key={reaction.id}
                                    className={`reaction ${isMyMessage(reaction) ? 'mine' : 'theirs'}`}
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
                        {isMine && (
                          <div className="message-status">
                            <MessageStatusIndicator message={msg} onShowDetails={() => setDetailsState({ message: msg, direction: 'sent' })} />
                          </div>
                        )}
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
              {/* Send DM form — suppressed for unmessageable nodes and MQTT-bridge mirror */}
              {!dmReadOnly && connectionStatus === 'connected' && (
                <div className="send-message-form">
                {replyingTo && (
                  <div className="reply-indicator">
                    <div className="reply-indicator-content">
                      <div className="reply-indicator-label">{t('messages.replying_to', { name: getNodeName(replyingTo.from) })}</div>
                      <div className="reply-indicator-text">{replyingTo.text}</div>
                    </div>
                    <button className="reply-indicator-close" onClick={() => setReplyingTo(null)} title={t('messages.cancel_reply_title')} aria-label={t('messages.cancel_reply_title')}>
                      ×
                    </button>
                  </div>
                )}
                {hasPermission('messages', 'write') && (
                  <div className="message-input-container">
                    <div className="input-with-counter">
                      <textarea
                        ref={attachDmInput}
                        value={newMessage}
                        onChange={e => setNewMessage(e.target.value)}
                        onFocus={scrollInputIntoView}
                        placeholder={t('messages.dm_placeholder', { name: getNodeName(selectedDMNode) })}
                        className="message-input"
                        rows={1}
                        disabled={txDisabled}
                        title={txDisabled ? (txDisabledTooltip ?? t('tx_disabled.control_tooltip')) : undefined}
                        onKeyDown={e => {
                          if (
                            txDisabled ||
                            !(
                              e.key === 'Enter' &&
                              !e.shiftKey &&
                              !e.ctrlKey &&
                              !e.metaKey &&
                              !e.altKey &&
                              !e.nativeEvent.isComposing
                            )
                          ) {
                            return;
                          }
                          e.preventDefault();
                          void handleSendDirectMessage(selectedDMNode);
                        }}
                      />
                      <div className={byteCountDisplay.className}>
                        {byteCountDisplay.text}
                      </div>
                    </div>
                    <MessageEmojiButton
                      textareaRef={dmMessageInputRef}
                      value={newMessage}
                      onChange={setNewMessage}
                    />
                    <button
                      onClick={() => { void onSendBell?.(selectedDMNode, newMessage); setNewMessage(''); }}
                      disabled={txDisabled}
                      className="send-btn channel-action-btn"
                      title={txDisabled ? (txDisabledTooltip ?? t('tx_disabled.control_tooltip')) : 'Send alert bell'}
                      aria-label="Send alert bell"
                    >
                      <UiIcon name="notifications" size={16} />
                    </button>
                    <button
                      onClick={() => handleSendDirectMessage(selectedDMNode)}
                      disabled={!newMessage.trim() || txDisabled}
                      className="send-btn"
                      title={txDisabled ? (txDisabledTooltip ?? t('tx_disabled.control_tooltip')) : undefined}
                      aria-label={t('common.send')}
                    >
                      <UiIcon name="send" size={16} />
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* Traceroute Display */}
              {/* Read gate: the box is a DISPLAY. `write` still gates the
                  request button (below / the channel split-button) and is
                  unchanged there. `|| write` keeps a write-without-read user
                  exactly where they were before this change (epic phase 2,
                  WP2, non-regressive per TRS_PHASE2_SPEC.md §6.4). */}
              {(hasPermission('traceroute', 'read') || hasPermission('traceroute', 'write')) &&
                (() => {
                  // displayedTrace/tracerouteStrip are computed at component
                  // scope (#4381 WP4; displayedTrace selection added epic
                  // phase 2 WP2) — this IIFE cannot host a hook, so the
                  // graph/meta build for the visual strip lives above.
                  //
                  // Rule 7: the box renders whenever there is a row to show,
                  // whether it came from the poll (`recentTrace`) or from the
                  // participation picker — this is what unlocks the strip on
                  // an MQTT source, which has no `recentTrace` at all.
                  if (displayedTrace) {
                    // Rule 4: age/badges read the displayed row, not
                    // `recentTrace`, so a picked historical row reads
                    // correctly ("last traced 3d ago … (Failed)" describes
                    // *that* traceroute).
                    // Clamp at 0: a node with a wrong/ahead clock can stamp a
                    // traceroute in the future, which would otherwise render as a
                    // negative "-1676m ago" (#2768). The data write-path now caps
                    // this at server time too; this guards any pre-fix rows.
                    const age = Math.max(0, Math.floor((Date.now() - displayedTrace.timestamp) / (1000 * 60)));
                    const ageStr = age < 60 ? `${age}m ago` : `${Math.floor(age / 60)}h ago`;

                    // Check if traceroute failed (both directions have no valid data)
                    const forwardFailed = !displayedTrace.route || displayedTrace.route === 'null';
                    const returnFailed = !displayedTrace.routeBack || displayedTrace.routeBack === 'null';
                    const noData = forwardFailed && returnFailed;
                    const isPending = noData && age < 1; // Less than 1 minute old
                    const isFailed = noData && !isPending;

                    const stripGraph = tracerouteStrip?.stripGraph;
                    const stripMeta = tracerouteStrip?.stripMeta;

                    return (
                      <div className="traceroute-info" style={{ marginTop: '1rem' }}>
                        <TracerouteParticipationPicker
                          entries={entries}
                          // Both branches of DisplayedTraceroute carry an
                          // optional `id`: a TracerouteParticipationEntry
                          // always has one, the poll's TracerouteData never
                          // does — so this alone distinguishes them. A
                          // statistical pick has no row id at all (S3).
                          selectedId={showStatistical ? null : (displayedTrace.id ?? null)}
                          onSelect={id => setPick({ kind: 'entry', id })}
                          nodes={nodes}
                          timeFormat={timeFormat}
                          dateFormat={dateFormat}
                          statistical={statistical ? { totalRoutes: statistical.totalRoutes } : undefined}
                          statisticalSelected={showStatistical}
                          onSelectStatistical={() => setPick({ kind: 'statistical' })}
                        />
                        {showStatistical && statistical ? (
                          <TracerouteStrip
                            graph={statistical.graph}
                            meta={statistical.meta}
                            timeFormat={timeFormat}
                            dateFormat={dateFormat}
                            distanceUnit={distanceUnit}
                            onOpenNodeDetails={handleStripNodeDetails}
                          />
                        ) : stripGraph && stripMeta && !stripGraph.isEmpty ? (
                          // Always renders at default size (#4381 follow-up):
                          // narrow panels are handled by `.scroller`'s
                          // horizontal scroll, not a width heuristic.
                          <TracerouteStrip
                            graph={stripGraph}
                            meta={stripMeta}
                            timeFormat={timeFormat}
                            dateFormat={dateFormat}
                            distanceUnit={distanceUnit}
                            onOpenNodeDetails={handleStripNodeDetails}
                          />
                        ) : (
                          <div className="traceroute-route">
                            {t('messages.traceroute_no_response', 'No response received')}
                          </div>
                        )}
                        {/* S3: a statistical aggregate has no single return
                            leg to be missing — the whole notion doesn't apply. */}
                        {!showStatistical && stripGraph && !stripGraph.isEmpty && !stripGraph.hasReturn && (
                          <div className="traceroute-route">
                            {t('messages.traceroute_no_return_path', 'No return path data')}
                          </div>
                        )}
                        {!showStatistical && (
                          <TracerouteCopyLinks
                            route={displayedTrace.route}
                            routeBack={displayedTrace.routeBack}
                            snrTowards={displayedTrace.snrTowards}
                            snrBack={displayedTrace.snrBack}
                            fromNodeNum={Number(displayedTrace.fromNodeNum)}
                            toNodeNum={Number(displayedTrace.toNodeNum)}
                            nodes={nodes}
                          />
                        )}
                        {!showStatistical && (
                          <div className="traceroute-age">
                            {t('messages.last_traced', { time: ageStr })}
                            {isPending && (
                              <span className="traceroute-pending-badge" style={{
                                marginLeft: '0.5rem',
                                color: 'var(--color-warning)',
                                fontWeight: 'bold'
                              }}>
                                ({t('messages.traceroute_pending', 'Pending')})
                              </span>
                            )}
                            {isFailed && (
                              <span className="traceroute-failed-badge" style={{
                                marginLeft: '0.5rem',
                                color: 'var(--color-error)',
                                fontWeight: 'bold'
                              }}>
                                ({t('messages.traceroute_failed')})
                              </span>
                            )}
                          </div>
                        )}
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

              // Get most recent timestamp (normalize: old data in seconds, new in ms)
              const mostRecent = Math.max(...nodeNeighbors.map(n => n.timestamp < 10_000_000_000 ? n.timestamp * 1000 : n.timestamp));
              // Clamp at 0 so a future device-clock timestamp can't render a
              // negative "-1676m ago" (same guard as the traceroute age, #2768).
              const age = Math.max(0, Math.floor((Date.now() - mostRecent) / (1000 * 60)));
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
                      <span className="neighbor-info-age" style={{ marginLeft: '0.5rem', fontSize: '0.85em', color: 'var(--color-text-subtle)' }}>
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
                        backgroundColor: 'var(--color-surface)',
                        color: 'var(--color-text)',
                        border: '1px solid var(--color-surface-hover)',
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
                          borderBottom: idx < nodeNeighbors.length - 1 ? '1px solid var(--color-surface)' : 'none'
                        }}>
                          <span>{neighbor.neighborName || neighbor.neighborNodeId || `!${neighbor.neighborNodeNum.toString(16)}`}</span>
                          <span style={{ color: 'var(--color-text-subtle)' }}>
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
              {/* Center on Map (#4137: renamed from "Show on Map" — distinct from the
                  hide/show toggle's un-hide label of the same former text) */}
              {selectedNode?.position?.latitude != null && selectedNode?.position?.longitude != null && (
                <button
                  onClick={() => handleShowOnMap(selectedDMNode)}
                  style={{
                    flex: '1 1 auto',
                    minWidth: '120px',
                    padding: '0.5rem 1rem',
                    backgroundColor: 'var(--color-accent)',
                    color: 'var(--color-bg)',
                    border: 'none',
                    borderRadius: '4px',
                    cursor: 'pointer',
                    fontSize: '0.9rem'
                  }}
                >
                  <UiIcon name="target" /> {t('messages.center_on_map', 'Center on Map')}
                </button>
              )}

              {/* Traceroute - Split Button */}
              {!actionsReadOnly && hasPermission('traceroute', 'write') && (
                <div style={{ display: 'flex', flex: '1 1 auto', minWidth: '120px', position: 'relative' }}>
                  <button
                    onClick={() => handleTraceroute(selectedDMNode)}
                    disabled={connectionStatus !== 'connected' || tracerouteLoading === selectedDMNode || txDisabled}
                    title={txDisabled ? (txDisabledTooltip ?? t('tx_disabled.control_tooltip')) : undefined}
                    style={{
                      flex: 1,
                      padding: '0.5rem 1rem',
                      backgroundColor: 'var(--color-accent)',
                      color: 'var(--color-bg)',
                      border: 'none',
                      borderRadius: channels.length > 1 ? '4px 0 0 4px' : '4px',
                      cursor: connectionStatus !== 'connected' || tracerouteLoading === selectedDMNode || txDisabled ? 'not-allowed' : 'pointer',
                      opacity: connectionStatus !== 'connected' || tracerouteLoading === selectedDMNode || txDisabled ? 0.5 : 1,
                      fontSize: '0.9rem'
                    }}
                  >
                    {tracerouteLoading === selectedDMNode ? <span className="spinner"></span> : <UiIcon name="radioSignal" />} {t('messages.traceroute_button')}
                  </button>
                  {channels.length > 1 && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setShowTracerouteChannelDropdown(prev => !prev);
                      }}
                      disabled={connectionStatus !== 'connected' || tracerouteLoading === selectedDMNode || txDisabled}
                      title={txDisabled ? (txDisabledTooltip ?? t('tx_disabled.control_tooltip')) : t('messages.traceroute_channel')}
                      aria-label={t('messages.traceroute_channel')}
                      style={{
                        padding: '0.5rem 0.5rem',
                        backgroundColor: 'var(--color-accent)',
                        color: 'var(--color-bg)',
                        border: 'none',
                        borderLeft: '1px solid var(--color-bg)',
                        borderRadius: '0 4px 4px 0',
                        cursor: connectionStatus !== 'connected' || tracerouteLoading === selectedDMNode || txDisabled ? 'not-allowed' : 'pointer',
                        opacity: connectionStatus !== 'connected' || tracerouteLoading === selectedDMNode || txDisabled ? 0.5 : 1,
                        fontSize: '0.9rem'
                      }}
                    >
                      ▾
                    </button>
                  )}
                  {showTracerouteChannelDropdown && (
                    <div style={{
                      position: 'absolute',
                      top: '100%',
                      right: 0,
                      marginTop: '4px',
                      background: 'var(--color-surface)',
                      border: '1px solid var(--color-surface-active)',
                      borderRadius: '4px',
                      zIndex: 1000,
                      minWidth: '160px',
                      boxShadow: '0 4px 12px rgba(0, 0, 0, 0.3)'
                    }}>
                      {channels.map((ch) => (
                        <button
                          key={ch.id}
                          onClick={() => {
                            void handleTraceroute(selectedDMNode, ch.id);
                            setShowTracerouteChannelDropdown(false);
                          }}
                          style={{
                            display: 'block',
                            width: '100%',
                            padding: '0.5rem 1rem',
                            background: 'none',
                            border: 'none',
                            color: 'var(--color-text)',
                            cursor: 'pointer',
                            textAlign: 'left',
                            fontSize: '0.85rem'
                          }}
                          onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--color-surface-hover)')}
                          onMouseLeave={(e) => (e.currentTarget.style.background = 'none')}
                        >
                          {ch.name || `Channel ${ch.id}`}{ch.id === 0 ? ' (Primary)' : ''}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Exchange Node Info - Split Button */}
              {!actionsReadOnly && hasPermission('messages', 'write') && (
                <div style={{ display: 'flex', flex: '1 1 auto', minWidth: '120px', position: 'relative' }}>
                  <button
                    onClick={() => handleExchangeNodeInfo(selectedDMNode)}
                    disabled={connectionStatus !== 'connected' || nodeInfoLoading === selectedDMNode || txDisabled}
                    title={txDisabled ? (txDisabledTooltip ?? t('tx_disabled.control_tooltip')) : undefined}
                    style={{
                      flex: 1,
                      padding: '0.5rem 1rem',
                      backgroundColor: 'var(--color-accent)',
                      color: 'var(--color-bg)',
                      border: 'none',
                      borderRadius: channels.length > 1 ? '4px 0 0 4px' : '4px',
                      cursor: connectionStatus !== 'connected' || nodeInfoLoading === selectedDMNode || txDisabled ? 'not-allowed' : 'pointer',
                      opacity: connectionStatus !== 'connected' || nodeInfoLoading === selectedDMNode || txDisabled ? 0.5 : 1,
                      fontSize: '0.9rem'
                    }}
                  >
                    {nodeInfoLoading === selectedDMNode ? <span className="spinner"></span> : <UiIcon name="key" />} {t('messages.exchange_node_info')}
                  </button>
                  {channels.length > 1 && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setShowNodeInfoChannelDropdown(prev => !prev);
                      }}
                      disabled={connectionStatus !== 'connected' || nodeInfoLoading === selectedDMNode || txDisabled}
                      title={txDisabled ? (txDisabledTooltip ?? t('tx_disabled.control_tooltip')) : t('messages.exchange_node_info_channel')}
                      aria-label={t('messages.exchange_node_info_channel')}
                      style={{
                        padding: '0.5rem 0.5rem',
                        backgroundColor: 'var(--color-accent)',
                        color: 'var(--color-bg)',
                        border: 'none',
                        borderLeft: '1px solid var(--color-bg)',
                        borderRadius: '0 4px 4px 0',
                        cursor: connectionStatus !== 'connected' || nodeInfoLoading === selectedDMNode || txDisabled ? 'not-allowed' : 'pointer',
                        opacity: connectionStatus !== 'connected' || nodeInfoLoading === selectedDMNode || txDisabled ? 0.5 : 1,
                        fontSize: '0.9rem'
                      }}
                    >
                      ▾
                    </button>
                  )}
                  {showNodeInfoChannelDropdown && (
                    <div style={{
                      position: 'absolute',
                      top: '100%',
                      right: 0,
                      marginTop: '4px',
                      background: 'var(--color-surface)',
                      border: '1px solid var(--color-surface-active)',
                      borderRadius: '4px',
                      zIndex: 1000,
                      minWidth: '160px',
                      boxShadow: '0 4px 12px rgba(0, 0, 0, 0.3)'
                    }}>
                      {channels.map((ch) => (
                        <button
                          key={ch.id}
                          onClick={() => {
                            void handleExchangeNodeInfo(selectedDMNode, ch.id);
                            setShowNodeInfoChannelDropdown(false);
                          }}
                          style={{
                            display: 'block',
                            width: '100%',
                            padding: '0.5rem 1rem',
                            background: 'none',
                            border: 'none',
                            color: 'var(--color-text)',
                            cursor: 'pointer',
                            textAlign: 'left',
                            fontSize: '0.85rem'
                          }}
                          onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--color-surface-hover)')}
                          onMouseLeave={(e) => (e.currentTarget.style.background = 'none')}
                        >
                          {ch.name || `Channel ${ch.id}`}{ch.id === 0 ? ' (Primary)' : ''}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Exchange Position - Split Button */}
              {!actionsReadOnly && hasPermission('messages', 'write') && (
                <div style={{ display: 'flex', flex: '1 1 auto', minWidth: '120px', position: 'relative' }}>
                  <button
                    onClick={() => handleExchangePosition(selectedDMNode)}
                    disabled={connectionStatus !== 'connected' || positionLoading === selectedDMNode || txDisabled}
                    title={txDisabled ? (txDisabledTooltip ?? t('tx_disabled.control_tooltip')) : undefined}
                    style={{
                      flex: 1,
                      padding: '0.5rem 1rem',
                      backgroundColor: 'var(--color-accent)',
                      color: 'var(--color-bg)',
                      border: 'none',
                      borderRadius: channels.length > 1 ? '4px 0 0 4px' : '4px',
                      cursor: connectionStatus !== 'connected' || positionLoading === selectedDMNode || txDisabled ? 'not-allowed' : 'pointer',
                      opacity: connectionStatus !== 'connected' || positionLoading === selectedDMNode || txDisabled ? 0.5 : 1,
                      fontSize: '0.9rem'
                    }}
                  >
                    {positionLoading === selectedDMNode ? <span className="spinner"></span> : <UiIcon name="location" />} {t('messages.exchange_position')}
                  </button>
                  {channels.length > 1 && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setShowPositionChannelDropdown(prev => !prev);
                      }}
                      disabled={connectionStatus !== 'connected' || positionLoading === selectedDMNode || txDisabled}
                      title={txDisabled ? (txDisabledTooltip ?? t('tx_disabled.control_tooltip')) : t('messages.exchange_position_channel')}
                      aria-label={t('messages.exchange_position_channel')}
                      style={{
                        padding: '0.5rem 0.5rem',
                        backgroundColor: 'var(--color-accent)',
                        color: 'var(--color-bg)',
                        border: 'none',
                        borderLeft: '1px solid var(--color-bg)',
                        borderRadius: '0 4px 4px 0',
                        cursor: connectionStatus !== 'connected' || positionLoading === selectedDMNode || txDisabled ? 'not-allowed' : 'pointer',
                        opacity: connectionStatus !== 'connected' || positionLoading === selectedDMNode || txDisabled ? 0.5 : 1,
                        fontSize: '0.9rem'
                      }}
                    >
                      ▾
                    </button>
                  )}
                  {showPositionChannelDropdown && (
                    <div style={{
                      position: 'absolute',
                      top: '100%',
                      right: 0,
                      marginTop: '4px',
                      background: 'var(--color-surface)',
                      border: '1px solid var(--color-surface-active)',
                      borderRadius: '4px',
                      zIndex: 1000,
                      minWidth: '160px',
                      boxShadow: '0 4px 12px rgba(0, 0, 0, 0.3)'
                    }}>
                      {channels.map((ch) => (
                        <button
                          key={ch.id}
                          onClick={() => {
                            void handleExchangePosition(selectedDMNode, ch.id);
                            setShowPositionChannelDropdown(false);
                          }}
                          style={{
                            display: 'block',
                            width: '100%',
                            padding: '0.5rem 1rem',
                            background: 'none',
                            border: 'none',
                            color: 'var(--color-text)',
                            cursor: 'pointer',
                            textAlign: 'left',
                            fontSize: '0.85rem'
                          }}
                          onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--color-surface-hover)')}
                          onMouseLeave={(e) => (e.currentTarget.style.background = 'none')}
                        >
                          {ch.name || `Channel ${ch.id}`}{ch.id === 0 ? ' (Primary)' : ''}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Request Neighbor Info */}
              {!actionsReadOnly && hasPermission('traceroute', 'write') && (
                <button
                  onClick={() => handleRequestNeighborInfo(selectedDMNode)}
                  disabled={connectionStatus !== 'connected' || neighborInfoLoading === selectedDMNode || txDisabled}
                  title={txDisabled ? (txDisabledTooltip ?? t('tx_disabled.control_tooltip')) : undefined}
                  style={{
                    flex: '1 1 auto',
                    minWidth: '120px',
                    padding: '0.5rem 1rem',
                    backgroundColor: 'var(--color-accent)',
                    color: 'var(--color-bg)',
                    border: 'none',
                    borderRadius: '4px',
                    cursor: connectionStatus !== 'connected' || neighborInfoLoading === selectedDMNode || txDisabled ? 'not-allowed' : 'pointer',
                    opacity: connectionStatus !== 'connected' || neighborInfoLoading === selectedDMNode || txDisabled ? 0.5 : 1,
                    fontSize: '0.9rem'
                  }}
                >
                  {neighborInfoLoading === selectedDMNode ? <span className="spinner"></span> : <UiIcon name="home" />} {t('messages.request_neighbor_info')}
                </button>
              )}
            </div>

            {selectedNode && (
              <NodeDetailsBlock
                node={selectedNode}
                timeFormat={timeFormat}
                dateFormat={dateFormat}
                sourceId={sourceId}
                canEditNotes={hasPermission('nodes', 'write')}
                onSaveNotes={async (notes) => {
                  if (!selectedNode.user?.id) throw new Error('Node has no ID');
                  await apiService.setNodeNotes(selectedNode.user.id, notes, sourceId);
                  showToast(t('node_details.notes_saved', 'Notes saved'), 'success');
                }}
              />
            )}

            {/* Security Details Section */}
            {selectedNode &&
              (selectedNode.keyIsLowEntropy || selectedNode.duplicateKeyDetected || selectedNode.keySecurityIssueDetails) && (
                <div className="node-details-block" style={{ marginTop: '1rem' }}>
                  <h3 className="node-details-title" style={{ color: '#f44336' }}>
                    <UiIcon name="alert" /> {t('messages.security_issue_title')}
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
                showTimeRangeSelector
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

      {/* Unified Message Details modal (#4816 follow-up) — both the sent
          delivery-status icon and the hop/⏱ badge open this one popup. */}
      {detailsState && (
        <MessageDetailsModal
          protocol="meshtastic"
          direction={detailsState.direction}
          sourceId={sourceId ?? ''}
          message={detailsState.message}
          nodes={mappedNodes}
          onNodeClick={(nodeId) => {
            setDetailsState(null);
            handleSenderClick(nodeId, { stopPropagation: () => {} } as React.MouseEvent);
          }}
          onClose={() => setDetailsState(null)}
        />
      )}

      {/* Telemetry request modal */}
      {showTelemetryRequestModal && selectedDMNode && (
        <TelemetryRequestModal
          isOpen={showTelemetryRequestModal}
          onClose={() => setShowTelemetryRequestModal(false)}
          onRequest={(telemetryType: TelemetryType) => {
            void handleRequestTelemetry(selectedDMNode, telemetryType);
            setShowTelemetryRequestModal(false);
          }}
          loading={telemetryRequestLoading === selectedDMNode}
          nodeName={selectedNode?.user?.longName || selectedNode?.user?.shortName || selectedDMNode}
        />
      )}

      {/* Copy NodeInfo from Another Source modal */}
      <CopyNodeInfoModal
        isOpen={showCopyNodeInfoModal}
        nodeNum={selectedNode?.nodeNum ?? null}
        currentNode={selectedNode ? {
          longName: selectedNode.user?.longName,
          shortName: selectedNode.user?.shortName,
          hwModel: selectedNode.user?.hwModel,
          role: selectedNode.user?.role != null ? Number(selectedNode.user.role) : null,
          publicKey: selectedNode.user?.publicKey,
          // #4244: see NodesTab — all eight diffed fields must be passed.
          macaddr: selectedNode.user?.macaddr,
          hasPKC: selectedNode.user?.hasPKC,
          firmwareVersion: selectedNode.user?.firmwareVersion,
        } : null}
        onClose={() => setShowCopyNodeInfoModal(false)}
        onCopied={() => setShowCopyNodeInfoModal(false)}
      />
    </div>
  );
};

export default MessagesTab;
