/**
 * MessagesTab - Direct Messages conversation view
 *
 * Extracted from App.tsx to improve maintainability.
 * Handles the Messages/DM tab with node list and conversation view.
 */

import React, { useRef, useCallback } from 'react';
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
import { getUtf8ByteLength, formatByteCount } from '../utils/text';
import { renderMessageWithLinks } from '../utils/linkRenderer';
import { isNodeComplete } from '../utils/nodeHelpers';
import HopCountDisplay from './HopCountDisplay';
import LinkPreview from './LinkPreview';
import NodeDetailsBlock from './NodeDetailsBlock';
import TelemetryGraphs from './TelemetryGraphs';
import { NodeFilterPopup } from './NodeFilterPopup';
import { MessageStatusIndicator } from './MessageStatusIndicator';

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
  nodeFilter: string;
  setNodeFilter: (filter: string) => void;
  dmFilter: 'all' | 'unread' | 'recent';
  setDmFilter: (filter: 'all' | 'unread' | 'recent') => void;
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
  handleTraceroute: (nodeId: string) => Promise<void>;
  handleExchangePosition: (nodeId: string) => Promise<void>;
  handleDeleteMessage: (message: MeshMessage) => Promise<void>;
  handleSenderClick: (nodeId: string, event: React.MouseEvent) => void;
  handleSendTapback: (emoji: string, message: MeshMessage) => void;
  getRecentTraceroute: (nodeId: string) => TracerouteData | null;

  // Modal controls
  setShowTracerouteHistoryModal: (show: boolean) => void;
  setShowPurgeDataModal: (show: boolean) => void;
  setEmojiPickerMessage: (message: MeshMessage | null) => void;

  // Helper function
  shouldShowData: () => boolean;
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
  nodeFilter,
  setNodeFilter,
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
  timeFormat,
  dateFormat,
  temperatureUnit,
  telemetryVisualizationHours,
  distanceUnit,
  baseUrl,
  hasPermission,
  handleSendDirectMessage,
  handleTraceroute,
  handleExchangePosition,
  handleDeleteMessage,
  handleSenderClick,
  handleSendTapback,
  getRecentTraceroute,
  setShowTracerouteHistoryModal,
  setShowPurgeDataModal,
  setEmojiPickerMessage,
  shouldShowData,
}) => {
  // Refs
  const dmMessagesContainerRef = useRef<HTMLDivElement>(null);
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

  // Permission check
  if (!hasPermission('messages', 'read')) {
    return (
      <div className="no-permission-message">
        <p>
          You need <strong>messages:read</strong> permission to view direct messages.
        </p>
      </div>
    );
  }

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

  // Sort and filter nodes
  const sortedNodesWithMessages = [...nodesWithMessages]
    .sort((a, b) => {
      if (a.isFavorite && !b.isFavorite) return -1;
      if (!a.isFavorite && b.isFavorite) return 1;
      return b.lastMessageTime - a.lastMessageTime;
    })
    .filter(node => {
      if (dmFilter === 'unread') {
        return node.unreadCount > 0;
      } else if (dmFilter === 'recent') {
        const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
        return node.lastMessageTime > oneDayAgo;
      }
      return true;
    });

  // Filter for display
  const filteredNodes = sortedNodesWithMessages.filter(node => {
    if (securityFilter === 'flaggedOnly') {
      if (!node.keyIsLowEntropy && !node.duplicateKeyDetected) return false;
    } else if (securityFilter === 'hideFlagged') {
      if (node.keyIsLowEntropy || node.duplicateKeyDetected) return false;
    }
    if (!showIncompleteNodes && !isNodeComplete(node)) {
      return false;
    }
    if (channelFilter !== 'all') {
      const nodeChannel = node.channel ?? 0;
      if (nodeChannel !== channelFilter) return false;
    }
    if (!nodeFilter) return true;
    const searchTerm = nodeFilter.toLowerCase();
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
            title={isMessagesNodeListCollapsed ? 'Expand node list' : 'Collapse node list'}
          >
            {isMessagesNodeListCollapsed ? '▶' : '◀'}
          </button>
          {!isMessagesNodeListCollapsed && (
            <div className="sidebar-header-content">
              <h3>Nodes</h3>
              <button
                className="mark-all-read-btn"
                onClick={() => markMessagesAsRead(undefined, undefined, undefined, true)}
                title="Mark all direct messages as read"
              >
                Mark All Read
              </button>
            </div>
          )}
          {!isMessagesNodeListCollapsed && (
            <div className="node-controls">
              <input
                type="text"
                placeholder="Filter nodes..."
                value={nodeFilter}
                onChange={e => setNodeFilter(e.target.value)}
                className="filter-input-small"
              />
              <div className="sort-controls">
                <select
                  value={dmFilter}
                  onChange={e => setDmFilter(e.target.value as 'all' | 'unread' | 'recent')}
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
                          <span className="node-name-text">{node.user?.longName || `Node ${node.nodeNum}`}</span>
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
                                cursor: 'help',
                              }}
                            >
                              ⚠️
                            </span>
                          )}
                          <div className="node-short">{node.user?.shortName || '-'}</div>
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
                            {node.lastMessageText || 'No messages'}
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
                            <span className="stat" title="Total Messages">
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

                      <div className="node-indicators">
                        {node.position && node.position.latitude != null && node.position.longitude != null && (
                          <div className="node-location" title="Location">
                            📍 {node.position.latitude.toFixed(3)}, {node.position.longitude.toFixed(3)}
                            {node.isMobile && (
                              <span title="Mobile Node (position varies > 1km)" style={{ marginLeft: '4px' }}>
                                🚶
                              </span>
                            )}
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
            <option value="">Select a conversation...</option>
            {sortedNodesWithMessages
              .filter(node => {
                if (!showIncompleteNodes && !isNodeComplete(node)) return false;
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
                  Conversation with {getNodeName(selectedDMNode)}
                  {selectedNode?.lastHeard && (
                    <div style={{ fontSize: '0.75em', fontWeight: 'normal', color: '#888', marginTop: '4px' }}>
                      Last seen: {formatDateTime(new Date(selectedNode.lastHeard * 1000), timeFormat, dateFormat)}
                    </div>
                  )}
                </h3>
                <button
                  className="btn btn-secondary"
                  onClick={() => markMessagesAsRead(undefined, undefined, selectedDMNode)}
                  title="Mark all messages in this conversation as read"
                  style={{ padding: '0.5rem 1rem', fontSize: '0.9rem', whiteSpace: 'nowrap' }}
                >
                  Mark all as Read
                </button>
              </div>
            </div>

            {/* Security Warning Bar */}
            {selectedNode && (selectedNode.keyIsLowEntropy || selectedNode.duplicateKeyDetected) && (
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
                ⚠️ This node is a security risk
              </div>
            )}

            {/* Messages Container */}
            <div className="messages-container" ref={dmMessagesContainerRef}>
              {selectedDMMessages.length > 0 ? (
                selectedDMMessages.map((msg, index) => {
                  const isTraceroute = msg.portnum === 70;
                  const isMine = isMyMessage(msg);
                  const isReaction = msg.emoji === 1;

                  if (isReaction) return null;

                  const reactions = selectedDMMessages.filter(
                    m => m.emoji === 1 && m.replyId && m.replyId.toString() === msg.id.split('_')[1]
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
                              <HopCountDisplay hopStart={msg.hopStart} hopLimit={msg.hopLimit} />
                            </span>
                            <span className="traceroute-badge">TRACEROUTE</span>
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
                      <div className={`message-bubble-container ${isMine ? 'mine' : 'theirs'}`}>
                        {!isMine && (
                          <div
                            className="sender-dot clickable"
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
                                    <div className="reply-text">{repliedMessage.text || 'Empty Message'}</div>
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
                            <div className="message-text" style={{ whiteSpace: 'pre-line' }}>
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
                        {isMine && <div className="message-status"><MessageStatusIndicator message={msg} /></div>}
                      </div>
                    </React.Fragment>
                  );
                })
              ) : (
                <p className="no-messages">No direct messages with this node yet</p>
              )}
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
                    <button className="reply-indicator-close" onClick={() => setReplyingTo(null)} title="Cancel reply">
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
                        placeholder={`Send direct message to ${getNodeName(selectedDMNode)}...`}
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

            {/* Traceroute and Purge Section */}
            <div style={{ marginTop: '1rem' }}>
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
                      {tracerouteLoading === selectedDMNode && <span className="spinner"></span>}
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
                    {positionLoading === selectedDMNode && <span className="spinner"></span>}
                  </button>
                )}
                {hasPermission('messages', 'write') && (
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
                      fontWeight: 'bold',
                    }}
                  >
                    🗑️ Purge Data
                  </button>
                )}
              </div>

              {/* Traceroute Display */}
              {hasPermission('traceroute', 'write') &&
                (() => {
                  const recentTrace = getRecentTraceroute(selectedDMNode);
                  if (recentTrace) {
                    const age = Math.floor((Date.now() - recentTrace.timestamp) / (1000 * 60));
                    const ageStr = age < 60 ? `${age}m ago` : `${Math.floor(age / 60)}h ago`;

                    return (
                      <div className="traceroute-info" style={{ marginTop: '1rem' }}>
                        <div className="traceroute-route">
                          <strong>→ Forward:</strong>{' '}
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
                          <strong>← Return:</strong>{' '}
                          {formatTracerouteRoute(
                            recentTrace.routeBack,
                            recentTrace.snrBack,
                            recentTrace.toNodeNum,
                            recentTrace.fromNodeNum,
                            nodes,
                            distanceUnit
                          )}
                        </div>
                        <div className="traceroute-age">Last traced {ageStr}</div>
                      </div>
                    );
                  }
                  return null;
                })()}
            </div>

            {selectedNode && <NodeDetailsBlock node={selectedNode} timeFormat={timeFormat} dateFormat={dateFormat} />}

            {/* Security Details Section */}
            {selectedNode &&
              (selectedNode.keyIsLowEntropy || selectedNode.duplicateKeyDetected) &&
              selectedNode.keySecurityIssueDetails && (
                <div className="node-details-block" style={{ marginTop: '1rem' }}>
                  <h3 className="node-details-title" style={{ color: '#f44336' }}>
                    ⚠️ Security Issue
                  </h3>
                  <div className="node-details-grid">
                    <div className="node-detail-card" style={{ gridColumn: '1 / -1', borderLeft: '4px solid #f44336' }}>
                      <div className="node-detail-label">Issue Details</div>
                      <div className="node-detail-value" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                        {selectedNode.keyIsLowEntropy && 'This node uses a known low-entropy cryptographic key. '}
                        {selectedNode.duplicateKeyDetected &&
                          (() => {
                            const match = selectedNode.keySecurityIssueDetails?.match(/nodes?: ([\d, ]+)/);
                            const sharedNodeNums = match ? match[1].split(',').map(s => parseInt(s.trim(), 10)) : [];
                            if (sharedNodeNums.length === 0) return null;

                            return (
                              <>
                                This key is shared with:{' '}
                                {sharedNodeNums.map((nodeNum, idx) => {
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
                                          font: 'inherit',
                                        }}
                                        title={`Switch to ${displayName}`}
                                      >
                                        {displayName} ({shortName})
                                      </button>
                                    </span>
                                  );
                                })}
                              </>
                            );
                          })()}
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

export default MessagesTab;
