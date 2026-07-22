/**
 * Hook for checking application version updates
 *
 * Uses TanStack Query's `refetchInterval` to poll the server every 4 hours
 * for new versions and provides state for showing the update banner.
 * Replaces the previous hand-rolled `setInterval` + raw `fetch` implementation
 * (#3962 Phase 5.1) — the server's `versionCheckService` does the actual
 * GitHub polling/caching and gates `updateAvailable` on the Docker image
 * being ready; this hook just reads the cached result on an interval.
 */

import { useCallback, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import api, { ApiError } from '../services/api';
import type { DeploymentMethod } from '../components/AppBanners';

export interface VersionCheckResponse {
  updateAvailable: boolean;
  currentVersion?: string;
  latestVersion?: string;
  releaseUrl?: string;
  deploymentMethod?: DeploymentMethod;
}

interface VersionCheckResult {
  /** Whether a new version is available (and not locally dismissed) */
  updateAvailable: boolean;
  /** The latest available version string */
  latestVersion: string;
  /** URL to the release page */
  releaseUrl: string;
  /** Detected deployment method, used to tailor the update instructions */
  deploymentMethod: DeploymentMethod;
  /** Dismiss the update notification for this session (sets updateAvailable to false) */
  dismissUpdate: () => void;
}

/** Interval between version checks (4 hours) */
export const VERSION_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

/**
 * Hook to check for application updates.
 *
 * @param baseUrl - Reserved for API parity with the previous hook signature.
 *   `ApiService` resolves its own base URL internally, so this is accepted
 *   but not required to build the request.
 * @returns Version check state and controls
 */
export function useVersionCheck(_baseUrl?: string): VersionCheckResult {
  const [dismissed, setDismissed] = useState(false);

  const { data } = useQuery({
    queryKey: ['version-check'],
    queryFn: () => api.get<VersionCheckResponse>('/api/version/check'),
    // A 404 means version checking is disabled server-side
    // (env.versionCheckDisabled) — stop polling instead of retrying forever.
    refetchInterval: (query) => {
      const error = query.state.error;
      if (error instanceof ApiError && error.status === 404) {
        return false;
      }
      return VERSION_CHECK_INTERVAL_MS;
    },
    refetchIntervalInBackground: false,
    staleTime: VERSION_CHECK_INTERVAL_MS - 1000,
    gcTime: 5 * 60 * 1000,
    retry: false,
    refetchOnWindowFocus: false,
  });

  const dismissUpdate = useCallback(() => {
    setDismissed(true);
  }, []);

  // Only surface latestVersion/releaseUrl when it's actually newer than the
  // running version, mirroring the previous inline effect's behavior.
  const hasNewerVersion = !!data?.latestVersion && data.latestVersion !== data.currentVersion;

  return {
    updateAvailable: !dismissed && Boolean(data?.updateAvailable),
    latestVersion: hasNewerVersion && data?.latestVersion ? data.latestVersion : '',
    releaseUrl: hasNewerVersion ? (data?.releaseUrl || '') : '',
    deploymentMethod: data?.deploymentMethod ?? 'manual',
    dismissUpdate,
  };
}
