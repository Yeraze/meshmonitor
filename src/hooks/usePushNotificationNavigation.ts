/**
 * usePushNotificationNavigation - Hook for handling navigation from push notification clicks
 *
 * This hook listens for:
 * 1. Messages from the service worker when a notification is clicked (app already open)
 * 2. The `notificationNav` URL parameter when the app is cold-launched from a
 *    notification click (query string, with the legacy hash form as fallback)
 *
 * It provides the navigation data and a way to clear it after navigating.
 */

import { useState, useEffect, useCallback } from 'react';
import { logger } from '../utils/logger';
import { NOTIFICATION_NAV_PARAM, type NotificationNavigationData } from '../utils/notificationUrl';

export type { NotificationNavigationData } from '../utils/notificationUrl';

interface UsePushNotificationNavigationReturn {
  /** Navigation data from a notification click, null if none pending */
  pendingNavigation: NotificationNavigationData | null;
  /** Call this after handling the navigation to clear the pending state */
  clearPendingNavigation: () => void;
}

/**
 * Parse a `notificationNav` payload out of a `?a=b`/`#a=b` parameter string.
 * Returns null when the parameter is absent or unparseable.
 */
const parseNavParams = (
  paramString: string,
  label: string
): NotificationNavigationData | null => {
  if (!paramString) return null;
  try {
    const navDataStr = new URLSearchParams(paramString).get(NOTIFICATION_NAV_PARAM);
    if (!navDataStr) return null;
    const navData = JSON.parse(navDataStr) as NotificationNavigationData;
    logger.info(`📬 [${label}] Found notification navigation data in URL:`, navData);
    return navData;
  } catch (error) {
    logger.error(`📬 [${label}] Failed to parse notification navigation data:`, error);
    return null;
  }
};

// Check for navigation data in the URL immediately (before React hydration) so
// it survives the router's own history rewrites.
//
// The service worker puts the payload in the *query string* and cold-launches
// the app on `/source/<id>/<tab>` (#4463) — the old hash form is still read as
// a fallback for notifications that were already delivered by an older build.
const getInitialNavigationFromUrl = (): NotificationNavigationData | null => {
  if (typeof window === 'undefined') return null;
  return (
    parseNavParams(window.location.search.replace(/^\?/, ''), 'Initial') ??
    parseNavParams(window.location.hash.replace(/^#/, ''), 'Initial/hash')
  );
};

/**
 * Strip `notificationNav` from the current URL without discarding any other
 * query parameters, and without touching the path (the router owns that).
 */
const stripNavParamFromUrl = (): void => {
  const search = new URLSearchParams(window.location.search);
  search.delete(NOTIFICATION_NAV_PARAM);
  const hash = window.location.hash.replace(/^#/, '');
  const hashParams = new URLSearchParams(hash);
  const hadNavInHash = hashParams.has(NOTIFICATION_NAV_PARAM);
  hashParams.delete(NOTIFICATION_NAV_PARAM);

  const nextSearch = search.toString();
  const nextHash = hadNavInHash ? hashParams.toString() : hash;
  window.history.replaceState(
    null,
    '',
    window.location.pathname +
      (nextSearch ? `?${nextSearch}` : '') +
      (nextHash ? `#${nextHash}` : '')
  );
};

// Store initial navigation data before React hydration can clear it
let initialNavData: NotificationNavigationData | null = null;
if (typeof window !== 'undefined') {
  initialNavData = getInitialNavigationFromUrl();
  // Clean up the URL immediately to prevent re-reads
  if (initialNavData) {
    stripNavParamFromUrl();
  }
}

export function usePushNotificationNavigation(): UsePushNotificationNavigationReturn {
  // Use initial navigation data captured before React mounted
  const [pendingNavigation, setPendingNavigation] = useState<NotificationNavigationData | null>(
    () => initialNavData
  );

  // Consume the module-level capture once the hook has actually mounted.
  // This must NOT happen inside the useState initializer: <React.StrictMode>
  // double-invokes initializers, so the second call would see null and the
  // navigation would be dropped in development.
  useEffect(() => {
    initialNavData = null;
  }, []);

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

  // Backup check for navigation data arriving after mount (the main check
  // happens at module load, before React mounts). Covers both the query-string
  // form and the legacy hash form.
  useEffect(() => {
    const checkUrlForNavigation = () => {
      const navData =
        parseNavParams(window.location.search.replace(/^\?/, ''), 'UrlChange') ??
        parseNavParams(window.location.hash.replace(/^#/, ''), 'HashChange');

      if (navData) {
        setPendingNavigation(navData);
        stripNavParamFromUrl();
      }
    };

    // Listen for hash changes in case a notification is clicked while app is open
    window.addEventListener('hashchange', checkUrlForNavigation);
    window.addEventListener('popstate', checkUrlForNavigation);

    return () => {
      window.removeEventListener('hashchange', checkUrlForNavigation);
      window.removeEventListener('popstate', checkUrlForNavigation);
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
