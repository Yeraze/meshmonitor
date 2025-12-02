/**
 * Hook for managing application auto-upgrade functionality
 *
 * Handles checking upgrade availability, triggering upgrades,
 * and polling for upgrade progress.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { logger } from '../utils/logger';

interface UpgradeState {
  /** Whether auto-upgrade is enabled (Docker deployment) */
  upgradeEnabled: boolean;
  /** Whether an upgrade is currently in progress */
  upgradeInProgress: boolean;
  /** Current upgrade status message */
  upgradeStatus: string;
  /** Upgrade progress percentage (0-100) */
  upgradeProgress: number;
  /** Trigger an upgrade to the specified version */
  triggerUpgrade: (targetVersion: string) => Promise<void>;
}

const BASE_POLL_INTERVAL = 10000; // 10 seconds
const MAX_POLL_INTERVAL = 30000; // 30 seconds
const MAX_POLL_ATTEMPTS = 60;

/**
 * Hook to manage auto-upgrade functionality
 *
 * @param baseUrl - The base URL of the API
 * @param authFetch - Authenticated fetch function
 * @param showToast - Optional toast notification function
 * @returns Upgrade state and controls
 */
export function useAutoUpgrade(
  baseUrl: string,
  authFetch: (url: string, options?: RequestInit) => Promise<Response>,
  showToast?: (message: string, type: 'success' | 'error' | 'info' | 'warning') => void
): UpgradeState {
  const [upgradeEnabled, setUpgradeEnabled] = useState(false);
  const [upgradeInProgress, setUpgradeInProgress] = useState(false);
  const [upgradeStatus, setUpgradeStatus] = useState('');
  const [upgradeProgress, setUpgradeProgress] = useState(0);
  
  const pollingIntervalRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Check if auto-upgrade is enabled
  useEffect(() => {
    const checkUpgradeStatus = async () => {
      try {
        const response = await authFetch(`${baseUrl}/api/upgrade/status`);
        if (response.ok) {
          const data = await response.json();
          setUpgradeEnabled(data.enabled && data.deploymentMethod === 'docker');
        }
      } catch (error) {
        logger.debug('Auto-upgrade not available:', error);
      }
    };

    checkUpgradeStatus();
  }, [baseUrl, authFetch]);

  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      if (pollingIntervalRef.current) {
        clearTimeout(pollingIntervalRef.current);
        pollingIntervalRef.current = null;
      }
    };
  }, []);

  // Poll upgrade status with exponential backoff
  const pollUpgradeStatus = useCallback((id: string) => {
    // Clear any existing polling
    if (pollingIntervalRef.current) {
      clearTimeout(pollingIntervalRef.current);
      pollingIntervalRef.current = null;
    }

    let attempts = 0;
    let currentInterval = BASE_POLL_INTERVAL;

    const poll = async () => {
      attempts++;

      try {
        const response = await authFetch(`${baseUrl}/api/upgrade/status/${id}`);
        if (response.ok) {
          const data = await response.json();

          setUpgradeStatus(data.currentStep || data.status);
          setUpgradeProgress(data.progress || 0);

          if (data.status === 'complete') {
            if (pollingIntervalRef.current) {
              clearTimeout(pollingIntervalRef.current);
              pollingIntervalRef.current = null;
            }
            showToast?.('Upgrade complete! Reloading...', 'success');
            setUpgradeStatus('Complete! Reloading...');
            setUpgradeProgress(100);

            // Reload after 3 seconds
            setTimeout(() => {
              window.location.reload();
            }, 3000);
            return;
          } else if (data.status === 'failed') {
            if (pollingIntervalRef.current) {
              clearTimeout(pollingIntervalRef.current);
              pollingIntervalRef.current = null;
            }
            showToast?.('Upgrade failed. Check logs for details.', 'error');
            setUpgradeInProgress(false);
            setUpgradeStatus('Failed');
            return;
          }

          // Reset interval on successful response
          currentInterval = BASE_POLL_INTERVAL;
        }
      } catch (error) {
        // Connection may be lost during restart - use exponential backoff
        currentInterval = Math.min(currentInterval * 1.5, MAX_POLL_INTERVAL);
        logger.debug('Polling upgrade status (connection may be restarting):', error);
      }

      // Stop polling after max attempts
      if (attempts >= MAX_POLL_ATTEMPTS) {
        if (pollingIntervalRef.current) {
          clearTimeout(pollingIntervalRef.current);
          pollingIntervalRef.current = null;
        }
        setUpgradeInProgress(false);
        setUpgradeStatus('Upgrade timeout - check status manually');
        return;
      }

      // Schedule next poll
      pollingIntervalRef.current = setTimeout(poll, currentInterval);
    };

    // Start polling
    poll();
  }, [baseUrl, authFetch, showToast]);

  // Trigger an upgrade
  const triggerUpgrade = useCallback(async (targetVersion: string) => {
    if (upgradeInProgress) return;

    try {
      setUpgradeInProgress(true);
      setUpgradeStatus('Initiating upgrade...');
      setUpgradeProgress(0);

      const response = await authFetch(`${baseUrl}/api/upgrade/trigger`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          targetVersion,
          backup: true
        })
      });

      const data = await response.json();

      if (data.success) {
        setUpgradeStatus('Upgrade initiated...');
        showToast?.('Upgrade initiated! The application will restart shortly.', 'info');
        pollUpgradeStatus(data.upgradeId);
      } else {
        showToast?.(`Upgrade failed: ${data.message}`, 'error');
        setUpgradeInProgress(false);
        setUpgradeStatus('');
      }
    } catch (error) {
      logger.error('Error triggering upgrade:', error);
      showToast?.('Failed to trigger upgrade', 'error');
      setUpgradeInProgress(false);
      setUpgradeStatus('');
    }
  }, [baseUrl, authFetch, showToast, upgradeInProgress, pollUpgradeStatus]);

  return {
    upgradeEnabled,
    upgradeInProgress,
    upgradeStatus,
    upgradeProgress,
    triggerUpgrade,
  };
}
