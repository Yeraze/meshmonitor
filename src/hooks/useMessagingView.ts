/**
 * Messaging state machinery for the `channels`/`messages` tabs of the
 * (Meshtastic) source view.
 *
 * Extracted from App.tsx (#3962 Phase 5.4 PR7, task54_spec.md §3 row 7) as
 * part of migrating `channels`/`messages` to routes. Unlike the poll-cache
 * mirrors that PR2/PR8 fold into `useServerData` selectors, `messages` and
 * `channelMessages` are NOT pure cache mirrors: they merge the poll's
 * latest ~100 rows with (a) older rows loaded via infinite-scroll pagination
 * and (b) optimistic "pending" rows created by a just-sent message, so no
 * selector can replace them — the merge logic has to live somewhere, and
 * this hook is that somewhere (task54_spec.md §4 PR7 invariants).
 *
 * Owns:
 *  - `messages`/`channelMessages` state (moved off DataContext — the two
 *    poll-effect writes for them move here too, exposed as
 *    `applyPollMessages`).
 *  - The 2 refs the pagination loaders read to avoid a stale-offset bug
 *    (`messagesRef`, `channelMessagesRef` — see the comment on their
 *    declarations below), plus the DOM container refs and the "pending
 *    optimistic send" ref.
 *  - `loadMoreChannelMessages`/`loadMoreDirectMessages` pagination.
 *  - The 8 `activeTab`-gated scroll/pagination/read-marking effects
 *    (task54_spec.md §1.3 census) plus their two non-gated companions
 *    (the ref-sync effects and the channel auto-scroll-on-new-message
 *    effect, which historically has no `activeTab` guard — preserved
 *    as-is for behavior parity).
 *
 * Message row-id format is load-bearing (`${sourceId}_${fromNum}_${packetId}`,
 * cross-source dedup for /api/unified/messages) — everything in this hook
 * only reads/renders/compares ids, it never reconstructs one.
 *
 * The optimistic-send handlers themselves (handleSendMessage,
 * handleSendDirectMessage, handleSendTapback, handleResendMessage, …) stay
 * in App.tsx — they're deeply entangled with node lookups, sound/toast/
 * homoglyph settings, and the shared traceroute/map orchestration already
 * living there (useSourceView). They consume this hook's `messages`/
 * `setMessages`/`channelMessages`/`setChannelMessages`/`pendingMessagesRef`/
 * the two container refs exactly as they consumed the old DataContext
 * fields — same names, same shapes, so those ~700 lines of handler bodies
 * did not need to change, only their state source.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { MeshMessage } from '../types/message';
import { useSource } from '../contexts/SourceContext';
import { useData } from '../contexts/DataContext';
import { useMessaging } from '../contexts/MessagingContext';
import { useUI } from '../contexts/UIContext';
import { useSettings, useNotificationMuteSettings } from '../contexts/SettingsContext';
import { useToast } from '../components/ToastContainer';
import api from '../services/api';
import { logger } from '../utils/logger';
import { playSound, playChannelSound, DEFAULT_SOUND_ID } from '../utils/notificationSounds';
import type { PollData, RawMessage } from './usePoll';

export function useMessagingView() {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const { sourceId } = useSource();
  const { currentNodeId } = useData();
  const {
    activeTab,
  } = useUI();
  const {
    selectedChannel,
    selectedDMNode,
    setIsChannelScrolledToBottom,
    setIsDMScrolledToBottom,
    markMessagesAsRead,
    setPendingMessages,
    setUnreadCounts,
    unreadCountsData,
  } = useMessaging();
  const { enableAudioNotifications } = useSettings();
  const { isChannelMuted, isDMMuted } = useNotificationMuteSettings();

  const [messages, setMessages] = useState<MeshMessage[]>([]);
  const [channelMessages, setChannelMessages] = useState<{ [key: number]: MeshMessage[] }>({});

  // Pagination state for infinite scroll. Local to this hook (#3962 5.4 PR7)
  // — only the pagination machinery here ever read or wrote these on
  // DataContext, so they moved rather than being left behind as an orphaned
  // prop-drill.
  const [channelHasMore, setChannelHasMore] = useState<{ [key: number]: boolean }>({});
  const [channelLoadingMore, setChannelLoadingMore] = useState<{ [key: number]: boolean }>({});
  const [dmHasMore, setDmHasMore] = useState<{ [key: string]: boolean }>({});
  const [dmLoadingMore, setDmLoadingMore] = useState<{ [key: string]: boolean }>({});

  // Track pending (optimistic, not-yet-server-confirmed) messages for
  // interval/poll access without a stale closure — the source of truth the
  // send handlers write to synchronously, ahead of the setPendingMessages
  // React state update (see handleSendMessage et al. in App.tsx).
  const pendingMessagesRef = useRef<Map<string, MeshMessage>>(new Map());

  const channelMessagesContainerRef = useRef<HTMLDivElement>(null);
  const dmMessagesContainerRef = useRef<HTMLDivElement>(null);
  const lastScrollLoadTimeRef = useRef<number>(0); // Throttle scroll-triggered loads (200ms)

  // Track latest channelMessages/messages via refs so the infinite-scroll loaders
  // see current state without rebuilding their closure on every poll. Without
  // this the first scroll-up uses a stale offset (0) captured at mount and the
  // resulting fetch is filtered out by dedup, so the user sees nothing load.
  const channelMessagesRef = useRef<{ [key: number]: MeshMessage[] }>({});
  const messagesRef = useRef<MeshMessage[]>([]);

  // Track the newest message ID to detect NEW messages (count-based tracking
  // fails at the 100 message limit) — used only by applyPollMessages below.
  const newestMessageId = useRef<string>('');

  // applyPollMessages (below) is memoized without unreadCountsData in its
  // deps (the caller — App's processPollData — has the same constraint), so
  // bridge the latest filtered counts through a ref. This lets the
  // per-channel unread badges honor the "Show MQTT/Bridge Messages" toggle
  // the same way the sidebar dot does (#3787) — the dedicated unread query
  // already applies excludeMqtt, but the /poll aggregate does not.
  const unreadCountsDataRef = useRef(unreadCountsData);
  useEffect(() => {
    unreadCountsDataRef.current = unreadCountsData;
  }, [unreadCountsData]);

  // Play the notification sound configured for a given channel using the
  // synthesized Web Audio sound library. Channel `-1` is the DM pseudo-channel;
  // when no channel is supplied (or it is undefined) the default sound plays,
  // preserving the previous single-tone behavior. Honors the master audio
  // toggle exactly as before.
  const playNotificationSound = useCallback((channelId?: number) => {
    if (!enableAudioNotifications) {
      logger.debug('🔇 Audio notifications disabled, skipping sound');
      return;
    }

    logger.debug('🔊 playNotificationSound called for channel:', channelId);
    if (channelId === undefined) {
      playSound(DEFAULT_SOUND_ID);
    } else {
      // Scope the lookup to the active source so per-source selections (and the
      // DM pseudo-channel) don't leak across sources that share channel numbers.
      playChannelSound(channelId, sourceId);
    }
  }, [enableAudioNotifications, sourceId]);

  // Keep refs in sync with the latest state so infinite-scroll loaders read
  // current values instead of a stale closure. See comment at the ref decls.
  useEffect(() => {
    channelMessagesRef.current = channelMessages;
  }, [channelMessages]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  // Load more channel messages (for infinite scroll)
  const loadMoreChannelMessages = useCallback(async () => {
    if (channelLoadingMore[selectedChannel] || channelHasMore[selectedChannel] === false) {
      return;
    }

    const currentMessages = channelMessagesRef.current[selectedChannel] || [];
    const offset = currentMessages.length;
    const container = channelMessagesContainerRef.current;

    // Store scroll position before loading
    const scrollHeightBefore = container?.scrollHeight || 0;

    setChannelLoadingMore(prev => ({ ...prev, [selectedChannel]: true }));

    try {
      const result = await api.getChannelMessages(selectedChannel, 100, offset, sourceId);

      if (result.messages.length > 0) {
        // Process timestamps for new messages
        const processedMessages = result.messages.map(msg => ({
          ...msg,
          timestamp: new Date(msg.timestamp),
          receivedAt: new Date(msg.receivedAt ?? msg.timestamp),
        }));

        // Prepend older messages to the existing list, deduplicating by id
        setChannelMessages(prev => {
          const existingMessages = prev[selectedChannel] || [];
          const existingIds = new Set(existingMessages.map(m => m.id));
          const newMessages = processedMessages.filter(m => !existingIds.has(m.id));
          return {
            ...prev,
            [selectedChannel]: [...newMessages, ...existingMessages],
          };
        });

        // Restore scroll position after messages are prepended
        requestAnimationFrame(() => {
          if (container) {
            const scrollHeightAfter = container.scrollHeight;
            container.scrollTop = scrollHeightAfter - scrollHeightBefore;
          }
        });
      }

      setChannelHasMore(prev => ({ ...prev, [selectedChannel]: result.hasMore }));
    } catch (error) {
      logger.error('Failed to load more channel messages:', error);
      showToast(t('toast.failed_load_older_messages'), 'error');
    } finally {
      setChannelLoadingMore(prev => ({ ...prev, [selectedChannel]: false }));
    }
  }, [
    selectedChannel,
    channelLoadingMore,
    channelHasMore,
    setChannelMessages,
    setChannelHasMore,
    setChannelLoadingMore,
    showToast,
    sourceId,
    t,
  ]);

  // Load more direct messages (for infinite scroll)
  const loadMoreDirectMessages = useCallback(async () => {
    if (!selectedDMNode || !currentNodeId) return;

    const dmKey = [currentNodeId, selectedDMNode].sort().join('_');
    if (dmLoadingMore[dmKey] || dmHasMore[dmKey] === false) {
      return;
    }

    // Get current DM messages from the messages array (channel -1 or direct messages)
    const currentDMs = messagesRef.current.filter(
      msg =>
        (msg.fromNodeId === currentNodeId && msg.toNodeId === selectedDMNode) ||
        (msg.fromNodeId === selectedDMNode && msg.toNodeId === currentNodeId)
    );
    const offset = currentDMs.length;
    const container = dmMessagesContainerRef.current;

    // Store scroll position before loading
    const scrollHeightBefore = container?.scrollHeight || 0;

    setDmLoadingMore(prev => ({ ...prev, [dmKey]: true }));

    try {
      const result = await api.getDirectMessages(currentNodeId, selectedDMNode, 100, offset, sourceId);

      if (result.messages.length > 0) {
        // Process timestamps for new messages
        const processedMessages = result.messages.map(msg => ({
          ...msg,
          timestamp: new Date(msg.timestamp),
          receivedAt: new Date(msg.receivedAt ?? msg.timestamp),
        }));

        // Prepend older messages to the existing list
        setMessages(prev => {
          // Remove duplicates by id
          const existingIds = new Set(prev.map(m => m.id));
          const newMessages = processedMessages.filter(m => !existingIds.has(m.id));
          return [...newMessages, ...prev];
        });

        // Restore scroll position after messages are prepended
        requestAnimationFrame(() => {
          if (container) {
            const scrollHeightAfter = container.scrollHeight;
            container.scrollTop = scrollHeightAfter - scrollHeightBefore;
          }
        });
      }

      setDmHasMore(prev => ({ ...prev, [dmKey]: result.hasMore }));
    } catch (error) {
      logger.error('Failed to load more direct messages:', error);
      showToast(t('toast.failed_load_older_messages'), 'error');
    } finally {
      setDmLoadingMore(prev => ({ ...prev, [dmKey]: false }));
    }
  }, [
    selectedDMNode,
    currentNodeId,
    dmLoadingMore,
    dmHasMore,
    setMessages,
    setDmHasMore,
    setDmLoadingMore,
    showToast,
    sourceId,
    t,
  ]);

  // Check if container is scrolled near bottom (within 100px)
  const isScrolledNearBottom = useCallback((container: HTMLDivElement | null): boolean => {
    if (!container) return true;
    const threshold = 100;
    const { scrollTop, scrollHeight, clientHeight } = container;
    return scrollHeight - scrollTop - clientHeight < threshold;
  }, []);

  // Check if container is scrolled near top (within 100px)
  const isScrolledNearTop = useCallback((container: HTMLDivElement | null): boolean => {
    if (!container) return false;
    return container.scrollTop < 100;
  }, []);

  // Handle scroll events to track scroll position (throttled for load-more)
  const handleChannelScroll = useCallback(() => {
    if (channelMessagesContainerRef.current) {
      const atBottom = isScrolledNearBottom(channelMessagesContainerRef.current);
      setIsChannelScrolledToBottom(atBottom);

      // Check if scrolled near top and trigger load more (throttled to 200ms)
      const now = Date.now();
      if (isScrolledNearTop(channelMessagesContainerRef.current) && now - lastScrollLoadTimeRef.current > 200) {
        lastScrollLoadTimeRef.current = now;
        void loadMoreChannelMessages();
      }
    }
  }, [isScrolledNearBottom, isScrolledNearTop, loadMoreChannelMessages, setIsChannelScrolledToBottom]);

  const handleDMScroll = useCallback(() => {
    if (dmMessagesContainerRef.current) {
      const atBottom = isScrolledNearBottom(dmMessagesContainerRef.current);
      setIsDMScrolledToBottom(atBottom);

      // Check if scrolled near top and trigger load more (throttled to 200ms)
      const now = Date.now();
      if (isScrolledNearTop(dmMessagesContainerRef.current) && now - lastScrollLoadTimeRef.current > 200) {
        lastScrollLoadTimeRef.current = now;
        void loadMoreDirectMessages();
      }
    }
  }, [isScrolledNearBottom, isScrolledNearTop, loadMoreDirectMessages, setIsDMScrolledToBottom]);

  // Attach scroll event listeners. Re-run when navigation could have swapped
  // the underlying DOM node — channel switch, DM switch, or tab switch, or
  // when the handler closures themselves change (pagination state changed)
  // — to be sure we attach to the freshly mounted container / current
  // closure. Without this the very first scroll on the initial channel never
  // fires the load-more handler.
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
  }, [handleChannelScroll, handleDMScroll, activeTab, selectedChannel, selectedDMNode]);

  // Force scroll to bottom when channel changes OR when switching to channels tab
  // Note: We track initial scroll per channel to avoid re-scrolling when user manually scrolls
  // [GATED EFFECT #1 — task54_spec.md §1.3]
  useEffect(() => {
    if (activeTab === 'channels' && selectedChannel >= 0) {
      const currentChannelMessages = channelMessages[selectedChannel] || [];
      const hasMessages = currentChannelMessages.length > 0;

      // Always scroll to bottom when entering the channels tab or changing channels
      if (hasMessages) {
        // Use setTimeout to ensure messages are rendered before scrolling
        setTimeout(() => {
          if (channelMessagesContainerRef.current) {
            channelMessagesContainerRef.current.scrollTop = channelMessagesContainerRef.current.scrollHeight;
            setIsChannelScrolledToBottom(true);
          }
        }, 100);
      }
    }
  }, [selectedChannel, activeTab, channelMessages, setIsChannelScrolledToBottom]);

  // Auto-scroll to bottom when new messages arrive and user is already at the bottom.
  // Non-gated companion to GATED EFFECT #2 below (channels vs DMs) — preserved
  // as-is (no activeTab guard existed here pre-migration).
  const prevChannelMsgCountRef = useRef<Record<number, number>>({});
  useEffect(() => {
    const currentMessages = channelMessages[selectedChannel] || [];
    const prevCount = prevChannelMsgCountRef.current[selectedChannel] || 0;
    const currentCount = currentMessages.length;

    if (currentCount > prevCount && prevCount > 0) {
      // New messages arrived — auto-scroll if user was near the bottom
      const container = channelMessagesContainerRef.current;
      if (container) {
        const isNearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 150;
        if (isNearBottom) {
          setTimeout(() => {
            if (channelMessagesContainerRef.current) {
              channelMessagesContainerRef.current.scrollTo({
                top: channelMessagesContainerRef.current.scrollHeight,
                behavior: 'smooth'
              });
            }
          }, 50);
        }
      }
    }

    prevChannelMsgCountRef.current = {
      ...prevChannelMsgCountRef.current,
      [selectedChannel]: currentCount
    };
  }, [channelMessages, selectedChannel]);

  // Auto-scroll DMs to bottom when new messages arrive and user is at the bottom
  // [GATED EFFECT #2 — task54_spec.md §1.3]
  const prevDMMsgCountRef = useRef(0);
  useEffect(() => {
    const currentCount = messages.length;
    const prevCount = prevDMMsgCountRef.current;

    if (currentCount > prevCount && prevCount > 0 && activeTab === 'messages') {
      const container = dmMessagesContainerRef.current;
      if (container) {
        const isNearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 150;
        if (isNearBottom) {
          setTimeout(() => {
            if (dmMessagesContainerRef.current) {
              dmMessagesContainerRef.current.scrollTo({
                top: dmMessagesContainerRef.current.scrollHeight,
                behavior: 'smooth'
              });
            }
          }, 50);
        }
      }
    }

    prevDMMsgCountRef.current = currentCount;
  }, [messages, activeTab]);

  // Auto-load more channel messages if container doesn't have a scrollbar
  // This fixes the case where a channel has no recent messages and infinite scroll never triggers
  // [GATED EFFECT #3 — task54_spec.md §1.3]
  useEffect(() => {
    if (activeTab === 'channels' && selectedChannel >= 0) {
      // Skip if we're already loading or know there are no more messages
      if (channelLoadingMore[selectedChannel] || channelHasMore[selectedChannel] === false) {
        return;
      }

      // Check after a delay to allow the DOM to render
      const checkTimer = setTimeout(() => {
        const container = channelMessagesContainerRef.current;
        if (container) {
          // If container doesn't have a scrollbar, load more messages
          const hasScrollbar = container.scrollHeight > container.clientHeight;
          if (!hasScrollbar) {
            void loadMoreChannelMessages();
          }
        }
      }, 200);

      return () => clearTimeout(checkTimer);
    }
  }, [selectedChannel, activeTab, channelLoadingMore, channelHasMore, loadMoreChannelMessages]);

  // Force scroll to bottom when DM node changes OR when switching to messages tab
  // [GATED EFFECT #4 — task54_spec.md §1.3]
  useEffect(() => {
    if (activeTab === 'messages' && selectedDMNode && currentNodeId) {
      const currentDMMessages = messages.filter(
        msg =>
          (msg.fromNodeId === currentNodeId && msg.toNodeId === selectedDMNode) ||
          (msg.fromNodeId === selectedDMNode && msg.toNodeId === currentNodeId)
      );
      const hasMessages = currentDMMessages.length > 0;

      // Always scroll to bottom when entering the messages tab or changing conversations
      if (hasMessages) {
        setTimeout(() => {
          if (dmMessagesContainerRef.current) {
            dmMessagesContainerRef.current.scrollTop = dmMessagesContainerRef.current.scrollHeight;
            setIsDMScrolledToBottom(true);
          }
        }, 150);
      }
    }
  }, [selectedDMNode, activeTab, currentNodeId, messages, setIsDMScrolledToBottom]);

  // Auto-load more DM messages if container doesn't have a scrollbar
  // This fixes the case where a conversation has no recent messages and infinite scroll never triggers
  // [GATED EFFECT #5 — task54_spec.md §1.3]
  useEffect(() => {
    if (activeTab === 'messages' && selectedDMNode && currentNodeId) {
      const dmKey = [currentNodeId, selectedDMNode].sort().join('_');

      // Skip if we're already loading or know there are no more messages
      if (dmLoadingMore[dmKey] || dmHasMore[dmKey] === false) {
        return;
      }

      // Check after a delay to allow the DOM to render
      const checkTimer = setTimeout(() => {
        const container = dmMessagesContainerRef.current;
        if (container) {
          // If container doesn't have a scrollbar, load more messages
          const hasScrollbar = container.scrollHeight > container.clientHeight;
          if (!hasScrollbar) {
            void loadMoreDirectMessages();
          }
        }
      }, 200);

      return () => clearTimeout(checkTimer);
    }
  }, [selectedDMNode, activeTab, currentNodeId, dmLoadingMore, dmHasMore, loadMoreDirectMessages]);

  // Mark messages as read when viewing a channel — also re-fires when new messages arrive
  // so that incoming messages are immediately marked as read while the user is viewing the channel.
  // Without the message count dependency, new messages would show as "unread" until the user
  // clicks away and back (#2316).
  // [GATED EFFECT #6 — task54_spec.md §1.3]
  const currentChannelMsgCount = (channelMessages[selectedChannel] || []).length;
  useEffect(() => {
    if (activeTab === 'channels' && selectedChannel >= 0) {
      void markMessagesAsRead(undefined, selectedChannel);
    }
  }, [selectedChannel, activeTab, markMessagesAsRead, currentChannelMsgCount]);

  // Mark messages as read when viewing a DM conversation — also re-fires on new messages
  // Filter to only the selected conversation so we don't fire on messages from other DMs
  // [GATED EFFECT #7 — task54_spec.md §1.3]
  const currentDMMsgCount = selectedDMNode
    ? messages.filter(msg => msg.fromNodeId === selectedDMNode || msg.toNodeId === selectedDMNode).length
    : 0;
  useEffect(() => {
    if (activeTab === 'messages' && selectedDMNode) {
      void markMessagesAsRead(undefined, undefined, selectedDMNode);
    }
  }, [selectedDMNode, activeTab, markMessagesAsRead, currentDMMsgCount]);

  // Timer to update message status indicators (timeout detection after 30s)
  // Only runs when on channels/messages tabs to reduce CPU usage on mobile (#1769)
  // [GATED EFFECT #8 — task54_spec.md §1.3]
  const [, setStatusTick] = useState(0);
  useEffect(() => {
    // Only run timer when viewing messaging tabs where status indicators are visible
    if (activeTab !== 'channels' && activeTab !== 'messages') {
      return;
    }

    const interval = setInterval(() => {
      // Force re-render to update message status indicators
      setStatusTick(prev => prev + 1);
    }, 5000); // Update every 5 seconds (reduced from 1s for mobile performance)

    return () => clearInterval(interval);
  }, [activeTab]);

  // Apply a /api/poll payload's messages data — merges the poll's latest rows
  // with (a) older rows preserved from infinite-scroll pagination and (b)
  // still-pending optimistic rows, updates unread counts, and plays the
  // notification sound for a genuinely new incoming message. Moved verbatim
  // out of App's processPollData (#3962 5.4 PR7) — `currentSelectedChannel`
  // is `selectedChannelRef.current`, passed in because that ref stays in App
  // (it's also used by channel-fetch/Sidebar-navigation logic outside this
  // hook's scope).
  const applyPollMessages = useCallback(
    (data: PollData, localNodeId: string, currentSelectedChannel: number) => {
      if (!data.messages) return;

      const messagesData = data.messages;
      // RawMessage.deliveryState is a bare `string` (server-side wire shape);
      // MeshMessage narrows it to MessageDeliveryState. The cast mirrors what
      // the untyped (`any`) version of this code relied on implicitly — the
      // server only ever sends valid values.
      const processedMessages: MeshMessage[] = messagesData.map((msg: RawMessage) => ({
        ...msg,
        timestamp: new Date(msg.timestamp),
        receivedAt: new Date(msg.receivedAt ?? msg.timestamp),
      } as MeshMessage));

      // Play notification sound if new messages arrived from OTHER users
      if (processedMessages.length > 0) {
        const currentNewestMessage = processedMessages[0];
        const currentNewestId = currentNewestMessage.id;

        if (newestMessageId.current && currentNewestId !== newestMessageId.current) {
          const isFromOther = currentNewestMessage.fromNodeId !== localNodeId;
          const isTextMessage = currentNewestMessage.portnum === 1;

          if (isFromOther && isTextMessage) {
            logger.debug('New message arrived from other user:', currentNewestMessage.fromNodeId);
            const isDM = currentNewestMessage.channel === -1;
            const muted = isDM
              ? isDMMuted(currentNewestMessage.fromNodeId)
              : isChannelMuted(currentNewestMessage.channel);
            if (!muted) {
              // Play the sound configured for this channel (channel -1 is the
              // DM pseudo-channel, which has its own selectable sound too).
              playNotificationSound(currentNewestMessage.channel);
            } else {
              logger.debug('🔇 Notification sound suppressed (muted):', isDM ? `DM from ${currentNewestMessage.fromNodeId}` : `channel ${currentNewestMessage.channel}`);
            }
          }
        }

        newestMessageId.current = currentNewestId;
      }

      // Check for matching messages to remove from pending
      const currentPending = pendingMessagesRef.current;
      const updatedPending = new Map(currentPending);
      let pendingChanged = false;

      if (currentPending.size > 0) {
        currentPending.forEach((pendingMsg, tempId) => {
          const isDM = pendingMsg.channel === -1;

          const matchingMessage = processedMessages.find((msg: MeshMessage) => {
            if (msg.text !== pendingMsg.text) return false;

            const senderMatches =
              (localNodeId && msg.from === localNodeId) ||
              msg.from === pendingMsg.from ||
              msg.fromNodeId === pendingMsg.fromNodeId;

            if (!senderMatches) return false;
            if (Math.abs(msg.timestamp.getTime() - pendingMsg.timestamp.getTime()) >= 30000) return false;

            if (isDM) {
              const matches =
                msg.toNodeId === pendingMsg.toNodeId ||
                (msg.to === pendingMsg.to && (msg.channel === 0 || msg.channel === -1));
              return matches;
            } else {
              return msg.channel === pendingMsg.channel;
            }
          });

          if (matchingMessage) {
            updatedPending.delete(tempId);
            pendingChanged = true;
          }
        });

        if (pendingChanged) {
          pendingMessagesRef.current = updatedPending;
          setPendingMessages(updatedPending);
        }
      }

      // Compute merged messages using setMessages callback to access current state
      // Preserve older DM messages loaded via infinite scroll (similar to channel messages)
      const pendingIds = new Set(Array.from(pendingMessagesRef.current.keys()));
      const pollMsgIds = new Set(processedMessages.map((m: MeshMessage) => m.id));

      setMessages(currentMessages => {
        // Keep older messages that aren't in the poll (they were loaded via infinite scroll)
        // Poll returns newest messages, so any messages not in poll are older
        const olderMsgs = (currentMessages || []).filter(m => {
          // If message is in poll results, don't keep it (poll version is authoritative)
          if (pollMsgIds.has(m.id)) return false;

          // For pending messages (temp IDs), only keep if still pending
          if (m.id.toString().startsWith('temp_')) {
            if (!pendingIds.has(m.id)) return false;
            // Safety net: filter out if a matching server message already exists
            // This catches edge cases where the ref timing or text/sender matching fails
            // Must use localNodeId fallback (same as primary dedup) because temp messages
            // created before first poll may have fromNodeId='me' instead of the real node ID
            const hasServerMatch = processedMessages.some((pm: MeshMessage) =>
              pm.text === m.text &&
              ((localNodeId && pm.from === localNodeId) || pm.fromNodeId === m.fromNodeId || pm.from === m.from) &&
              Math.abs(pm.timestamp.getTime() - m.timestamp.getTime()) < 30000
            );
            if (hasServerMatch) return false;
            return true;
          }

          // Keep all other older messages (loaded via infinite scroll)
          return true;
        });

        // Combine: older messages + poll messages (poll messages are newer/updated)
        // Sort by timestamp to maintain order
        const merged = [...olderMsgs, ...processedMessages];
        merged.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
        return merged;
      });

      // Group messages by channel (use processedMessages since we don't need pending for channel groups)
      const channelGroups: { [key: number]: MeshMessage[] } = {};
      processedMessages.forEach((msg: MeshMessage) => {
        if (msg.channel === -1) return;
        if (!channelGroups[msg.channel]) {
          channelGroups[msg.channel] = [];
        }
        channelGroups[msg.channel].push(msg);
      });

      // Update unread counts from the dedicated (filtered) unread query rather
      // than the raw /poll aggregate, so the per-channel badges respect the
      // "Show MQTT/Bridge Messages" toggle just like the sidebar dot (#3787).
      // Fall back to the poll payload only until the first dedicated fetch lands.
      const newUnreadCounts: { [key: number]: number } = {};

      const filteredChannelUnreads = unreadCountsDataRef.current?.channels ?? data.unreadCounts?.channels;
      if (filteredChannelUnreads) {
        Object.entries(filteredChannelUnreads).forEach(([channelId, count]) => {
          const chId = parseInt(channelId, 10);
          if (chId === currentSelectedChannel) {
            newUnreadCounts[chId] = 0;
          } else {
            newUnreadCounts[chId] = count as number;
          }
        });
      }

      setUnreadCounts(newUnreadCounts);

      // Merge poll messages with existing messages (preserve older messages loaded via infinite scroll)
      setChannelMessages(prev => {
        const merged: { [key: number]: MeshMessage[] } = {};

        // Get all channel IDs from both existing and new messages
        const allChannelIds = new Set([...Object.keys(prev).map(Number), ...Object.keys(channelGroups).map(Number)]);

        allChannelIds.forEach(channelId => {
          const existingMsgs = prev[channelId] || [];
          const pollMsgs = channelGroups[channelId] || [];

          // Create a map of poll message IDs for quick lookup
          const pollMsgIdsForChannel = new Set(pollMsgs.map(m => m.id));

          // Keep older messages that aren't in the poll (they were loaded via infinite scroll)
          // Poll returns newest 100, so any messages not in poll are older
          // Also filter out pending messages that are no longer pending (they've been matched to real messages)
          const olderMsgs = existingMsgs.filter(m => {
            // If message is in poll results, don't keep it (poll version is authoritative)
            if (pollMsgIdsForChannel.has(m.id)) return false;

            // For pending messages (temp IDs), only keep if still pending
            // Once matched/acknowledged, pendingIds won't contain it anymore
            // Channel messages use 'temp_' prefix, DMs use 'temp_dm_' prefix
            if (m.id.toString().startsWith('temp_')) {
              if (!pendingIds.has(m.id)) return false;
              // Safety net: filter out if a matching server message already exists
              // Must use localNodeId fallback (same as primary dedup) because temp messages
              // created before first poll may have fromNodeId='me' instead of the real node ID
              const hasServerMatch = pollMsgs.some(pm =>
                pm.text === m.text &&
                ((localNodeId && pm.from === localNodeId) || pm.fromNodeId === m.fromNodeId || pm.from === m.from) &&
                Math.abs(pm.timestamp.getTime() - m.timestamp.getTime()) < 30000
              );
              if (hasServerMatch) return false;
              return true;
            }

            // Keep all other older messages (loaded via infinite scroll)
            return true;
          });

          // Combine: older messages + poll messages (poll messages are newer/updated)
          merged[channelId] = [...olderMsgs, ...pollMsgs];
        });

        return merged;
      });
    },
    [isChannelMuted, isDMMuted, playNotificationSound, setPendingMessages, setUnreadCounts]
  );

  return {
    messages,
    setMessages,
    channelMessages,
    setChannelMessages,
    pendingMessagesRef,
    channelMessagesContainerRef,
    dmMessagesContainerRef,
    applyPollMessages,
  };
}
