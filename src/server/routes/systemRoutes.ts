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
import { ALL_SOURCES } from '../../db/repositories/index.js';
import { logger } from '../../utils/logger.js';
import { getEnvironmentConfig } from '../config/environment.js';
import { versionCheckService } from '../services/versionCheckService.js';
import { detectDeploymentMethod } from '../utils/deployment.js';
import { fallbackManager } from '../meshtasticManager.js';
import { sourceManagerRegistry } from '../sourceManagerRegistry.js';
import { getPrimaryMeshtasticManager } from '../sourceManagerTypes.js';
import {
  serverStartTime,
  isRunningInDocker,
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
  const mgr = getPrimaryMeshtasticManager(sourceManagerRegistry) ?? fallbackManager;
  const connectionStatus = await mgr.getConnectionStatus();
  const localNode = mgr.getLocalNodeInfo();

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
      // intentional cross-source: system stats report global totals
      nodes: await databaseService.nodes.getNodeCount(ALL_SOURCES),
      messages: await databaseService.messages.getMessageCount(ALL_SOURCES),
      channels: await databaseService.channels.getChannelCount(ALL_SOURCES),
    },
    uptime: process.uptime(),
  });
});

// Version check endpoint — cache read through versionCheckService. The single
// server-side poller (versionCheckService) performs the GitHub fetch, caches the
// result, and fires the `upgrade-available` automation event headlessly. This
// route no longer triggers any upgrade — detection/notification only.
//
// `deploymentMethod` tells the frontend which deployment-specific update
// instructions to show (docker / lxc / kubernetes / manual).
router.get('/version/check', optionalAuth(), async (_req: Request, res: Response) => {
  if (env.versionCheckDisabled) {
    return res.status(404).send();
  }

  const deploymentMethod = detectDeploymentMethod();
  const status = await versionCheckService.getStatus();

  if (status.error) {
    // Preserve the historical failure shape (bare object, updateAvailable:false).
    return res.json({
      updateAvailable: false,
      error: status.error,
      deploymentMethod,
    });
  }

  return res.json({
    updateAvailable: status.updateAvailable,
    currentVersion: status.currentVersion,
    latestVersion: status.latestVersion,
    releaseUrl: status.releaseUrl,
    releaseName: status.releaseName,
    publishedAt: status.publishedAt,
    imageReady: status.imageReady,
    deploymentMethod,
  });
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
