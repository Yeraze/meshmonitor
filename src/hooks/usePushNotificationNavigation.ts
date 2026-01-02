/**
 * usePushNotificationNavigation - Hook for handling navigation from push notification clicks
 *
 * This hook listens for:
 * 1. Messages from the service worker when a notification is clicked (app already open)
 * 2. URL hash parameters when the app is opened from a notification click
 *
 * It provides the navigation data and a way to clear it after navigating.
 */

import { useState, useEffect, useCallback } from 'react';
import { logger } from '../utils/logger';

export interface NotificationNavigationData {
  type: 'channel' | 'dm';
  channelId?: number;
  messageId?: string;
  senderNodeId?: string;
}

interface UsePushNotificationNavigationReturn {
  /** Navigation data from a notification click, null if none pending */
  pendingNavigation: NotificationNavigationData | null;
  /** Call this after handling the navigation to clear the pending state */
  clearPendingNavigation: () => void;
}

// Check for navigation data in URL hash immediately (before React hydration)
// This ensures we don't lose the data if the hash is modified
const getInitialNavigationFromHash = (): NotificationNavigationData | null => {
  if (typeof window === 'undefined') return null;
  
  const hash = window.location.hash;
  if (!hash || hash.length <= 1) return null;
  
  try {
    const params = new URLSearchParams(hash.substring(1));
    const navDataStr = params.get('notificationNav');
    if (navDataStr) {
      const navData = JSON.parse(navDataStr) as NotificationNavigationData;
      logger.info('📬 [Initial] Found notification navigation data in URL:', navData);
      return navData;
    }
  } catch (error) {
    logger.error('📬 [Initial] Failed to parse notification navigation data:', error);
  }
  return null;
};

// Store initial navigation data before React hydration can clear it
let initialNavData: NotificationNavigationData | null = null;
if (typeof window !== 'undefined') {
  initialNavData = getInitialNavigationFromHash();
  // Clean up the URL immediately to prevent re-reads
  if (initialNavData) {
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }
}

export function usePushNotificationNavigation(): UsePushNotificationNavigationReturn {
  // Use initial navigation data captured before React mounted
  const [pendingNavigation, setPendingNavigation] = useState<NotificationNavigationData | null>(() => {
    // Consume the initial nav data
    const data = initialNavData;
    initialNavData = null; // Clear so it's only used once
    return data;
  });

  // Handle messages from service worker
  useEffect(() => {
    const handleServiceWorkerMessage = (event: MessageEvent) => {
      if (event.data?.type === 'NOTIFICATION_CLICK' && event.data?.payload) {
        logger.info('📬 Received notification click from service worker:', event.data.payload);
        setPendingNavigation(event.data.payload);
      }
    };

    // Listen for messages from service worker
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.addEventListener('message', handleServiceWorkerMessage);
    }

    return () => {
      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.removeEventListener('message', handleServiceWorkerMessage);
      }
    };
  }, []);

  // Check URL hash for navigation data (backup check - main check happens before React mounts)
  // This handles edge cases where the hash might be set after initial mount
  useEffect(() => {
    const checkHashForNavigation = () => {
      const hash = window.location.hash;
      if (!hash || hash.length <= 1) return;

      try {
        const params = new URLSearchParams(hash.substring(1));
        const navDataStr = params.get('notificationNav');

        if (navDataStr) {
          const navData = JSON.parse(navDataStr) as NotificationNavigationData;
          logger.info('📬 [HashChange] Found notification navigation data:', navData);
          setPendingNavigation(navData);

          // Clean up the URL hash after reading
          window.history.replaceState(null, '', window.location.pathname + window.location.search);
        }
      } catch (error) {
        logger.error('📬 Failed to parse notification navigation data from URL:', error);
      }
    };

    // Listen for hash changes in case a notification is clicked while app is open
    window.addEventListener('hashchange', checkHashForNavigation);

    return () => {
      window.removeEventListener('hashchange', checkHashForNavigation);
    };
  }, []);

  const clearPendingNavigation = useCallback(() => {
    logger.debug('📬 Clearing pending navigation');
    setPendingNavigation(null);
  }, []);

  return {
    pendingNavigation,
    clearPendingNavigation,
  };
}
