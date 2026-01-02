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

import { useState, useEffect, type MutableRefObject } from 'react';
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

  const { setActiveTab, setSelectedChannel, setSelectedDMNode, selectedChannelRef } = callbacks;
  const { connectionStatus, channels, activeTab, selectedChannel, selectedDMNode } = state;

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
  useEffect(() => {
    if (!scrollToMessageId) return;

    // Wait for the messages to render, then scroll to the target message
    const scrollTimer = setTimeout(() => {
      const messageElement = document.querySelector(`[data-message-id="${scrollToMessageId}"]`);

      if (messageElement) {
        logger.info(`📬 Scrolling to message: ${scrollToMessageId}`);
        messageElement.scrollIntoView({ behavior: 'smooth', block: 'center' });

        // Add a brief highlight effect to the message
        messageElement.classList.add('message-highlight');
        setTimeout(() => {
          messageElement.classList.remove('message-highlight');
        }, 2000);
      } else {
        logger.warn(`📬 Message element not found for ID: ${scrollToMessageId}`);
      }

      // Clear the scroll target
      setScrollToMessageId(null);
    }, 300); // Wait for messages to render

    return () => clearTimeout(scrollTimer);
  }, [scrollToMessageId, activeTab, selectedChannel, selectedDMNode]);
}
