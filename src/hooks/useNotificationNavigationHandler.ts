/**
 * useNotificationNavigationHandler - Hook for handling navigation from push notification clicks
 *
 * This hook combines the notification data capture with the navigation logic.
 * It handles:
 * 1. Capturing navigation data from service worker messages or URL hash
 * 2. Waiting for app to be ready (connected)
 * 3. Navigating to the correct channel/DM
 * 4. Scrolling to and highlighting the target message
 */

import { useState, useEffect, useRef, type MutableRefObject } from 'react';
import { logger } from '../utils/logger';
import { usePushNotificationNavigation } from './usePushNotificationNavigation';

interface NavigationCallbacks {
  /** Set the active tab ('channels' | 'messages') */
  setActiveTab: (tab: 'channels' | 'messages') => void;
  /** Set the selected channel index */
  setSelectedChannel: (channelId: number) => void;
  /** Set the selected DM node ID */
  setSelectedDMNode: (nodeId: string) => void;
  /** Ref to keep selectedChannel in sync */
  selectedChannelRef?: MutableRefObject<number>;
}

interface NavigationState {
  /** Current connection status */
  connectionStatus: string;
  /** Available channels (used to determine if app is ready) */
  channels: unknown[] | null;
  /** Current active tab */
  activeTab: string;
  /** Currently selected channel */
  selectedChannel: number;
  /** Currently selected DM node */
  selectedDMNode: string | null;
}

/**
 * Hook to handle push notification navigation
 * 
 * @param callbacks - Functions to control navigation
 * @param state - Current app state needed for navigation logic
 */
export function useNotificationNavigationHandler(
  callbacks: NavigationCallbacks,
  state: NavigationState
): void {
  const { pendingNavigation, clearPendingNavigation } = usePushNotificationNavigation();
  const [scrollToMessageId, setScrollToMessageId] = useState<string | null>(null);
  
  // Use ref to persist scroll target across re-renders
  const scrollToMessageIdRef = useRef<string | null>(null);

  const { setActiveTab, setSelectedChannel, setSelectedDMNode, selectedChannelRef } = callbacks;
  const { connectionStatus, channels, activeTab, selectedChannel, selectedDMNode } = state;

  // Sync ref with state
  useEffect(() => {
    scrollToMessageIdRef.current = scrollToMessageId;
    if (scrollToMessageId) {
      logger.debug(`📬 scrollToMessageId updated: ${scrollToMessageId}`);
    }
  }, [scrollToMessageId]);

  // Handle push notification click navigation
  // When a notification is clicked, navigate to the relevant channel/DM and scroll to the message
  // We wait until the app is connected to ensure data is loaded
  useEffect(() => {
    if (!pendingNavigation) return;

    // Wait until we have a connection (data is loaded)
    // Allow navigation when connected or when we have channels data
    const hasChannels = channels && channels.length > 0;
    if (connectionStatus !== 'connected' && !hasChannels) {
      logger.debug('📬 Waiting for connection before navigating...');
      return; // Will retry when connectionStatus changes
    }

    logger.info('📬 Handling push notification navigation:', pendingNavigation);

    if (pendingNavigation.type === 'channel' && pendingNavigation.channelId !== undefined) {
      // Navigate to channel
      setActiveTab('channels');
      setSelectedChannel(pendingNavigation.channelId);
      if (selectedChannelRef) {
        selectedChannelRef.current = pendingNavigation.channelId;
      }

      // Set message to scroll to if provided
      if (pendingNavigation.messageId) {
        setScrollToMessageId(pendingNavigation.messageId);
      }

      logger.info(`📬 Navigated to channel ${pendingNavigation.channelId}`);
    } else if (pendingNavigation.type === 'dm' && pendingNavigation.senderNodeId) {
      // Navigate to DM conversation
      setActiveTab('messages');
      setSelectedDMNode(pendingNavigation.senderNodeId);

      // Set message to scroll to if provided
      if (pendingNavigation.messageId) {
        setScrollToMessageId(pendingNavigation.messageId);
      }

      logger.info(`📬 Navigated to DM with node ${pendingNavigation.senderNodeId}`);
    }

    // Clear the pending navigation after handling
    clearPendingNavigation();
  }, [
    pendingNavigation,
    clearPendingNavigation,
    setActiveTab,
    setSelectedChannel,
    setSelectedDMNode,
    selectedChannelRef,
    connectionStatus,
    channels,
  ]);

  // Scroll to specific message after navigation from push notification
  // Use a separate effect that only depends on scrollToMessageId to prevent unnecessary re-runs
  useEffect(() => {
    if (!scrollToMessageId) return;

    logger.info(`📬 Starting scroll attempt for message: ${scrollToMessageId}, activeTab: ${activeTab}, selectedChannel: ${selectedChannel}, selectedDMNode: ${selectedDMNode}`);

    // Retry mechanism - try multiple times with increasing delays
    // This handles cases where messages are still loading
    const maxRetries = 10;
    let retryCount = 0;
    let scrollTimer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;
    const targetMessageId = scrollToMessageId; // Capture in closure

    const attemptScroll = () => {
      if (cancelled) return;
      
      // Check if we still need to scroll (state might have changed)
      if (scrollToMessageIdRef.current !== targetMessageId) {
        logger.debug(`📬 Scroll target changed, aborting scroll to: ${targetMessageId}`);
        return;
      }

      const messageElement = document.querySelector(`[data-message-id="${targetMessageId}"]`);

      if (messageElement) {
        logger.info(`📬 Found message element, scrolling to: ${targetMessageId}`);
        messageElement.scrollIntoView({ behavior: 'smooth', block: 'center' });

        // Add a brief highlight effect to the message
        messageElement.classList.add('message-highlight');
        setTimeout(() => {
          messageElement.classList.remove('message-highlight');
        }, 2000);

        // Clear the scroll target after successful scroll
        setScrollToMessageId(null);
      } else {
        retryCount++;
        // Log all message elements to help debugging
        if (retryCount === 1) {
          const allMessageElements = document.querySelectorAll('[data-message-id]');
          const messageIds = Array.from(allMessageElements).map(el => el.getAttribute('data-message-id'));
          logger.debug(`📬 Looking for: ${targetMessageId}`);
          logger.debug(`📬 Available message IDs (${allMessageElements.length}):`, 
            messageIds.slice(0, 10)
          );
          // Check if target is in the list
          if (!messageIds.includes(targetMessageId)) {
            logger.debug(`📬 Target message NOT in available messages - may need to load older messages`);
          }
        }
        
        if (retryCount < maxRetries) {
          // Linear backoff: 500ms, 1000ms, 1500ms, 2000ms, then cap at 2000ms
          const delay = Math.min(500 * retryCount, 2000);
          logger.debug(`📬 Message not found, retry ${retryCount}/${maxRetries} in ${delay}ms: ${targetMessageId}`);
          scrollTimer = setTimeout(attemptScroll, delay);
        } else {
          logger.warn(`📬 Message element not found after ${maxRetries} retries: ${targetMessageId}`);
          // Clear the scroll target to prevent infinite loop
          setScrollToMessageId(null);
        }
      }
    };

    // Initial delay to allow React to render the messages after tab/channel change
    scrollTimer = setTimeout(attemptScroll, 600);

    return () => {
      cancelled = true;
      if (scrollTimer) {
        clearTimeout(scrollTimer);
      }
    };
  // Only depend on scrollToMessageId - other values are logged but shouldn't trigger re-runs
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollToMessageId]);
}
