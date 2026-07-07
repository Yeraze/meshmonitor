/**
 * System Routes
 *
 * GET  /system/status   — system statistics (uptime, memory, db, docker)
 * GET  /status          — connection + statistics status
 * GET  /version/check   — compare current version with latest GitHub release
 * POST /system/restart  — restart (Docker) or shutdown (baremetal) the process
 *
 * Extracted from server.ts. The Docker/version helpers live in
 * ../utils/systemInfo.js (shared with the startup auto-upgrade scheduler).
 * The restart handler needs the server-lifecycle `gracefulShutdown`, which is
 * injected from server.ts via setSystemCallbacks() so this module stays free
 * of the HTTP-server reference.
 */

import { createRequire } from 'module';
import { Router, Request, Response } from 'express';
import { optionalAuth, requirePermission } from '../auth/authMiddleware.js';
import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';
import { getEnvironmentConfig } from '../config/environment.js';
import { upgradeService } from '../services/upgradeService.js';
import { notifyUpgradeAvailable } from '../services/automation/automationEngineSingleton.js';
import meshtasticManager from '../meshtasticManager.js';
import {
  serverStartTime,
  isRunningInDocker,
  compareVersions,
  checkDockerImageExists,
} from '../utils/systemInfo.js';

const require = createRequire(import.meta.url);
const packageJson = require('../../../package.json');

const env = getEnvironmentConfig();

export interface SystemCallbacks {
  gracefulShutdown: (reason: string) => void;
}

let callbacks: SystemCallbacks = {
  gracefulShutdown: () => {
    logger.warn('gracefulShutdown called before system callbacks were registered');
  },
};

export function setSystemCallbacks(cb: SystemCallbacks): void {
  callbacks = cb;
}

const router: Router = Router();

// System status endpoint
router.get('/system/status', requirePermission('dashboard', 'read'), async (_req: Request, res: Response) => {
  const uptimeSeconds = Math.floor((Date.now() - serverStartTime) / 1000);
  const days = Math.floor(uptimeSeconds / 86400);
  const hours = Math.floor((uptimeSeconds % 86400) / 3600);
  const minutes = Math.floor((uptimeSeconds % 3600) / 60);
  const seconds = uptimeSeconds % 60;

  let uptimeString = '';
  if (days > 0) uptimeString += `${days}d `;
  if (hours > 0 || days > 0) uptimeString += `${hours}h `;
  if (minutes > 0 || hours > 0 || days > 0) uptimeString += `${minutes}m `;
  uptimeString += `${seconds}s`;

  // Get database info
  const databaseType = databaseService.getDatabaseType();
  const databaseVersion = await databaseService.getDatabaseVersion();

  res.json({
    version: packageJson.version,
    nodeVersion: process.version,
    platform: process.platform,
    architecture: process.arch,
    uptime: uptimeString,
    uptimeSeconds,
    environment: env.nodeEnv,
    isDocker: isRunningInDocker(),
    memoryUsage: {
      heapUsed: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + ' MB',
      heapTotal: Math.round(process.memoryUsage().heapTotal / 1024 / 1024) + ' MB',
      rss: Math.round(process.memoryUsage().rss / 1024 / 1024) + ' MB',
    },
    database: {
      type: databaseType.charAt(0).toUpperCase() + databaseType.slice(1), // Capitalize
      version: databaseVersion,
    },
  });
});

// Detailed status endpoint - provides system statistics and connection status
router.get('/status', optionalAuth(), async (_req: Request, res: Response) => {
  const connectionStatus = await meshtasticManager.getConnectionStatus();
  const localNode = meshtasticManager.getLocalNodeInfo();

  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: packageJson.version,
    nodeEnv: env.nodeEnv,
    connection: {
      connected: connectionStatus.connected,
      localNode: localNode
        ? {
            nodeNum: localNode.nodeNum,
            nodeId: localNode.nodeId,
            longName: localNode.longName,
            shortName: localNode.shortName,
          }
        : null,
    },
    statistics: {
      nodes: await databaseService.nodes.getNodeCount(),
      messages: await databaseService.messages.getMessageCount(),
      channels: await databaseService.channels.getChannelCount(),
    },
    uptime: process.uptime(),
  });
});

// Version check endpoint - compares current version with latest GitHub release
let versionCheckCache: { data: any; timestamp: number } | null = null;
const VERSION_CHECK_CACHE_MS = 5 * 60 * 1000; // 5 minute cache (reduced to detect image availability sooner)

router.get('/version/check', optionalAuth(), async (_req: Request, res: Response) => {
  if (env.versionCheckDisabled) {
    return res.status(404).send();
  }
  try {
    // Check cache first
    if (versionCheckCache && Date.now() - versionCheckCache.timestamp < VERSION_CHECK_CACHE_MS) {
      return res.json(versionCheckCache.data);
    }

    // Fetch latest release from GitHub
    const response = await fetch('https://api.github.com/repos/Yeraze/meshmonitor/releases/latest');

    if (!response.ok) {
      logger.warn(`GitHub API returned ${response.status} for version check`);
      return res.json({ updateAvailable: false, error: 'Unable to check for updates' });
    }

    const release = await response.json();
    const currentVersion = packageJson.version;
    const latestVersionRaw = release.tag_name;

    // Strip 'v' prefix from version strings for comparison
    const latestVersion = latestVersionRaw.replace(/^v/, '');
    const current = currentVersion.replace(/^v/, '');

    // Simple semantic version comparison
    const isNewerVersion = compareVersions(latestVersion, current) > 0;

    // Check if Docker image exists for this version (pass publish time for time-based heuristic)
    const imageReady = await checkDockerImageExists(latestVersion, release.published_at);

    // Only mark update as available if it's a newer version AND container image exists
    const updateAvailable = isNewerVersion && imageReady;

    // Check if auto-upgrade immediate is enabled and trigger upgrade automatically
    let autoUpgradeTriggered = false;
    if (updateAvailable && upgradeService.isEnabled()) {
      const autoUpgradeImmediate = await databaseService.settings.getSetting('autoUpgradeImmediate') === 'true';
      if (autoUpgradeImmediate) {
        // Check if an upgrade is already in progress before triggering
        try {
          const inProgress = await upgradeService.isUpgradeInProgress();
          if (inProgress) {
            logger.debug(`ℹ️ Auto-upgrade skipped: upgrade already in progress`);
          } else {
            logger.info(`🚀 Auto-upgrade immediate enabled, triggering upgrade to ${latestVersion}`);
            const upgradeResult = await upgradeService.triggerUpgrade(
              { targetVersion: latestVersion, backup: true },
              currentVersion,
              'system-auto-upgrade'
            );
            if (upgradeResult.success) {
              autoUpgradeTriggered = true;
              logger.info(`✅ Auto-upgrade triggered successfully: ${upgradeResult.upgradeId}`);
              void databaseService.auditLogAsync(
                null,
                'auto_upgrade_triggered',
                'system',
                `Auto-upgrade initiated: ${currentVersion} → ${latestVersion}`,
                null
              );
            } else {
              // Check if failure was due to upgrade already in progress (race condition)
              if (upgradeResult.message === 'An upgrade is already in progress') {
                logger.debug(`ℹ️ Auto-upgrade skipped: upgrade started by another process`);
              } else {
                logger.warn(`⚠️ Auto-upgrade failed to trigger: ${upgradeResult.message}`);
              }
            }
          }
        } catch (upgradeError) {
          logger.error('❌ Error triggering auto-upgrade:', upgradeError);
        }
      }
    }

    const result = {
      updateAvailable,
      currentVersion,
      latestVersion,
      releaseUrl: release.html_url,
      releaseName: release.name,
      publishedAt: release.published_at,
      imageReady,
      autoUpgradeTriggered,
    };

    // Cache the result
    versionCheckCache = { data: result, timestamp: Date.now() };

    // Fire the `upgrade-available` automation system event (deduped by version
    // inside the helper). Runs on cache-miss only, so at most once per ~5 min.
    if (updateAvailable) {
      notifyUpgradeAvailable({
        latestVersion,
        currentVersion,
        releaseUrl: release.html_url,
        releaseName: release.name,
      }).catch((err) => logger.error('Failed to raise upgrade-available automation event:', err));
    }

    return res.json(result);
  } catch (error) {
    logger.error('Error checking for version updates:', error);
    return res.json({ updateAvailable: false, error: 'Unable to check for updates' });
  }
});

// Restart/shutdown container endpoint
router.post('/system/restart', requirePermission('settings', 'write'), (_req: Request, res: Response) => {
  const isDocker = isRunningInDocker();

  if (isDocker) {
    logger.info('🔄 Container restart requested by admin');
    res.json({
      success: true,
      message: 'Container will restart now',
      action: 'restart',
    });

    // Gracefully shutdown - Docker will restart the container automatically
    setTimeout(() => {
      callbacks.gracefulShutdown('Admin-requested container restart');
    }, 500);
  } else {
    logger.info('🛑 Shutdown requested by admin');
    res.json({
      success: true,
      message: 'MeshMonitor will shut down now',
      action: 'shutdown',
    });

    // Gracefully shutdown - will need to be manually restarted
    setTimeout(() => {
      callbacks.gracefulShutdown('Admin-requested shutdown');
    }, 500);
  }
});

export default router;
