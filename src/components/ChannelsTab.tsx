/**
 * ChannelsTab - Channel messaging view
 *
 * Extracted from App.tsx to improve maintainability.
 * Handles the Channels tab with channel selection and messaging.
 */

import React, { useRef, useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Channel } from '../types/device';
import { MeshMessage } from '../types/message';
import { ResourceType } from '../types/permission';
import { TimeFormat, DateFormat } from '../contexts/SettingsContext';
import apiService, { type ChannelDatabaseEntry } from '../services/api';
import { formatMessageTime, getMessageDateSeparator, shouldShowDateSeparator } from '../utils/datetime';
import { getUtf8ByteLength, formatByteCount, isEmoji } from '../utils/text';
import { renderMessageWithLinks } from '../utils/linkRenderer';
import HopCountDisplay from './HopCountDisplay';
import LinkPreview from './LinkPreview';
import RelayNodeModal from './RelayNodeModal';
import { logger } from '../utils/logger';
import { MessageStatusIndicator } from './MessageStatusIndicator';
import { useNodes } from '../hooks/useServerData';

// Default PSK value (publicly known key - not truly secure)
const DEFAULT_PUBLIC_PSK = 'AQ==';

// Offset for Channel Database channels
// IMPORTANT: This value must match CHANNEL_DB_OFFSET in src/server/constants/meshtastic.ts
// Device channels use indices 0-7, database channels start at 100
const CHANNEL_DB_OFFSET = 100;

// Encryption status types
type EncryptionStatus = 'none' | 'default' | 'secure';

// Helper to determine encryption status
const getEncryptionStatus = (psk: string | undefined | null): EncryptionStatus => {
  if (!psk || psk === '') {
    return 'none'; // No encryption
  }
  if (psk === DEFAULT_PUBLIC_PSK) {
    return 'default'; // Default/public key - not secure
  }
  return 'secure'; // Custom key - encrypted
};

export interface ChannelsTabProps {
  // Data
  channels: Channel[];
  channelDatabaseEntries: ChannelDatabaseEntry[];
  channelMessages: Record<number, MeshMessage[]>;
  messages: MeshMessage[];
  currentNodeId: string;

  // Connection state
  connectionStatus: string;

  // Channel selection
  selectedChannel: number;
  setSelectedChannel: (channel: number) => void;
  selectedChannelRef: React.MutableRefObject<number>;

  // MQTT filter
  showMqttMessages: boolean;
  setShowMqttMessages: (show: boolean) => void;

  // Message input
  newMessage: string;
  setNewMessage: (message: string) => void;
  replyingTo: MeshMessage | null;
  setReplyingTo: (message: MeshMessage | null) => void;

  // Unread tracking
  unreadCounts: Record<number, number>;
  setUnreadCounts: (updater: (prev: Record<number, number>) => Record<number, number>) => void;
  markMessagesAsRead: (
    messageIds?: string[],
    channelId?: number,
    dmNodeId?: string,
    markAllDMs?: boolean
  ) => Promise<void>;

  // Modal state
  channelInfoModal: number | null;
  setChannelInfoModal: (channelId: number | null) => void;
  showPsk: boolean;
  setShowPsk: (show: boolean) => void;

  // Settings
  timeFormat: TimeFormat;
  dateFormat: DateFormat;

  // Permission check
  hasPermission: (resource: ResourceType, action: 'read' | 'write') => boolean;

  // Handlers
  handleSendMessage: (channel: number) => Promise<void>;
  handleResendMessage: (message: MeshMessage) => Promise<void>;
  handleDeleteMessage: (message: MeshMessage) => Promise<void>;
  handleSendTapback: (emoji: string, message: MeshMessage) => void;
  handlePurgeChannelMessages: (channelId: number) => Promise<void>;
  handleSenderClick: (nodeId: string, event: React.MouseEvent) => void;

  // Helper functions
  shouldShowData: () => boolean;
  getNodeName: (nodeId: string) => string;
  getNodeShortName: (nodeId: string) => string;
  isMqttBridgeMessage: (msg: MeshMessage) => boolean;

  // Emoji picker
  setEmojiPickerMessage: (message: MeshMessage | null) => void;

  // Refs from parent for scroll handling
  channelMessagesContainerRef: React.RefObject<HTMLDivElement | null>;
}

export default function ChannelsTab({
  channels,
  channelDatabaseEntries,
  channelMessages,
  messages,
  currentNodeId,
  connectionStatus,
  selectedChannel,
  setSelectedChannel,
  selectedChannelRef,
  showMqttMessages,
  setShowMqttMessages,
  newMessage,
  setNewMessage,
  replyingTo,
  setReplyingTo,
  unreadCounts,
  setUnreadCounts,
  markMessagesAsRead,
  channelInfoModal,
  setChannelInfoModal,
  showPsk,
  setShowPsk,
  timeFormat,
  dateFormat,
  hasPermission,
  handleSendMessage,
  handleResendMessage,
  handleDeleteMessage,
  handleSendTapback,
  handlePurgeChannelMessages,
  handleSenderClick,
  shouldShowData,
  getNodeName,
  getNodeShortName,
  isMqttBridgeMessage,
  setEmojiPickerMessage,
  channelMessagesContainerRef,
}: ChannelsTabProps) {
  const { t } = useTranslation();
  const { nodes } = useNodes();

  // Refs
  const channelMessageInputRef = useRef<HTMLInputElement>(null);

  // State for "Jump to Bottom" button
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);

  // Virtual Channel info modal state
  const [virtualChannelInfoModal, setVirtualChannelInfoModal] = useState<ChannelDatabaseEntry | null>(null);

  // Relay node modal state
  const [relayModalOpen, setRelayModalOpen] = useState(false);
  const [selectedRelayNode, setSelectedRelayNode] = useState<number | null>(null);
  const [selectedRxTime, setSelectedRxTime] = useState<Date | undefined>(undefined);
  const [selectedMessageRssi, setSelectedMessageRssi] = useState<number | undefined>(undefined);
  const [directNeighborStats, setDirectNeighborStats] = useState<Record<number, { avgRssi: number; packetCount: number; lastHeard: number }>>({});

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

  // Handle scroll to detect if user has scrolled up
  const handleScroll = useCallback(() => {
    const container = channelMessagesContainerRef.current;
    if (!container) return;

    // Check if scrolled more than 100px from bottom
    const isNearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 100;
    setShowJumpToBottom(!isNearBottom);
  }, [channelMessagesContainerRef]);

  // Scroll to bottom function
  const scrollToBottom = useCallback(() => {
    const container = channelMessagesContainerRef.current;
    if (container) {
      container.scrollTo({
        top: container.scrollHeight,
        behavior: 'smooth'
      });
    }
  }, [channelMessagesContainerRef]);

  // Attach scroll listener
  useEffect(() => {
    const container = channelMessagesContainerRef.current;
    if (container) {
      container.addEventListener('scroll', handleScroll);
      return () => container.removeEventListener('scroll', handleScroll);
    }
  }, [channelMessagesContainerRef, handleScroll]);

  // Helper: get channel name
  const getChannelName = (channelNum: number): string => {
    // First check device channels (0-7)
    const channel = channels.find(ch => ch.id === channelNum);
    if (channel) {
      return channel.name;
    }
    // For channels >= CHANNEL_DB_OFFSET, check Channel Database entries
    // Channel number = CHANNEL_DB_OFFSET + Channel Database entry ID
    if (channelNum >= CHANNEL_DB_OFFSET && channelDatabaseEntries.length > 0) {
      const channelDbId = channelNum - CHANNEL_DB_OFFSET;
      const dbChannel = channelDatabaseEntries.find(entry => entry.id === channelDbId);
      if (dbChannel) {
        return dbChannel.name;
      }
    }
    return t('channels.channel_fallback', { channelNum });
  };

  // Helper: get available channels
  const getAvailableChannels = (): number[] => {
    const channelSet = new Set<number>();

    // Add channels from channel configurations first (these are authoritative)
    channels.forEach(ch => channelSet.add(ch.id));

    // Add virtual channels from Channel Database
    channelDatabaseEntries.forEach(entry => {
      channelSet.add(CHANNEL_DB_OFFSET + entry.id);
    });

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

  // Helper: check if message is mine
  const isMyMessage = (msg: MeshMessage): boolean => {
    return msg.from === currentNodeId || msg.isLocalMessage === true;
  };

  // Helper: find message by ID in channel
  const findMessageById = (messageId: number, channelId: number): MeshMessage | null => {
    const messagesForChannel = channelMessages[channelId] || [];
    return (
      messagesForChannel.find(msg => {
        const msgIdNum = parseInt(msg.id.split('_')[1] || '0');
        return msgIdNum === messageId;
      }) || null
    );
  };

  // Get selected channel config for modal
  const selectedChannelConfig =
    channelInfoModal !== null ? channels.find(ch => ch.id === channelInfoModal) || null : null;

  // Handle info link click - opens appropriate modal based on channel type
  const handleInfoLinkClick = useCallback((channelId: number) => {
    if (channelId >= CHANNEL_DB_OFFSET) {
      // Virtual channel from Channel Database
      const channelDbId = channelId - CHANNEL_DB_OFFSET;
      const dbChannel = channelDatabaseEntries.find(entry => entry.id === channelDbId);
      if (dbChannel) {
        setVirtualChannelInfoModal(dbChannel);
      }
    } else {
      // Device channel
      setChannelInfoModal(channelId);
    }
  }, [channelDatabaseEntries, setChannelInfoModal]);

  const availableChannels = getAvailableChannels();

  return (
    <div className="tab-content channels-tab-content">
      <div className="channels-header">
        <h2>{t('channels.title_with_count', { count: availableChannels.length })}</h2>
        <div className="channels-controls">
          <label className="mqtt-toggle">
            <input type="checkbox" checked={showMqttMessages} onChange={e => setShowMqttMessages(e.target.checked)} />
            {t('channels.show_mqtt_messages')}
          </label>
        </div>
      </div>

      {shouldShowData() ? (
        availableChannels.length > 0 ? (
          <>
            {/* Channel Dropdown Selector */}
            <div className="channel-dropdown">
              <select
                className="channel-dropdown-select"
                value={selectedChannel}
                onChange={e => {
                  const channelId = parseInt(e.target.value);
                  logger.debug('👆 User selected channel from dropdown:', channelId);
                  setSelectedChannel(channelId);
                  selectedChannelRef.current = channelId;
                  setReplyingTo(null);
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
                  const encryptionStatus = getEncryptionStatus(channelConfig?.psk);
                  const uplink = channelConfig?.uplinkEnabled ? '↑' : '';
                  const downlink = channelConfig?.downlinkEnabled ? '↓' : '';
                  const encryptionIcon = encryptionStatus === 'secure' ? '🔒' : encryptionStatus === 'default' ? '🔐' : '🔓';

                  return (
                    <option key={channelId} value={channelId}>
                      {encryptionIcon} {displayName} #{channelId} {uplink}
                      {downlink} {unread > 0 ? `(${unread})` : ''}
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
                      selectedChannelRef.current = channelId;
                      setReplyingTo(null);
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
                          {(() => {
                            const status = getEncryptionStatus(channelConfig?.psk);
                            if (status === 'secure') {
                              return (
                                <span className="encryption-icon secure" title={t('channels.encrypted_secure')}>
                                  🔒
                                </span>
                              );
                            } else if (status === 'default') {
                              return (
                                <span className="encryption-icon default-key" title={t('channels.encrypted_default')}>
                                  🔐
                                </span>
                              );
                            } else {
                              return (
                                <span className="encryption-icon unencrypted" title={t('channels.unencrypted')}>
                                  🔓
                                </span>
                              );
                            }
                          })()}
                          <a
                            href="#"
                            className="channel-info-link"
                            onClick={e => {
                              e.preventDefault();
                              e.stopPropagation();
                              handleInfoLinkClick(channelId);
                            }}
                            title={t('channels.show_channel_info')}
                          >
                            {t('channels.info_link')}
                          </a>
                        </div>
                      </div>
                      <div className="channel-button-right">
                        {unreadCounts[channelId] > 0 && <span className="unread-badge">{unreadCounts[channelId]}</span>}
                        <div className="channel-button-status">
                          <span
                            className={`arrow-icon uplink ${channelConfig?.uplinkEnabled ? 'enabled' : 'disabled'}`}
                            title={t('channels.mqtt_uplink')}
                          >
                            ↑
                          </span>
                          <span
                            className={`arrow-icon downlink ${channelConfig?.downlinkEnabled ? 'enabled' : 'disabled'}`}
                            title={t('channels.mqtt_downlink')}
                          >
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
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    marginBottom: '1rem',
                  }}
                >
                  <h3 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    {getChannelName(selectedChannel)}
                    <span className="channel-id-label">#{selectedChannel}</span>
                    <a
                      href="#"
                      className="channel-info-link"
                      onClick={e => {
                        e.preventDefault();
                        handleInfoLinkClick(selectedChannel);
                      }}
                      title={t('channels.show_channel_info')}
                      style={{ fontSize: '0.8rem' }}
                    >
                      {t('channels.info_link')}
                    </a>
                  </h3>
                  <button
                    className="btn btn-secondary"
                    onClick={() => {
                      markMessagesAsRead(undefined, selectedChannel);
                    }}
                    title={t('channels.mark_all_read_title')}
                    style={{
                      padding: '0.5rem 1rem',
                      fontSize: '0.9rem',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {t('channels.mark_all_read_button')}
                  </button>
                </div>

                {/* Read-only banner for Channel Database channels */}
                {selectedChannel >= CHANNEL_DB_OFFSET && (
                  <div
                    style={{
                      backgroundColor: 'var(--ctp-surface0)',
                      color: 'var(--ctp-blue)',
                      padding: '0.5rem 1rem',
                      borderRadius: '0.25rem',
                      marginBottom: '0.5rem',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.5rem',
                      fontSize: '0.9rem',
                    }}
                  >
                    <span>🔑</span>
                    <span>{t('channels.channel_database_readonly')}</span>
                  </div>
                )}

                <div className="channel-conversation">
                  <div className="messages-container" ref={channelMessagesContainerRef} style={{ position: 'relative' }}>
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
                            backgroundColor: 'var(--ctp-blue)',
                            border: 'none',
                            borderRadius: '20px',
                            cursor: 'pointer',
                            fontSize: '0.85rem',
                            color: 'var(--ctp-base)',
                            fontWeight: 'bold',
                            boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '0.5rem',
                          }}
                        >
                          <span>↓</span> {t('channels.jump_to_bottom', 'Jump to Bottom')}
                        </button>
                      </div>
                    )}
                    {(() => {
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
                      messagesForChannel = messagesForChannel.sort(
                        (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
                      );

                      return messagesForChannel && messagesForChannel.length > 0 ? (
                        messagesForChannel.map((msg, index) => {
                          const isMine = isMyMessage(msg);
                          const repliedMessage = msg.replyId ? findMessageById(msg.replyId, messageChannel) : null;
                          const isReaction = msg.emoji === 1 || (msg.replyId != null && isEmoji(msg.text));

                          // Hide reactions (tapbacks) from main message list
                          if (isReaction) {
                            return null;
                          }

                          // Find ALL reactions in the full channel message list
                          const allChannelMessages = channelMessages[messageChannel] || [];
                          const reactions = allChannelMessages.filter(
                            m => (m.emoji === 1 || isEmoji(m.text)) && m.replyId && m.replyId.toString() === msg.id.split('_')[1]
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
                              <div 
                                className={`message-bubble-container ${isMine ? 'mine' : 'theirs'}`}
                                data-message-id={msg.id}
                              >
                                {!isMine && (
                                  <div
                                    className={`sender-dot clickable ${isEmoji(getNodeShortName(msg.from)) ? 'is-emoji' : ''}`}
                                    title={t('channels.sender_click_title', { name: getNodeName(msg.from) })}
                                    onClick={e => handleSenderClick(msg.from, e)}
                                  >
                                    {getNodeShortName(msg.from)}
                                  </div>
                                )}
                                <div className="message-content">
                                  {!isMine && (
                                    <div className="sender-name">{getNodeName(msg.from)}</div>
                                  )}
                                  {msg.replyId && !isReaction && (
                                    <div className="replied-message">
                                      <div className="reply-arrow">↳</div>
                                      <div className="reply-content">
                                        {repliedMessage ? (
                                          <>
                                            <div className="reply-from">{getNodeShortName(repliedMessage.from)}</div>
                                            <div className="reply-text">{repliedMessage.text || t('channels.empty_message')}</div>
                                          </>
                                        ) : (
                                          <div className="reply-text" style={{ fontStyle: 'italic', opacity: 0.6 }}>
                                            {t('channels.message_unavailable')}
                                          </div>
                                        )}
                                      </div>
                                    </div>
                                  )}
                                  {hasPermission(`channel_${selectedChannel}` as ResourceType, 'write') && (
                                    <div className="message-actions">
                                      {/* Hide reply/resend for Channel Database channels (read-only) - device channels are 0-7 */}
                                      {selectedChannel >= 0 && selectedChannel < CHANNEL_DB_OFFSET && (
                                        isMine ? (
                                          <button
                                            className="resend-button"
                                            onClick={() => handleResendMessage(msg)}
                                            title={t('channels.resend_button_title')}
                                          >
                                            ↻
                                          </button>
                                        ) : (
                                          <button
                                            className="reply-button"
                                            onClick={() => {
                                              setReplyingTo(msg);
                                              channelMessageInputRef.current?.focus();
                                            }}
                                            title={t('channels.reply_button_title')}
                                          >
                                            ↩
                                          </button>
                                        )
                                      )}
                                      {/* Hide emoji reactions for Channel Database channels (read-only) */}
                                      {selectedChannel >= 0 && selectedChannel < CHANNEL_DB_OFFSET && (
                                        <button
                                          className="emoji-picker-button"
                                          onClick={() => setEmojiPickerMessage(msg)}
                                          title={t('channels.emoji_button_title')}
                                        >
                                          😄
                                        </button>
                                      )}
                                      <button
                                        className="delete-button"
                                        onClick={() => handleDeleteMessage(msg)}
                                        title={t('channels.delete_button_title')}
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
                                            title={t('channels.reaction_tooltip', { name: getNodeShortName(reaction.from) })}
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
                        <p className="no-messages">{t('channels.no_messages_yet')}</p>
                      );
                    })()}
                  </div>

                  {/* Send message form */}
                  {connectionStatus === 'connected' && (
                    <div className="send-message-form">
                      {replyingTo && (
                        <div className="reply-indicator">
                          <div className="reply-indicator-content">
                            <div className="reply-indicator-label">{t('channels.replying_to', { name: getNodeName(replyingTo.from) })}</div>
                            <div className="reply-indicator-text">{replyingTo.text}</div>
                          </div>
                          <button
                            className="reply-indicator-close"
                            onClick={() => setReplyingTo(null)}
                            title={t('channels.cancel_reply_title')}
                          >
                            ×
                          </button>
                        </div>
                      )}
                      {/* Hide message input for Channel Database channels (read-only) - device channels are 0-7 */}
                      {hasPermission(`channel_${selectedChannel}` as ResourceType, 'write') && selectedChannel >= 0 && selectedChannel < CHANNEL_DB_OFFSET && (
                        <div className="message-input-container">
                          <div className="input-with-counter">
                            <input
                              ref={channelMessageInputRef}
                              type="text"
                              value={newMessage}
                              onChange={e => setNewMessage(e.target.value)}
                              placeholder={t('channels.send_placeholder', { name: getChannelName(selectedChannel) })}
                              className="message-input"
                              onFocus={e => {
                                // On mobile, prevent iOS from scrolling the page excessively
                                // Use a small delay to let iOS do its thing, then reset scroll
                                setTimeout(() => {
                                  e.target.scrollIntoView({ block: 'end', behavior: 'smooth' });
                                }, 100);
                              }}
                              onKeyPress={e => {
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
              <p className="no-data">{t('channels.select_channel_prompt')}</p>
            )}
          </>
        ) : (
          <p className="no-data">{t('channels.no_configs_yet')}</p>
        )
      ) : (
        <p className="no-data">{t('channels.connect_to_view')}</p>
      )}

      {/* Channel Info Modal */}
      {channelInfoModal !== null &&
        selectedChannelConfig &&
        (() => {
          const displayName = selectedChannelConfig.name || getChannelName(channelInfoModal);
          const handleCloseModal = () => {
            setChannelInfoModal(null);
            setShowPsk(false);
          };

          return (
            <div className="modal-overlay" onClick={handleCloseModal}>
              <div className="modal-content channel-info-modal" onClick={e => e.stopPropagation()}>
                <div className="modal-header">
                  <h2>{t('channels.info_modal_title')}</h2>
                  <button className="modal-close" onClick={handleCloseModal}>
                    ×
                  </button>
                </div>
                <div className="modal-body">
                  <div className="channel-info-grid">
                    <div className="info-row">
                      <span className="info-label">{t('channels.channel_name')}</span>
                      <span className="info-value">{displayName}</span>
                    </div>
                    <div className="info-row">
                      <span className="info-label">{t('channels.channel_number')}</span>
                      <span className="info-value">#{channelInfoModal}</span>
                    </div>
                    <div className="info-row">
                      <span className="info-label">{t('channels.encryption')}</span>
                      <span className="info-value">
                        {(() => {
                          const status = getEncryptionStatus(selectedChannelConfig.psk);
                          if (status === 'secure') {
                            return <span className="status-secure">{t('channels.status_secure')}</span>;
                          } else if (status === 'default') {
                            return <span className="status-default-key">{t('channels.status_default_key')}</span>;
                          } else {
                            return <span className="status-unencrypted">{t('channels.status_unencrypted')}</span>;
                          }
                        })()}
                      </span>
                    </div>
                    {selectedChannelConfig.psk && (
                      <div className="info-row">
                        <span className="info-label">{t('channels.psk_base64')}</span>
                        <span
                          className="info-value info-value-code"
                          style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}
                        >
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
                              transition: 'all 0.2s',
                            }}
                            onMouseOver={e => (e.currentTarget.style.background = 'var(--ctp-surface2)')}
                            onMouseOut={e => (e.currentTarget.style.background = 'var(--ctp-surface1)')}
                          >
                            {showPsk ? t('channels.hide') : t('channels.show')}
                          </button>
                        </span>
                      </div>
                    )}
                    <div className="info-row">
                      <span className="info-label">{t('channels.mqtt_uplink')}:</span>
                      <span className="info-value">
                        {selectedChannelConfig.uplinkEnabled ? (
                          <span className="status-enabled">{t('channels.enabled')}</span>
                        ) : (
                          <span className="status-disabled">{t('channels.disabled')}</span>
                        )}
                      </span>
                    </div>
                    <div className="info-row">
                      <span className="info-label">{t('channels.mqtt_downlink')}:</span>
                      <span className="info-value">
                        {selectedChannelConfig.downlinkEnabled ? (
                          <span className="status-enabled">{t('channels.enabled')}</span>
                        ) : (
                          <span className="status-disabled">{t('channels.disabled')}</span>
                        )}
                      </span>
                    </div>
                    {selectedChannelConfig.createdAt && (
                      <div className="info-row">
                        <span className="info-label">{t('channels.discovered')}</span>
                        <span className="info-value">{new Date(selectedChannelConfig.createdAt).toLocaleString()}</span>
                      </div>
                    )}
                    {selectedChannelConfig.updatedAt && (
                      <div className="info-row">
                        <span className="info-label">{t('channels.last_updated')}</span>
                        <span className="info-value">{new Date(selectedChannelConfig.updatedAt).toLocaleString()}</span>
                      </div>
                    )}
                  </div>
                  {hasPermission(`channel_${channelInfoModal}` as ResourceType, 'write') && channelInfoModal !== -1 && (
                    <div
                      style={{
                        marginTop: '1.5rem',
                        paddingTop: '1rem',
                        borderTop: '1px solid var(--ctp-surface2)',
                      }}
                    >
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
                          fontSize: '0.95rem',
                        }}
                        title={t('channels.purge_messages_title')}
                      >
                        {t('channels.purge_all_messages')}
                      </button>
                      <p
                        style={{
                          marginTop: '0.5rem',
                          fontSize: '0.85rem',
                          color: 'var(--ctp-subtext0)',
                          textAlign: 'center',
                        }}
                      >
                        {t('channels.cannot_undo')}
                      </p>
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })()}

      {/* Virtual Channel Info Modal */}
      {virtualChannelInfoModal && (
        <div className="modal-overlay" onClick={() => setVirtualChannelInfoModal(null)}>
          <div className="modal-content channel-info-modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>{t('channels.virtual_channel_info_title', 'Virtual Channel Info')}</h2>
              <button className="modal-close" onClick={() => setVirtualChannelInfoModal(null)}>
                ×
              </button>
            </div>
            <div className="modal-body">
              <div className="channel-info-grid">
                <div className="info-row">
                  <span className="info-label">{t('channels.channel_name')}</span>
                  <span className="info-value">{virtualChannelInfoModal.name}</span>
                </div>
                <div className="info-row">
                  <span className="info-label">{t('channels.channel_number')}</span>
                  <span className="info-value">#{CHANNEL_DB_OFFSET + virtualChannelInfoModal.id}</span>
                </div>
                <div className="info-row">
                  <span className="info-label">{t('channels.encryption')}</span>
                  <span className="info-value">
                    {(() => {
                      const status = getEncryptionStatus(virtualChannelInfoModal.psk);
                      if (status === 'secure') {
                        return <span className="status-secure">{t('channels.status_secure')}</span>;
                      } else if (status === 'default') {
                        return <span className="status-default-key">{t('channels.status_default_key')}</span>;
                      } else {
                        return <span className="status-unencrypted">{t('channels.status_unencrypted')}</span>;
                      }
                    })()}
                  </span>
                </div>
                {virtualChannelInfoModal.psk && (
                  <div className="info-row">
                    <span className="info-label">{t('channels.psk_base64')}</span>
                    <span
                      className="info-value info-value-code"
                      style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}
                    >
                      {showPsk ? virtualChannelInfoModal.psk : '••••••••'}
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
                          transition: 'all 0.2s',
                        }}
                        onMouseOver={e => (e.currentTarget.style.background = 'var(--ctp-surface2)')}
                        onMouseOut={e => (e.currentTarget.style.background = 'var(--ctp-surface1)')}
                      >
                        {showPsk ? t('channels.hide') : t('channels.show')}
                      </button>
                    </span>
                  </div>
                )}
                {virtualChannelInfoModal.description && (
                  <div className="info-row">
                    <span className="info-label">{t('channels.description', 'Description')}</span>
                    <span className="info-value">{virtualChannelInfoModal.description}</span>
                  </div>
                )}
                <div className="info-row">
                  <span className="info-label">{t('channels.source', 'Source')}</span>
                  <span className="info-value">
                    <span style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '0.25rem',
                      color: 'var(--ctp-blue)',
                    }}>
                      🔑 {t('channels.channel_database', 'Channel Database')}
                    </span>
                  </span>
                </div>
                <div className="info-row">
                  <span className="info-label">{t('channels.access_mode', 'Access Mode')}</span>
                  <span className="info-value">
                    <span style={{ color: 'var(--ctp-yellow)' }}>
                      {t('channels.read_only', 'Read-only')}
                    </span>
                  </span>
                </div>
                {virtualChannelInfoModal.decryptedPacketCount !== undefined && virtualChannelInfoModal.decryptedPacketCount > 0 && (
                  <div className="info-row">
                    <span className="info-label">{t('channels.packets_decrypted', 'Packets Decrypted')}</span>
                    <span className="info-value">{virtualChannelInfoModal.decryptedPacketCount.toLocaleString()}</span>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

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
    </div>
  );
}
