/**
 * Hook for checking application version updates
 *
 * Polls the server every 4 hours to check for new versions
 * and provides state for showing update notifications.
 */

import { useState, useEffect, useCallback } from 'react';
import { logger } from '../utils/logger';

interface VersionCheckResult {
  /** Whether a new version is available */
  updateAvailable: boolean;
  /** The latest available version string */
  latestVersion: string;
  /** URL to the release page */
  releaseUrl: string;
  /** Dismiss the update notification */
  dismissUpdate: () => void;
}

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours

/**
 * Hook to check for application updates
 *
 * @param baseUrl - The base URL of the API
 * @returns Version check state and controls
 */
export function useVersionCheck(baseUrl: string): VersionCheckResult {
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [latestVersion, setLatestVersion] = useState('');
  const [releaseUrl, setReleaseUrl] = useState('');

  const dismissUpdate = useCallback(() => {
    setUpdateAvailable(false);
  }, []);

  useEffect(() => {
    let intervalId: ReturnType<typeof setInterval> | null = null;

    const checkForUpdates = async () => {
      try {
        const response = await fetch(`${baseUrl}/api/version/check`);
        if (response.ok) {
          const data = await response.json();

          // Always update version info if a newer version exists
          if (data.latestVersion && data.latestVersion !== data.currentVersion) {
            setLatestVersion(data.latestVersion);
            setReleaseUrl(data.releaseUrl);
          }

          // Only show update available if images are ready
          if (data.updateAvailable) {
            setUpdateAvailable(true);
          } else {
            setUpdateAvailable(false);
          }
        } else if (response.status === 404) {
          // Version check endpoint not available, stop polling
          if (intervalId) {
            clearInterval(intervalId);
            intervalId = null;
          }
        }
      } catch (error) {
        logger.error('Error checking for updates:', error);
      }
    };

    // Initial check
    checkForUpdates();

    // Check for updates every 4 hours
    intervalId = setInterval(checkForUpdates, CHECK_INTERVAL_MS);

    return () => {
      if (intervalId) {
        clearInterval(intervalId);
      }
    };
  }, [baseUrl]);

  return {
    updateAvailable,
    latestVersion,
    releaseUrl,
    dismissUpdate,
  };
}
