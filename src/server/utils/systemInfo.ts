/**
 * System / version utilities
 *
 * Pure helpers extracted from server.ts so they can be shared between the
 * system route handlers (routes/systemRoutes.ts) and the startup
 * auto-upgrade scheduler (checkForAutoUpgrade in server.ts) without
 * pulling in the whole monolith.
 */

import fs from 'fs';
import { logger } from '../../utils/logger.js';

/** Process start time, captured when this module is first loaded at boot. */
export const serverStartTime = Date.now();

/** Detect whether the process is running inside a Docker container. */
export function isRunningInDocker(): boolean {
  try {
    return fs.existsSync('/.dockerenv');
  } catch {
    return false;
  }
}

/**
 * Compare two semantic version strings.
 * Returns 1 if a > b, -1 if a < b, 0 if equal.
 */
export function compareVersions(a: string, b: string): number {
  const aParts = a.split(/[-.]/).map(p => parseInt(p) || 0);
  const bParts = b.split(/[-.]/).map(p => parseInt(p) || 0);

  for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
    const aPart = aParts[i] || 0;
    const bPart = bParts[i] || 0;

    if (aPart > bPart) return 1;
    if (aPart < bPart) return -1;
  }

  return 0;
}

/** Check if a Docker image for the given version exists in GHCR. */
export async function checkDockerImageExists(version: string, publishedAt?: string): Promise<boolean> {
  try {
    const owner = 'yeraze';
    const repo = 'meshmonitor';

    // STRATEGY 1: Query manifest directly (most reliable, avoids pagination issues)
    // Try both with and without 'v' prefix as GHCR may use either
    const tagsToTry = [version, `v${version}`];

    for (const tag of tagsToTry) {
      try {
        // Step 1: Get anonymous token from GHCR
        const tokenUrl = `https://ghcr.io/token?scope=repository:${owner}/${repo}:pull`;
        const tokenResponse = await fetch(tokenUrl);

        if (tokenResponse.ok) {
          const tokenData = await tokenResponse.json();
          const token = tokenData.token;

          // Step 2: Try to fetch the manifest for this specific tag
          const manifestUrl = `https://ghcr.io/v2/${owner}/${repo}/manifests/${tag}`;
          const manifestResponse = await fetch(manifestUrl, {
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: 'application/vnd.docker.distribution.manifest.v2+json',
            },
          });

          if (manifestResponse.ok) {
            logger.debug(`✓ Image for ${version} (tag: ${tag}) found in GitHub Container Registry`);
            return true;
          }
        }
      } catch (manifestError) {
        logger.debug(`Manifest check failed for tag ${tag}:`, manifestError);
        // Try next tag variant
      }
    }

    // If we reach here, manifest check failed for all tag variants
    logger.debug(`⏳ Image for ${version} not found via manifest check, falling back to time-based heuristic`);

    // STRATEGY 2: Time-based heuristic fallback (only if manifest check failed)
    // GitHub Actions typically takes 10-30 minutes to build and push container images
    // If release was published more than 30 minutes ago, assume the build completed
    if (publishedAt) {
      const publishTime = new Date(publishedAt).getTime();
      const now = Date.now();
      const minutesSincePublish = (now - publishTime) / (60 * 1000);

      if (minutesSincePublish >= 30) {
        logger.debug(
          `✓ Image for ${version} assumed ready (${Math.round(
            minutesSincePublish
          )} minutes since release, API check failed)`
        );
        return true;
      } else {
        logger.debug(
          `⏳ Image for ${version} still building (${Math.round(minutesSincePublish)}/30 minutes since release)`
        );
        return false;
      }
    }

    // If no publish time provided and API failed, be conservative and return false
    logger.warn(`Cannot verify image availability for ${version} (no publish time and API failed)`);
    return false;
  } catch (error) {
    logger.warn(`Error checking Docker image existence for ${version}:`, error);
    // On error with known publish time, use time-based fallback
    if (publishedAt) {
      const minutesSincePublish = (Date.now() - new Date(publishedAt).getTime()) / (60 * 1000);
      const assumeReady = minutesSincePublish >= 30;
      if (assumeReady) {
        logger.debug(
          `✓ Image for ${version} assumed ready (${Math.round(
            minutesSincePublish
          )} minutes since release, error during check)`
        );
      }
      return assumeReady;
    }
    // Otherwise fail closed to avoid false positives
    return false;
  }
}
